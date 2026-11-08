import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from turzx_studio.dashboard_display import DashboardStats
from turzx_studio.now_playing import NowPlaying, choose
import test_sheet as T


def player(lists):
    def run(args):
        if args[1] == "-l":
            return "\n".join(lists) + "\n"
        return lists[args[2]] + "\n"
    return run


class ChooseTests(unittest.TestCase):
    def test_kainos_player_wins_even_paused(self):
        rows = [("chromium.instance1", "Playing", "Video", "Channel", ""),
                ("kainosplayer", "Paused", "Viva La Vida", "Coldplay", "file:///art/cover%201.jpg")]
        self.assertEqual(choose(rows), {"player": "kainosplayer", "playing": False, "title": "Viva La Vida",
                                        "artist": "Coldplay", "art": "/art/cover 1.jpg"})

    def test_otherwise_the_first_player_that_plays(self):
        rows = [("spotify", "Paused", "A", "B", ""), ("chromium.instance1", "Playing", "Video", "Channel", "https://x/y.jpg")]
        self.assertEqual(choose(rows)["player"], "chromium.instance1")
        self.assertIsNone(choose(rows)["art"])

    def test_nothing_playing_and_no_kainos_is_none(self):
        self.assertIsNone(choose([("spotify", "Paused", "A", "B", "")]))
        self.assertIsNone(choose([("kainosplayer", "Stopped", "", "", "")]))

    def test_snapshot_reads_playerctl_and_caches(self):
        calls = []
        lists = {"kainosplayer": "Playing\tViva La Vida\tColdplay\t"}

        def run(args):
            calls.append(args)
            return player(lists)(args) if args[1] == "-l" else lists[args[2]] + "\n"

        now = [0.0]
        reader = NowPlaying(run=run, clock=lambda: now[0])
        self.assertEqual(reader.snapshot()["title"], "Viva La Vida")
        reader.snapshot()
        self.assertEqual(len(calls), 2)
        now[0] = 5.0
        reader.snapshot()
        self.assertEqual(len(calls), 4)


class FogRenderTests(unittest.TestCase):
    def test_now_playing_leads_the_weather_and_the_stack_stays_centred(self):
        rhythm = T.FrostRhythmTests()
        rhythm.setUp()
        base = rhythm.stats()
        weather = T.widget(T.SHEET, "weather")
        quiet = rhythm.renderer.render(T.SHEET, stats=base)
        playing = {"player": "kainosplayer", "playing": True, "title": "Viva La Vida", "artist": "Coldplay", "art": None}
        loud = rhythm.renderer.render(T.SHEET, stats=DashboardStats(base.parent, base.t3_activity, None, playing))
        span = lambda image: T.lit_rows(image, 56, 536, weather["y"], weather["y"] + weather["height"])
        before, after = span(quiet), span(loud)
        # The extra row sits above the temperature: the stack grows upwards past the old top,
        # the weather moves down, and the whole stack stays centred in the widget.
        self.assertLess(after[0], before[0] - 30)
        self.assertGreater(after[-1], before[-1] + 30)
        centre = weather["y"] + weather["height"] / 2
        self.assertAlmostEqual((after[0] + after[-1]) / 2, centre, delta=12)


if __name__ == "__main__":
    unittest.main()
