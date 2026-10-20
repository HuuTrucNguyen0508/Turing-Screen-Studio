"""Serve the browser test build with disposable Studio state and no USB access."""
from pathlib import Path
import os
import signal
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "runtime"))
from python_runner import interpreter

if "--serve" not in sys.argv:
    python = str(interpreter(ROOT))
    os.execv(python, [python, __file__, "--serve"])


def stop(*args):
    raise SystemExit(0)


signal.signal(signal.SIGTERM, stop)

with TemporaryDirectory(prefix="studio-e2e-") as directory:
    root = Path(directory)
    sys.argv = [
        str(ROOT / "runtime/server.py"), "--port", "4176",
        "--state-dir", str(root / "state"), "--runtime-dir", str(root / "runtime"),
        "--dist", str(ROOT / "dist"),
    ]
    from server import main
    main()
