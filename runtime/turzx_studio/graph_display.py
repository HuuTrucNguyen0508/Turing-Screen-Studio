"""History graph geometry mirrored by src/domain/graph.ts."""

import math

from .card_text import SENSOR_SHORT_LABELS, card_kicker, card_padding
from .trend import (format_reading, gauge_number, trend_history, trend_range,
                    trend_segments, trend_state, trend_unit)

GRAPH_SERIES_ROLES = ('primary', 'secondary')
GRAPH_AREA_MIX = .24


def demo_graph_history(source):
    profiles = {'cpu': (24, 12, 0), 'gpu': (18, 10, 12), 'memory': (39, 3, 6), 'disk': (45, 1, 18),
                'network-down': (640, 450, 0), 'network-up': (90, 65, 12),
                'cpu-temperature': (42, 4, 0), 'gpu-temperature': (55, 6, 12)}
    base, amplitude, offset = profiles[source]
    anchors = [-3, 1, 5, 2, -2, -4, -3]
    history = []
    for index in range(120):
        slot = (index + offset) % 120
        segment, t = slot // 20, slot % 20
        blend = t * t * (60 - 2 * t) / 8000
        wave = anchors[segment] + (anchors[segment + 1] - anchors[segment]) * blend
        history.append(math.floor((base + amplitude * wave / 10) * 10 + .5) / 10)
    return history


def graph_range(source, history):
    numbers = [value for value in history if value is not None]
    if not source.endswith('-temperature'):
        return trend_range(source, history)
    if not numbers:
        return [0, 100]
    low, high = min(numbers), max(numbers)
    padding = max(2, math.ceil((high - low) * .15))
    return [math.floor(low - padding), math.ceil(high + padding)]


def graph_geometry(width, height):
    padding, top, bottom = card_padding(width), 144, height - 48
    return {'left': padding, 'right': width - padding, 'top': top, 'bottom': bottom,
            'middle': (top + bottom) // 2, 'rangeY': 130, 'captionY': height - 20,
            'showChart': width >= 160 and bottom - top >= 32}


def graph_ranges(sources, histories):
    if len({trend_unit(source) for source in sources}) == 1:
        value_range = list(graph_range(sources[0], [item for history in histories for item in history]))
        return True, [value_range for _ in sources]
    return False, [list(graph_range(source, history)) for source, history in zip(sources, histories)]


def graph_chart(label, sources, inputs, width, height):
    geometry = graph_geometry(width, height)
    histories = [trend_history(inputs[index] if index < len(inputs) else None) for index in range(len(sources))]
    shared, ranges = graph_ranges(sources, histories)
    series = []
    for index, source in enumerate(sources):
        history = histories[index]
        segments = trend_segments(history, ranges[index], geometry)
        last_value = history[-1] if history else None
        reading = format_reading(source, last_value)
        column = (geometry['right'] - geometry['left']) // len(sources)
        characters = len(reading['value']) * .64 + len(reading['unit']) * .3
        if len(sources) == 1:
            legend = {'x': geometry['left'], 'nameY': None, 'valueY': 92, 'unitSize': 16,
                      'valueSize': max(12, min(36, math.floor(column / max(1, characters))))}
        else:
            legend = {'x': geometry['left'] + index * column, 'nameY': 68, 'valueY': 104, 'unitSize': 14,
                      'valueSize': max(12, min(28, math.floor((column - 8) / max(1, characters + .5))))}
        primary = index == 0
        lines = [segment for segment in segments if len(segment) > 1]
        series.append({'source': source, 'role': GRAPH_SERIES_ROLES[index], 'name': SENSOR_SHORT_LABELS[source],
                       'primary': primary, 'segments': segments, 'lines': lines,
                       'last': None if not history or history[-1] is None or not segments else segments[-1][-1],
                       'reading': reading, 'legend': legend})

    def scale(index):
        return f"{gauge_number(ranges[index][0])}-{gauge_number(ranges[index][1])} {trend_unit(sources[index])}".strip()

    return {**geometry, 'kicker': card_kicker(label, width), 'series': series, 'range': scale(0) if shared else f'{scale(0)} · {scale(1)}',
            'state': trend_state(histories, [points for entry in series for points in entry['segments']])}


def graph_area(points, bottom):
    return [{'x': points[0]['x'], 'y': bottom}, *points, {'x': points[-1]['x'], 'y': bottom}]


def widget_graph(settings, stats, width, height):
    sources = settings['sources']
    if stats is None:
        inputs = [demo_graph_history(source) for source in sources]
    else:
        histories = getattr(stats, 'studio_history', {})
        inputs = [histories.get(source, []) if isinstance(histories, dict) else [] for source in sources]
    return graph_chart(settings['label'], sources, inputs, width, height)
