"""Bounded readings shared by the existing runtime and the editor.

This module samples caller-supplied stats. It never opens sensors or USB.
"""
from collections import deque
from copy import deepcopy
import math
import time
from types import SimpleNamespace

MAX_HISTORY = 120
MAX_AGE = 15
SOURCE_FIELDS = {
    'cpu': ('cpu_percent', 'CPU load', '%'),
    'gpu': ('gpu_percent', 'GPU load', '%'),
    'memory': ('ram_percent', 'Memory usage', '%'),
    'disk': ('disk_percent', 'Disk usage', '%'),
    'network-down': ('net_down_kbps', 'Download', 'KB/s'),
    'network-up': ('net_up_kbps', 'Upload', 'KB/s'),
    'cpu-temperature': ('cpu_temp', 'CPU temperature', '°C'),
    'gpu-temperature': ('gpu_temp', 'GPU temperature', '°C'),
}
NUMBER_FIELDS = tuple(dict.fromkeys([item[0] for item in SOURCE_FIELDS.values()] + [
    'cpu_freq_mhz', 'gpu_vram_used_mb', 'gpu_vram_total_mb', 'ram_used_gb',
    'ram_total_gb', 'disk_used_gb', 'disk_total_gb', 'weather_temp_c',
    'weather_feels_like_c', 'weather_humidity', 'weather_wind_kmh',
]))
TEXT_FIELDS = ('cpu_name', 'gpu_name', 'wifi_iface', 'clock', 'weather_city',
               'weather_country', 'weather_description', 'weather_error')


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return value if math.isfinite(value) else None
    except OverflowError:
        return None


class LiveHistory:
    def __init__(self, clock=time.time):
        self.clock = clock
        self.observed_at = None
        self.stats = {}
        self.histories = {source: deque(maxlen=MAX_HISTORY) for source in SOURCE_FIELDS}

    def observe(self, stats):
        if stats is None:
            return False
        now = self.clock()
        previous = self.observed_at
        if previous is not None and 0 <= now - previous < 1:
            return False
        if previous is not None and now < previous:
            for history in self.histories.values():
                history.clear()
        elif previous is not None and now - previous > MAX_AGE:
            for history in self.histories.values():
                history.append(None)
        self.stats = {field: number(getattr(stats, field, None)) for field in NUMBER_FIELDS}
        self.stats.update({field: str(getattr(stats, field, '') or '')[:256] for field in TEXT_FIELDS})
        for source, (field, _, _) in SOURCE_FIELDS.items():
            self.histories[source].append(self.stats[field])
        self.observed_at = now
        return True

    def snapshot(self, pid, process_start):
        return {'version': 1, 'pid': pid, 'processStart': process_start,
                'observedAt': self.observed_at, 'stats': dict(self.stats),
                'history': {key: list(values) for key, values in self.histories.items()}}


def validate_snapshot(raw):
    if not isinstance(raw, dict) or raw.get('version') != 1:
        raise ValueError('Live readings have an unsupported format.')
    observed = number(raw.get('observedAt'))
    if observed is None or observed < 0 or type(raw.get('pid')) is not int or raw['pid'] <= 0:
        raise ValueError('Live readings have an invalid observation.')
    if not isinstance(raw.get('processStart'), str) or not raw['processStart'].isascii() or not raw['processStart'].isdecimal():
        raise ValueError('Live readings have an invalid runtime identity.')
    stats, history = raw.get('stats'), raw.get('history')
    if not isinstance(stats, dict) or not isinstance(history, dict):
        raise ValueError('Live readings are incomplete.')
    checked = {}
    for field in NUMBER_FIELDS:
        value = stats.get(field)
        if value is not None and number(value) is None:
            raise ValueError('Live readings contain an invalid number.')
        checked[field] = value
    for field in TEXT_FIELDS:
        value = stats.get(field, '')
        if not isinstance(value, str) or len(value) > 256:
            raise ValueError('Live readings contain invalid text.')
        checked[field] = value
    histories = {}
    for source in SOURCE_FIELDS:
        values = history.get(source, [])
        if not isinstance(values, list) or len(values) > MAX_HISTORY or any(value is not None and number(value) is None for value in values):
            raise ValueError('Live readings contain invalid history.')
        histories[source] = list(values)
    return {'version': 1, 'pid': raw['pid'], 'processStart': raw['processStart'],
            'observedAt': observed, 'stats': checked, 'history': histories}


def snapshot_stats(snapshot):
    checked = validate_snapshot(snapshot)
    return SimpleNamespace(**deepcopy(checked['stats']), studio_history=deepcopy(checked['history']))


class HistoryStats:
    def __init__(self, stats, histories):
        self._stats = stats
        self.studio_history = {source: list(values) for source, values in histories.items()}

    def __getattr__(self, name):
        return getattr(self._stats, name)


def source_diagnostics(snapshot, *, stale=False):
    checked = validate_snapshot(snapshot)
    rows = []
    for source, (field, label, unit) in SOURCE_FIELDS.items():
        value = checked['stats'].get(field)
        rows.append({'id': source, 'label': label, 'value': value, 'unit': unit,
                     'status': 'stale' if stale else 'unavailable' if value is None else 'ok',
                     'observedAt': checked['observedAt'],
                     'samples': sum(value is not None for value in checked['history'][source])})
    for source, field, label in [('clock', 'clock', 'Clock'), ('weather', 'weather_temp_c', 'Weather')]:
        value = checked['stats'].get(field)
        missing = value is None or value == '' or source == 'weather' and bool(checked['stats']['weather_error'])
        rows.append({'id': source, 'label': label, 'value': value, 'unit': '°C' if source == 'weather' else '',
                     'status': 'stale' if stale else 'unavailable' if missing else 'ok',
                     'observedAt': checked['observedAt'], 'samples': 0})
    return rows
