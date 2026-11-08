"""Runtime-only movie override. Saved dashboards and shell state stay untouched."""
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .frost import FONT_DIR, FACES
from .storage import atomic_write

# Add exact wallpaper paths here to opt more backgrounds into automatic movie mode.
MOVIE_WALLPAPERS = (Path.home() / 'Pictures/Wallpapers/Folio/folio-charcoal-dark.png',)
MOVIE_BRIGHTNESS = 12
MOVIE_INK = '#808080'


class MovieMode:
    def __init__(self, state_dir, wallpaper=None):
        self.override = Path(state_dir) / 'movie-mode'
        self.wallpaper = wallpaper or Path.home() / '.local/state/caelestia/wallpaper/path.txt'
        self.active = False
        self.previous_brightness = None

    def mode(self):
        try:
            value = self.override.read_text().strip()
        except OSError:
            return 'auto'
        return value if value in ('on', 'off', 'auto') else 'auto'

    def set_mode(self, value):
        if value not in ('on', 'off', 'auto'):
            raise ValueError('Movie mode must be on, off or auto')
        atomic_write(self.override, (value + '\n').encode())

    def poll(self):
        mode = self.mode()
        try:
            wallpaper = Path(self.wallpaper.read_text().strip()).expanduser()
            automatic = wallpaper in MOVIE_WALLPAPERS
        except OSError:
            automatic = False
        self.active = mode == 'on' or mode == 'auto' and automatic
        return self.active

    def brightness(self, requested):
        if self.active:
            if self.previous_brightness is None:
                self.previous_brightness = requested
            return MOVIE_BRIGHTNESS
        if self.previous_brightness is not None:
            previous = self.previous_brightness
            self.previous_brightness = None
            return previous
        return requested


def render_movie(now=None, size=(1280, 800)):
    now = now or datetime.now()
    image = Image.new('RGB', size, '#000000')
    draw = ImageDraw.Draw(image)
    for text, pixels, face, y in (
        (now.strftime('%H:%M'), 112, 'thin', size[1] // 2),
        (now.strftime('%A %d %B').replace(' 0', ' '), 23, 'light', size[1] // 2 + 64),
    ):
        font = ImageFont.truetype(str(FONT_DIR / FACES[face]), pixels)
        draw.text((size[0] // 2, y), text, font=font, fill=MOVIE_INK, anchor='mm')
    return image
