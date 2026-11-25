"""The ground behind the panel, made from the shell's live wallpaper: Frost's fog, a
blurred and toned crop, or Nyx's sky (mode "nyx"), the art behind the panel's grid.

The panel cannot blur live, so the ground is made once per wallpaper, mode and
canvas size, kept on disk and reused for every frame. Any failure returns None
and the renderer falls back to the flat background colour.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
import threading

from PIL import Image, ImageFilter

from .nyx import NYX, SKY_RECIPE, make_sky

# Bump when the recipe changes so cached grounds are rebuilt.
RECIPE = 1
# The crop shows the upper part of the wallpaper (fog and the first ridge): the
# largest window with the canvas's aspect, zoomed in by ZOOM, centred horizontally.
ZOOM = 1.625
BLUR = 22
# out = in * scale + lift, plus a lean on the blue channel (Frost's dark ground is #141518).
TONES = {"dark": (0.40, 6.0, 2.0), "light": (0.55, 115.0, 0.0)}
CACHE_FILES = 8


def make_ground(source: Path, size: tuple[int, int], mode: str) -> Image.Image:
    width, height = size
    scale, lift, blue = TONES[mode]
    with Image.open(source) as raw:
        image = raw.convert("RGB")
    crop_w, crop_h = image.width, image.width * height / width
    if crop_h > image.height:
        crop_w, crop_h = image.height * width / height, image.height
    crop_w, crop_h = round(crop_w / ZOOM), round(crop_h / ZOOM)
    left = (image.width - crop_w) // 2
    image = image.crop((left, 0, left + crop_w, crop_h)).resize(size, Image.LANCZOS)
    image = image.filter(ImageFilter.GaussianBlur(BLUR))
    tone = [min(255, max(0, int(value * scale + lift + extra)))
            for extra in (0, 0, blue) for value in range(256)]
    return image.point(tone)


class WallpaperGround:
    """Callable ground provider for LayoutRenderer: (size, mode) -> RGB image or None.
    Mode is "dark" or "light" for Frost's fog, NYX for Nyx's sky."""

    def __init__(self, wallpaper_state: Path | None = None, cache_dir: Path | None = None) -> None:
        home = Path.home()
        self.wallpaper_state = wallpaper_state or home / ".local/state/caelestia/wallpaper/path.txt"
        cache_home = Path(os.environ.get("XDG_CACHE_HOME") or home / ".cache")
        self.cache_dir = cache_dir or cache_home / "turzx-studio/ground"
        self._lock = threading.Lock()
        self._memo: tuple[tuple, Image.Image | None] | None = None

    def _source(self) -> tuple[Path, tuple] | None:
        try:
            current = self.wallpaper_state.read_text(encoding="utf-8").strip()
            if not current:
                return None
            path = Path(current)
            info = path.stat()
        except (OSError, ValueError):
            return None
        if not stat.S_ISREG(info.st_mode):
            return None
        return path, (str(path), info.st_dev, info.st_ino, info.st_mtime_ns, info.st_size)

    def signature(self) -> tuple | None:
        source = self._source()
        return None if source is None else source[1]

    def __call__(self, size: tuple[int, int], mode: str) -> Image.Image | None:
        source = self._source()
        if source is None or (mode not in TONES and mode != NYX):
            return None
        path, identity = source
        key = (identity, tuple(size), mode)
        with self._lock:
            if self._memo is not None and self._memo[0] == key:
                return self._memo[1]
            image = self._load(path, key)
            self._memo = key, image
            return image

    def _load(self, path: Path, key: tuple) -> Image.Image | None:
        recipe = (RECIPE, SKY_RECIPE) if key[2] == NYX else RECIPE
        name = hashlib.sha256(repr((recipe, key)).encode()).hexdigest()[:24] + ".png"
        cached = self.cache_dir / name
        try:
            with Image.open(cached) as stored:
                if stored.size == key[1]:
                    return stored.convert("RGB")
        except (OSError, ValueError):
            pass
        try:
            image = make_sky(path, key[1]) if key[2] == NYX else make_ground(path, key[1], key[2])
        except (OSError, ValueError, Image.DecompressionBombError):
            return None
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            temporary = cached.with_suffix(f".{os.getpid()}.tmp")
            image.save(temporary, format="PNG")
            os.replace(temporary, cached)
            stale = sorted(self.cache_dir.glob("*.png"), key=lambda item: item.stat().st_mtime, reverse=True)
            for old in stale[CACHE_FILES:]:
                old.unlink(missing_ok=True)
        except OSError:
            # The in-memory copy still serves this process.
            pass
        return image
