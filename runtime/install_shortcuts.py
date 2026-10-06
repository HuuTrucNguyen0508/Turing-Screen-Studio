"""Install four Hyprland dashboard shortcuts and the local Studio API service."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

from turzx_studio.storage import Paths, atomic_write

ROOT = Path(__file__).resolve().parents[1]
START = '-- BEGIN TURZX Studio layout shortcuts'
END = '-- END TURZX Studio layout shortcuts'


def command(python: Path, root: Path, slot: int) -> str:
    return shlex.join([str(python), str(root / 'runtime/layout_cli.py'), 'slot', str(slot)])


def binding(python: Path, root: Path, slot: int) -> str:
    return f'hl.bind("CTRL + F{slot + 8}", hl.dsp.exec_cmd({json.dumps(command(python, root, slot))}))'


def conflicts(bindings: list, previous: str, python: Path, root: Path, slot: int) -> bool:
    matches = [item for item in bindings if item.get('modmask') == 4
               and item.get('key', '').upper() == f'F{slot + 8}']
    if not matches:
        return False
    managed = previous.count(START) == 1 and previous.count(END) == 1
    if managed:
        managed = binding(python, root, slot) in previous.split(START, 1)[1].split(END, 1)[0]
    return len(matches) != 1 or not (
        (matches[0].get('dispatcher') == 'exec' and matches[0].get('arg') == command(python, root, slot))
        or (managed and matches[0].get('dispatcher') == '__lua'))


def user_config(previous: str, python: Path, root: Path) -> str:
    """Replace only our managed block; leave unrelated bindings byte-for-byte."""
    if previous.count(START) != previous.count(END) or previous.count(START) > 1:
        raise ValueError('The existing Studio shortcut block is incomplete. Preserve and repair hypr-user.lua first.')
    block = '\n'.join([START, *[binding(python, root, slot) for slot in range(1, 5)], END])
    if START in previous:
        start, end = previous.index(START), previous.index(END) + len(END)
        if end < start:
            raise ValueError('The existing Studio shortcut block has reversed markers.')
        return previous[:start] + block + previous[end:]
    separator = '' if not previous or previous.endswith('\n') else '\n'
    return previous + separator + '\n' + block + '\n'


def systemd_quote(value: Path) -> str:
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'


def service(python: Path, root: Path) -> str:
    return '\n'.join([
        '[Unit]', 'Description=TURZX Studio local layout API', '',
        '[Service]', 'Type=simple',
        f'ExecStart={systemd_quote(python)} {systemd_quote(root / "runtime/server.py")}',
        'Restart=on-failure', 'RestartSec=3', '',
        '[Install]', 'WantedBy=default.target', '',
    ])


def install(home: Path, python: Path, root: Path) -> None:
    config = home / '.config/caelestia/hypr-user.lua'
    unit = home / '.config/systemd/user/turzx-studio.service'
    previous = config.read_text(encoding='utf-8') if config.exists() else ''
    updated = user_config(previous, python, root)
    unit_data = service(python, root).encode()
    if unit.exists() and unit.read_bytes() != unit_data:
        existing = unit.read_text(encoding='utf-8')
        if 'Description=TURZX Studio local layout API' not in existing:
            raise ValueError('turzx-studio.service already exists with a different configuration. Preserve it and choose a separate unit before installing.')
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backup = Paths(home / '.local/share/turzx-studio').state_dir / 'backups' / f'shortcuts-{stamp}'
    for path in (config, unit):
        if path.exists():
            atomic_write(backup / path.name, path.read_bytes())
    atomic_write(config, updated.encode())
    atomic_write(unit, unit_data)
    print(f'Installed Ctrl+F9 through Ctrl+F12. Previous files preserved in {backup}')


def activate_bindings(python: Path, root: Path) -> None:
    for slot in range(1, 5):
        # Lua configs require eval; keyword returns an error even with exit status zero.
        expression = f'hl.unbind("CTRL + F{slot + 8}"); {binding(python, root, slot)}'
        result = subprocess.run(['hyprctl', 'eval', expression], check=True, capture_output=True, text=True)
        if result.stdout.strip() != 'ok':
            raise ValueError(f'Hyprland could not activate Ctrl+F{slot + 8}: {result.stdout.strip()}')
    active = json.loads(subprocess.check_output(['hyprctl', '-j', 'binds'], text=True))
    for slot in range(1, 5):
        matches = [item for item in active if item.get('modmask') == 4 and item.get('key', '').upper() == f'F{slot + 8}']
        if len(matches) != 1:
            raise ValueError(f'Ctrl+F{slot + 8} has {len(matches)} bindings after installation; inspect before using it.')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-only', action='store_true', help='Prepare configuration without starting services or live bindings')
    args = parser.parse_args()
    home = Path.home()
    python = Path(os.environ.get('TURZX_PYTHON', str(home / 'Documents/dashboard/.venv/bin/python')))
    if not python.is_file():
        python = Path(sys.executable)
    try:
        # Never replace an existing key action. Our own live exec bindings are safe to refresh.
        if not args.write_only and os.environ.get('HYPRLAND_INSTANCE_SIGNATURE'):
            bindings = json.loads(subprocess.check_output(['hyprctl', '-j', 'binds'], text=True))
            config = home / '.config/caelestia/hypr-user.lua'
            previous = config.read_text(encoding='utf-8') if config.exists() else ''
            for slot in range(1, 5):
                if conflicts(bindings, previous, python, ROOT, slot):
                    raise ValueError(f'Ctrl+F{slot + 8} already has an action. Preserve that shortcut before installing Studio bindings.')
        install(home, python, ROOT)
        if not args.write_only:
            subprocess.run(['systemctl', '--user', 'daemon-reload'], check=True)
            subprocess.run(['systemctl', '--user', 'enable', '--now', 'turzx-studio.service'], check=True)
            if os.environ.get('HYPRLAND_INSTANCE_SIGNATURE'):
                activate_bindings(python, ROOT)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f'Cannot install Studio shortcuts: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
