"""Saved dashboard rotation uses guarded, archived writes without hardware."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.client import HTTPConnection
import json
import multiprocessing
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

import server
from turzx_studio.archives import list_archives, read_archive
from turzx_studio.layout import revision, serialize_layout
from turzx_studio.layout_library import MAX_BYTES, LibraryTooLarge, validate_library
from turzx_studio.storage import Paths, atomic_write


def switch_process(state, runtime, expected, barrier, queue):
    app = server.StudioApplication(Paths(state, runtime))
    barrier.wait(timeout=5)
    try:
        result = app.switch_layout({'direction': 'next'}, expected)
        queue.put((200, result['activeId']))
    except server.APIError as error:
        queue.put((error.status, str(error)))


class LayoutLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.paths = Paths(self.root / 'state', self.root / 'runtime')
        self.app = server.StudioApplication(self.paths)
        self.original = self.app.layout()

    def assert_api_error(self, status, call, *args):
        with self.assertRaises(server.APIError) as caught:
            call(*args)
        self.assertEqual(caught.exception.status, status, str(caught.exception))
        return caught.exception

    def test_initialization_preserves_exact_panel_bytes_palette_and_mode(self):
        for mode in ('saved', 'live', None):
            with self.subTest(mode=mode):
                current = deepcopy(self.original['document'])
                current['palette']['primary'] = '#abcdef'
                current.pop('paletteMode', None)
                if mode is not None:
                    current['paletteMode'] = mode
                data = json.dumps(current, indent=4).encode() + b'\n\n'
                atomic_write(self.paths.layout, data)
                self.app.library.path.unlink(missing_ok=True)
                with patch('server.usb_present', side_effect=AssertionError('USB inspected')), \
                        patch('server.runtime_is_running', side_effect=AssertionError('runtime inspected')):
                    library = self.app.layouts()
                self.assertEqual([entry['id'] for entry in library['entries']],
                                 ['current', 'system-overview', 'ai-usage', 'focus'])
                self.assertEqual(library['activeId'], 'current')
                self.assertEqual(library['entries'][0]['document'], current)
                for entry in library['entries']:
                    self.assertEqual(entry['document']['palette'], current['palette'])
                    self.assertEqual(entry['document'].get('paletteMode'), mode)
                self.assertEqual(self.paths.layout.read_bytes(), data)
                self.assertFalse(self.paths.older_configs.exists())
                self.assertEqual(self.app.library.path.stat().st_mode & 0o777, 0o600)
                # Initialization is one-time, including across app/server restarts.
                library_bytes = self.app.library.path.read_bytes()
                current['name'] = 'Edited independently'
                atomic_write(self.paths.layout, serialize_layout(current).encode())
                reopened = server.StudioApplication(self.paths).layouts()
                self.assertEqual(reopened['activeId'], None)
                self.assertEqual(reopened['revision'], library['revision'])
                self.assertEqual(self.app.library.path.read_bytes(), library_bytes)

    def test_initial_slots_do_not_repeat_the_current_named_preset(self):
        presets = json.loads((server.ROOT / 'public/layout-presets.json').read_text())['presets']
        current = deepcopy(next(p['document'] for p in presets if p['id'] == 'ai-usage'))
        # A small user edit should still leave room for three other designed dashboards.
        current['widgets'][-1]['x'] -= 1
        atomic_write(self.paths.layout, serialize_layout(current).encode())
        before = self.paths.layout.read_bytes()
        library = self.app.layouts()
        self.assertEqual([entry['id'] for entry in library['entries']],
                         ['current', 'system-overview', 'focus', 'gauge-designs'])
        self.assertEqual(library['entries'][0]['document'], current)
        self.assertEqual(self.paths.layout.read_bytes(), before)

    def test_switch_wraps_and_archives_exact_previous_bytes(self):
        library = self.app.layouts()
        library_bytes = self.app.library.path.read_bytes()
        data = json.dumps(self.original['document'], separators=(',', ':')).encode() + b'\n\n'
        atomic_write(self.paths.layout, data)
        result = self.app.switch_layout({'direction': 'previous'}, self.original['revision'])
        self.assertEqual(result['activeId'], 'focus')
        archive = self.paths.older_configs / result['archive']['id'] / 'layout.json'
        self.assertEqual(archive.read_bytes(), data)
        self.assertEqual(read_archive(self.paths, result['archive']['id'])['document'], self.original['document'])
        for direction, expected in (('next', 'current'), ('next', 'system-overview'),
                                    ('next', 'ai-usage'), ('next', 'focus'), ('next', 'current')):
            result = self.app.switch_layout({'direction': direction}, result['revision'])
            self.assertEqual(result['activeId'], expected)
            self.assertEqual(self.app.layouts()['activeId'], expected)
            self.assertEqual(self.app.layouts()['revision'], library['revision'])
        self.assertEqual(len(list_archives(self.paths)), 6)
        self.assertEqual(self.app.library.path.read_bytes(), library_bytes)

    def test_unknown_current_selects_first_or_last_and_id_is_explicit(self):
        self.app.layouts()
        for direction, expected in (('next', 'current'), ('previous', 'focus')):
            current = deepcopy(self.original['document'])
            current['name'] = 'Not in saved library'
            self.app.save(current, self.app.layout()['revision'])
            self.assertIsNone(self.app.layouts()['activeId'])
            result = self.app.switch_layout({'direction': direction}, self.app.layout()['revision'])
            self.assertEqual(result['activeId'], expected)
        result = self.app.switch_layout({'id': 'system-overview'}, result['revision'])
        self.assertEqual(result['activeId'], 'system-overview')
        self.assertEqual(result['document'], self.app.layouts()['entries'][1]['document'])

    def test_noop_switch_does_not_archive_or_rewrite(self):
        self.app.layouts()
        old = self.paths.layout.stat()
        result = self.app.switch_layout({'id': 'current'}, self.original['revision'])
        self.assertIsNone(result['archive'])
        self.assertEqual(result['revision'], self.original['revision'])
        self.assertEqual(self.paths.layout.stat().st_mtime_ns, old.st_mtime_ns)
        self.assertFalse(self.paths.older_configs.exists())

    def test_slots_select_ordered_entries_and_reject_invalid_or_unconfigured_slots(self):
        library = self.app.layouts()
        for slot, entry in enumerate(library['entries'], 1):
            result = self.app.switch_layout({'slot': slot}, self.app.layout()['revision'])
            self.assertEqual(result['activeId'], entry['id'])
            self.assertEqual(result['document'], entry['document'])
        panel, saved = self.paths.layout.read_bytes(), self.app.library.path.read_bytes()
        for raw in ({'slot': True}, {'slot': False}, {'slot': 1.0}, {'slot': 1.5}, {'slot': '1'},
                    {'slot': None}, {'slot': 0}, {'slot': -1}, {'slot': 13}, {'slot': 5}, {'slot': 12},
                    {'slot': 1, 'id': 'current'}, {'slot': 1, 'direction': 'next'}):
            with self.subTest(raw=raw):
                self.assert_api_error(422, self.app.switch_layout, raw, result['revision'])
                self.assertEqual(self.paths.layout.read_bytes(), panel)
                self.assertEqual(self.app.library.path.read_bytes(), saved)
        reordered = self.app.save_layouts({'entries': library['entries'][::-1]}, library['revision'])
        result = self.app.switch_layout({'slot': 1}, result['revision'])
        self.assertEqual(result['activeId'], reordered['entries'][0]['id'])
        self.assertIsNone(result['archive'])

    def test_switch_errors_do_not_initialize_or_modify_library_or_panel(self):
        original = self.paths.layout.read_bytes()
        error = self.assert_api_error(422, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
        self.assertIn('pnpm layout saved', str(error))
        self.assertFalse(self.app.library.path.exists())
        self.assertEqual(self.paths.layout.read_bytes(), original)
        library = self.app.layouts()
        library_bytes = self.app.library.path.read_bytes()
        for raw in ({}, [], {'direction': 'sideways'}, {'id': 'missing'}, {'id': '../layout'},
                    {'id': 'current', 'direction': 'next'}, {'direction': 'next', 'other': True}):
            with self.subTest(raw=raw):
                self.assert_api_error(422, self.app.switch_layout, raw, self.original['revision'])
                self.assertEqual(self.app.library.path.read_bytes(), library_bytes)
                self.assertEqual(self.paths.layout.read_bytes(), original)
        self.assert_api_error(428, self.app.switch_layout, {'direction': 'next'}, None)
        self.assert_api_error(409, self.app.switch_layout, {'direction': 'next'}, library['revision'])
        empty = self.app.save_layouts({'entries': []}, library['revision'])
        self.assertEqual(empty['entries'], [])
        self.assertIsNone(empty['activeId'])
        library_bytes = self.app.library.path.read_bytes()
        self.assert_api_error(422, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
        self.assertEqual(self.app.library.path.read_bytes(), library_bytes)
        self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_library_updates_require_own_revision_and_never_save_to_panel(self):
        library = self.app.layouts()
        original = self.paths.layout.read_bytes()
        raw = {'entries': deepcopy(library['entries'][::-1])}
        self.assert_api_error(428, self.app.save_layouts, raw, None)
        self.assert_api_error(409, self.app.save_layouts, raw, self.original['revision'])
        updated = self.app.save_layouts(raw, f'"{library["revision"]}"')
        self.assertEqual(updated['entries'][0]['id'], 'focus')
        self.assertNotEqual(updated['revision'], library['revision'])
        self.assertEqual(updated['activeId'], 'current')
        self.assert_api_error(409, self.app.save_layouts, {'entries': library['entries']}, library['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), original)
        self.assertFalse(self.paths.older_configs.exists())
        # A library revision does not depend on later edits to the panel document.
        changed = deepcopy(self.original['document'])
        changed['name'] = 'Independent panel edit'
        self.app.save(changed, self.original['revision'])
        self.assertEqual(self.app.layouts()['revision'], updated['revision'])
        self.assertIsNone(self.app.layouts()['activeId'])
        self.app.save_layouts({'entries': library['entries']}, updated['revision'])

    def test_stale_panel_switch_returns_current_revision_without_writes(self):
        self.app.layouts()
        result = self.app.switch_layout({'direction': 'next'}, self.original['revision'])
        panel, library = self.paths.layout.read_bytes(), self.app.library.path.read_bytes()
        error = self.assert_api_error(409, self.app.switch_layout, {'direction': 'previous'}, self.original['revision'])
        self.assertEqual(error.details['revision'], result['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), panel)
        self.assertEqual(self.app.library.path.read_bytes(), library)
        self.assertEqual(len(list_archives(self.paths)), 1)

    def test_removed_and_replaced_library_documents_are_archived_before_update(self):
        library = self.app.layouts()
        panel = self.paths.layout.read_bytes()
        replacement = deepcopy(library['entries'][1])
        replacement['document']['name'] = 'New overview'
        entries = [library['entries'][0], replacement, library['entries'][3]]
        self.app.save_layouts({'entries': entries}, library['revision'])
        archived = [read_archive(self.paths, archive['id'])['document'] for archive in list_archives(self.paths)]
        self.assertEqual(len(archived), 2)
        self.assertIn(library['entries'][1]['document'], archived)
        self.assertIn(library['entries'][2]['document'], archived)
        self.assertEqual(self.paths.layout.read_bytes(), panel)

    def test_archive_failure_preserves_library_before_remove_or_update(self):
        library = self.app.layouts()
        original = self.app.library.path.read_bytes()
        panel = self.paths.layout.read_bytes()
        with patch('server.archive_layout', side_effect=OSError('disk full')):
            self.assert_api_error(500, self.app.save_layouts, {'entries': []}, library['revision'])
        self.assertEqual(self.app.library.path.read_bytes(), original)
        self.assertEqual(self.paths.layout.read_bytes(), panel)

    def test_identical_documents_are_rejected_even_with_distinct_ids(self):
        library = self.app.layouts()
        duplicate = deepcopy(library['entries'][0])
        duplicate['id'] = 'identical-copy'
        duplicate['name'] = 'Another label'
        original = self.app.library.path.read_bytes()
        error = self.assert_api_error(422, self.app.save_layouts,
                                      {'entries': [*library['entries'], duplicate]}, library['revision'])
        self.assertIn('identical copy', str(error))
        self.assertEqual(self.app.library.path.read_bytes(), original)
        result = self.app.switch_layout({'direction': 'next'}, self.original['revision'])
        self.assertEqual(result['activeId'], 'system-overview')

    def test_strict_library_validation_and_canonical_panel_documents(self):
        library = self.app.layouts()
        entry = deepcopy(library['entries'][0])
        invalid = [[], {}, {'entries': [], 'revision': library['revision']}, {'entries': [entry] * 13},
                   {'entries': [entry, entry]}, {'entries': [{**entry, 'other': True}]}]
        invalid.extend({'entries': [{**entry, 'id': value}]} for value in
                       ('', '../path', 'a/b', 'a\\b', '.hidden', 'á', 'a' * 65, None, 3))
        invalid.extend({'entries': [{**entry, 'name': value}]} for value in
                       ('', '  ', 'a' * 121, None, 3))
        invalid.extend({'entries': [{**entry, 'document': value}]} for value in
                       ({}, {**entry['document'], 'canvas': {'width': 800, 'height': 1280}},
                        {**entry['document'], 'version': 2}))
        old_library, old_panel = self.app.library.path.read_bytes(), self.paths.layout.read_bytes()
        for raw in invalid:
            with self.subTest(raw=raw):
                self.assert_api_error(422, self.app.save_layouts, raw, library['revision'])
                self.assertEqual(self.app.library.path.read_bytes(), old_library)
                self.assertEqual(self.paths.layout.read_bytes(), old_panel)
        raw = {'entries': [entry]}
        raw['entries'][0]['document']['widgets'][0]['x'] = 64.0
        canonical = self.app.save_layouts(raw, library['revision'])
        self.assertIs(type(canonical['entries'][0]['document']['widgets'][0]['x']), int)

    def test_library_size_bound_covers_file_and_canonical_updates(self):
        library = self.app.layouts()
        original = self.paths.layout.read_bytes()
        entry = deepcopy(library['entries'][0])
        entry['document']['name'] = 'x' * MAX_BYTES
        with self.assertRaises(LibraryTooLarge):
            validate_library({'entries': [entry]})
        self.assert_api_error(413, self.app.save_layouts, {'entries': [entry]}, library['revision'])
        atomic_write(self.app.library.path, b' ' * (MAX_BYTES + 1))
        self.assert_api_error(422, self.app.layouts)
        self.assert_api_error(422, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_invalid_existing_library_is_preserved(self):
        for data in (b'{"entries":[],"entries":[]}', b'{"entries":NaN}', b'{"entries":[{}]}', b'{'):
            with self.subTest(data=data):
                atomic_write(self.app.library.path, data)
                self.assert_api_error(422, self.app.layouts)
                self.assert_api_error(422, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
                self.assertEqual(self.app.library.path.read_bytes(), data)
                self.assertEqual(self.app.layout(), self.original)
        self.app.library.path.unlink()
        other = self.root / 'outside.json'
        atomic_write(other, b'{"entries":[]}')
        self.app.library.path.symlink_to(other)
        self.assert_api_error(422, self.app.layouts)
        self.assertTrue(self.app.library.path.is_symlink())
        self.assertEqual(other.read_bytes(), b'{"entries":[]}')

    def test_runtime_guards_cover_widget_types_styles_and_usage_sources(self):
        self.app.layouts()
        statuses = [
            {'supportedWidgetTypes': ['metric', 'weather']},
            {'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge'],
             'supportedGaugeStyles': [], 'supportedUsageSources': list(server.USAGE_SOURCES)},
            {'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge'],
             'supportedGaugeStyles': ['arc', 'ring', 'bar', 'segments', 'thermometer', 'number'],
             'supportedUsageSources': []},
        ]
        panel, library = self.paths.layout.read_bytes(), self.app.library.path.read_bytes()
        for capabilities, identifier in zip(statuses, ('system-overview', 'ai-usage', 'ai-usage')):
            with self.subTest(capabilities=capabilities):
                runtime = {'pid': os.getpid(), 'processStart': server.process_start(os.getpid()), **capabilities}
                atomic_write(self.paths.status, json.dumps(runtime).encode())
                self.assert_api_error(409, self.app.switch_layout, {'id': identifier}, self.original['revision'])
                self.assertEqual(self.paths.layout.read_bytes(), panel)
                self.assertEqual(self.app.library.path.read_bytes(), library)
                self.assertFalse(self.paths.older_configs.exists())

    def test_failed_archive_panel_and_library_writes_preserve_existing_files(self):
        library = self.app.layouts()
        panel, saved = self.paths.layout.read_bytes(), self.app.library.path.read_bytes()
        with patch('server.archive_layout', side_effect=OSError('archive disk full')):
            self.assert_api_error(500, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
        self.assertFalse(self.paths.older_configs.exists())
        with patch('server.atomic_write', side_effect=OSError('panel disk full')):
            self.assert_api_error(500, self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), panel)
        self.assertEqual(self.app.library.path.read_bytes(), saved)
        self.assertEqual(len(list_archives(self.paths)), 1)
        with patch('turzx_studio.layout_library.atomic_write', side_effect=OSError('library disk full')):
            self.assert_api_error(500, self.app.save_layouts, {'entries': []}, library['revision'])
        self.assertEqual(self.paths.layout.read_bytes(), panel)
        self.assertEqual(self.app.library.path.read_bytes(), saved)

    def test_failed_initialization_does_not_create_library_or_change_panel(self):
        original = self.paths.layout.read_bytes()
        with patch('turzx_studio.layout_library.atomic_write', side_effect=OSError('disk full')):
            self.assert_api_error(500, self.app.layouts)
        self.assertFalse(self.app.library.path.exists())
        self.assertEqual(self.paths.layout.read_bytes(), original)

    def test_two_apps_concurrent_library_updates_have_one_winner(self):
        library = self.app.layouts()
        other = server.StudioApplication(self.paths)
        barrier = threading.Barrier(2)
        def update(pair):
            app, name = pair
            raw = {'entries': deepcopy(library['entries'])}
            raw['entries'][0]['name'] = name
            barrier.wait(timeout=5)
            try:
                return 200, app.save_layouts(raw, library['revision'])
            except server.APIError as error:
                return error.status, None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(update, ((self.app, 'one'), (other, 'two'))))
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        winner = next(result for status, result in results if status == 200)
        self.assertEqual(self.app.layouts(), winner)
        self.assertEqual(self.app.layout(), self.original)

    def test_switch_serializes_against_library_update(self):
        library = self.app.layouts()
        other = server.StudioApplication(self.paths)
        entered, release = threading.Event(), threading.Event()
        original_save = self.app._save_locked
        def held_save(raw, expected):
            entered.set()
            if not release.wait(timeout=5):
                raise AssertionError('Switch was not released')
            return original_save(raw, expected)
        with ThreadPoolExecutor(max_workers=2) as executor, patch.object(self.app, '_save_locked', held_save):
            switch = executor.submit(self.app.switch_layout, {'direction': 'next'}, self.original['revision'])
            self.assertTrue(entered.wait(timeout=5))
            update = executor.submit(other.save_layouts, {'entries': library['entries'][::-1]}, library['revision'])
            try:
                self.assertFalse(update.done())
            finally:
                release.set()
            self.assertEqual(switch.result(timeout=5)['activeId'], 'system-overview')
            updated = update.result(timeout=5)
        self.assertEqual(updated['entries'][0]['id'], 'focus')
        self.assertEqual(updated['activeId'], 'system-overview')

    def test_two_processes_switch_same_revision_have_one_winner(self):
        self.app.layouts()
        context = multiprocessing.get_context('spawn')
        barrier, queue = context.Barrier(2), context.Queue()
        self.addCleanup(queue.close)
        processes = [context.Process(target=switch_process, args=(self.paths.state_dir, self.paths.runtime_dir,
                     self.original['revision'], barrier, queue)) for _ in range(2)]
        try:
            for process in processes:
                process.start()
            results = [queue.get(timeout=10) for _ in processes]
            for process in processes:
                process.join(timeout=5)
                self.assertEqual(process.exitcode, 0)
        finally:
            for process in processes:
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=5)
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(self.app.layouts()['activeId'], 'system-overview')
        self.assertEqual(len(list_archives(self.paths)), 1)


class LayoutLibraryHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.paths = Paths(Path(self.temporary.name) / 'state', Path(self.temporary.name) / 'runtime')
        self.app = server.StudioApplication(self.paths)
        self.httpd = server.StudioHTTPServer(self.app, 0)
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, path, raw=None, expected=None, method=None):
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=10)
        headers = {'Content-Type': 'application/json'}
        if expected is not None:
            headers['If-Match'] = expected
        try:
            connection.request(method or ('GET' if raw is None else 'POST'), path,
                               json.dumps(raw).encode() if raw is not None else None, headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), json.loads(response.read())
        finally:
            connection.close()

    def test_routes_library_and_switch_etags_use_distinct_revisions(self):
        original = self.paths.layout.read_bytes()
        status, headers, library = self.request('/api/layouts')
        self.assertEqual(status, 200)
        self.assertEqual(set(library), {'entries', 'revision', 'activeId'})
        self.assertEqual(headers['ETag'], f'"{library["revision"]}"')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertEqual(self.paths.layout.read_bytes(), original)
        updated_raw = {'entries': library['entries'][::-1]}
        self.assertEqual(self.request('/api/layouts', updated_raw)[0], 428)
        status, _, updated = self.request('/api/layouts', updated_raw, headers['ETag'])
        self.assertEqual(status, 200)
        self.assertEqual(self.paths.layout.read_bytes(), original)
        self.assertEqual(self.request('/api/layouts', updated_raw, library['revision'])[0], 409)
        self.assertEqual(self.request('/api/layouts/switch', {'direction': 'next'})[0], 428)
        self.assertEqual(self.request('/api/layouts/switch', {'direction': 'next'}, updated['revision'])[0], 409)
        _, current_headers, _ = self.request('/api/layout')
        status, headers, result = self.request('/api/layouts/switch', {'direction': 'next'}, current_headers['ETag'])
        self.assertEqual(status, 200, result)
        self.assertEqual(set(result), {'document', 'revision', 'archive', 'activeId'})
        self.assertEqual(result['activeId'], 'focus')
        self.assertEqual(headers['ETag'], f'"{result["revision"]}"')
        self.assertIsNotNone(result['archive'])
        self.assertEqual(self.request('/api/layouts')[2]['activeId'], result['activeId'])

    def test_body_limits_strict_json_and_duplicate_if_match(self):
        self.app.layouts()
        current = self.app.layout()['revision']
        for body, length, expected in ((b'{"entries":[],"entries":[]}', None, 400),
                                       (b'{}', MAX_BYTES + 1, 413)):
            connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=10)
            try:
                headers = {'Content-Type': 'application/json', 'If-Match': current}
                if length:
                    headers['Content-Length'] = str(length)
                connection.request('POST', '/api/layouts', body, headers)
                response = connection.getresponse()
                self.assertEqual(response.status, expected, response.read())
            finally:
                connection.close()
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=10)
        try:
            connection.putrequest('POST', '/api/layouts/switch')
            connection.putheader('Content-Type', 'application/json')
            connection.putheader('Content-Length', '20')
            connection.putheader('If-Match', current)
            connection.putheader('If-Match', current)
            connection.endheaders(b'{"direction":"next"}')
            response = connection.getresponse()
            self.assertEqual(response.status, 400, response.read())
        finally:
            connection.close()


if __name__ == '__main__':
    unittest.main()
