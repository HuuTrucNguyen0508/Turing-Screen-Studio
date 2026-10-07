"""Mounted local capacity from bounded synthetic mount tables and size probes."""

from collections import namedtuple
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from turzx_studio import mounted_storage as storage


NOW = datetime(2026, 10, 6, 21, tzinfo=timezone.utc).timestamp()
Disk = namedtuple("Disk", "total used free")
SIZES = Disk(100 * 1024**3, 40 * 1024**3, 55 * 1024**3)


def record(index, mount="/", device="/dev/root", filesystem="btrfs", root="/", optional="", parent=0):
    return f"{index} {parent} 8:1 {root} {mount} rw {optional}- {filesystem} {device} rw\n"


class MountedStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "mountinfo"
        self.probe = Mock(return_value=SIZES)
        self.sysfs = Path(self.temp.name) / "sys" / "class" / "block"
        self.sysfs.mkdir(parents=True)
        self.resolver = Mock(side_effect=lambda device: device)

    def collect(self, rows, **kwargs):
        self.path.write_text("".join(rows))
        options = {"sysfs_path": self.sysfs, "device_resolver": self.resolver, **kwargs}
        return storage.collect_mounted_storage(NOW, self.path, self.probe, **options)

    def test_all_ntfs_drives_boot_and_btrfs_aliases_sorted_without_double_counting(self):
        result = self.collect([
            record(1, "/mnt/nvme", "/dev/nvme1n1p1", "fuseblk", parent=5),
            record(2, "/home", root="/@home", optional="shared:1 master:2 ", parent=5),
            record(3, "/boot", "/dev/nvme0n1p1", "vfat", parent=5),
            record(4, "/mnt/hdd", "/dev/sdb1", "fuseblk", parent=5),
            record(5, "/", root="/@"),
            record(6, "/mnt/games", "/dev/sda1", "fuseblk", parent=5),
        ])
        self.assertEqual([row["mount"] for row in result["mounts"]],
                         ["/", "/boot", "/mnt/games", "/mnt/hdd", "/mnt/nvme"])
        self.assertEqual(result["mounts"][0]["aliases"], ["/home"])
        self.assertEqual(self.probe.call_count, 5)
        self.assertFalse(result["stale"])
        for row in result["mounts"]:
            self.assertEqual((row["totalGiB"], row["usedGiB"], row["freeGiB"], row["usedPercent"]),
                             (100, 40, 55, 40))
            self.assertEqual(row["freeKind"], "available_to_unprivileged_process")
            self.assertEqual(row["observedAt"], "2026-10-06T21:00:00.000Z")
        json.dumps(result, allow_nan=False)

    def test_escapes_spaces_backslashes_tabs_newlines_and_no_double_decoding(self):
        result = self.collect([record(1, r"/mnt/my\040drive\011tab\134040\012line",
                                      r"/dev/disk\040with\134slash", optional="shared:1 ")])
        row = result["mounts"][0]
        self.assertEqual(row["mount"], "/mnt/my drive\ttab\\040\nline")
        self.assertEqual(row["device"], "/dev/disk with\\slash")
        self.probe.assert_called_once_with(row["mount"])

    def test_pseudo_overlay_appimage_and_network_mounts_never_probed(self):
        filesystems = ["tmpfs", "devtmpfs", "proc", "sysfs", "debugfs", "tracefs", "cgroup2",
                       "overlay", "fuse.overlayfs", "fuse.fuse-overlayfs", "nfs4", "cifs", "fuse.sshfs"]
        rows = [record(index + 1, f"/mnt/exclude-{index}", "/dev/not-a-disk", fs)
                for index, fs in enumerate(filesystems)]
        rows.extend([record(100, "/tmp/.mount_AppImage123", "/dev/loop0", "squashfs"),
                     record(104, "/run/docker/netns/example", "nsfs", "nsfs", root="net:[4026533231]"),
                     record(101, "/mnt/remote", "host:/volume", "nfs"),
                     record(102, "/mnt/custom", "some-source", "fuse.custom"),
                     record(103, "/mnt/persist", "/dev/sdc1", "ext4")])
        result = self.collect(rows)
        self.assertEqual([row["mount"] for row in result["mounts"]], ["/mnt/persist"])
        self.assertEqual(result["errors"], [])
        self.probe.assert_called_once_with("/mnt/persist")

    def test_local_child_under_remote_or_non_device_fuse_parent_is_not_probed(self):
        for filesystem in ("nfs", "nfs4", "cifs", "fuse", "fuse.sshfs", "fuse.custom", "autofs", "lustre", "gpfs", "beegfs", "orangefs", "pvfs2", "ncpfs"):
            with self.subTest(filesystem=filesystem):
                self.probe.reset_mock()
                result = self.collect([record(1),
                    record(2, "/mnt/nas", "host:/share", filesystem, parent=1),
                    record(3, "/mnt/nas/scratch", "/dev/sdc1", "ext4", parent=2),
                    record(4, "/mnt/nvme", "/dev/nvme0n1p2", "fuseblk", parent=1)])
                self.assertEqual([call.args[0] for call in self.probe.call_args_list], ["/", "/mnt/nvme"])
                blocked = next(row for row in result['mounts'] if row['mount'] == '/mnt/nas/scratch')
                self.assertIsNone(blocked['totalGiB'])
                self.assertTrue(blocked['stale'])
                self.assertIn('mounted_storage_network_ancestor', blocked['errors'])
                self.assertEqual(result['mounts'][-1]['usedPercent'], 40)

    def test_local_device_fuse_parent_keeps_local_child_available(self):
        result = self.collect([record(1),
            record(2, "/mnt/local", "/dev/sda1", "fuseblk", parent=1),
            record(3, "/mnt/local/child", "/dev/sdb1", "ext4", parent=2)])
        self.assertFalse(result['stale'])
        self.assertEqual(self.probe.call_count, 3)

    def test_zfs_dataset_identity_includes_source(self):
        result = self.collect([record(1, "/mnt/one", "pool/one", "zfs"),
                               record(2, "/mnt/alias", "pool/one", "zfs"),
                               record(3, "/mnt/two", "pool/two", "zfs")])
        self.assertEqual([row["device"] for row in result["mounts"]], ["pool/one", "pool/two"])
        self.assertEqual(result["mounts"][0]["aliases"], ["/mnt/one"])
        self.assertEqual(self.probe.call_count, 2)

    def test_malformed_rows_mark_partial_enumeration_stale_but_keep_good_drive(self):
        result = self.collect(["broken\n", "1 2 nope / / rw - btrfs /dev/root rw\n",
                               "1 2 8:1 relative / rw - btrfs /dev/root rw\n", record(3)])
        self.assertTrue(result["stale"])
        self.assertIn("mounted_storage_mountinfo_invalid_row", result["errors"])
        self.assertFalse(result["mounts"][0]["stale"])
        self.assertEqual(result["mounts"][0]["usedPercent"], 40)

    def test_missing_empty_and_broken_mountinfo_return_empty_stale_error(self):
        result = storage.collect_mounted_storage(NOW, self.path, self.probe)
        self.assertEqual(result["mounts"], [])
        self.assertTrue(result["stale"])
        self.assertIn("mounted_storage_mountinfo_unavailable", result["errors"])
        for rows in ([], ["garbage\n"]):
            with self.subTest(rows=rows):
                result = self.collect(rows)
                self.assertEqual(result["mounts"], [])
                self.assertTrue(result["stale"])
                self.assertTrue(result["errors"])
                self.assertIsNone(result["observedAt"])
        self.probe.assert_not_called()

    def test_independent_stat_failure_preserves_other_drives_and_sanitizes_error(self):
        def probe(path):
            if path == "/mnt/broken":
                raise OSError("private exception contents")
            return SIZES
        self.probe.side_effect = probe
        result = self.collect([record(1), record(2, "/mnt/broken", "/dev/sdb1", "fuseblk", parent=1)])
        good, broken = result["mounts"]
        self.assertEqual(good["usedPercent"], 40)
        self.assertFalse(good["stale"])
        for key in ("totalGiB", "usedGiB", "freeGiB", "usedPercent", "observedAt"):
            self.assertIsNone(broken[key])
        self.assertTrue(broken["stale"])
        self.assertEqual(broken["errors"], ["mounted_storage_stat_unavailable"])
        self.assertTrue(result["stale"])
        self.assertNotIn("private", json.dumps(result))

    def test_unmount_during_stat_does_not_report_parent_capacity(self):
        def probe(path):
            if path == "/mnt/games":
                self.path.write_text(record(1))
            return SIZES
        self.probe.side_effect = probe
        result = self.collect([record(1), record(2, "/mnt/games", "/dev/sda1", "fuseblk", parent=1)])
        self.assertEqual(result["mounts"][0]["usedPercent"], 40)
        row = result["mounts"][1]
        self.assertIsNone(row["usedPercent"])
        self.assertIsNone(row["observedAt"])
        self.assertEqual(row["errors"], ["mounted_storage_mount_disappeared"])

    def test_replaced_mount_at_same_path_and_source_is_detected(self):
        self.probe.side_effect = lambda path: (self.path.write_text(record(2)), SIZES)[1]
        result = self.collect([record(1)])
        self.assertIsNone(result["mounts"][0]["usedPercent"])
        self.assertIn("mounted_storage_mount_disappeared", result["errors"])

    def test_disappeared_alias_removed_without_losing_representative_sizes(self):
        self.probe.side_effect = lambda path: (self.path.write_text(record(1)), SIZES)[1]
        result = self.collect([record(1), record(2, "/home", parent=1)])
        self.assertEqual(result["mounts"][0]["aliases"], [])
        self.assertEqual(result["mounts"][0]["usedPercent"], 40)

    def test_broken_verification_invalidates_sizes(self):
        self.probe.side_effect = lambda path: (self.path.unlink(), SIZES)[1]
        result = self.collect([record(1)])
        self.assertIsNone(result["mounts"][0]["usedPercent"])
        self.assertIn("mounted_storage_mountinfo_verification_failed", result["errors"])

    def test_hidden_mount_under_overlay_is_excluded(self):
        result = self.collect([record(1), record(2, "/", "overlay", "overlay", parent=1)])
        self.assertEqual(result["mounts"], [])
        self.assertFalse(result["stale"])
        self.probe.assert_not_called()

    def test_preexisting_ancestor_overmount_never_probes_hidden_drive(self):
        for covering_parent in (1, 2):
            with self.subTest(covering_parent=covering_parent):
                self.probe.reset_mock()
                rows = [record(1), record(3, "/mnt/games", "/dev/games", "fuseblk",
                                          parent=covering_parent),
                        record(4, "/mnt", "overlay", "overlay", parent=covering_parent),
                        record(5, "/other/nvme", "/dev/nvme", "ext4", parent=1)]
                if covering_parent == 2:
                    rows.append(record(2, "/mnt", "tmpfs", "tmpfs", parent=1))
                result = self.collect(rows)
                self.assertEqual([row["mount"] for row in result["mounts"]], ["/", "/other/nvme"])
                self.assertEqual([call.args[0] for call in self.probe.call_args_list], ["/", "/other/nvme"])
                self.assertFalse(result["stale"])

    def test_ancestor_overmount_during_probe_invalidates_only_affected_drive(self):
        rows = [record(1), record(2, "/mnt", "tmpfs", "tmpfs", parent=1),
                record(3, "/mnt/games", "/dev/games", "fuseblk", parent=2),
                record(4, "/other/nvme", "/dev/nvme", "ext4", parent=1)]

        def probe(path):
            if path == "/mnt/games":
                # The old drive record survives, but its path now reads overlay capacity.
                self.path.write_text("".join(rows + [record(5, "/mnt", "overlay", "overlay", parent=2)]))
            return SIZES

        self.probe.side_effect = probe
        result = self.collect(rows)
        root, games, nvme = result["mounts"]
        for row in (root, nvme):
            self.assertFalse(row["stale"])
            self.assertEqual(row["usedPercent"], 40)
        for key in ("totalGiB", "usedGiB", "freeGiB", "usedPercent", "observedAt"):
            self.assertIsNone(games[key])
        self.assertTrue(games["stale"])
        self.assertTrue(games["errors"])
        self.assertTrue(result["stale"])

    def test_same_path_stacks_follow_parent_ids_not_row_order(self):
        result = self.collect([record(1),
                               record(3, "/mnt", "/dev/top", "ext4", parent=2),
                               record(4, "/mnt/games", "/dev/games", "fuseblk", parent=3),
                               record(2, "/mnt", "/dev/lower", "ext4", parent=1)])
        self.assertEqual([row["device"] for row in result["mounts"]],
                         ["/dev/root", "/dev/top", "/dev/games"])
        self.assertFalse(result["stale"])

    def test_same_path_descendants_of_hidden_and_visible_trees_are_distinguished(self):
        result = self.collect([record(1),
                               record(2, "/mnt", "tmpfs", "tmpfs", parent=1),
                               record(3, "/mnt/games", "/dev/old", "fuseblk", parent=2),
                               record(4, "/mnt", "overlay", "overlay", parent=2),
                               record(5, "/mnt/games", "/dev/current", "fuseblk", parent=4),
                               record(6, "/mnt/games/backup", "/dev/hidden", "ext4", parent=3)])
        self.assertEqual([row["device"] for row in result["mounts"]], ["/dev/root", "/dev/current"])
        self.assertFalse(result["stale"])
        self.assertEqual(self.probe.call_count, 2)

    def test_normal_tree_keeps_nested_drives_and_path_component_boundaries(self):
        result = self.collect([record(1, parent=1),
                               record(2, "/mnt", "tmpfs", "tmpfs", parent=1),
                               record(3, "/mnt/games", "/dev/games", "fuseblk", parent=2),
                               record(4, "/mnt/games/backup", "/dev/backup", "ext4", parent=3),
                               record(5, "/mnt2/nvme", "/dev/nvme", "ext4", parent=1)])
        self.assertEqual([row["mount"] for row in result["mounts"]],
                         ["/", "/mnt/games", "/mnt/games/backup", "/mnt2/nvme"])
        self.assertFalse(result["stale"])
        self.assertEqual(self.probe.call_count, 4)

    def test_hidden_alias_removed_without_invalidating_visible_representative(self):
        rows = [record(1), record(2, "/mnt/games", parent=1)]
        self.probe.side_effect = lambda path: (self.path.write_text("".join(
            rows + [record(3, "/mnt", "overlay", "overlay", parent=1)])), SIZES)[1]
        result = self.collect(rows)
        self.assertEqual(len(result["mounts"]), 1)
        self.assertEqual(result["mounts"][0]["aliases"], [])
        self.assertEqual(result["mounts"][0]["usedPercent"], 40)
        self.assertFalse(result["mounts"][0]["stale"])

    def test_hidden_representative_invalidated_even_when_alias_remains_visible(self):
        rows = [record(1), record(2, "/mnt/games", "/dev/games", "fuseblk", parent=1),
                record(3, "/other/games", "/dev/games", "fuseblk", parent=1)]
        self.probe.side_effect = lambda path: (self.path.write_text("".join(
            rows + [record(4, "/mnt", "overlay", "overlay", parent=1)])), SIZES)[1]
        result = self.collect(rows)
        row = result["mounts"][1]
        self.assertEqual(row["aliases"], ["/other/games"])
        self.assertIsNone(row["usedPercent"])
        self.assertTrue(row["stale"])
        self.assertFalse(result["mounts"][0]["stale"])

    def test_changed_ancestor_record_invalidates_still_present_child(self):
        rows = [record(1), record(2, "/mnt", "tmpfs", "tmpfs", parent=1),
                record(3, "/mnt/games", "/dev/games", "fuseblk", parent=2),
                record(4, "/other/nvme", "/dev/nvme", "ext4", parent=1)]
        after = [rows[0], record(2, "/mnt", "overlay", "overlay", parent=1), *rows[2:]]
        self.probe.side_effect = lambda path: (self.path.write_text("".join(after)), SIZES)[1]
        result = self.collect(rows)
        self.assertIsNone(result["mounts"][1]["usedPercent"])
        self.assertEqual(result["mounts"][1]["errors"], ["mounted_storage_mount_visibility_changed"])
        self.assertFalse(result["mounts"][0]["stale"])
        self.assertFalse(result["mounts"][2]["stale"])

    def test_invalid_mount_cycles_and_ambiguous_stacks_never_probe_affected_paths(self):
        cases = [
            [record(2, "/cycle", "/dev/one", "ext4", parent=3),
             record(3, "/cycle", "/dev/two", "ext4", parent=2)],
            [record(2, "/cycle", "/dev/self", "ext4", parent=2)],
            [record(2, "/cycle/a", "/dev/one", "ext4", parent=3),
             record(3, "/cycle/b", "/dev/two", "ext4", parent=2)],
            [record(2, "/cycle", "/dev/one", "ext4", parent=1),
             record(3, "/cycle", "/dev/two", "ext4", parent=1)],
            [record(2, "/cycle", "/dev/one", "ext4", parent=1),
             record(2, "/cycle", "/dev/two", "ext4", parent=1)],
        ]
        for malformed in cases:
            with self.subTest(malformed=malformed):
                self.probe.reset_mock()
                result = self.collect([record(1), *malformed,
                                       record(4, "/cycle/child", "/dev/child", "ext4", parent=2)])
                self.assertEqual([row["mount"] for row in result["mounts"]], ["/"])
                self.probe.assert_called_once_with("/")
                self.assertIn("mounted_storage_mountinfo_invalid_tree", result["errors"])
                self.assertFalse(result["mounts"][0]["stale"])

    def test_maximum_record_stack_is_iterative_and_keeps_visible_child(self):
        top = storage.MAX_MOUNTINFO_RECORDS - 1
        rows = [record(1)]
        rows.extend(record(index, "/mnt", "tmpfs", "tmpfs", parent=index - 1)
                    for index in range(2, top + 1))
        rows.append(record(top + 1, "/mnt/games", "/dev/games", "fuseblk", parent=top))
        result = self.collect(list(reversed(rows)))
        self.assertEqual([row["mount"] for row in result["mounts"]], ["/", "/mnt/games"])
        self.assertFalse(result["stale"])
        self.assertEqual(self.probe.call_count, 2)

    def test_byte_read_is_bounded_even_when_file_size_metadata_is_zero(self):
        class ReadGuard(io.BytesIO):
            def read(self, size=-1):
                self.size_requested = size
                return super().read(size)

        handle = ReadGuard(b"x" * 100)
        with patch.object(storage, "MAX_MOUNTINFO_BYTES", 32), patch.object(Path, "open", return_value=handle):
            result = storage.collect_mounted_storage(NOW, self.path, self.probe)
        self.assertEqual(handle.size_requested, 33)
        self.assertEqual(result["mounts"], [])
        self.assertIn("mounted_storage_mountinfo_byte_bound_reached", result["errors"])
        self.probe.assert_not_called()

    def test_record_count_bound_applies_to_all_rows(self):
        with patch.object(storage, "MAX_MOUNTINFO_RECORDS", 1):
            result = self.collect([record(1), record(2, "/mnt/alias")])
        self.assertEqual(result["mounts"], [])
        self.assertIn("mounted_storage_mountinfo_record_bound_reached", result["errors"])
        self.probe.assert_not_called()

    def test_stat_budget_is_128_unique_sources_with_unknown_overflow_rows(self):
        rows = [record(index + 1, f"/mnt/{index:03}", f"/dev/disk{index}", "fuseblk")
                for index in range(130)]
        rows.extend(record(index + 200, f"/mnt/alias{index}", f"/dev/disk{index}", "fuseblk")
                    for index in range(130))
        result = self.collect(rows)
        self.assertEqual(len(result["mounts"]), 130)
        self.assertEqual(self.probe.call_count, 128)
        self.assertEqual(sum(row["usedPercent"] is None for row in result["mounts"]), 2)
        self.assertIn("mounted_storage_stat_bound_reached", result["errors"])
        self.assertTrue(result["stale"])

    def test_invalid_stat_values_stay_json_safe_and_unknown(self):
        for sizes in (Disk(0, 0, 0), Disk(100, -1, 0), Disk(100, 101, 0),
                      Disk(100, 0, float("nan")), Disk(float("inf"), 0, 0)):
            with self.subTest(sizes=sizes):
                self.probe.return_value = sizes
                result = self.collect([record(1)])
                self.assertIsNone(result["mounts"][0]["usedPercent"])
                self.assertTrue(result["stale"])
                json.dumps(result, allow_nan=False)


