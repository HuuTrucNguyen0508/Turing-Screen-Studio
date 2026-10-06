"""Local Studio files and last-good Caelestia palette snapshots."""

from __future__ import annotations

from copy import deepcopy
import os
from pathlib import Path
import tempfile
from threading import RLock

from .layout import parse_caelestia_palette

MAX_FILE_BYTES = 1024 * 1024


class Paths:
    def __init__(self, state_dir: str | Path | None = None,
                 runtime_dir: str | Path | None = None) -> None:
        self.state_dir = Path(state_dir).expanduser() if state_dir is not None else (
            Path.home() / ".local/share/turzx-studio"
        )
        if runtime_dir is not None:
            self.runtime_dir = Path(runtime_dir).expanduser()
        elif os.environ.get("XDG_RUNTIME_DIR"):
            self.runtime_dir = Path(os.environ["XDG_RUNTIME_DIR"]) / "turzx-studio"
        else:
            self.runtime_dir = Path(tempfile.gettempdir()) / f"turzx-studio-{os.getuid()}"

    @property
    def layout(self) -> Path:
        return self.state_dir / "layout.json"

    @property
    def older_configs(self) -> Path:
        return self.state_dir / "older-config"

    @property
    def status(self) -> Path:
        return self.runtime_dir / "status.json"

    @property
    def frame(self) -> Path:
        return self.runtime_dir / "frame.png"


def atomic_write(path: str | Path, data: bytes) -> None:
    """Replace a file with flushed bytes, keeping both temp and final files private.

    A failed write or replace leaves the previous destination intact. The temp
    file lives beside its destination so replacement stays on one filesystem.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class PaletteWatcher:
    """Poll a scheme file and return the last valid palette on every call."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).expanduser()
        self._lock = RLock()
        self._palette: dict | None = None
        self._error: str | None = None
        self._signature: tuple[int, int, int] | None = None

    @property
    def error(self) -> str | None:
        with self._lock:
            return self._error

    def poll(self) -> dict | None:
        with self._lock:
            try:
                info = self.path.stat()
                signature = (info.st_ino, info.st_mtime_ns, info.st_size)
                if signature == self._signature:
                    return deepcopy(self._palette)
                if not self.path.is_file():
                    raise ValueError("expected a regular scheme JSON file")
                if info.st_size > MAX_FILE_BYTES:
                    raise ValueError("scheme exceeds the 1 MB file limit")
                with self.path.open("rb") as stream:
                    data = stream.read(MAX_FILE_BYTES + 1)
                if len(data) > MAX_FILE_BYTES:
                    raise ValueError("scheme exceeds the 1 MB file limit")
                palette = parse_caelestia_palette(data.decode("utf-8"))
            except (OSError, ValueError) as error:
                # Retry failures even if a producer rewrites metadata in place.
                self._signature = None
                self._error = f"Cannot load Caelestia scheme {self.path}: {error}"
                return deepcopy(self._palette)
            self._palette = palette
            self._signature = signature
            self._error = None
            return deepcopy(self._palette)
