"""What the desk's music player is playing, read over MPRIS with playerctl.

Kainos Player wins whenever it is open, playing or paused, because it is the user's music
player; otherwise the first player that is actually playing. A short cache keeps the panel
loop from spawning playerctl on every frame. Display-only: any failure reads as nothing playing.
"""

from __future__ import annotations

import shutil
import subprocess
import threading
import time
from typing import Callable
from urllib.parse import unquote, urlparse

CACHE_SECONDS = 2.0
PREFERRED = "kainosplayer"
_FIELDS = "{{status}}\t{{xesam:title}}\t{{artist}}\t{{mpris:artUrl}}"


def _run(args: list[str]) -> str:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=1.5, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout if result.returncode == 0 else ""


def art_path(url: str) -> str | None:
    """A local file behind an mpris:artUrl, or None for remote or missing art."""
    parsed = urlparse(url.strip())
    return unquote(parsed.path) if parsed.scheme == "file" and parsed.path else None


def choose(rows: list[tuple[str, str, str, str, str]]) -> dict | None:
    """Pick one (player, status, title, artist, art) row: Kainos Player first, else the first one playing."""
    usable = [row for row in rows if row[2].strip()]
    preferred = [row for row in usable if row[0].split(".")[0] == PREFERRED and row[1] in ("Playing", "Paused")]
    playing = [row for row in usable if row[1] == "Playing"]
    pick = (preferred or playing or [None])[0]
    if pick is None:
        return None
    player, status, title, artist, art = pick
    return {"player": player, "playing": status == "Playing", "title": title.strip(),
            "artist": artist.strip(), "art": art_path(art)}


class NowPlaying:
    def __init__(self, run: Callable[[list[str]], str] = _run, clock: Callable[[], float] = time.monotonic):
        self.run, self.clock = run, clock
        self._cached: dict | None = None
        self._cached_at: float | None = None
        self._lock = threading.Lock()

    def snapshot(self) -> dict | None:
        with self._lock:
            now = self.clock()
            if self._cached_at is not None and 0 <= now - self._cached_at < CACHE_SECONDS:
                return None if self._cached is None else dict(self._cached)
            self._cached, self._cached_at = self._read(), now
            return None if self._cached is None else dict(self._cached)

    def _read(self) -> dict | None:
        if self.run is _run and shutil.which("playerctl") is None:
            return None
        rows = []
        for player in self.run(["playerctl", "-l"]).split():
            fields = self.run(["playerctl", "-p", player, "metadata", "--format", _FIELDS]).rstrip("\n").split("\t")
            if len(fields) == 4:
                rows.append((player, *fields))
        return choose(rows)
