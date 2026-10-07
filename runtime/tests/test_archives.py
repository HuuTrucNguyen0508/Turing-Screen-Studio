"""Previous configurations must survive failed, conflicting and restored saves."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import stat
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

import server
from turzx_studio.archives import archive_layout, list_archives, read_archive, snapshot_original_dashboard
from turzx_studio.layout import parse_layout, revision
from turzx_studio.storage import Paths

ROOT = Path(__file__).resolve().parents[2]


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.paths = Paths(self.root / 'state', self.root / 'runtime')
        self.app = server.StudioApplication(self.paths)
        self.document = self.app.layout()['document']

    def test_replacement_preserves_exact_previous_bytes_and_restore_preserves_newer(self):
        # Existing user formatting is part of the preserved file.
        before = json.dumps(self.document, ensure_ascii=False).encode() + b'\n\n'
        self.paths.layout.write_bytes(before)
        newer = deepcopy(self.document)
        newer['name'] = 'New dashboard'
        result = self.app.save(newer, revision(self.document))
        archive = self.paths.older_configs / result['archive']['id']
        self.assertEqual((archive / 'layout.json').read_bytes(), before)
        self.assertEqual(result['archive']['sha256'], hashlib.sha256(before).hexdigest())
        self.assertEqual(stat.S_IMODE((archive / 'layout.json').stat().st_mode), 0o600)
        old = read_archive(self.paths, result['archive']['id'])
        restored = self.app.save(old['document'], result['revision'])
        self.assertEqual(restored['revision'], revision(self.document))
        self.assertEqual(read_archive(self.paths, restored['archive']['id'])['document'], newer)
        self.assertEqual(len(list_archives(self.paths)), 2)

    def test_archive_failure_blocks_replacement_and_stale_save_creates_no_archive(self):
        before = self.paths.layout.read_bytes()
        newer = {**self.document, 'name': 'Must not replace'}
        with patch('server.archive_layout', side_effect=OSError('archive disk full')):
            with self.assertRaisesRegex(server.APIError, 'archive disk full'):
                self.app.save(newer, revision(self.document))
        self.assertEqual(self.paths.layout.read_bytes(), before)
        with self.assertRaises(server.APIError) as error:
            self.app.save(newer, 'stale revision')
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(list_archives(self.paths), [])

    def test_noop_save_keeps_bytes_and_does_not_fill_history(self):
        before = self.paths.layout.read_bytes()
        result = self.app.save(self.document, revision(self.document))
        self.assertIsNone(result['archive'])
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertEqual(list_archives(self.paths), [])

    def test_old_running_runtime_cannot_receive_unsupported_widgets(self):
        import layout_cli
        proposed = layout_cli.generate({'widgets': [{'template': 'clock'}]})
        status = {'pid': os.getpid(), 'processStart': server.process_start(os.getpid())}
        self.paths.runtime_dir.mkdir()
        self.paths.status.write_text(json.dumps(status))
        before = self.paths.layout.read_bytes()
        with self.assertRaisesRegex(server.APIError, 'runtime needs an update'):
            self.app.save(proposed, revision(self.document))
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertEqual(list_archives(self.paths), [])
        status['supportedWidgetTypes'] = ['metric', 'weather', 'clock', 'text', 'gauge']
        self.paths.status.write_text(json.dumps(status))
        result = self.app.save(proposed, revision(self.document))
        self.assertIsNotNone(result['archive'])

    def test_mounted_storage_requires_runtime_support_and_archives_before_apply(self):
        import layout_cli
        proposed = layout_cli.generate({'widgets': [{'template': 'mounted-storage-wide'}]})
        status = {'pid': os.getpid(), 'processStart': server.process_start(os.getpid()),
                  'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge']}
        self.paths.runtime_dir.mkdir()
        self.paths.status.write_text(json.dumps(status))
        before = self.paths.layout.read_bytes()
        with self.assertRaisesRegex(server.APIError, 'runtime needs an update'):
            self.app.save(proposed, revision(self.document))
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertEqual(list_archives(self.paths), [])
        status['supportedWidgetTypes'].append('storage')
        self.paths.status.write_text(json.dumps(status))
        with self.assertRaisesRegex(server.APIError, 'runtime needs an update before saving storage views'):
            self.app.save(proposed, revision(self.document))
        self.assertEqual(self.paths.layout.read_bytes(), before)
        self.assertEqual(list_archives(self.paths), [])
        status['supportedStorageViews'] = ['drives', 'partitions']
        self.paths.status.write_text(json.dumps(status))
        self.assertIsNotNone(self.app.save(proposed, revision(self.document))['archive'])

    def test_old_running_runtime_cannot_receive_usage_sources_or_create_an_archive(self):
        import layout_cli
        proposed = layout_cli.generate({'widgets': [{'template': 'codex-tokens'}]})
        status = {'pid': os.getpid(), 'processStart': server.process_start(os.getpid()),
                  'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge']}
        self.paths.runtime_dir.mkdir()
        before = self.paths.layout.read_bytes()
        for supported in (None, 'codex-tokens', ['storage']):
            status['supportedUsageSources'] = supported
            self.paths.status.write_text(json.dumps(status))
            with self.assertRaisesRegex(server.APIError, 'runtime needs an update'):
                self.app.save(proposed, revision(self.document))
            self.assertEqual(self.paths.layout.read_bytes(), before)
            self.assertEqual(list_archives(self.paths), [])
        status['supportedUsageSources'] = ['codex-tokens']
        self.paths.status.write_text(json.dumps(status))
        self.assertIsNotNone(self.app.save(proposed, revision(self.document))['archive'])

    def test_old_runtime_style_guard_preserves_bytes_and_archives(self):
        import layout_cli
        proposed = layout_cli.generate({'widgets': [{'template': 'cpu-ring'}]})
        status = {'pid': os.getpid(), 'processStart': server.process_start(os.getpid()),
                  'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge']}
        self.paths.runtime_dir.mkdir()
        before = self.paths.layout.read_bytes()
        for supported in (None, 'ring', ['arc']):
            with self.subTest(supported=supported):
                status['supportedGaugeStyles'] = supported
                self.paths.status.write_text(json.dumps(status))
                with self.assertRaisesRegex(server.APIError, 'runtime needs an update'):
                    self.app.save(proposed, revision(self.document))
                self.assertEqual(self.paths.layout.read_bytes(), before)
                self.assertEqual(list_archives(self.paths), [])
        status['supportedGaugeStyles'] = ['ring']
        self.paths.status.write_text(json.dumps(status))
        result = self.app.save(proposed, revision(self.document))
        self.assertIsNotNone(result['archive'])

    def test_explicit_arc_also_requires_style_capability(self):
        import layout_cli
        proposed = layout_cli.generate({'widgets': [{'template': 'cpu-gauge', 'settings': {'style': 'arc'}}]})
        self.paths.runtime_dir.mkdir()
        self.paths.status.write_text(json.dumps({'pid': os.getpid(),
            'processStart': server.process_start(os.getpid()),
            'supportedWidgetTypes': ['metric', 'weather', 'clock', 'text', 'gauge']}))
        with self.assertRaisesRegex(server.APIError, 'runtime needs an update'):
            self.app.save(proposed, revision(self.document))
        self.assertEqual(list_archives(self.paths), [])

    def test_separate_app_writers_share_revision_lock(self):
        second = server.StudioApplication(self.paths)
        barrier = threading.Barrier(2)
        def save(item):
            app, name = item
            barrier.wait(timeout=5)
            try:
                app.save({**self.document, 'name': name}, revision(self.document))
                return 200
            except server.APIError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, [(self.app, 'First'), (second, 'Second')]))
        self.assertEqual(sorted(results), [200, 409])
        self.assertEqual(len(list_archives(self.paths)), 1)

    def test_archive_paths_reject_traversal_and_symlinks(self):
        metadata = archive_layout(self.paths, self.paths.layout.read_bytes())
        for identifier in ('../layout.json', 'original-dashboard', '/', metadata['id'] + '/..'):
            with self.assertRaises(ValueError):
                read_archive(self.paths, identifier)
        directory = self.paths.older_configs / metadata['id']
        (directory / 'layout.json').unlink()
        (directory / 'layout.json').symlink_to(self.paths.layout)
        with self.assertRaises(ValueError):
            read_archive(self.paths, metadata['id'])

    def test_changed_archive_cannot_silently_restore_different_content(self):
        metadata = archive_layout(self.paths, self.paths.layout.read_bytes())
        path = self.paths.older_configs / metadata['id'] / 'layout.json'
        changed = {**self.document, 'name': 'Tampered archive'}
        path.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, 'checksum'):
            read_archive(self.paths, metadata['id'])

    def test_original_source_and_configuration_are_preserved_once(self):
        live, config = self.root / 'dashboard', self.root / 'systemd'
        live.mkdir(); config.mkdir()
        (live / 'dashboard.py').write_text('original renderer')
        (live / 'stats.py').write_text('original collector')
        (live / 'requirements.txt').write_text('Pillow')
        (live / 'log.log').write_text('not an older configuration')
        (live / '.venv').mkdir()
        (config / 'turzx-dashboard.service').write_text('ExecStart=original')
        dropins = config / 'turzx-dashboard.service.d'; dropins.mkdir()
        (dropins / 'override.conf').write_text('original override')
        (dropins / 'turzx-studio.conf').write_text('new adapter')
        destination = snapshot_original_dashboard(self.paths, live, config)
        self.assertEqual((destination / 'dashboard/dashboard.py').read_text(), 'original renderer')
        self.assertEqual((destination / 'service/override.conf').read_text(), 'original override')
        self.assertFalse((destination / 'service/turzx-studio.conf').exists())
        self.assertFalse((destination / 'dashboard/log.log').exists())
        self.assertFalse((destination / 'dashboard/.venv').exists())
        (live / 'dashboard.py').write_text('later change')
        self.assertEqual(snapshot_original_dashboard(self.paths, live, config), destination)
        self.assertEqual((destination / 'dashboard/dashboard.py').read_text(), 'original renderer')
        self.assertEqual(parse_layout((destination / 'studio-layout-at-snapshot.json').read_text()), self.document)

    def test_failed_original_snapshot_does_not_publish_partial_folder(self):
        live, config = self.root / 'dashboard', self.root / 'systemd'
        live.mkdir(); config.mkdir()
        (live / 'dashboard.py').write_text('original')
        (config / 'turzx-dashboard.service').write_text('service')
        with patch('turzx_studio.archives.shutil.copy2', side_effect=OSError('copy failed')):
            with self.assertRaisesRegex(OSError, 'copy failed'):
                snapshot_original_dashboard(self.paths, live, config)
        self.assertFalse((self.paths.older_configs / 'original-dashboard').exists())
        self.assertEqual(list(self.paths.older_configs.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
