"""Preserve replaced layouts and the original dashboard before activation."""

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile

from .layout import parse_layout, revision
from .storage import Paths, atomic_write

ARCHIVE_ID = re.compile(r"[0-9]{8}T[0-9]{12}Z-[0-9a-f]{12}\Z")


def _read_regular(path: Path, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Archive entries must be regular files')
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Archive entry exceeds its file size limit')
    return data


@contextmanager
def layout_write_lock(paths: Paths):
    """Serialize the revision check, archive, and replacement across servers."""
    paths.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(paths.state_dir / '.layout.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def archive_layout(paths: Paths, data: bytes, reason: str = 'panel-save') -> dict:
    """Commit exact previous bytes and metadata before replacing a layout."""
    document = parse_layout(data.decode('utf-8'), panel=True)
    timestamp = datetime.now(timezone.utc)
    identifier = timestamp.strftime('%Y%m%dT%H%M%S%fZ') + '-' + revision(document)[:12]
    root = paths.older_configs
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = Path(tempfile.mkdtemp(prefix='.layout-', dir=root))
    metadata = {'id': identifier, 'name': document['name'], 'revision': revision(document),
                'createdAt': timestamp.isoformat(), 'reason': reason,
                'sha256': hashlib.sha256(data).hexdigest()}
    try:
        atomic_write(temporary / 'layout.json', data)
        atomic_write(temporary / 'manifest.json', (json.dumps(metadata, indent=2) + '\n').encode())
        temporary.rename(root / identifier)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return metadata


def read_archive(paths: Paths, identifier: str) -> dict:
    if not isinstance(identifier, str) or not ARCHIVE_ID.fullmatch(identifier):
        raise ValueError('Invalid archived layout ID')
    directory = paths.older_configs / identifier
    # Fixed private paths only; never follow an archive outside older-config.
    if directory.is_symlink() or directory.resolve().parent != paths.older_configs.resolve():
        raise ValueError('Archived layout must remain inside older-config')
    path = directory / 'layout.json'
    if path.is_symlink():
        raise ValueError('Archived layout must be a regular JSON file under 1 MB')
    data = _read_regular(path, 1024 * 1024)
    metadata = json.loads(_read_regular(directory / 'manifest.json', 4096))
    if not isinstance(metadata, dict) or metadata.get('sha256') != hashlib.sha256(data).hexdigest():
        raise ValueError('Archived layout checksum does not match; preserve the archive and inspect it before restoring')
    document = parse_layout(data.decode('utf-8'), panel=True)
    return {'document': document, 'revision': revision(document)}


def list_archives(paths: Paths) -> list[dict]:
    result = []
    if not paths.older_configs.exists():
        return result
    for directory in sorted(paths.older_configs.iterdir(), reverse=True):
        if not ARCHIVE_ID.fullmatch(directory.name) or directory.is_symlink():
            continue
        try:
            manifest = directory / 'manifest.json'
            metadata = json.loads(_read_regular(manifest, 4096))
            if not isinstance(metadata, dict) or metadata.get('id') != directory.name:
                continue
            result.append({key: metadata[key] for key in ('id', 'name', 'revision', 'createdAt', 'reason')})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return result


def snapshot_original_dashboard(paths: Paths, live: Path, config: Path,
                                driver: Path | None = None, settings: Path | None = None) -> Path:
    """Save source/config once; environments, caches, logs and captures stay out."""
    destination = paths.older_configs / 'original-dashboard'
    with layout_write_lock(paths):
        if destination.exists():
            required = ('manifest.json', 'dashboard/dashboard.py', 'service/turzx-dashboard.service')
            if destination.is_symlink() or any(not (destination / name).is_file() or
                    (destination / name).is_symlink() for name in required):
                raise OSError('Original dashboard archive is incomplete; preserve it and repair before activation')
            return destination
        if not (live / 'dashboard.py').is_file() or not (config / 'turzx-dashboard.service').is_file():
            raise OSError('Original dashboard source and service are required before activation')
        paths.older_configs.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = Path(tempfile.mkdtemp(prefix='.original-', dir=paths.older_configs))
        try:
            source = temporary / 'dashboard'
            source.mkdir(mode=0o700)
            for path in sorted(live.iterdir()):
                if path.is_file() and not path.is_symlink() and (
                        path.suffix == '.py' or path.name in ('requirements.txt', 'run-dashboard.sh')):
                    shutil.copy2(path, source / path.name)
                    os.chmod(source / path.name, 0o600)
            service = temporary / 'service'
            service.mkdir(mode=0o700)
            shutil.copy2(config / 'turzx-dashboard.service', service / 'turzx-dashboard.service')
            dropins = config / 'turzx-dashboard.service.d'
            if dropins.is_dir():
                for path in dropins.glob('*.conf'):
                    if path.name != 'turzx-studio.conf' and not path.is_symlink():
                        shutil.copy2(path, service / path.name)
            if driver is not None and driver.is_file():
                shutil.copy2(driver, temporary / 'lcd_comm_turing_usb.py')
            if settings is not None and settings.is_file():
                shutil.copy2(settings, temporary / 'config.json')
            if paths.layout.exists():
                atomic_write(temporary / 'studio-layout-at-snapshot.json', paths.layout.read_bytes())
            manifest = {'createdAt': datetime.now(timezone.utc).isoformat(),
                        'source': str(live), 'service': 'turzx-dashboard.service',
                        'restoreCommand': 'pnpm panel:rollback',
                        'description': 'Original dashboard source, USB driver, settings and service configuration. Python environment is reused from the original installation.'}
            atomic_write(temporary / 'manifest.json', (json.dumps(manifest, indent=2) + '\n').encode())
            temporary.rename(destination)
        finally:
            if temporary.exists():
                shutil.rmtree(temporary)
    return destination
