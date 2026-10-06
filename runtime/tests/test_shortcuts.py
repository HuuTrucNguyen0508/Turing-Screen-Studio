import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import subprocess
import json

from install_shortcuts import END, START, activate_bindings, command, conflicts, install, service, user_config


class ShortcutTests(unittest.TestCase):
    def test_live_lua_bindings_are_checked_and_foreign_actions_are_preserved(self):
        python, root = Path('/python'), Path('/project')
        managed = user_config('', python, root)
        bindings = [{'modmask': 4, 'key': 'F9', 'dispatcher': '__lua', 'arg': '100'}]
        self.assertFalse(conflicts(bindings, managed, python, root, 1))
        self.assertTrue(conflicts(bindings, '', python, root, 1))
        self.assertTrue(conflicts(bindings * 2, managed, python, root, 1))
        active = [{'modmask': 4, 'key': f'F{slot + 8}'} for slot in range(1, 5)]
        with patch('install_shortcuts.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'ok\n')) as run, \
                patch('install_shortcuts.subprocess.check_output', return_value=json.dumps(active)):
            activate_bindings(python, root)
        self.assertEqual(run.call_count, 4)
        self.assertEqual(run.call_args_list[0].args[0][:2], ['hyprctl', 'eval'])
        self.assertIn('hl.unbind("CTRL + F9")', run.call_args_list[0].args[0][2])
        with patch('install_shortcuts.subprocess.run', return_value=subprocess.CompletedProcess([], 0, 'unsupported parser')):
            with self.assertRaises(ValueError):
                activate_bindings(python, root)

    def test_only_managed_block_changes_and_repeated_install_keeps_bindings_unique(self):
        original = 'hl.bind("ALT + F1", "keep this")\n-- Existing user rules\n'
        first = user_config(original, Path('/usr/bin/python'), Path('/project with space'))
        self.assertTrue(first.startswith(original))
        self.assertEqual(first.count('hl.bind("CTRL + F'), 4)
        second = user_config(first, Path('/other/python'), Path('/project with space'))
        self.assertTrue(second.startswith(original))
        self.assertEqual(second.count(START), 1)
        self.assertEqual(second.count(END), 1)
        self.assertEqual(second.count('hl.bind("CTRL + F'), 4)
        self.assertIn('/other/python', second)
        self.assertIn("'/project with space/runtime/layout_cli.py' slot 4", second)

    def test_malformed_blocks_fail_without_replacing_user_configuration(self):
        for original in (START, END, END + '\n' + START, START + END + START + END):
            with self.subTest(original=original), self.assertRaises(ValueError):
                user_config(original, Path('/python'), Path('/project'))

    def test_service_has_no_dashboard_restart_or_usb_command(self):
        data = service(Path('/venv/python'), Path('/project'))
        self.assertIn('runtime/server.py', data)
        self.assertNotIn('launch_dashboard', data)
        self.assertEqual(command(Path('/python'), Path('/project'), 2), '/python /project/runtime/layout_cli.py slot 2')

    def test_install_preserves_existing_user_file_in_backup_and_refuses_foreign_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / '.config/caelestia/hypr-user.lua'
            config.parent.mkdir(parents=True)
            original = b'-- Existing config\n'
            config.write_bytes(original)
            install(home, Path('/python'), Path('/project'))
            backups = list((home / '.local/share/turzx-studio/backups').glob('*/hypr-user.lua'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            unit = home / '.config/systemd/user/turzx-studio.service'
            unit.write_text('[Unit]\nDescription=Unrelated service\n')
            current = config.read_bytes()
            with self.assertRaises(ValueError):
                install(home, Path('/python'), Path('/project'))
            self.assertEqual(config.read_bytes(), current)


if __name__ == '__main__':
    unittest.main()
