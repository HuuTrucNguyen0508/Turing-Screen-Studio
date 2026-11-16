"""How busy each block device is: the share of wall time it had I/O in flight, from /proc/diskstats."""
from __future__ import annotations
import os
import time
from pathlib import Path
from typing import Callable


def read_io_ticks(path: Path) -> dict[str, int]:
    """Milliseconds each device has spent doing I/O since boot, by kernel name (sda, nvme0n1p2, dm-0)."""
    ticks = {}
    for line in path.read_text().splitlines()[:4096]:
        fields = line.split()
        if len(fields) >= 13 and fields[12].isdigit():
            ticks[fields[2]] = int(fields[12])
    return ticks


def kernel_name(device: object) -> str | None:
    """The diskstats name for a device path; /dev/mapper links resolve to their dm-N node."""
    if not isinstance(device, str) or not device.startswith('/dev/'):
        return None
    return os.path.basename(os.path.realpath(device))


class DiskActivity:
    """Busy percentages over the last window of at least `window` seconds.

    The first sample has no previous reading, so every device is unknown until the window elapses.
    """

    def __init__(self, path: Path | str = '/proc/diskstats', clock: Callable[[], float] = time.monotonic, window: float = 1.0):
        self.path = Path(path)
        self.clock = clock
        self.window = window
        self._base: tuple[float, dict[str, int]] | None = None
        self._busy: dict[str, float] = {}

    def sample(self) -> dict[str, float]:
        now = self.clock()
        if self._base is not None and now - self._base[0] < self.window:
            return self._busy
        try:
            ticks = read_io_ticks(self.path)
        except OSError:
            self._base, self._busy = None, {}
            return self._busy
        if self._base is not None:
            then, previous = self._base
            elapsed = (now - then) * 1000
            self._busy = {name: min(100.0, max(0.0, (value - previous[name]) / elapsed * 100))
                          for name, value in ticks.items() if name in previous}
        self._base = (now, ticks)
        return self._busy

    def annotate(self, storage: object) -> tuple:
        """Add busyPercent to each mount and drive row in place; return the rounded values for the frame key."""
        busy = self.sample()
        shown = []
        if isinstance(storage, dict):
            for kind in ('mounts', 'drives'):
                for row in storage.get(kind) or []:
                    if isinstance(row, dict):
                        row['busyPercent'] = busy.get(kernel_name(row.get('device')))
                        shown.append(None if row['busyPercent'] is None else round(row['busyPercent']))
        return tuple(shown)
