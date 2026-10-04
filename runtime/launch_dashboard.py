"""Entry point for the existing turzx-dashboard.service."""
from pathlib import Path
import fcntl
import json
import os
import sys


def publish_adapter_failure(error, paths=None):
    from turzx_studio.storage import Paths, atomic_write
    paths = paths or Paths()
    pid = os.getpid()
    status = {'pid': pid, 'processStart': Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19],
              'connected': False, 'appliedRevision': None, 'frameRevision': None, 'frameTime': None,
              'view': 'stats', 'error': f'Studio adapter unavailable; using original dashboard: {error}'}
    atomic_write(paths.status, (json.dumps(status) + '\n').encode())
    paths.frame.unlink(missing_ok=True)


def install_adapter(dashboard):
    try:
        from turzx_studio.integration import RuntimeIntegration
        from library.lcd import lcd_comm_turing_usb
        integration = RuntimeIntegration()
        integration.install(dashboard, lcd_comm_turing_usb)
    except Exception as error:
        try:
            publish_adapter_failure(error)
        except Exception as status_error:
            print(f'Studio adapter failure status unavailable: {status_error}', flush=True)
        print(f'Studio adapter unavailable; using original dashboard: {error}', flush=True)
        return False
    return True


def main():
    live = Path.home() / 'Documents/dashboard'
    sys.path.insert(0, str(live))
    import dashboard
    import renderer
    for module in (dashboard, renderer):
        if Path(module.__file__).resolve().parent != live.resolve():
            raise RuntimeError(f'Unexpected live module: {module.__file__}')
    # Offline previews never acquire USB or publish runtime state.
    if '--preview' in sys.argv:
        return dashboard.main()
    lock_path = Path(os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}')) / 'turzx-panel.lock'
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        install_adapter(dashboard)
        return dashboard.main()


if __name__ == '__main__':
    raise SystemExit(main())
