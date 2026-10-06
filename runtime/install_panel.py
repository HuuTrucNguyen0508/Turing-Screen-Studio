"""Install or remove a separate override for the existing user service."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
from turzx_studio.archives import snapshot_original_dashboard
from turzx_studio.storage import Paths


def systemctl(*args):
    subprocess.run(['systemctl', '--user', *args], check=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    service = 'turzx-dashboard.service'
    config = Path.home() / '.config/systemd/user'
    override = config / f'{service}.d/turzx-studio.conf'
    if args.rollback:
        override.unlink(missing_ok=True)
        systemctl('daemon-reload')
        systemctl('restart', service)
        print('Original dashboard restored. Saved Studio layouts are kept.')
        return
    live = Path.home() / 'Documents/dashboard'
    python = live / '.venv/bin/python'
    if not (config / service).is_file() or not python.is_file() or not (live / 'dashboard.py').is_file():
        raise SystemExit('The existing dashboard and user service are required. See docs/panel-integration.md.')
    # Prove the adapter can import before changing the unit. No USB is opened.
    subprocess.run([str(python), '-c', 'import turzx_studio.integration'],
                   cwd=root / 'runtime', check=True)
    original = snapshot_original_dashboard(Paths(), live, config,
        Path.home() / 'Documents/turing-smart-screen-python/library/lcd/lcd_comm_turing_usb.py',
        Path.home() / '.config/turzx/config.json')
    backup = Path.home() / '.local/share/turzx-studio/backups' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup.mkdir(parents=True, mode=0o700)
    shutil.copy2(config / service, backup / service)
    if override.exists():
        shutil.copy2(override, backup / override.name)
    state = Path.home() / '.local/share/turzx-studio/layout.json'
    if state.exists():
        shutil.copy2(state, backup / state.name)
    before = subprocess.check_output(['systemctl', '--user', 'cat', service])
    (backup / 'service-before.txt').write_bytes(before)
    override.parent.mkdir(parents=True, exist_ok=True)
    def quote(path):
        return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    temporary = override.with_suffix('.tmp')
    temporary.write_text(f'[Service]\nExecStart=\nExecStart={quote(python)} {quote(root / "runtime/launch_dashboard.py")}\n')
    temporary.replace(override)
    try:
        systemctl('daemon-reload')
        systemctl('restart', service)
        systemctl('is-active', service)
    except subprocess.CalledProcessError:
        if (backup / override.name).exists():
            shutil.copy2(backup / override.name, override)
        else:
            override.unlink(missing_ok=True)
        systemctl('daemon-reload')
        systemctl('restart', service)
        raise
    print(f'Studio renderer installed. Original dashboard: {original}. Previous configuration: {backup}')


if __name__ == '__main__':
    main()
