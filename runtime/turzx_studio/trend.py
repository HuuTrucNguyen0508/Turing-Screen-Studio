"""Trend geometry mirrored by src/domain/trend.ts. No collectors or I/O."""

import math

TREND_CAPACITY = 120
PERCENTAGE_SOURCES = ('sample', 'cpu', 'gpu', 'memory', 'disk')


def trend_history(value):
    if not isinstance(value, (list, tuple)):
        return []
    result = []
    for item in value[-TREND_CAPACITY:]:
        try:
            valid = type(item) in (int, float) and math.isfinite(item)
        except OverflowError:
            valid = False
        result.append(float(item) if valid else None)
    return result


def demo_trend_history(source='sample'):
    profiles = {'sample': (24, 12), 'cpu': (24, 12), 'gpu': (18, 10),
                'memory': (39, 3), 'disk': (45, 1), 'network-down': (640, 450),
                'network-up': (90, 65), 'cpu-temperature': (42, 4), 'gpu-temperature': (55, 6)}
    if source not in profiles:
        return []
    base, amplitude = profiles[source]
    return [math.floor((base + amplitude * ((index * 7 % 31) / 30 - .5)) * 10 + .5) / 10
            for index in range(TREND_CAPACITY)]


def trend_unit(source):
    return '%' if source in PERCENTAGE_SOURCES else 'KB/s' if source.startswith('network-') else '°C' if source.endswith('-temperature') else ''


def trend_chart(source, value, width, height):
    history = trend_history(value)
    numbers = [item for item in history if item is not None]
    minimum, maximum = (0, 100) if source in PERCENTAGE_SOURCES else (min([0, *numbers]), max([1, *numbers]))
    padding = min(29, width // 6)
    left, right, top, bottom = padding, width - padding, 120, height - 66
    segments, segment = [], []
    scale = max(abs(minimum), abs(maximum), 1)
    for index, item in enumerate(history):
        if item is None:
            if segment:
                segments.append(segment)
            segment = []
            continue
        fraction = min(1, max(0, (item / scale - minimum / scale) / (maximum / scale - minimum / scale)))
        segment.append({'x': math.floor(left + (TREND_CAPACITY - len(history) + index) * (right - left) / (TREND_CAPACITY - 1) + .5),
                        'y': math.floor(bottom - fraction * (bottom - top) + .5)})
    if segment:
        segments.append(segment)
    state = 'No history yet' if not numbers else '' if any(len(points) > 1 for points in segments) else 'Collecting history'
    return {'left': left, 'right': right, 'top': top, 'bottom': bottom,
            'captionY': height - 29, 'showChart': width >= 160 and height >= 216,
            'min': minimum, 'max': maximum, 'segments': segments, 'count': len(numbers), 'state': state}


def trend_caption(demo):
    return f"Last 120 readings · {'Demo' if demo else 'Observed'}"


def widget_trend(settings, stats, width, height):
    source = settings.get('source', 'sample')
    demo = stats is None
    if demo:
        history = demo_trend_history(source)
    else:
        histories = getattr(stats, 'studio_history', {})
        history = histories.get(source, []) if isinstance(histories, dict) else []
    return trend_chart(source, history, width, height), trend_caption(demo)
