from pathlib import Path
import tempfile
import unittest

from turzx_studio.disk_activity import DiskActivity


def diskstats(**ticks):
    # major minor name, then ten counters; io_ticks is the tenth.
    return ''.join(f'   8       0 {name} 1 0 8 1 1 0 8 1 0 {value} {value}\n' for name, value in ticks.items())


class DiskActivityTests(unittest.TestCase):
    def setUp(self):
        self.path = Path(tempfile.mkdtemp()) / 'diskstats'
        self.now = 100.0
        self.activity = DiskActivity(self.path, clock=lambda: self.now)

    def test_busy_share_of_the_window_per_partition_with_unknown_first_sample(self):
        self.path.write_text(diskstats(sda2=1000, nvme0n1p3=5000))
        storage = {'mounts': [{'mount': '/', 'device': '/dev/sda2'}, {'mount': '/mnt/games', 'device': '/dev/nvme0n1p3'},
                              {'mount': '/mnt/gone', 'device': '/dev/sdz9'}],
                   'drives': [{'mount': 'SSD', 'device': '/dev/sda'}]}
        self.assertEqual(self.activity.annotate(storage), (None, None, None, None))
        self.now += 2
        self.path.write_text(diskstats(sda2=1250, nvme0n1p3=9000))
        self.assertEqual(self.activity.annotate(storage), (12, 100, None, None))
        self.assertEqual(storage['mounts'][0]['busyPercent'], 12.5)
        self.assertIsNone(storage['drives'][0]['busyPercent'])

    def test_rapid_calls_reuse_the_last_full_window(self):
        self.path.write_text(diskstats(sda=0))
        self.activity.sample()
        self.now += 1
        self.path.write_text(diskstats(sda=500))
        self.assertEqual(self.activity.sample(), {'sda': 50.0})
        self.now += .1
        self.path.write_text(diskstats(sda=600))
        self.assertEqual(self.activity.sample(), {'sda': 50.0})

    def test_unreadable_stats_are_unknown(self):
        self.assertEqual(self.activity.sample(), {})


if __name__ == '__main__':
    unittest.main()
