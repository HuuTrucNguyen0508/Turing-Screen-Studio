"""Read changed layout files without replacing the last valid document."""

from __future__ import annotations

from copy import deepcopy
import os
from pathlib import Path
import stat
from threading import RLock

from .layout import parse_layout, revision

MAX_LAYOUT_BYTES = 1024 * 1024


def _signature(info: os.stat_result) -> tuple[int, int, int]:
    return info.st_size, info.st_mtime_ns, info.st_ino


class LayoutWatcher:
    """Poll on demand. Returns a snapshot only when valid content changes.

    Accessors return detached snapshots, protected by the same lock as poll.
    Invalid or missing files keep the last valid document and revision. A
    failed parse is retried only after file metadata changes. No files are
    written, and no background thread or logging handler is created.
    """

    def __init__(self, path: str | Path, *, panel: bool = False) -> None:
        self.path = Path(path)
        self.panel = panel
        self._lock = RLock()
        self._document: dict | None = None
        self._revision: str | None = None
        self._error: str | None = None
        self._cached_stat: tuple[int, int, int] | None = None

    @property
    def document(self) -> dict | None:
        with self._lock:
            return deepcopy(self._document)

    @property
    def revision(self) -> str | None:
        with self._lock:
            return self._revision

    @property
    def error(self) -> str | None:
        with self._lock:
            return self._error

    def poll(self) -> dict | None:
        with self._lock:
            try:
                info = self.path.stat()
            except FileNotFoundError:
                self._cached_stat = None
                self._error = f"Layout file not found: {self.path}. Save a layout JSON file at this path."
                return None
            except OSError as error:
                self._cached_stat = None
                self._error = f"Cannot read layout {self.path}: {error}"
                return None
            signature = _signature(info)
            if signature == self._cached_stat:
                return None
            self._cached_stat = signature
            try:
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("expected a regular JSON file")
                if info.st_size > MAX_LAYOUT_BYTES:
                    raise ValueError("layout exceeds the 1 MB file limit")
                # A replacement FIFO must not block between stat and open.
                with os.fdopen(os.open(self.path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if not stat.S_ISREG(opened.st_mode):
                        self._cached_stat = None
                        raise ValueError("expected a regular JSON file")
                    if _signature(opened) != signature:
                        self._cached_stat = None
                        raise ValueError("layout changed while opening; retrying on next poll")
                    data = stream.read(MAX_LAYOUT_BYTES + 1)
                    finished = os.fstat(stream.fileno())
                if len(data) > MAX_LAYOUT_BYTES:
                    raise ValueError("layout exceeds the 1 MB file limit")
                if _signature(finished) != signature or _signature(self.path.stat()) != signature:
                    self._cached_stat = None
                    raise ValueError("layout changed while reading; retrying on next poll")
                document = parse_layout(data.decode("utf-8"), panel=self.panel)
                content_revision = revision(document)
            except OSError as error:
                self._cached_stat = None
                self._error = f"Cannot load layout {self.path}: {error}"
                return None
            except ValueError as error:
                self._error = f"Cannot load layout {self.path}: {error}"
                return None
            self._error = None
            if content_revision == self._revision:
                return None
            self._document = document
            self._revision = content_revision
            return deepcopy(document)
