"""Bounded Linux mounted-storage observations, using only local files and statvfs.

Network filesystems are excluded because even a size probe can block on a server.
Non-device sources are accepted only for local ZFS datasets. Sysfs enumeration
and reads are bounded. No worker, subprocess, or network request is needed.
UsageCollector owns caching.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import errno
from itertools import islice
import math
import os
from pathlib import Path
import re
import shutil
from typing import Callable


MAX_MOUNTINFO_BYTES = 1024 * 1024
MAX_MOUNTINFO_RECORDS = 4096
MAX_STAT_CALLS = 128
MAX_BLOCK_ENTRIES = 256
MAX_SYSFS_READS = 2048
MAX_SYSFS_BYTES = 256
MAX_BTRFS_FILESYSTEMS = 64
MAX_SYMLINK_HOPS = 8
_BLOCK_NAME = re.compile(r"[A-Za-z0-9_-]+")
_VIRTUAL_BLOCK = re.compile(r"(?:loop|zram|ram|dm-|md|sr|fd|nbd|rbd|zd)")
_ESCAPES = {b"040": b" ", b"011": b"\t", b"012": b"\n", b"134": b"\\"}
_ESCAPED = re.compile(rb"\\(040|011|012|134)")
_NETWORK = frozenset({
    "autofs", "nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "9p", "afs", "coda",
    "glusterfs", "lustre", "gpfs", "beegfs", "orangefs", "pvfs2", "ncpfs", "fuse.sshfs", "fuse.rclone", "fuse.s3fs", "fuse.ceph", "fuse.glusterfs",
})
_EXCLUDED = frozenset({
    "proc", "sysfs", "tmpfs", "devtmpfs", "devpts", "ramfs", "rootfs",
    "debugfs", "tracefs", "securityfs", "configfs", "pstore", "efivarfs",
    "cgroup", "cgroup2", "hugetlbfs", "mqueue", "bpf", "fusectl",
    "binfmt_misc", "rpc_pipefs", "autofs", "overlay", "overlayfs", "aufs",
    "fuse.overlayfs", "fuse.fuse-overlayfs", "fuse.portal", "nsfs",
    "nfs", "nfs4", "cifs", "smb3", "smbfs", "ceph", "9p", "afs", "coda",
    "fuse.sshfs", "fuse.rclone", "fuse.s3fs", "fuse.ceph", "fuse.glusterfs",
}) | _NETWORK


@dataclass(frozen=True)
class _Mount:
    mount_id: int
    parent_id: int
    mount: str
    device: str
    filesystem: str

    @property
    def identity(self) -> tuple[str, str]:
        # FUSE mounts can share a major:minor pair while using different drives.
        # Btrfs subvolumes on one source intentionally share a capacity row.
        return self.device, self.filesystem


def _decode(raw: bytes) -> str:
    # One substitution pass: a literal escaped backslash followed by "040"
    # must not subsequently become a space.
    return os.fsdecode(_ESCAPED.sub(lambda match: _ESCAPES[match[1]], raw))


def _parse(raw: bytes) -> _Mount:
    before, separator, after = raw.partition(b" - ")
    left, right = before.split(), after.split()
    if (not separator or len(left) < 6 or len(right) != 3
            or not left[0].isdigit() or not left[1].isdigit()
            or re.fullmatch(rb"\d+:\d+", left[2]) is None
            # nsfs uses roots such as net:[4026533231], not directory paths.
            or not left[3].startswith(b"/") and right[0] != b"nsfs"
            or not left[4].startswith(b"/")
            or b"\x00" in raw):
        raise ValueError("mountinfo row")
    return _Mount(int(left[0]), int(left[1]), _decode(left[4]), _decode(right[1]), _decode(right[0]))


def _read_mounts(path: Path) -> tuple[list[_Mount], list[str]]:
    try:
        with path.open("rb") as handle:
            raw = handle.read(MAX_MOUNTINFO_BYTES + 1)
    except OSError:
        return [], ["mounted_storage_mountinfo_unavailable"]
    if len(raw) > MAX_MOUNTINFO_BYTES:
        return [], ["mounted_storage_mountinfo_byte_bound_reached"]
    rows = raw.split(b"\n", MAX_MOUNTINFO_RECORDS)
    if rows[-1] == b"":
        rows.pop()
    if len(rows) > MAX_MOUNTINFO_RECORDS:
        return [], ["mounted_storage_mountinfo_record_bound_reached"]
    if not rows:
        return [], ["mounted_storage_mountinfo_empty"]
    mounts, errors = [], set()
    for row in rows:
        try:
            mounts.append(_parse(row))
        except ValueError:
            errors.add("mounted_storage_mountinfo_invalid_row")
    return mounts, sorted(errors)


def _local_persistent(mount: _Mount) -> bool:
    if mount.filesystem in _EXCLUDED:
        return False
    if any(part.startswith(".mount_") for part in mount.mount.split("/")):
        return False
    return mount.device.startswith("/dev/") or mount.filesystem == "zfs"


def _path_order(path: str) -> tuple[bool, str]:
    return path != "/", path


def _ancestor_paths(path: str):
    # Mountinfo paths are absolute namespace paths. This only examines strings;
    # it does not resolve symlinks, traverse directories, or touch covered mounts.
    while path != "/":
        path = path.rpartition("/")[0] or "/"
        yield path


def _visible_mounts(mounts: list[_Mount]) -> tuple[dict[str, _Mount], list[str]]:
    by_id, groups, duplicates = {}, {}, set()
    for mount in mounts:
        if mount.mount_id in by_id:
            duplicates.add(mount.mount_id)
        by_id[mount.mount_id] = mount
        groups.setdefault(mount.mount, []).append(mount)
    visible, uncertain = {}, set()
    # Lexical order puts each strict ancestor before its descendants.
    for path, records in sorted(groups.items()):
        ancestor = None
        for prefix in _ancestor_paths(path):
            if prefix in uncertain:
                uncertain.add(path)
                break
            if prefix in visible:
                ancestor = visible[prefix]
                break
        if path in uncertain:
            continue
        members = {mount.mount_id: mount for mount in records}
        if duplicates.intersection(members):
            uncertain.add(path)
            continue
        children, bases = {}, []
        for mount in records:
            if mount.parent_id in members and not (path == "/" and mount.parent_id == mount.mount_id):
                children.setdefault(mount.parent_id, []).append(mount)
            else:
                bases.append(mount)
        # Every same-path chain must reach a base. Iterative traversal bounds
        # work by the record count and rejects cycles without recursive calls.
        pending, reached = list(bases), set()
        while pending:
            mount = pending.pop()
            if mount.mount_id not in reached:
                reached.add(mount.mount_id)
                pending.extend(children.get(mount.mount_id, []))
        if len(reached) != len(members):
            uncertain.add(path)
            continue
        accessible = []
        for mount in bases:
            parent = by_id.get(mount.parent_id)
            if parent is not None and parent != mount and not (
                    parent.mount == "/" and path != "/" or path.startswith(parent.mount + "/")):
                uncertain.add(path)
                break
            if ancestor is not None:
                if mount.parent_id == ancestor.mount_id:
                    accessible.append(mount)
            elif parent is None or path == "/" and parent == mount:
                # The namespace root's parent can be outside a chroot and
                # therefore absent from mountinfo. It may also point to itself.
                accessible.append(mount)
        if path in uncertain or len(accessible) > 1:
            uncertain.add(path)
            continue
        if not accessible:
            # The mount is attached beneath a covered ancestor, not the
            # filesystem currently reached by this pathname.
            continue
        mount = accessible[0]
        while children.get(mount.mount_id):
            stacked = children[mount.mount_id]
            if len(stacked) != 1:
                uncertain.add(path)
                break
            mount = stacked[0]
        if path not in uncertain:
            visible[path] = mount
    return visible, ["mounted_storage_mountinfo_invalid_tree"] if uncertain else []


def _ancestors_unchanged(path: str, before: dict[str, _Mount], after: dict[str, _Mount]) -> bool:
    return all(before.get(prefix) == after.get(prefix) for prefix in _ancestor_paths(path))


def _unsafe_ancestor(path: str, visible: dict[str, _Mount]) -> bool:
    # statvfs still resolves the pathname through parent filesystems. A local
    # child does not make a remote/FUSE parent lookup safe for the panel loop.
    return any(mount.filesystem in _NETWORK or (
        (mount.filesystem == "fuse" or mount.filesystem.startswith("fuse."))
        and not mount.device.startswith("/dev/"))
        for prefix in _ancestor_paths(path) if (mount := visible.get(prefix)) is not None)


def _unknown(row: dict, error: str) -> None:
    row.update(totalGiB=None, usedGiB=None, freeGiB=None, usedPercent=None,
               observedAt=None, stale=True)
    row["errors"] = sorted(set(row["errors"] + [error]))


def _resolve_device(device: str) -> str:
    """Resolve /dev/disk aliases without an unbounded symlink traversal."""
    path = device
    for _ in range(MAX_SYMLINK_HOPS):
        try:
            target = os.readlink(path)
        except OSError as error:
            if error.errno in (errno.EINVAL, errno.ENOENT):
                return path
            raise
        path = os.path.normpath(target if os.path.isabs(target)
                                else os.path.join(os.path.dirname(path), target))
    raise ValueError("device symlink bound")


class _Sysfs:
    """One refresh's bounded metadata reads, shared across all mounted sources."""

    def __init__(self):
        self.reads = 0
        self.cache = {}

    def spend(self):
        if self.reads >= MAX_SYSFS_READS:
            raise ValueError("mounted_storage_sysfs_read_bound_reached")
        self.reads += 1

    def names(self, path: Path, limit: int) -> list[str]:
        self.spend()
        try:
            with os.scandir(path) as entries:
                names = [entry.name for entry in islice(entries, limit + 1)]
        except OSError:
            raise ValueError("mounted_storage_sysfs_unavailable") from None
        if len(names) > limit:
            raise ValueError("mounted_storage_sysfs_entry_bound_reached")
        return sorted(names)

    def read(self, path: Path) -> str | None:
        if path not in self.cache:
            self.spend()
            try:
                with path.open("rb") as handle:
                    raw = handle.read(MAX_SYSFS_BYTES + 1)
            except FileNotFoundError:
                self.cache[path] = None
            except OSError:
                raise ValueError("mounted_storage_sysfs_unavailable") from None
            else:
                if len(raw) > MAX_SYSFS_BYTES:
                    raise ValueError("mounted_storage_sysfs_byte_bound_reached")
                try:
                    self.cache[path] = raw.decode("ascii").strip()
                except UnicodeError:
                    raise ValueError("mounted_storage_sysfs_invalid_value") from None
        return self.cache[path]

    def target(self, path: Path) -> Path:
        for _ in range(MAX_SYMLINK_HOPS):
            self.spend()
            try:
                target = os.readlink(path)
            except OSError as error:
                if error.errno == errno.EINVAL:
                    return path
                raise ValueError("mounted_storage_sysfs_unavailable") from None
            path = Path(os.path.normpath(target if os.path.isabs(target) else path.parent / target))
        raise ValueError("mounted_storage_sysfs_symlink_bound_reached")


