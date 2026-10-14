"""Month calendar geometry mirrored by src/domain/calendar.ts. No collectors."""

import calendar
import datetime
import math
import re

from .list_display import card_kicker

CALENDAR_SAMPLE_DATE = '2026-10-06'
_MONTHS = ('January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
           'September', 'October', 'November', 'December')
_DAYS = ('Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa')
_CLOCK = re.compile(r'\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b')


def calendar_month(date, week_start):
    match = re.fullmatch(r'(\d{4})-(\d{2})-(\d{2})', date or '')
    if not match:
        return None
    year, month, day = (int(part) for part in match.groups())
    if not 1 <= month <= 12 or year < 1000:
        return None
    length = calendar.monthrange(year, month)[1]
    if not 1 <= day <= length:
        return None
    first = (datetime.date(year, month, 1).weekday() + 1) % 7
    shift = 1 if week_start == 'monday' else 0
    offset = (first - shift + 7) % 7
    cells = [value if 1 <= value <= length else None
             for value in (index - offset + 1 for index in range(math.ceil((offset + length) / 7) * 7))]
    weekdays = [(index + shift) % 7 for index in range(7)]
    return {'title': _MONTHS[month - 1], 'year': str(year),
            'weekdays': [{'name': _DAYS[weekday], 'weekend': weekday in (0, 6)} for weekday in weekdays],
            'weeks': [cells[index:index + 7] for index in range(0, len(cells), 7)], 'today': day}


def calendar_geometry(width, height, label, weeks):
    labelled = label != ''
    padding = min(29, width // 6)
    title_size = max(16, min(28, width // 14))
    title_y = 50 + title_size if labelled else 24 + title_size
    header_y = title_y + 24
    grid_top = header_y + 8
    cell_width = max(1, (width - 2 * padding) // 7)
    cell_height = max(1, min(cell_width, (height - grid_top - 12) // max(1, weeks)))
    return {'padding': padding, 'kicker': card_kicker(label, width), 'titleSize': title_size, 'titleY': title_y, 'headerY': header_y,
            'gridTop': grid_top, 'cellWidth': cell_width, 'cellHeight': cell_height,
            'gridLeft': (width - 7 * cell_width) // 2,
            'daySize': max(10, min(26, math.floor(min(cell_width, cell_height) * .48))),
            'showGrid': cell_height >= 12, 'todayRadius': min(8, min(cell_width, cell_height) // 4)}


def panel_date(clock, today=None):
    """The panel clock carries day and month only ("Tue 06 Oct  10:24"); take the nearest year."""
    match = _CLOCK.search(clock) if isinstance(clock, str) else None
    if not match:
        return None
    today = today or datetime.date.today()
    day, month = int(match.group(1)), [name[:3] for name in _MONTHS].index(match.group(2)) + 1
    candidates = []
    for year in (today.year - 1, today.year, today.year + 1):
        try:
            candidates.append(datetime.date(year, month, day))
        except ValueError:
            continue
    if not candidates:
        return None
    return min(candidates, key=lambda value: abs((value - today).days)).isoformat()


def calendar_content(settings, stats):
    if settings['source'] == 'clock' and stats is not None:
        return {**settings, 'date': panel_date(getattr(stats, 'clock', None), getattr(stats, 'today', None))}
    return {**settings, 'date': CALENDAR_SAMPLE_DATE}
