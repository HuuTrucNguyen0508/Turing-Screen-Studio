from copy import deepcopy
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PIL import Image, ImageChops

from turzx_studio import nyx
from turzx_studio.frost import PALETTES as FROST, ShellStyle
from turzx_studio.ground import WallpaperGround
from turzx_studio.integration import RuntimeIntegration
from turzx_studio.layout import parse_layout, serialize_layout
from turzx_studio.renderer import LayoutRenderer
from turzx_studio.storage import Paths, PaletteWatcher, atomic_write

ROOT = Path(__file__).resolve().parents[2]
SCHEME = {"name": "dynamic", "mode": "dark", "colours": {
    "background": "0e0e0e", "surfaceContainer": "1a1a1a", "surfaceContainerHigh": "202020",
    "onSurface": "e5e5e5", "onSurfaceVariant": "ababab", "primary": "c6c6c6",
    "secondary": "9d9d9d", "outlineVariant": "484848"}}
FROST_WALL, NYX_WALL = "/walls/frost.jpg", "/walls/nyx.png"
SHEET = json.loads((ROOT / "layouts/frost-sheet.json").read_text())


def touch(path: Path) -> None:
    # Same-second rewrites must still invalidate cached palettes.
    stamp = path.stat().st_mtime_ns + 1_000_000_000
    os.utime(path, ns=(stamp, stamp))


class Shell:
    """A scheme, a wallpaper and both style manifests in a temporary directory."""

    def __init__(self, root: Path) -> None:
        self.scheme, self.wallpaper = root / "scheme.json", root / "path.txt"
        self.frost, self.nyx = root / "frost.json", root / "nyx.json"
        self.frost.write_text(json.dumps({"id": "frost", "wallpapers": [FROST_WALL]}))
        self.nyx.write_text(json.dumps({"id": "nyx", "wallpapers": [NYX_WALL]}))
        self.set_mode("dark")
        self.set_wallpaper(NYX_WALL)

    def watcher(self) -> PaletteWatcher:
        return PaletteWatcher(self.scheme, ShellStyle(self.wallpaper, self.frost),
                              ShellStyle(self.wallpaper, self.nyx, style=nyx.NYX))

    def set_mode(self, mode: str) -> None:
        self.scheme.write_text(json.dumps({**SCHEME, "mode": mode}))
        touch(self.scheme)

    def set_wallpaper(self, path: str) -> None:
        self.wallpaper.write_text(path + "\n")
        touch(self.wallpaper)


class NyxSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.shell = Shell(Path(self.temp.name))
        self.watcher = self.shell.watcher()

    def tearDown(self):
        self.temp.cleanup()

    def test_claimed_wallpaper_in_dark_mode_uses_nyx(self):
        self.assertEqual(self.watcher.poll(), nyx.PALETTE)

    def test_light_mode_pairs_nyx_with_frost_light(self):
        self.shell.set_mode("light")
        self.assertEqual(self.watcher.poll(), FROST["light"])
        self.shell.set_mode("dark")
        self.assertEqual(self.watcher.poll()["name"], nyx.NYX)

    def test_unclaimed_wallpapers_follow_frost_or_caelestia(self):
        self.shell.set_wallpaper(FROST_WALL)
        self.assertEqual(self.watcher.poll(), FROST["dark"])
        self.shell.set_wallpaper("/walls/folio.jpg")
        self.assertEqual(self.watcher.poll()["name"], "dynamic")

    def test_unreadable_nyx_manifest_falls_back_to_caelestia(self):
        self.shell.nyx.write_text("{not json")
        self.assertEqual(self.watcher.poll()["name"], "dynamic")
        self.assertIsNone(self.watcher.error)

    def test_style_names_its_own_manifest(self):
        self.assertEqual(ShellStyle(style=nyx.NYX).manifest.parts[-2:], ("nyx", "style.json"))
        self.assertEqual(ShellStyle().manifest.parts[-2:], ("frost", "style.json"))


def wallpaper(path: Path) -> Path:
    """A shell-style wallpaper: 5 px cells of varied art behind a 1 px black grid."""
    art = Image.new("RGB", (400, 200))
    art.putdata([(40 + x % 200, 30 + y, 120 + (x * y) % 120) for y in range(200) for x in range(400)])
    image = art.resize((2000, 1000), Image.NEAREST)
    for x in range(0, 2000, 5):
        image.paste((0, 0, 0), (x, 0, x + 1, 1000))
    for y in range(4, 1000, 5):
        image.paste((0, 0, 0), (0, y, 2000, y + 1))
    image.save(path)
    return path


class NyxLatticeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        state = root / "path.txt"
        state.write_text(str(wallpaper(root / "wall.png")))
        self.ground = WallpaperGround(state, root / "cache")

    def tearDown(self):
        self.temp.cleanup()

    def test_sky_lines_are_whole_pixels_on_the_8px_lattice(self):
        sky = self.ground((1280, 800), nyx.NYX)
        pixels = sky.load()
        for y in range(800):
            for x in range(1280):
                if nyx.on_line(x, y):
                    self.assertEqual(pixels[x, y], (0, 0, 0), (x, y))
        # Inside a cell the art is one flat colour, with none of the wallpaper's own lines.
        for column, row in ((0, 0), (37, 21), (159, 99)):
            cell = sky.crop((column * 8 + 2, row * 8, column * 8 + 8, row * 8 + 6))
            self.assertEqual(len(cell.getcolors()), 1)
            self.assertNotEqual(cell.getpixel((0, 0)), (0, 0, 0))

    def test_wire_frame_keeps_each_cell_in_one_jpeg_block(self):
        # The driver rotates 270 degrees before encoding: lines must stay on block edges.
        wire = self.ground((1280, 800), nyx.NYX).transpose(Image.Transpose.ROTATE_270)
        self.assertEqual(wire.size, (800, 1280))
        pixels = wire.load()
        for y in range(1280):
            for x in range(800):
                if x % 8 < 2 or y % 8 < 2:
                    self.assertEqual(pixels[x, y], (0, 0, 0), (x, y))
        # Every 8 x 8 block of the wire frame holds the lit part of exactly one cell.
        for bx, by in ((0, 0), (400, 640), (792, 1272)):
            block = wire.crop((bx, by, bx + 8, by + 8))
            self.assertEqual(len([color for _, color in block.getcolors() if color != (0, 0, 0)]), 1)

    def test_replaced_wallpaper_with_same_size_and_timestamp_invalidates_the_sky(self):
        source = Path(self.ground.wallpaper_state.read_text())
        root = source.parent
        original = self.ground((1280, 800), nyx.NYX)
        signature = self.ground.signature()
        changed = root / "next.png"
        data = source.read_bytes()
        Image.new("RGB", (2000, 1000), "red").save(changed)
        with changed.open("ab") as stream:
            stream.truncate(len(data))
        stamp = source.stat().st_mtime_ns
        os.utime(changed, ns=(stamp, stamp))
        changed.replace(source)
        self.assertNotEqual(self.ground.signature(), signature)
        updated = self.ground((1280, 800), nyx.NYX)
        self.assertEqual(updated.getpixel((2, 0)), (255, 0, 0))
        self.assertIsNotNone(ImageChops.difference(original, updated).getbbox())
        self.assertIs(updated, self.ground((1280, 800), nyx.NYX))

    def test_tiny_claimed_art_still_builds_a_sky(self):
        source = Path(self.ground.wallpaper_state.read_text())
        Image.new("RGB", (1, 3), "red").save(source)
        sky = self.ground((1280, 800), nyx.NYX)
        self.assertEqual(sky.getpixel((0, 0)), (0, 0, 0))
        self.assertEqual(sky.getpixel((2, 0)), (255, 0, 0))

    def test_frost_fog_ignores_the_nyx_recipe(self):
        self.assertIsNotNone(self.ground((320, 200), "dark"))
        self.assertIsNone(self.ground((320, 200), "sepia"))

    def test_nyx_frame_keeps_the_grid_through_the_cut_clock_and_meters(self):
        frame = LayoutRenderer(ground=self.ground).render(SHEET, stats=None, palette=nyx.PALETTE)
        pixels = frame.load()
        # The clock is frameless: its type is cut by the grid, so every line pixel above the date
        # chip stays black (the chip is a slab, which lets the grid through at 8%).
        for y in range(55, 250):
            for x in range(56, 536):
                if nyx.on_line(x, y):
                    self.assertEqual(pixels[x, y], (0, 0, 0), (x, y))
        # The clock adds light to the sky inside its cells.
        lit = sum(1 for y in range(120, 230) for x in range(64, 520) if sum(pixels[x, y]) > 600)
        self.assertGreater(lit, 2000)

    def test_meter_lights_whole_cells_and_turns_rose_past_ninety_percent(self):
        card = Image.new("RGB", (200, 40))
        nyx.paint_meter(card, (588, 105), 0, 184, 8, .95)
        lit = {card.getpixel((x, y)) for y in range(40) for x in range(200)} - {(0, 0, 0)}
        self.assertIn(nyx.mix(nyx.PALETTE["primary"], nyx.ROSE, (21 + .5) / 22), lit)
        for y in range(40):
            for x in range(200):
                if nyx.on_line(588 + x, 105 + y):
                    self.assertEqual(card.getpixel((x, y)), (0, 0, 0), (x, y))
        cool = Image.new("RGB", (200, 40))
        nyx.paint_meter(cool, (588, 105), 0, 184, 8, .5)
        colors = {cool.getpixel((x, y)) for y in range(40) for x in range(200)}
        self.assertNotIn(nyx.mix(nyx.PALETTE["primary"], nyx.ROSE, 1), colors)
        self.assertEqual(len(nyx.meter_cells(588, 772)), 23)