def _btrfs_sources(sysfs: _Sysfs, root: Path, targets: dict[str, Path]) -> dict[str, bool]:
    # Block metadata alone cannot tell whether Btrfs usage spans several disks.
    # Its sibling sysfs filesystem registry also includes missing device IDs.
    registry = root.parent.parent / "fs" / "btrfs"
    supported = {}
    for fsid in sysfs.names(registry, MAX_BTRFS_FILESYSTEMS):
        if fsid == "features":
            continue
        devices = sysfs.names(registry / fsid / "devices", MAX_BLOCK_ENTRIES)
        ids = sysfs.names(registry / fsid / "devinfo", MAX_BLOCK_ENTRIES)
        single = len(devices) == len(ids) == 1
        for device in devices:
            if device in targets and sysfs.target(registry / fsid / "devices" / device) == targets[device]:
                supported[device] = single
    return supported


def _collect_drives(rows: list[dict], root: Path, resolver: Callable,
                    observed: str, coverage_errors: list[str]) -> tuple[list[dict], list[str]]:
    if not any(row["device"].startswith("/dev/") for row in rows):
        return [], []
    sysfs, errors = _Sysfs(), set()
    try:
        names = sysfs.names(root, MAX_BLOCK_ENTRIES)
        targets, parents = {}, {}
        for name in names:
            if _BLOCK_NAME.fullmatch(name) and not _VIRTUAL_BLOCK.match(name):
                targets[name] = sysfs.target(root / name)
        whole = {}
        for name, target in targets.items():
            partition = sysfs.read(root / name / "partition")
            if partition is None:
                if "virtual" not in target.parts:
                    whole[target] = name
            elif not partition.isdecimal() or int(partition) <= 0:
                raise ValueError("mounted_storage_sysfs_invalid_value")
        for name, target in targets.items():
            if target in whole:
                parents[name] = whole[target]
            elif target.parent in whole:
                parents[name] = whole[target.parent]
    except ValueError as error:
        return [], [str(error)]
    candidates = []
    for row in rows:
        if row["filesystem"] == "zfs" or not row["device"].startswith("/dev/"):
            continue
        try:
            resolved = os.fspath(resolver(row["device"]))
            if not resolved.startswith("/dev/") or Path(resolved).parent != Path("/dev"):
                continue
            name = Path(resolved).name
            if name in parents:
                candidates.append((row, name, parents[name]))
        except (OSError, ValueError, TypeError):
            errors.add("mounted_storage_device_resolution_unavailable")
    btrfs = {}
    if any(row["filesystem"] == "btrfs" for row, _, _ in candidates):
        try:
            btrfs = _btrfs_sources(sysfs, root, targets)
        except ValueError as error:
            errors.add(str(error))
    groups, unsupported = {}, set()
    for row, name, parent in candidates:
        if row["filesystem"] == "btrfs" and not btrfs.get(name, False):
            errors.add("mounted_storage_btrfs_topology_unsupported")
            unsupported.add(parent)
            continue
        groups.setdefault(parent, []).append((row, name))
    drives = []
    for parent, members in sorted(groups.items()):
        drive_errors = set()
        try:
            removable = sysfs.read(root / parent / "removable")
            if removable == "1":
                continue
            if removable != "0":
                raise ValueError("mounted_storage_drive_removable_unknown")
            rotational = sysfs.read(root / parent / "queue" / "rotational")
            if re.fullmatch(r"nvme\d+n\d+", parent):
                kind = "NVMe"
            elif rotational in ("0", "1"):
                kind = "SSD" if rotational == "0" else "HDD"
            else:
                raise ValueError("mounted_storage_drive_kind_unknown")
        except ValueError as error:
            errors.add(str(error))
            continue
        total = None
        try:
            sectors = sysfs.read(root / parent / "size")
            if sectors is None or not sectors.isdecimal() or not 0 < int(sectors) < 2**64:
                raise ValueError("mounted_storage_drive_capacity_unavailable")
            total = int(sectors) * 512 / 1024**3
        except ValueError as error:
            drive_errors.add(str(error))
        distinct, mount_paths, mounted = {}, set(), set()
        for row, name in members:
            row.update(driveKind=kind, driveDevice=f"/dev/{parent}")
            identity = name, row["filesystem"]
            if identity not in distinct or distinct[identity]["stale"] and not row["stale"]:
                distinct[identity] = row
            mounted.add(name)
            mount_paths.update([row["mount"], *row["aliases"]])
            drive_errors.update(row["errors"])
        values = list(distinct.values())
        # Known subtotals remain useful, but an entirely unavailable reading
        # stays null. Partial and errors make omitted readings explicit.
        def subtotal(key):
            known = [row[key] for row in values if row[key] is not None]
            return sum(known) if known else None
        used, free = subtotal("usedGiB"), subtotal("freeGiB")
        children = {name for name, owner in parents.items() if owner == parent and name != parent}
        stale = bool(drive_errors) or any(row["stale"] for row in values)
        drives.append({"mount": kind, "aliases": [], "device": f"/dev/{parent}",
                       "filesystem": "drive", "label": kind, "driveKind": kind,
                       "driveDevice": f"/dev/{parent}", "totalGiB": total,
                       "usedGiB": used, "freeGiB": free,
                       "usedPercent": used / total * 100 if used is not None and total is not None else None,
                       "freeKind": "available_to_unprivileged_process",
                       "partitionMounts": sorted(mount_paths, key=_path_order),
                       "observedAt": observed if total is not None or used is not None or free is not None else None,
                       "stale": stale, "errors": sorted(drive_errors),
                       "partial": stale or bool(coverage_errors) or parent in unsupported
                                  or not children.issubset(mounted)})
        errors.update(drive_errors)
    drives.sort(key=lambda row: ({'SSD': 0, 'NVMe': 1, 'HDD': 2}.get(row['driveKind'], 3), row['device']))
    return drives, sorted(errors)


