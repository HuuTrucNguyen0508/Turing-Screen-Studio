"""Measure sample/live preview and telemetry work without sensors or USB."""
import argparse
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import time
from types import SimpleNamespace

from server import StudioApplication, process_start
from turzx_studio.live import LiveHistory
from turzx_studio.storage import Paths, atomic_write


def measure(action, iterations):
    wall, cpu = time.perf_counter(), time.process_time()
    observed_rss = resident_mib()
    for _ in range(iterations):
        action()
        observed_rss = max(observed_rss, resident_mib())
    return {'iterations': iterations, 'mean_wall_ms': (time.perf_counter() - wall) * 1000 / iterations,
            'mean_cpu_ms': (time.process_time() - cpu) * 1000 / iterations,
            'observed_rss_mib': observed_rss}


def resident_mib():
    # ru_maxrss can include a launcher peak inherited across exec on Linux.
    return int(Path('/proc/self/statm').read_text().split()[1]) * os.sysconf('SC_PAGE_SIZE') / 1048576


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--iterations', type=int, default=30)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.iterations <= 1000:
        parser.error('iterations must be between 1 and 1000')
    with TemporaryDirectory(prefix='turzx-preview-measure-') as directory:
        paths = Paths(Path(directory) / 'state', Path(directory) / 'run')
        app = StudioApplication(paths)
        document = app.layout()['document']
        pid, start = os.getpid(), process_start(os.getpid())
        stats = SimpleNamespace(cpu_percent=24, gpu_percent=18, ram_percent=39,
                                ram_used_gb=12.5, ram_total_gb=32, weather_temp_c=18,
                                weather_city='Preview fixture', clock='Wednesday 12:34')
        now = time.time() - 120
        history = LiveHistory(lambda: now)
        for _ in range(120):
            now += 1
            history.observe(stats)
        atomic_write(paths.status, json.dumps({'pid': pid, 'processStart': start}).encode())
        def publish():
            nonlocal now
            now = time.time()
            atomic_write(paths.live, json.dumps(history.snapshot(pid, start), allow_nan=False).encode())
        publish()
        app.preview(document)  # Warm the shared font cache.
        sample = measure(lambda: app.preview(document), args.iterations)
        sample_rss = sample['observed_rss_mib']
        publish()
        app.preview(document, live=True)  # Warm the read-only usage cache.
        live = measure(lambda: app.preview(document, live=True), args.iterations)
        live_rss = live['observed_rss_mib']
        telemetry = measure(publish, max(120, args.iterations))
        result = {'scope': 'Offline fixture, existing PIL renderer. No sensors, USB or service changes.',
                  'sample_preview': sample, 'live_preview': live, 'telemetry_publish': telemetry,
                  'telemetry_bytes': paths.live.stat().st_size,
                  'telemetry_cpu_points_at_2_seconds': telemetry['mean_cpu_ms'] / 20,
                  'sample_observed_rss_mib': sample_rss, 'live_observed_rss_mib': live_rss,
                  'incremental_observed_rss_mib': max(0, live_rss - sample_rss),
                  'history_capacity': 120,
                  'limitations': 'RSS is sampled between requests, not an allocation peak. Running-service baseline is measured separately. Updated adapter resource use on the physical panel requires activation.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