class NyxFallbackTests(unittest.TestCase):
    def test_frost_light_palette_renders_frost_even_with_the_nyx_wallpaper(self):
        renderer = LayoutRenderer()
        renderer.render(SHEET, palette=FROST["light"])
        self.assertTrue(renderer._frost)
        self.assertFalse(renderer._nyx)
        renderer.render(SHEET, palette=nyx.PALETTE)
        self.assertTrue(renderer._nyx)

    def test_without_rubik_nyx_falls_back_to_the_sheet_faces(self):
        with patch.object(nyx, "FONTS", (Path("/missing/Rubik.ttf"),)):
            frame = LayoutRenderer().render(SHEET, stats=None, palette=nyx.PALETTE)
        self.assertEqual(frame.size, (1280, 800))


class NyxWidgetTests(unittest.TestCase):
    def test_compact_weather_draws_inside_its_saved_box(self):
        doc = deepcopy(SHEET)
        widget = next(w for w in doc["widgets"] if w["type"] == "weather")
        widget.update(x=59, y=315, width=160, height=104)
        # The sheet next to it reaches below the weather widget.
        without_weather = {**doc, "widgets": [w for w in doc["widgets"] if w is not widget]}
        renderer = LayoutRenderer()
        before = renderer.render(without_weather, palette=nyx.PALETTE)
        after = renderer.render(doc, palette=nyx.PALETTE)
        left, top, right, bottom = ImageChops.difference(before, after).getbbox()
        self.assertGreaterEqual(left, 59)
        self.assertGreaterEqual(top, 315)
        self.assertLessEqual(right, 219)
        self.assertLessEqual(bottom, 419)

    def test_date_nudge_and_alignment_move_the_preview_ink(self):
        doc = deepcopy(SHEET)
        clock = next(w for w in doc["widgets"] if w["type"] == "clock")
        doc["widgets"] = [clock]
        clock["design"]["elements"]["time"]["hidden"] = True
        date = clock["design"]["elements"]["date"]
        date.update(dx=8, color="#ff0000")
        renderer = LayoutRenderer()

        def date_left():
            frame = renderer.render(doc, palette=nyx.PALETTE)
            red_only = ImageChops.subtract(frame.getchannel("R"), frame.getchannel("G"))
            return red_only.point(lambda x: 255 if x > 128 else 0).getbbox()[0]

        original = date_left()
        date["dx"] += 1
        self.assertEqual(date_left(), original + 1)
        date.update(align="end", dx=0)
        self.assertGreater(date_left(), original + 64)

    def test_explicit_time_ink_keeps_its_color_and_the_lattice(self):
        doc = deepcopy(SHEET)
        clock = next(w for w in doc["widgets"] if w["type"] == "clock")
        doc["widgets"] = [clock]
        clock["design"]["elements"]["time"]["color"] = "#ff0000"
        clock["design"]["elements"]["date"]["hidden"] = True
        frame = LayoutRenderer().render(doc, palette=nyx.PALETTE)
        self.assertIsNone(frame.getchannel("G").getbbox())
        self.assertIsNone(frame.getchannel("B").getbbox())
        self.assertTrue(any(color == (255, 0, 0) for _, color in frame.getcolors()))
        for y in range(55, 250):
            for x in range(56, 536):
                if nyx.on_line(x, y):
                    self.assertEqual(frame.getpixel((x, y)), (0, 0, 0))


class LegacyRenderer:
    def __init__(self, font_dir, palette):
        self.palette = palette

    def render(self, stats):
        return Image.new("RGB", (1280, 800), "red")


class NyxMovieTests(unittest.TestCase):
    def test_movie_mode_wins_over_nyx(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            shell = Shell(root)
            paths = Paths(state_dir=root / "state", runtime_dir=root / "run")
            atomic_write(paths.layout, serialize_layout(parse_layout(json.dumps(SHEET))).encode())
            owner = RuntimeIntegration(paths, root / "missing-scheme")
            owner.movie_backlight.update = Mock()
            owner.scheme = shell.watcher()
            owner.movie.wallpaper = root / "movie-wallpaper"
            owner.movie.shell_flag = root / "movie.json"
            owner.ground.wallpaper_state = root / "missing-wallpaper"
            dashboard = SimpleNamespace(DashboardRenderer=LegacyRenderer, logical_dirty_key=lambda *a, **kw: "same",
                                        try_lcd_write=lambda *a: (True, 50), open_lcd=lambda: object(),
                                        SchemeWatcher=type("Scheme", (), {"poll": lambda s: s.palette}))
            owner.install(dashboard, SimpleNamespace(send_image=None, send_jpeg=None, _resp_ok=lambda r: True))
            renderer = dashboard.DashboardRenderer(None, palette=object())
            dashboard.logical_dirty_key(view="stats")
            self.assertEqual(owner.palette["name"], nyx.NYX)
            nyx_frame = renderer.render(None)
            self.assertTrue(owner.rendered_layout)
            owner.movie.set_mode("on")
            movie = Image.new("RGB", (1280, 800), "black")
            with patch("turzx_studio.integration.render_movie", return_value=movie) as render_movie:
                dashboard.logical_dirty_key(view="stats")
                self.assertIs(renderer.render(None), movie)
            render_movie.assert_called_once()
            self.assertNotEqual(nyx_frame.tobytes(), movie.tobytes())


if __name__ == "__main__":
    unittest.main()
