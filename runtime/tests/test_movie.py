from datetime import datetime
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageChops
from turzx_studio.movie import MovieMode, MOVIE_WALLPAPERS, render_movie
from turzx_studio.frost import ShellStyle, FACES
from turzx_studio.storage import PaletteWatcher
from turzx_studio.renderer import LayoutRenderer
from turzx_studio.design import resolve_elements

ROOT = Path(__file__).parents[2]


class MovieTests(unittest.TestCase):
    def test_auto_and_manual_modes_follow_wallpaper_without_restart(self):
        with TemporaryDirectory() as temp:
            root = Path(temp)
            wallpaper = root / 'wallpaper'
            movie = MovieMode(root, wallpaper)
            self.assertFalse(movie.poll())
            wallpaper.write_text(str(MOVIE_WALLPAPERS[0]) + '\n')
            self.assertTrue(movie.poll())
            self.assertEqual(movie.brightness(73), 12)
            movie.set_mode('off')
            self.assertFalse(movie.poll())
            self.assertEqual(movie.brightness(73), 73)
            movie.set_mode('auto')
            self.assertTrue(movie.poll())
            wallpaper.write_text('/walls/other.png')
            self.assertFalse(movie.poll())
            movie.set_mode('on')
            self.assertTrue(MovieMode(root, wallpaper).poll())
            with self.assertRaises(ValueError):
                movie.set_mode('invalid')

    def test_movie_pixels_are_black_and_grey_and_stable_within_minute(self):
        a = render_movie(datetime(2026, 11, 8, 22, 10, 1))
        b = render_movie(datetime(2026, 11, 8, 22, 10, 59))
        self.assertIsNone(ImageChops.difference(a, b).getbbox())
        self.assertIsNotNone(ImageChops.difference(a, render_movie(datetime(2026, 11, 8, 22, 11))).getbbox())
        colors = a.getcolors(a.width * a.height)
        self.assertTrue(all(r == g == b and r <= 128 for _, (r, g, b) in colors))
        self.assertEqual(a.getpixel((0, 0)), (0, 0, 0))
        maximum = max(color[0] for _, color in colors)
        luminance = ((maximum / 255 + .055) / 1.055) ** 2.4
        self.assertGreaterEqual((luminance + .05) / .05, 4.5)
        self.assertLess(a.getbbox()[2], 1280)

    def test_frost_sheet_keeps_faces_glyphs_and_fits_clock_off_style(self):
        doc = json.loads((ROOT / 'layouts/frost-sheet.json').read_text())
        with TemporaryDirectory() as temp:
            root = Path(temp)
            wallpaper, manifest = root / 'wall', root / 'manifest'
            wallpaper.write_text('/walls/other.png')
            manifest.write_text('{"wallpapers": []}')
            style = ShellStyle(wallpaper, manifest)
            self.assertFalse(style.active())
            scheme = root / 'scheme.json'
            scheme.write_text(json.dumps({'name': 'dynamic', 'mode': 'dark', 'colours': {
                'background': '0e0e0e', 'surfaceContainer': '1a1a1a', 'surfaceContainerHigh': '202020',
                'onSurface': 'e5e5e5', 'onSurfaceVariant': 'ababab', 'primary': 'c6c6c6',
                'secondary': '9d9d9d', 'outlineVariant': '484848'}}))
            palette = PaletteWatcher(scheme, style).poll()
            self.assertNotEqual(palette['name'], 'frost')
            renderer = LayoutRenderer()
            frame = renderer.render(doc, palette=palette)
            self.assertIsNotNone(renderer._fonts.get(('icon', 34, True)))
            self.assertEqual(frame.size, (1280, 800))
            self.assertTrue(renderer._frost)
            self.assertEqual(Path(renderer._font('sans', 17).path).name, FACES['regular'])
            self.assertEqual(Path(renderer._font('mono', 176).path).name, FACES['thin'])
            clock = next(w for w in doc['widgets'] if w['type'] == 'clock')
            slab = next(w for w in doc['widgets'] if w.get('frame') == 'glass')
            self.assertLessEqual(clock['x'] + clock['width'], slab['x'])
            # Force a face much wider than Fira too; actual ink must remain inside the column.
            from PIL import ImageFont
            for fallback in (False, True):
                renderer._ink_spans.clear()
                context = patch.object(renderer, '_font', side_effect=lambda family, size: ImageFont.truetype('DejaVuSansMono.ttf', size)) if fallback else patch.object(renderer, '_frost', True)
                with context:
                    for time in ('02:20', '23:59', '11:11'):
                        clock['settings']['time'] = time
                        image = Image.new('RGB', (clock['width'], clock['height']))
                        renderer._designed_text(ImageDraw.Draw(image), resolve_elements(clock), doc['palette'])
                        bbox = image.getbbox()
                        self.assertGreater(bbox[0], 0)
                        self.assertLess(bbox[2], image.width)
                        self.assertLess(bbox[3], image.height)
