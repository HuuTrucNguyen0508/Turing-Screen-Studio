import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from python_runner import interpreter


class PythonRunnerTests(unittest.TestCase):
    def test_local_environment_precedes_legacy_and_explicit_override_precedes_both(self):
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True):
            root = Path(tmp)
            local = root / '.venv/bin/python'
            local.parent.mkdir(parents=True)
            local.touch()
            explicit = root / 'chosen-python'
            explicit.touch()
            self.assertEqual(interpreter(root), local)
            with patch.dict(os.environ, {'TURZX_PYTHON': str(explicit)}):
                self.assertEqual(interpreter(root), explicit)
            with patch.dict(os.environ, {'TURZX_PYTHON': str(root / 'missing')}):
                with self.assertRaisesRegex(SystemExit, 'existing Python'):
                    interpreter(root)

    def test_current_interpreter_is_used_without_project_or_legacy_environment(self):
        with TemporaryDirectory() as tmp, patch.dict(os.environ, {}, clear=True), patch('python_runner.Path.home', return_value=Path(tmp)), patch('python_runner.sys.executable', '/usr/bin/python3'):
            self.assertEqual(interpreter(Path(tmp)), Path('/usr/bin/python3'))
