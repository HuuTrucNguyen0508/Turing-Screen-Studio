"""Choose an explicit, project-local, legacy, or current Python interpreter."""
import os
from pathlib import Path
import sys


def interpreter(root: Path) -> Path:
    override = os.environ.get('TURZX_PYTHON')
    if override:
        path = Path(override).expanduser()
        if not path.is_file():
            raise SystemExit('TURZX_PYTHON must point to an existing Python executable.')
        return path
    for path in (root / '.venv/bin/python', root / '.venv/Scripts/python.exe',
                 Path.home() / 'Documents/dashboard/.venv/bin/python'):
        if path.is_file():
            return path
    return Path(sys.executable)


def run(script: str) -> None:
    runtime = Path(__file__).resolve().parent
    python = interpreter(runtime.parent)
    os.execv(str(python), [str(python), str(runtime / script), *sys.argv[1:]])
