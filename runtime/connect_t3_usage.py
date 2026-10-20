"""Issue a read-only T3 token so the panel can keep T3's usage cache current."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

from turzx_studio.storage import Paths, atomic_write
from turzx_studio.t3_refresh import RefreshError, request_usage_scan, token_path

LABEL = 'TURZX Studio usage refresh'


def t3_cli() -> str:
    for candidate in (os.environ.get('T3CODE_CLI_PATH'), str(Path.home() / '.t3/bin/t3'), shutil.which('t3')):
        if candidate and Path(candidate).is_file():
            return candidate
    raise SystemExit('The t3 command was not found. Install T3 Code or set T3CODE_CLI_PATH.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ttl', default='365d', help='Token lifetime accepted by `t3 auth session issue` (default 365d).')
    args = parser.parse_args()
    # diagnostics:read is the only scope server.getUsageSummary needs.
    issued = subprocess.run([t3_cli(), 'auth', 'session', 'issue', '--scope', 'diagnostics:read',
                             '--ttl', args.ttl, '--label', LABEL, '--token-only'],
                            capture_output=True, text=True, timeout=60)
    token = issued.stdout.strip()
    if issued.returncode != 0 or not token or len(token.split()) != 1:
        raise SystemExit(f'T3 did not issue a token (exit {issued.returncode}).')
    path = token_path(Paths().state_dir)
    atomic_write(path, (token + '\n').encode())
    print(f'Saved a diagnostics:read token labelled "{LABEL}" to {path}.')
    try:
        request_usage_scan(Path.home(), path)
    except RefreshError as error:
        raise SystemExit(f'Token saved, but the test request failed: {error.code}. Is T3 Code running?')
    print('T3 rescanned usage. The panel now requests a rescan every minute while a usage widget is shown.')
    print('Revoke it later with `t3 auth session list` and `t3 auth session revoke <id>`.')


if __name__ == '__main__':
    main()
