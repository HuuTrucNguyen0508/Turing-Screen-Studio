"""Offline timers: exact boundaries, preserved state and concurrent updates."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

from turzx_studio.games import (
    GameResources, GameRevisionConflict, GameStateUnavailable, MAX_BYTES,
)


NOW = datetime(2026, 10, 7, 10, tzinfo=timezone.utc).timestamp()
ISO = '2026-10-07T10:00:00Z'


def write_process(path, identifier, expected, barrier, queue):
    timers = GameResources(Path(path), clock=lambda: NOW)
    barrier.wait(timeout=10)
    try:
        result = timers.set_timer(identifier, 42, if_match=expected)
        queue.put(('saved', result['revision']))
    except GameRevisionConflict:
        queue.put(('conflict', None))


class GameResourcesTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'state' / 'game-timers.json'
        self.now = NOW
        self.timers = GameResources(self.path, clock=lambda: self.now)

    def row(self, identifier, snapshot=None):
        snapshot = self.timers.snapshot() if snapshot is None else snapshot
        return next(game for game in snapshot['games'] if game['id'] == identifier)

    def write_raw(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(data)

    def test_missing_state_is_unknown_and_snapshot_has_no_filesystem_writes(self):
        first = self.timers.snapshot()
        self.assertEqual(set(first), {'games', 'observedAt', 'revision'})
        self.assertEqual([row['id'] for row in first['games']], ['genshin', 'wuwa', 'zzz'])
        self.assertEqual([row['capacity'] for row in first['games']], [200, 240, 240])
        self.assertEqual(first['observedAt'], ISO)
        self.assertRegex(first['revision'], r'^[a-f0-9]{64}$')
        for row in first['games']:
            self.assertEqual(set(row), {'id', 'name', 'resource', 'current', 'capacity',
                                        'status', 'observedAt', 'fullAt', 'note'})
            self.assertIsNone(row['current'])
            self.assertIsNone(row['observedAt'])
            self.assertIsNone(row['fullAt'])
            self.assertEqual(row['status'], 'not-configured')
            self.assertTrue(row['note'])
        self.now += 1000
        self.assertEqual(self.timers.snapshot()['revision'], first['revision'])
        self.assertEqual(list(self.root.iterdir()), [])

    def test_each_game_regenerates_only_on_whole_interval_boundaries(self):
        for identifier, interval in (('genshin', 480), ('wuwa', 360), ('zzz', 360)):
            with self.subTest(identifier=identifier):
                self.now = NOW
                saved = self.timers.set_timer(identifier, 10)
                revision = saved['revision']
                self.assertEqual(self.row(identifier, saved)['current'], 10)
                self.assertEqual(self.row(identifier, saved)['status'], 'estimate')
                self.now = NOW + interval - 0.001
                self.assertEqual(self.row(identifier)['current'], 10)
                self.now = NOW + interval
                self.assertEqual(self.row(identifier)['current'], 11)
                self.now = NOW + 3 * interval + 20
                self.assertEqual(self.row(identifier)['current'], 13)
                self.assertEqual(self.row(identifier)['observedAt'], ISO)
                self.assertEqual(self.timers.snapshot()['revision'], revision)

    def test_time_to_full_is_from_original_anchor_and_null_once_full(self):
        for identifier, capacity, interval in (('genshin', 200, 480), ('wuwa', 240, 360),
                                               ('zzz', 240, 360)):
            with self.subTest(identifier=identifier):
                self.now = NOW
                first = self.timers.set_timer(identifier, capacity - 2)
                expected_full = datetime.fromtimestamp(NOW + interval * 2, timezone.utc).isoformat()
                self.assertEqual(self.row(identifier, first)['fullAt'], expected_full.replace('+00:00', 'Z'))
                self.now += interval
                self.assertEqual(self.row(identifier)['fullAt'], self.row(identifier, first)['fullAt'])
                self.now += interval
                self.assertEqual(self.row(identifier)['current'], capacity)
                self.assertEqual(self.row(identifier)['status'], 'full')
                self.assertIsNone(self.row(identifier)['fullAt'])
                self.now += interval * 100
                self.assertEqual(self.row(identifier)['current'], capacity)

    def test_zero_full_and_overcap_are_real_counts_without_clipping(self):
        for count, expected in ((0, 'estimate'), (200, 'full'), (201, 'full'), (10000, 'full')):
            with self.subTest(count=count):
                self.now = NOW
                result = self.timers.set_timer('genshin', count)
                self.assertEqual(self.row('genshin', result)['current'], count)
                self.assertEqual(self.row('genshin', result)['status'], expected)
                if count >= 200:
                    self.assertIsNone(self.row('genshin', result)['fullAt'])
                    self.now += 4800
                    self.assertEqual(self.row('genshin')['current'], count)

    def test_explicit_past_timestamp_and_offset_normalization(self):
        result = self.timers.set_timer('wuwa', 20, '2026-10-07T11:48:00+02:00')
        self.assertEqual(self.row('wuwa', result)['observedAt'], '2026-10-07T09:48:00Z')
        self.assertEqual(self.row('wuwa', result)['current'], 22)
        result = self.timers.set_timer('zzz', 20, '2026-10-07T09:59:59.500000Z')
        self.assertEqual(self.row('zzz', result)['current'], 20)

    def test_invalid_count_and_game_id_leave_saved_bytes_unchanged(self):
        self.timers.set_timer('genshin', 23)
        before = self.path.read_bytes()
        for count in (True, False, 1.0, '1', None, -1, 10001, float('nan')):
            with self.subTest(count=count), self.assertRaises(ValueError):
                self.timers.set_timer('genshin', count)
        for identifier in ('hsr', '', None, {}, True):
            with self.subTest(identifier=identifier), self.assertRaises(ValueError):
                self.timers.set_timer(identifier, 1)
            with self.assertRaises(ValueError):
                self.timers.clear(identifier)
        self.assertEqual(self.path.read_bytes(), before)

    def test_bad_or_future_timestamps_leave_saved_bytes_unchanged(self):
        self.timers.set_timer('genshin', 23)
        before = self.path.read_bytes()
        for stamp in ('', 'tomorrow', ISO + 'junk', '2026-10-07', '2026-10-07T10:00:00',
                      '2026-02-30T10:00:00Z', '2026-10-07T10:00:00+00:60',
                      '0001-01-01T00:00:00+23:00',
                      '2026-10-07T10:00:00.000001Z', '2026-10-07T10:00:01Z',
                      '9999-12-31T23:59:59Z', 123, True):
            with self.subTest(stamp=stamp), self.assertRaises(ValueError):
                self.timers.set_timer('genshin', 10, stamp)
        self.assertEqual(self.path.read_bytes(), before)

    def test_only_anchors_persist_and_reopened_instances_share_them(self):
        self.timers.set_timer('zzz', 51)
        self.timers.set_timer('genshin', 28)
        saved = json.loads(self.path.read_bytes())
        self.assertEqual(saved, {'anchors': {'genshin': {'count': 28, 'observedAt': ISO},
                                            'zzz': {'count': 51, 'observedAt': ISO}}})
        self.now += 480
        reopened = GameResources(self.path, clock=lambda: self.now)
        self.assertEqual(self.row('genshin', reopened.snapshot())['current'], 29)
        self.assertEqual(self.row('wuwa', reopened.snapshot())['status'], 'not-configured')
        self.assertEqual(json.loads(self.path.read_bytes()), saved)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.with_name(self.path.name + '.lock').stat().st_mode & 0o777, 0o600)

    def test_snapshot_and_mutation_results_are_detached(self):
        result = self.timers.set_timer('genshin', 10)
        result['games'][0]['current'] = -100
        result['games'][0]['capacity'] = -100
        result['games'].clear()
        snap = self.timers.snapshot()
        snap['games'][0]['note'] = 'mutated'
        snap['games'][1]['name'] = 'mutated'
        self.assertEqual(self.row('genshin')['current'], 10)
        self.assertEqual(self.row('genshin')['capacity'], 200)
        self.assertNotEqual(self.row('genshin')['note'], 'mutated')
        self.assertEqual(self.row('wuwa')['name'], 'Wuthering Waves')

    def test_clear_removes_only_selected_anchor_and_supports_preconditions(self):
        saved = self.timers.set_timer('genshin', 10)
        saved = self.timers.set_timer('wuwa', 15, if_match=saved['revision'])
        cleared = self.timers.clear('genshin', if_match=saved['revision'])
        self.assertEqual(self.row('genshin', cleared)['status'], 'not-configured')
        self.assertEqual(self.row('wuwa', cleared)['current'], 15)
        self.assertNotEqual(cleared['revision'], saved['revision'])
        self.assertEqual(self.timers.clear('genshin')['revision'], cleared['revision'])
        empty = self.timers.clear('wuwa')
        self.path.unlink()
        self.assertEqual(empty['revision'], self.timers.snapshot()['revision'])

    def test_conflict_is_specific_and_does_not_write(self):
        old = self.timers.snapshot()['revision']
        saved = self.timers.set_timer('genshin', 10, if_match=old)
        before = self.path.read_bytes()
        for operation in (lambda: self.timers.set_timer('wuwa', 12, if_match=old),
                          lambda: self.timers.clear('genshin', if_match=old)):
            with self.assertRaises(GameRevisionConflict):
                operation()
        self.assertEqual(self.path.read_bytes(), before)
        self.now += 600
        self.timers.set_timer('wuwa', 12, if_match=saved['revision'])

    def test_invalid_precondition_types_are_rejected(self):
        for expected in ('', 1, True, []):
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                self.timers.set_timer('genshin', 1, if_match=expected)
        self.assertFalse(self.path.exists())

    def test_corrupt_state_is_unavailable_and_never_overwritten_even_by_clear(self):
        bad_records = (b'', b'no json', b'\xff', b'{}', b'{"anchors":null}',
                       b'{"anchors":[],"extra":1}', b'{"anchors":{},"anchors":{}}',
                       json.dumps({'anchors': {'hsr': {'count': 2, 'observedAt': ISO}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': True, 'observedAt': ISO}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': 10001, 'observedAt': ISO}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': 2, 'observedAt': '2026-02-30T10:00:00Z'}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': 2, 'observedAt': '2026-10-07T10:00:00'}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': 2, 'observedAt': '2026-10-07T10:00:00+00:60'}}}).encode(),
                       json.dumps({'anchors': {'genshin': {'count': 2, 'observedAt': ISO, 'current': 2}}}).encode(),
                       b'[' * 2000, b' ' * (MAX_BYTES + 1))
        for data in bad_records:
            with self.subTest(data=data[:60]):
                self.write_raw(data)
                snapshot = self.timers.snapshot()
                self.assertTrue(all(row['status'] == 'unavailable' for row in snapshot['games']))
                self.assertTrue(all(row['current'] is None for row in snapshot['games']))
                for call in (lambda: self.timers.set_timer('genshin', 1, if_match=snapshot['revision']),
                             lambda: self.timers.clear('genshin', if_match=snapshot['revision'])):
                    with self.assertRaises(GameStateUnavailable):
                        call()
                self.assertEqual(self.path.read_bytes(), data)

    def test_valid_state_at_exact_size_limit_is_accepted(self):
        data = b'{"anchors":{}}'
        self.write_raw(data + b' ' * (MAX_BYTES - len(data)))
        self.assertEqual(self.row('genshin')['status'], 'not-configured')

    def test_more_than_three_or_duplicate_records_rejected(self):
        self.write_raw(b'{"anchors":{"genshin":{"count":1,"observedAt":"' + ISO.encode() +
                       b'"},"genshin":{"count":2,"observedAt":"' + ISO.encode() + b'"}}}')
        self.assertEqual(self.row('genshin')['status'], 'unavailable')
        self.write_raw(json.dumps({'anchors': {identifier: {'count': 1, 'observedAt': ISO}
                                               for identifier in ('genshin', 'wuwa', 'zzz', 'other')}}).encode())
        self.assertEqual(self.row('genshin')['status'], 'unavailable')

    def test_state_symlink_directory_and_fifo_are_unavailable_without_blocking(self):
        self.path.parent.mkdir()
        target = self.root / 'target.json'
        target.write_bytes(b'{"anchors":{}}')
        for kind in ('symlink', 'dangling', 'directory', 'fifo'):
            with self.subTest(kind=kind):
                if kind in ('symlink', 'dangling'):
                    self.path.symlink_to(target if kind == 'symlink' else self.root / 'absent')
                elif kind == 'directory':
                    self.path.mkdir()
                else:
                    os.mkfifo(self.path)
                self.assertEqual(self.row('genshin')['status'], 'unavailable')
                with self.assertRaises(GameStateUnavailable):
                    self.timers.set_timer('genshin', 1)
                if kind == 'directory':
                    self.path.rmdir()
                else:
                    self.path.unlink()
        self.assertEqual(target.read_bytes(), b'{"anchors":{}}')

    def test_failed_atomic_replace_preserves_last_good_bytes_and_cleans_tempfile(self):
        self.timers.set_timer('genshin', 10)
        before = self.path.read_bytes()
        with patch('turzx_studio.games.os.replace', side_effect=OSError('injected')):
            with self.assertRaises(OSError):
                self.timers.set_timer('wuwa', 20)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(sorted(path.name for path in self.path.parent.iterdir()),
                         ['game-timers.json', 'game-timers.json.lock'])

    def test_readers_see_complete_old_state_until_atomic_replace(self):
        self.timers.set_timer('genshin', 10)
        replace = os.replace
        observations = []
        def inspect_then_replace(source, target):
            observations.append(GameResources(self.path, clock=lambda: NOW).snapshot())
            replace(source, target)
        with patch('turzx_studio.games.os.replace', side_effect=inspect_then_replace):
            updated = self.timers.set_timer('wuwa', 20)
        self.assertEqual(self.row('genshin', observations[0])['current'], 10)
        self.assertIsNone(self.row('wuwa', observations[0])['current'])
        self.assertEqual(self.row('wuwa', updated)['current'], 20)
        self.assertEqual(self.row('wuwa')['current'], 20)

    def test_snapshot_never_rewrites_saved_anchors_or_recreates_lock(self):
        self.timers.set_timer('genshin', 199)
        before = self.path.read_bytes()
        modified = self.path.stat().st_mtime_ns
        self.path.with_name(self.path.name + '.lock').unlink()
        self.now += 1000
        self.assertEqual(self.row('genshin')['status'], 'full')
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual([path.name for path in self.path.parent.iterdir()], ['game-timers.json'])

    def test_clock_rollback_affects_only_future_anchor_and_snapshot_is_read_only(self):
        self.timers.set_timer('wuwa', 15, '2026-10-07T09:48:00Z')
        saved = self.timers.set_timer('genshin', 10)
        before = self.path.read_bytes()
        modified = self.path.stat().st_mtime_ns
        self.path.with_name(self.path.name + '.lock').unlink()
        self.now -= 1
        snapshot = self.timers.snapshot()
        affected = self.row('genshin', snapshot)
        self.assertEqual(affected['status'], 'unavailable')
        self.assertIsNone(affected['current'])
        self.assertIsNone(affected['fullAt'])
        self.assertEqual(affected['observedAt'], ISO)
        self.assertEqual(affected['note'], 'Check timer: set time is ahead.')
        self.assertEqual(self.row('wuwa', snapshot)['status'], 'estimate')
        self.assertEqual(self.row('wuwa', snapshot)['current'], 16)
        self.assertEqual(self.row('zzz', snapshot)['status'], 'not-configured')
        self.assertEqual(snapshot['revision'], saved['revision'])
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, modified)
        self.assertEqual([path.name for path in self.path.parent.iterdir()], ['game-timers.json'])
        self.now = NOW
        self.assertEqual(self.row('genshin')['current'], 10)

    def test_future_persisted_timestamp_is_unavailable_with_revision_of_original_bytes(self):
        for stamp in ('2026-10-07T12:00:00.000001+02:00', '9999-12-31T23:59:59Z'):
            with self.subTest(stamp=stamp):
                data = json.dumps({'anchors': {'genshin': {'count': 10000, 'observedAt': stamp}}}).encode()
                self.write_raw(data)
                snapshot = self.timers.snapshot()
                self.assertEqual(self.row('genshin', snapshot)['status'], 'unavailable')
                self.assertIsNone(self.row('genshin', snapshot)['current'])
                self.assertIsNone(self.row('genshin', snapshot)['fullAt'])
                self.assertEqual(self.row('wuwa', snapshot)['status'], 'not-configured')
                self.assertEqual(snapshot['revision'], hashlib.sha256(data).hexdigest())
                self.assertEqual(self.path.read_bytes(), data)

    def test_set_reanchor_and_clear_recover_future_anchor_with_revision_checks(self):
        for operation in ('set', 'reanchor', 'clear'):
            with self.subTest(operation=operation):
                self.now = NOW
                self.timers.set_timer('wuwa', 15, '2026-10-07T09:48:00Z')
                self.timers.set_timer('genshin', 10)
                self.now -= 1
                snapshot = self.timers.snapshot()
                before = self.path.read_bytes()
                other = json.loads(before)['anchors']['wuwa']

                def recover(revision):
                    if operation == 'clear':
                        return self.timers.clear('genshin', if_match=revision)
                    observed = '2026-10-07T09:59:00Z' if operation == 'reanchor' else None
                    return self.timers.set_timer('genshin', 20, observed, if_match=revision)

                with self.assertRaises(GameRevisionConflict):
                    recover('stale-revision')
                self.assertEqual(self.path.read_bytes(), before)
                recovered = recover(snapshot['revision'])
                self.assertNotEqual(recovered['revision'], snapshot['revision'])
                self.assertEqual(self.row('wuwa', recovered)['current'], 16)
                self.assertEqual(json.loads(self.path.read_bytes())['anchors']['wuwa'], other)
                if operation == 'clear':
                    self.assertEqual(self.row('genshin', recovered)['status'], 'not-configured')
                    self.assertIsNone(self.row('genshin', recovered)['current'])
                    self.assertNotIn('genshin', json.loads(self.path.read_bytes())['anchors'])
                else:
                    self.assertEqual(self.row('genshin', recovered)['status'], 'estimate')
                    self.assertEqual(self.row('genshin', recovered)['current'], 20)
                    expected = '2026-10-07T09:59:00Z' if operation == 'reanchor' else '2026-10-07T09:59:59Z'
                    self.assertEqual(self.row('genshin', recovered)['observedAt'], expected)

    def test_future_input_remains_rejected_when_saved_anchor_is_future(self):
        self.timers.set_timer('genshin', 10)
        before = self.path.read_bytes()
        self.now -= 1
        snapshot = self.timers.snapshot()
        with self.assertRaisesRegex(ValueError, 'observed_at must not be in the future'):
            self.timers.set_timer('genshin', 20, ISO, if_match=snapshot['revision'])
        self.assertEqual(self.path.read_bytes(), before)

    def test_editing_another_game_preserves_future_anchor(self):
        saved = self.timers.set_timer('genshin', 10)
        anchor = json.loads(self.path.read_bytes())['anchors']['genshin']
        self.now -= 1
        updated = self.timers.set_timer('wuwa', 20, if_match=saved['revision'])
        self.assertEqual(self.row('genshin', updated)['status'], 'unavailable')
        self.assertEqual(self.row('wuwa', updated)['current'], 20)
        self.assertEqual(json.loads(self.path.read_bytes())['anchors']['genshin'], anchor)
        cleared = self.timers.clear('wuwa', if_match=updated['revision'])
        self.assertEqual(self.row('genshin', cleared)['status'], 'unavailable')
        self.assertEqual(json.loads(self.path.read_bytes())['anchors'], {'genshin': anchor})

    def test_thread_writers_across_instances_do_not_lose_unrelated_updates(self):
        barrier = threading.Barrier(3)
        def write(identifier):
            timers = GameResources(self.path, clock=lambda: NOW)
            barrier.wait(timeout=5)
            timers.set_timer(identifier, 33)
        with ThreadPoolExecutor(max_workers=3) as executor:
            list(executor.map(write, ('genshin', 'wuwa', 'zzz')))
        self.assertEqual([row['current'] for row in self.timers.snapshot()['games']], [33, 33, 33])

    def test_thread_preconditions_allow_exactly_one_writer(self):
        expected = self.timers.snapshot()['revision']
        barrier = threading.Barrier(3)
        def write(identifier):
            timers = GameResources(self.path, clock=lambda: NOW)
            barrier.wait(timeout=5)
            try:
                timers.set_timer(identifier, 33, if_match=expected)
                return 'saved'
            except GameRevisionConflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=3) as executor:
            self.assertCountEqual(list(executor.map(write, ('genshin', 'wuwa', 'zzz'))),
                                  ['saved', 'conflict', 'conflict'])

    def test_process_lock_prevents_lost_updates_and_checks_revision_inside_lock(self):
        context = multiprocessing.get_context('spawn')
        for guarded in (False, True):
            with self.subTest(guarded=guarded):
                self.path.unlink(missing_ok=True)
                expected = self.timers.snapshot()['revision'] if guarded else None
                barrier, queue = context.Barrier(3), context.Queue()
                workers = [context.Process(target=write_process,
                           args=(str(self.path), identifier, expected, barrier, queue))
                           for identifier in ('genshin', 'wuwa', 'zzz')]
                try:
                    for worker in workers:
                        worker.start()
                    results = [queue.get(timeout=15)[0] for _ in workers]
                    for worker in workers:
                        worker.join(timeout=10)
                        self.assertEqual(worker.exitcode, 0)
                    self.assertCountEqual(results, ['saved', 'conflict', 'conflict'] if guarded
                                          else ['saved'] * 3)
                    configured = [row for row in self.timers.snapshot()['games'] if row['current'] is not None]
                    self.assertEqual(len(configured), 1 if guarded else 3)
                finally:
                    for worker in workers:
                        if worker.is_alive():
                            worker.terminate()
                            worker.join(timeout=5)
                    queue.close()


if __name__ == '__main__':
    unittest.main()