class PhysicalDriveTests(unittest.TestCase):
    setUp = MountedStorageTests.setUp
    collect = MountedStorageTests.collect

    def drive(self, name, capacity=1000, rotational="0", partitions=(), removable="0", virtual=False):
        target = self.sysfs.parent.parent / "devices" / ("virtual" if virtual else "pci") / name
        target.mkdir(parents=True)
        (self.sysfs / name).symlink_to(target, target_is_directory=True)
        (target / "size").write_text(str(capacity * 1024**3 // 512))
        (target / "removable").write_text(removable)
        (target / "queue").mkdir()
        (target / "queue" / "rotational").write_text(rotational)
        for number, child in enumerate(partitions, 1):
            directory = target / child
            directory.mkdir()
            (directory / "partition").write_text(str(number))
            (directory / "size").write_text("100")
            (self.sysfs / child).symlink_to(directory, target_is_directory=True)
        return target

    def btrfs(self, fsid, devices, missing=0):
        root = self.sysfs.parent.parent / "fs" / "btrfs" / fsid
        (root / "devices").mkdir(parents=True)
        (root / "devinfo").mkdir()
        for index, device in enumerate(devices, 1):
            (root / "devices" / device).symlink_to((self.sysfs / device).resolve())
            (root / "devinfo" / str(index)).mkdir()
        for index in range(len(devices) + 1, len(devices) + missing + 1):
            (root / "devinfo" / str(index)).mkdir()

    def test_physical_capacity_classes_shared_btrfs_and_unmounted_partitions(self):
        self.drive("sda", partitions=("sda1", "sda2"))
        self.drive("sdb", rotational="1", partitions=("sdb1", "sdb2"))
        self.drive("nvme0n1", capacity=2000,
                   partitions=("nvme0n1p1", "nvme0n1p2", "nvme0n1p3", "nvme0n1p4"))
        self.btrfs("single", ["sda2"])
        result = self.collect([
            record(1, device="/dev/sda2"),
            record(2, "/home", "/dev/sda2", root="/@home", parent=1),
            record(3, "/boot", "/dev/sda1", "vfat", parent=1),
            record(4, "/mnt/hdd", "/dev/sdb1", "ext4", parent=1),
            record(5, "/mnt/nvme", "/dev/nvme0n1p3", "fuseblk", parent=1),
            record(6, "/mnt/games", "/dev/nvme0n1p4", "fuseblk", parent=1),
        ])
        ssd, nvme, hdd = result["drives"]
        self.assertEqual([row["device"] for row in result["drives"]],
                         ["/dev/sda", "/dev/nvme0n1", "/dev/sdb"])
        self.assertEqual([row["label"] for row in result["drives"]], ["SSD", "NVMe", "HDD"])
        self.assertEqual((ssd["totalGiB"], ssd["usedGiB"], ssd["freeGiB"], ssd["usedPercent"]),
                         (1000, 80, 110, 8))
        self.assertEqual(ssd["partitionMounts"], ["/", "/boot", "/home"])
        self.assertFalse(ssd["partial"])
        self.assertEqual((nvme["totalGiB"], nvme["usedGiB"], nvme["freeGiB"], nvme["usedPercent"]),
                         (2000, 80, 110, 4))
        self.assertTrue(nvme["partial"])
        self.assertTrue(hdd["partial"])
        self.assertEqual(hdd["freeGiB"], 55)
        self.assertFalse(result["stale"])
        self.assertEqual(self.probe.call_count, 5)
        for row in result["drives"]:
            self.assertEqual(row["filesystem"], "drive")
            self.assertEqual(row["mount"], row["label"])
            self.assertEqual(row["aliases"], [])
            self.assertEqual(row["observedAt"], "2026-10-06T21:00:00.000Z")
            self.assertFalse(row["stale"])
            self.assertEqual(row["errors"], [])
        self.assertEqual(result["mounts"][0]["aliases"], ["/home"])
        self.assertEqual(result["mounts"][0]["driveDevice"], "/dev/sda")
        self.assertEqual(result["mounts"][0]["driveKind"], "SSD")
        json.dumps(result, allow_nan=False)

    def test_parent_comes_from_sysfs_topology_not_device_name_suffix(self):
        self.drive("sdb", rotational="1", partitions=("sda99",))
        result = self.collect([record(1, device="/dev/sda99", filesystem="ext4")])
        self.assertEqual(result["drives"][0]["device"], "/dev/sdb")
        self.assertFalse(result["drives"][0]["partial"])

    def test_whole_drive_filesystem_and_zero_used_are_known(self):
        target = self.drive("sda", capacity=200)
        (target / "queue" / "logical_block_size").write_text("4096")
        self.probe.return_value = Disk(100 * 1024**3, 0, 99 * 1024**3)
        result = self.collect([record(1, device="/dev/sda", filesystem="ext4")])
        drive = result["drives"][0]
        self.assertEqual((drive["totalGiB"], drive["usedGiB"], drive["usedPercent"]), (200, 0, 0))
        self.assertEqual(drive["freeGiB"], 99)
        self.assertFalse(drive["partial"])

    def test_dev_disk_symlinks_keep_mount_contract_and_deduplicate_drive_usage(self):
        self.drive("sda", partitions=("sda2",))
        readlink = storage.os.readlink

        def resolve(path):
            if str(path) == "/dev/disk/by-uuid/example":
                return "../../sda2"
            if str(path) == "/dev/sda2":
                raise OSError(22, "not a symlink")
            return readlink(path)

        with patch.object(storage.os, "readlink", side_effect=resolve):
            result = self.collect([record(1, "/one", "/dev/disk/by-uuid/example", "ext4"),
                                   record(2, "/two", "/dev/sda2", "ext4")],
                                  device_resolver=storage._resolve_device)
        self.assertEqual([row["device"] for row in result["mounts"]],
                         ["/dev/disk/by-uuid/example", "/dev/sda2"])
        self.assertEqual(result["drives"][0]["usedGiB"], 40)
        self.assertEqual(result["drives"][0]["freeGiB"], 55)
        self.assertEqual(result["drives"][0]["partitionMounts"], ["/one", "/two"])

    def test_unknown_usage_stays_null_with_known_hardware_capacity(self):
        self.drive("sda", partitions=("sda1",))
        self.probe.side_effect = OSError("secret probe details")
        result = self.collect([record(1, device="/dev/sda1", filesystem="ext4")])
        drive = result["drives"][0]
        self.assertEqual(drive["totalGiB"], 1000)
        for key in ("usedGiB", "freeGiB", "usedPercent"):
            self.assertIsNone(drive[key])
        self.assertTrue(drive["partial"])
        self.assertTrue(drive["stale"])
        self.assertEqual(drive["errors"], ["mounted_storage_stat_unavailable"])
        self.assertNotIn("secret", json.dumps(result))

    def test_failed_partition_retains_explicit_partial_known_subtotals(self):
        self.drive("sda", partitions=("sda1", "sda2"))
        self.drive("sdb", partitions=("sdb1",))
        self.probe.side_effect = lambda path: SIZES if path != "/bad" else Disk(0, 0, 0)
        result = self.collect([record(1, "/good", "/dev/sda1", "ext4"),
                               record(2, "/bad", "/dev/sda2", "ext4"),
                               record(3, "/other", "/dev/sdb1", "ext4")])
        broken, good = result["drives"]
        self.assertEqual((broken["usedGiB"], broken["freeGiB"], broken["usedPercent"]), (40, 55, 4))
        self.assertTrue(broken["partial"])
        self.assertTrue(broken["stale"])
        self.assertFalse(good["partial"])
        self.assertFalse(good["stale"])

    def test_mount_disappearance_is_not_counted_as_parent_filesystem_usage(self):
        self.drive("sda", partitions=("sda1", "sda2"))
        self.probe.side_effect = lambda path: (self.path.write_text(record(
            1, device="/dev/sda1", filesystem="ext4")), SIZES)[1]
        result = self.collect([record(1, device="/dev/sda1", filesystem="ext4"),
                               record(2, "/mnt/data", "/dev/sda2", "ext4", parent=1)])
        drive = result["drives"][0]
        self.assertEqual(drive["usedGiB"], 40)
        self.assertTrue(drive["partial"])
        self.assertIn("mounted_storage_mount_disappeared", drive["errors"])

    def test_bad_capacity_does_not_erase_available_filesystem_usage(self):
        target = self.drive("sda")
        for capacity in ("0", "invalid", "-1", str(2**64)):
            with self.subTest(capacity=capacity):
                (target / "size").write_text(capacity)
                drive = self.collect([record(1, device="/dev/sda", filesystem="ext4")])["drives"][0]
                self.assertIsNone(drive["totalGiB"])
                self.assertIsNone(drive["usedPercent"])
                self.assertEqual(drive["usedGiB"], 40)
                self.assertTrue(drive["partial"])
                self.assertEqual(drive["errors"], ["mounted_storage_drive_capacity_unavailable"])

    def test_virtual_removable_mapper_and_zfs_keep_mounts_without_drive_metadata(self):
        self.drive("loop0")
        self.drive("zram0")
        self.drive("dm-0")
        self.drive("md0")
        self.drive("sdc", removable="1")
        self.drive("sdd", virtual=True)
        rows = [record(index, f"/mnt/{name}", f"/dev/{name}", "ext4")
                for index, name in enumerate(("loop0", "zram0", "dm-0", "md0", "sdc", "sdd"), 1)]
        rows.append(record(7, "/mnt/zfs", "pool/data", "zfs"))
        result = self.collect(rows)
        self.assertEqual(len(result["mounts"]), 7)
        self.assertEqual(result["drives"], [])
        for row in result["mounts"]:
            self.assertNotIn("driveKind", row)
            self.assertNotIn("driveDevice", row)
            self.assertEqual(row["usedGiB"], 40)

    def test_btrfs_multidevice_and_missing_device_are_unsupported(self):
        self.drive("sda", partitions=("sda1", "sda2"))
        self.drive("sdb", partitions=("sdb1",))
        self.btrfs("multi", ["sda2", "sdb1"])
        result = self.collect([record(1, device="/dev/sda2"),
                               record(2, "/other", "/dev/sdb1"),
                               record(3, "/boot", "/dev/sda1", "vfat", parent=1)])
        self.assertEqual(len(result["drives"]), 1)
        drive = result["drives"][0]
        self.assertEqual(drive["usedGiB"], 40)
        self.assertEqual(drive["partitionMounts"], ["/boot"])
        self.assertTrue(drive["partial"])
        self.assertNotIn("driveDevice", result["mounts"][0])
        self.assertIn("mounted_storage_btrfs_topology_unsupported", result["errors"])
        # A missing member is visible through devinfo even without a block link.
        self.drive("sdc", partitions=("sdc1",))
        self.btrfs("missing", ["sdc1"], missing=1)
        result = self.collect([record(1, device="/dev/sdc1")])
        self.assertEqual(result["drives"], [])

    def test_missing_btrfs_topology_does_not_guess_a_single_drive(self):
        self.drive("sda", partitions=("sda1",))
        result = self.collect([record(1, device="/dev/sda1")])
        self.assertEqual(result["drives"], [])
        self.assertEqual(result["mounts"][0]["usedGiB"], 40)
        self.assertIn("mounted_storage_btrfs_topology_unsupported", result["errors"])

    def test_sysfs_enumeration_read_and_byte_budgets_are_explicit(self):
        target = self.drive("sda", partitions=("sda1",))
        cases = [("MAX_BLOCK_ENTRIES", 1, "mounted_storage_sysfs_entry_bound_reached"),
                 ("MAX_SYSFS_READS", 1, "mounted_storage_sysfs_read_bound_reached")]
        for constant, bound, error in cases:
            with self.subTest(constant=constant), patch.object(storage, constant, bound):
                result = self.collect([record(1, device="/dev/sda1", filesystem="ext4")])
                self.assertEqual(result["drives"], [])
                self.assertIn(error, result["errors"])
                self.assertEqual(result["mounts"][0]["usedGiB"], 40)
        (target / "sda1" / "partition").write_text("1" * (storage.MAX_SYSFS_BYTES + 1))
        result = self.collect([record(1, device="/dev/sda1", filesystem="ext4")])
        self.assertEqual(result["drives"], [])
        self.assertIn("mounted_storage_sysfs_byte_bound_reached", result["errors"])

    def test_sysfs_reads_are_limited_even_for_zero_size_metadata(self):
        self.drive("sda", partitions=("sda1",))
        opened = []
        original = Path.open

        class Guard(io.BytesIO):
            def read(self, size=-1):
                opened.append(size)
                return super().read(size)

        def guarded(path, *args, **kwargs):
            if path.name == "partition":
                return Guard(b"1" * (storage.MAX_SYSFS_BYTES + 1))
            return original(path, *args, **kwargs)

        with patch.object(Path, "open", guarded):
            result = self.collect([record(1, device="/dev/sda1", filesystem="ext4")])
        self.assertEqual(opened, [storage.MAX_SYSFS_BYTES + 1])
        self.assertIn("mounted_storage_sysfs_byte_bound_reached", result["errors"])

    def test_sysfs_and_device_resolver_errors_are_sanitized(self):
        self.drive("sda")
        self.resolver.side_effect = OSError("private device path and secret")
        result = self.collect([record(1, device="/dev/sda", filesystem="ext4")])
        self.assertEqual(result["drives"], [])
        self.assertIn("mounted_storage_device_resolution_unavailable", result["errors"])
        self.assertNotIn("secret", json.dumps(result))
        with patch.object(storage.os, "scandir", side_effect=PermissionError("secret")):
            result = self.collect([record(1, device="/dev/sda", filesystem="ext4")])
        self.assertIn("mounted_storage_sysfs_unavailable", result["errors"])
        self.assertNotIn("secret", json.dumps(result))

    def test_unknown_classification_is_unsupported_without_invented_metadata(self):
        self.drive("sda", rotational="unknown")
        result = self.collect([record(1, device="/dev/sda", filesystem="ext4")])
        self.assertEqual(result["drives"], [])
        self.assertNotIn("driveKind", result["mounts"][0])
        self.assertIn("mounted_storage_drive_kind_unknown", result["errors"])

    def test_mountinfo_errors_make_known_drive_coverage_partial(self):
        self.drive("sda")
        result = self.collect(["broken\n", record(1, device="/dev/sda", filesystem="ext4")])
        self.assertTrue(result["drives"][0]["partial"])
        self.assertFalse(result["drives"][0]["stale"])

    def test_btrfs_registry_and_symlink_traversals_are_bounded(self):
        self.drive("sda", partitions=("sda1",))
        self.btrfs("single", ["sda1"])
        with patch.object(storage, "MAX_BTRFS_FILESYSTEMS", 0):
            result = self.collect([record(1, device="/dev/sda1")])
        self.assertEqual(result["drives"], [])
        self.assertIn("mounted_storage_sysfs_entry_bound_reached", result["errors"])
        (self.sysfs / "sda1").unlink()
        (self.sysfs / "sda1").symlink_to(self.sysfs / "sda1")
        result = self.collect([record(1, device="/dev/sda1", filesystem="ext4")])
        self.assertEqual(result["drives"], [])
        self.assertIn("mounted_storage_sysfs_symlink_bound_reached", result["errors"])
        self.resolver.reset_mock()
        readlink = storage.os.readlink
        with patch.object(storage.os, "readlink", side_effect=lambda path: (
                "/dev/disk/by-uuid/loop" if str(path).startswith("/dev/") else readlink(path))):
            with self.assertRaises(ValueError):
                storage._resolve_device("/dev/disk/by-uuid/loop")


if __name__ == "__main__":
    unittest.main()
