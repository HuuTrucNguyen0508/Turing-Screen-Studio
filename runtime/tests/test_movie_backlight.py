import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from threading import Event, current_thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from turzx_studio.movie import MOVIE_MONITOR
from turzx_studio.movie_backlight import DDC_TIMEOUT, MovieBacklight


class FakeDdc:
    def __init__(self):
        self.brightness = 65
        self.bus = '6'
        self.writes = []
        self.calls = []
        self.failure = None
        self.identity = MOVIE_MONITOR

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs, current_thread().name))
        if self.failure and self.failure in command:
            raise subprocess.TimeoutExpired(command, DDC_TIMEOUT)
        if 'detect' in command:
            return SimpleNamespace(stdout=(
                'Display 1\n I2C bus: /dev/i2c-5\n DRM connector: card1-DP-2\n'
                ' Monitor: DEL:AW3426DW:H16NYH4\n\n'
                f'Display 2\n I2C bus: /dev/i2c-{self.bus}\n'
                f' DRM connector: card1-DP-3\n Monitor: {self.identity}\n'))
        assert command[1:3] == ['--bus', self.bus], command
        if 'getvcp' in command:
            return SimpleNamespace(stdout=f'VCP 10 C {self.brightness} 100\n')
        assert command[3:5] == ['setvcp', '10'], command
        self.brightness = int(command[5])
        self.writes.append(self.brightness)
        return SimpleNamespace(stdout='')


class MovieBacklightTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ddc = FakeDdc()

    def worker(self):
        worker = MovieBacklight(self.root, MOVIE_MONITOR, self.ddc)
        self.addCleanup(worker.close)
        return worker

    def apply(self, worker, active):
        worker.update(active)
        worker.queue.join()

    def test_entry_exit_uses_exact_prior_value_and_worker_thread(self):
        self.ddc.brightness = 47
        worker = self.worker()
        self.apply(worker, True)
        self.assertEqual(self.ddc.brightness, 0)
        self.assertEqual(json.loads(worker.path.read_text())['brightness'], 47)
        self.apply(worker, False)
        self.assertEqual(self.ddc.writes, [0, 47])
        self.assertFalse(worker.path.exists())
        for _, options, thread in self.ddc.calls:
            self.assertEqual(options['timeout'], DDC_TIMEOUT)
            self.assertTrue(options['check'])
            self.assertEqual(thread, 'movie-backlight')

    def test_restart_in_movie_preserves_original_and_manual_adjustment(self):
        first = self.worker()
        self.apply(first, True)
        self.ddc.brightness = 9  # Monitor buttons or Caelestia shortcut.
        restarted = self.worker()
        self.apply(restarted, True)
        for _ in range(20):
            restarted.update(True)
        self.assertEqual(self.ddc.brightness, 9)
        self.assertEqual(self.ddc.writes, [0])
        self.apply(restarted, False)
        self.assertEqual(self.ddc.brightness, 65)

    def test_restart_outside_movie_restores_even_after_bus_changes(self):
        self.apply(self.worker(), True)
        self.ddc.bus = '9'
        self.apply(self.worker(), False)
        self.assertEqual(self.ddc.brightness, 65)

    def test_no_ddc_when_starting_outside_movie(self):
        self.apply(self.worker(), False)
        self.assertEqual(self.ddc.calls, [])

    def test_next_entry_reads_a_new_prior_value(self):
        worker = self.worker()
        self.apply(worker, True)
        self.apply(worker, False)
        self.ddc.brightness = 31
        self.apply(worker, True)
        self.apply(worker, False)
        self.assertEqual(self.ddc.writes, [0, 65, 0, 31])

    def test_detect_and_read_failure_never_write(self):
        for failure in ('detect', 'getvcp'):
            self.ddc.failure = failure
            worker = self.worker()
            with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
                self.apply(worker, True)
            self.assertFalse(worker.path.exists())
            self.assertEqual(self.ddc.writes, [])

    def test_failed_dim_keeps_recovery_value_and_does_not_retry_each_tick(self):
        self.ddc.failure = 'setvcp'
        worker = self.worker()
        with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
            self.apply(worker, True)
        self.assertEqual(json.loads(worker.path.read_text())['brightness'], 65)
        self.ddc.failure = None
        self.apply(self.worker(), True)
        self.assertEqual(self.ddc.writes, [])
        self.apply(worker, False)
        self.assertEqual(self.ddc.writes, [65])

    def test_failed_restore_survives_restart(self):
        worker = self.worker()
        self.apply(worker, True)
        self.ddc.failure = 'setvcp'
        with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
            self.apply(worker, False)
        self.assertTrue(worker.path.exists())
        self.ddc.failure = None
        self.apply(self.worker(), False)
        self.assertEqual(self.ddc.brightness, 65)

    def test_wrong_identity_fails_closed(self):
        self.ddc.identity = 'AUS:VG27WQ:OTHER'
        with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
            self.apply(self.worker(), True)
        self.assertEqual(self.ddc.writes, [])

    def test_corrupt_or_different_monitor_state_fails_closed(self):
        for content in ('{', json.dumps({'monitor': 'other', 'brightness': 65})):
            worker = self.worker()
            worker.path.write_text(content)
            with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
                self.apply(worker, False)
            self.assertEqual(self.ddc.calls, [])

    def test_blocked_ddc_does_not_block_updates_and_edges_stay_ordered(self):
        entered, release = Event(), Event()
        original = self.ddc

        def blocked(command, **kwargs):
            entered.set()
            self.assertTrue(release.wait(2))
            return original(command, **kwargs)

        worker = MovieBacklight(self.root, MOVIE_MONITOR, blocked)
        self.addCleanup(worker.close)
        worker.update(True)
        self.assertTrue(entered.wait(1))
        worker.update(False)
        release.set()
        worker.queue.join()
        self.assertEqual(self.ddc.writes, [0, 65])

    def test_ddc_verification_failure_logs_details_and_preserves_original(self):
        original = self.ddc

        def reject_write(command, **kwargs):
            if 'setvcp' in command:
                raise subprocess.CalledProcessError(1, command, output='',
                                                    stderr='Verification failed for feature 10')
            return original(command, **kwargs)

        worker = MovieBacklight(self.root, MOVIE_MONITOR, reject_write)
        self.addCleanup(worker.close)
        with self.assertLogs('turzx_studio.movie_backlight', level='ERROR') as logs:
            self.apply(worker, True)
        self.assertIn('Verification failed for feature 10', '\n'.join(logs.output))
        self.assertEqual(json.loads(worker.path.read_text())['brightness'], 65)
        self.assertEqual(self.ddc.brightness, 65)

    def test_save_failure_never_dims_without_a_restore_value(self):
        worker = self.worker()
        with patch('turzx_studio.movie_backlight.atomic_write', side_effect=OSError('disk full')):
            with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
                self.apply(worker, True)
        self.assertEqual(self.ddc.writes, [])
        self.assertFalse(worker.path.exists())

    def test_malformed_brightness_response_never_dims(self):
        original = self.ddc

        def malformed(command, **kwargs):
            if 'getvcp' in command:
                return SimpleNamespace(stdout='VCP 10 ERR')
            return original(command, **kwargs)

        worker = MovieBacklight(self.root, MOVIE_MONITOR, malformed)
        self.addCleanup(worker.close)
        with self.assertLogs('turzx_studio.movie_backlight', level='ERROR'):
            self.apply(worker, True)
        self.assertEqual(self.ddc.writes, [])
        self.assertFalse(worker.path.exists())
