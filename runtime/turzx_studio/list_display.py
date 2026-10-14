"""Multi-metric list geometry mirrored by src/domain/list.ts."""

import math
import re

from .trend import format_reading

SENSOR_SHORT_LABELS = {
    'cpu': 'CPU', 'gpu': 'GPU', 'memory': 'Memory', 'disk': 'Disk', 'network-down': 'Download',
    'network-up': 'Upload', 'cpu-temperature': 'CPU temp', 'gpu-temperature': 'GPU temp',
}
_NUMBER = re.compile(r' *-?[0-9]+(\.[0-9]+)? *')
_FIELDS = {'cpu': 'cpu_percent', 'gpu': 'gpu_percent', 'memory': 'ram_percent', 'disk': 'disk_percent',
           'network-down': 'net_down_kbps', 'network-up': 'net_up_kbps',
           'cpu-temperature': 'cpu_temp', 'gpu-temperature': 'gpu_temp'}


def list_fraction(source, value):
    if source.startswith('network-'):
        return None
    if not _NUMBER.fullmatch(value):
        return 0
    return max(0, min(1, float(value) / 100))


def list_bar_role(source):
    return 'secondary' if source.endswith('-temperature') else 'primary'


def shorten_text(text, capacity):
    return text[:max(0, capacity - 1)] + '…' if len(text) > capacity else text


def card_kicker(label, width):
    return shorten_text(label, max(1, math.floor((width - 2 * min(29, width // 6)) / 8)))


def list_layout(width, height, label, rows, bars):
    padding = min(29, width // 6)
    top = 60 if label else 24
    available = max(0, height - top - 20)
    visible = min(len(rows), available // 24)
    stride = min(88, available // max(1, visible))
    value_size = max(12, min(28, math.floor(stride * .42)))
    label_size = max(12, min(18, math.floor(stride * .3)))
    unit_size = max(11, math.floor(value_size * .5))
    show_bars = bars and stride >= 44
    layouts = []
    for index, row in enumerate(rows[:visible]):
        row_top = top + index * stride
        fraction = list_fraction(row['source'], row['value']) if show_bars else None
        value_width = len(row['value']) * value_size * .6 + 4 + len(row['unit']) * unit_size * .55
        capacity = max(1, math.floor((width - 2 * padding - value_width - 12) / (label_size * .55)))
        layouts.append({
            'label': shorten_text(row['label'].strip() or SENSOR_SHORT_LABELS[row['source']], capacity),
            'value': row['value'], 'unit': row['unit'],
            'baseline': row_top + stride - 26 if show_bars else row_top + stride // 2 + math.floor(value_size * .35),
            'barY': None if fraction is None else row_top + stride - 16, 'fraction': fraction,
        })
    return {'padding': padding, 'top': top, 'stride': stride, 'valueSize': value_size,
            'labelSize': label_size, 'unitSize': unit_size, 'kicker': card_kicker(label, width), 'rows': layouts}


def list_content(settings, stats):
    """Replace sample row values with live readings; stats is None offline."""
    if stats is None:
        return settings
    rows = []
    for row in settings['rows']:
        value = getattr(stats, _FIELDS[row['source']], None)
        rows.append({**row, **format_reading(row['source'], None if isinstance(value, bool) else value)})
    return {**settings, 'rows': rows}
