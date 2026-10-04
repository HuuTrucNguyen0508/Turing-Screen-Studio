"""Sample the dashboard service without opening USB or changing its state."""
import argparse
import json
from pathlib import Path
import subprocess
import time

import psutil

parser = argparse.ArgumentParser()
parser.add_argument('--seconds', type=int, default=60)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--baseline', type=Path)
args = parser.parse_args()
if args.seconds < 60:
    parser.error('Use at least 60 seconds for a comparable idle window.')
pid = int(subprocess.check_output(['systemctl', '--user', 'show', 'turzx-dashboard.service', '-p', 'MainPID', '--value']))
process = psutil.Process(pid)
start = time.monotonic()
cpu_before = sum(process.cpu_times()[:2])
memory = []
for _ in range(args.seconds):
    memory.append(process.memory_info().rss)
    time.sleep(1)
elapsed = time.monotonic() - start
result = {'pid': pid, 'seconds': elapsed, 'cpu_percent': 100 * (sum(process.cpu_times()[:2]) - cpu_before) / elapsed,
          'rss_mib': max(memory) / 1048576, 'acceptance': 'CPU increase <=2 percentage points; RSS increase <=25 MiB'}
if args.baseline:
    baseline = json.loads(args.baseline.read_text())
    result['cpu_change_points'] = result['cpu_percent'] - baseline['cpu_percent']
    result['rss_change_mib'] = result['rss_mib'] - baseline['rss_mib']
    result['passed'] = result['cpu_change_points'] <= 2 and result['rss_change_mib'] <= 25
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
raise SystemExit(0 if result.get('passed', True) else 1)