def collect_mounted_storage(now: float, mountinfo_path: Path | str = "/proc/self/mountinfo",
                            disk_usage: Callable | None = None, *,
                            sysfs_path: Path | str = "/sys/class/block",
                            device_resolver: Callable | None = None) -> dict:
    """Return all eligible local mounts, probing at most 128 unique sources.

    Reads at most two bounded mount tables per refresh. A failed post-probe read
    invalidates sizes because an unmount can make statvfs report the parent drive.
    sysfs_path points to class/block; Btrfs membership uses sibling fs/btrfs.
    device_resolver maps a mount source to its canonical /dev block path or None.
    Drive partitionMounts contains representative paths and their aliases.
    Drive used/free values are known mounted subtotals, null when none are known;
    partial also covers unmounted partitions and incomplete mount enumeration.
    Sysfs budgets are 256 block entries, 64 Btrfs filesystems, 2048 operations,
    256 bytes per scalar, and eight symlink hops. No refresh cache is added.
    This limits work counts and bytes, not kernel latency for faulty local disks.
    """
    path = Path(mountinfo_path)
    mounts, errors = _read_mounts(path)
    result = {"mounts": [], "drives": [], "observedAt": None, "stale": bool(errors), "errors": errors}
    if not mounts:
        return result
    observed = datetime.fromtimestamp(now, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    groups = {}
    # Include excluded filesystems in visibility resolution: an overlay or
    # network mount can cover an eligible local drive and all of its children.
    visible, visibility_errors = _visible_mounts(mounts)
    errors.extend(visibility_errors)
    for mount in visible.values():
        if _local_persistent(mount):
            groups.setdefault(mount.identity, {})[mount.mount] = mount
    representatives = []
    for paths in groups.values():
        names = sorted(paths, key=_path_order)
        representatives.append((paths[names[0]], names[1:]))
    representatives.sort(key=lambda item: _path_order(item[0].mount))
    probe = disk_usage if disk_usage is not None else shutil.disk_usage
    for index, (mount, aliases) in enumerate(representatives):
        row = {"mount": mount.mount, "aliases": aliases, "device": mount.device,
               "filesystem": mount.filesystem, "totalGiB": None, "usedGiB": None,
               "freeGiB": None, "usedPercent": None,
               "freeKind": "available_to_unprivileged_process",
               "observedAt": None, "stale": True, "errors": []}
        result["mounts"].append(row)
        if _unsafe_ancestor(mount.mount, visible):
            _unknown(row, "mounted_storage_network_ancestor")
            continue
        if index >= MAX_STAT_CALLS:
            _unknown(row, "mounted_storage_stat_bound_reached")
            continue
        try:
            sizes = probe(mount.mount)
            values = (sizes.total, sizes.used, sizes.free)
            if (any(type(value) not in (int, float) or not math.isfinite(value) or value < 0 for value in values)
                    or sizes.total <= 0 or sizes.used > sizes.total or sizes.free > sizes.total):
                raise ValueError("invalid storage sizes")
            row.update(totalGiB=sizes.total / 1024**3, usedGiB=sizes.used / 1024**3,
                       freeGiB=sizes.free / 1024**3, usedPercent=sizes.used / sizes.total * 100,
                       observedAt=observed, stale=False)
        except (OSError, ValueError, OverflowError):
            _unknown(row, "mounted_storage_stat_unavailable")
    # Mount ID detects a removed/replaced mount even when path/source are reused.
    # Check every alias too, so cached rows never claim a disappeared alias exists.
    current, verify_errors = _read_mounts(path)
    current_visible, visibility_errors = _visible_mounts(current)
    verify_errors.extend(visibility_errors)
    present = set(current_visible.values())
    for row, (mount, _) in zip(result["mounts"], representatives):
        if verify_errors and not current:
            _unknown(row, "mounted_storage_mountinfo_verification_failed")
        elif mount not in present:
            _unknown(row, "mounted_storage_mount_disappeared")
        elif not _ancestors_unchanged(mount.mount, visible, current_visible):
            _unknown(row, "mounted_storage_mount_visibility_changed")
        row["aliases"] = [alias for alias in row["aliases"]
                          if groups[mount.identity][alias] in present
                          and _ancestors_unchanged(alias, visible, current_visible)]
    errors.extend(verify_errors)
    errors.extend(error for row in result["mounts"] for error in row["errors"])
    result["drives"], drive_errors = _collect_drives(
        result["mounts"], Path(sysfs_path).absolute(),
        device_resolver if device_resolver is not None else _resolve_device, observed,
        [error for error in errors if "_mountinfo_" in error])
    errors.extend(drive_errors)
    result.update(observedAt=observed, stale=bool(errors), errors=sorted(set(errors)))
    return result
