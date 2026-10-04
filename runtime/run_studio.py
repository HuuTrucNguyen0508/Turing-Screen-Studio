"""Use the existing dashboard's Pillow environment when available."""
import os
from pathlib import Path
import sys

python = Path(os.environ.get('TURZX_PYTHON', str(Path.home() / 'Documents/dashboard/.venv/bin/python')))
if not python.is_file():
    python = Path(sys.executable)
os.execv(str(python), [str(python), str(Path(__file__).with_name('server.py')), *sys.argv[1:]])
