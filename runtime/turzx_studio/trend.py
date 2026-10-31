"""Trend geometry mirrored by src/domain/trend.ts. No collectors or I/O."""

import math

from .card_text import card_padding

TREND_CAPACITY = 120
TREND_SOURCES = ('cpu', 'gpu', 'memory', 'disk', 'network-down', 'network-up', 'cpu-temperature', 'gpu-temperature')
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


def trend_range(source, history):
    if source in PERCENTAGE_SOURCES:
        return 0, 100
    numbers = [item for item in history if item is not None]
    return min([0, *numbers]), max([1, *numbers])


def trend_segments(history, value_range, box):
    minimum, maximum = value_range
    segments, segment = [], []
    scale = max(abs(minimum), abs(maximum), 1)
    for index, item in enumerate(history):
        if item is None:
            if segment:
                segments.append(segment)
            segment = []
            continue
        fraction = min(1, max(0, (item / scale - minimum / scale) / (maximum / scale - minimum / scale)))
        segment.append({'x': math.floor(box['left'] + (TREND_CAPACITY - len(history) + index) * (box['right'] - box['left']) / (TREND_CAPACITY - 1) + .5),
                        'y': math.floor(box['bottom'] - fraction * (box['bottom'] - box['top']) + .5)})
    if segment:
        segments.append(segment)
    return segments


def trend_state(histories, segments):
    if all(item is None for history in histories for item in history):
        return 'No history yet'
    return '' if any(len(points) > 1 for points in segments) else 'Collecting history'


def trend_chart(source, value, width, height):
    history = trend_history(value)
    minimum, maximum = trend_range(source, history)
    padding = card_padding(width)
    box = {'left': padding, 'right': width - padding, 'top': 120, 'bottom': height - 66}
    segments = trend_segments(history, (minimum, maximum), box)
    return {**box, 'captionY': height - 29, 'showChart': width >= 160 and height >= 216,
            'min': minimum, 'max': maximum, 'segments': segments,
            'count': sum(item is not None for item in history), 'state': trend_state([history], segments)}


def gauge_number(value: float) -> str:
    if abs(value) > 1e14:
        return str(value)
    rounded = math.floor(value * 10 + .5) / 10
    return str(int(rounded)) if rounded.is_integer() else str(rounded)


def fixed_number(value, places):
    factor = 10 ** places
    return f"{math.floor(value * factor + .5) / factor:.{places}f}"


def format_reading(source, value):
    unit = trend_unit(source)
    try:
        valid = type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        valid = False
    if not valid:
        return {'value': '—', 'unit': unit}
    if unit == 'KB/s' and value >= 1024:
        return {'value': fixed_number(value / 1024, 1), 'unit': 'MB/s'}
    return {'value': fixed_number(value, 0), 'unit': unit}


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
