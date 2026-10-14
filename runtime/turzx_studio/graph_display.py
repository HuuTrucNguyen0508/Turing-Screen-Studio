"""History graph geometry mirrored by src/domain/graph.ts."""

import math

from .list_display import SENSOR_SHORT_LABELS, card_kicker
from .trend import (demo_trend_history, format_reading, gauge_number, trend_history, trend_range,
                    trend_segments, trend_state, trend_unit)

GRAPH_SERIES_ROLES = ('primary', 'secondary')
GRAPH_AREA_MIX = .24


def graph_geometry(width, height):
    padding, top, bottom = min(29, width // 6), 124, height - 48
    return {'left': padding, 'right': width - padding, 'top': top, 'bottom': bottom,
            'middle': (top + bottom) // 2, 'captionY': height - 20,
            'showChart': width >= 160 and bottom - top >= 32}


def graph_ranges(sources, histories):
    if len({trend_unit(source) for source in sources}) == 1:
        value_range = list(trend_range(sources[0], [item for history in histories for item in history]))
        return True, [value_range for _ in sources]
    return False, [list(trend_range(source, history)) for source, history in zip(sources, histories)]


def _round(value):
    return math.floor(value + .5)


def dashed_line(points, dash=8, gap=5):
    dashes, current, phase = [], points[:1], 0
    for a, b in zip(points, points[1:]):
        length = math.sqrt((b['x'] - a['x']) ** 2 + (b['y'] - a['y']) ** 2)
        travelled = 0
        while travelled < length:
            drawing = phase < dash
            boundary = dash if drawing else dash + gap
            reached = boundary - phase <= length - travelled
            if reached:
                travelled += boundary - phase
                phase = boundary
            else:
                phase += length - travelled
                travelled = length
            point = {'x': _round(a['x'] + (b['x'] - a['x']) * travelled / length),
                     'y': _round(a['y'] + (b['y'] - a['y']) * travelled / length)}
            if drawing:
                current.append(point)
            if drawing and reached:
                if len(current) > 1:
                    dashes.append(current)
                current = []
            if not drawing and reached:
                phase = 0
                current = [point]
    if len(current) > 1:
        dashes.append(current)
    return dashes


def graph_chart(label, sources, inputs, width, height):
    geometry = graph_geometry(width, height)
    histories = [trend_history(inputs[index] if index < len(inputs) else None) for index in range(len(sources))]
    shared, ranges = graph_ranges(sources, histories)
    series = []
    for index, source in enumerate(sources):
        history = histories[index]
        segments = trend_segments(history, ranges[index], geometry)
        last_value = next((item for item in reversed(history) if item is not None), None)
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
        lines = [line for segment in segments if len(segment) > 1
                 for line in ([segment] if primary else dashed_line(segment))]
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
        inputs = [demo_trend_history(source) for source in sources]
    else:
        histories = getattr(stats, 'studio_history', {})
        inputs = [histories.get(source, []) if isinstance(histories, dict) else [] for source in sources]
    return graph_chart(settings['label'], sources, inputs, width, height)
