"""Pure display mapping for local activity and shared game timers."""

from __future__ import annotations

from datetime import datetime
import json
import math
import re
import time

DASHBOARD_SOURCES = ('t3-threads', 'game-resources')
GAME_LABELS = (('genshin', 'Genshin', 'Resin'),
               ('wuwa', 'Wuthering Waves', 'Waveplates'),
               ('zzz', 'Zenless', 'Battery'))


def clean(value, maximum=100):
    return re.sub(r'[\x00-\x1f\x7f]', ' ', value)[:maximum] if isinstance(value, str) else ''


def whole(value, maximum=10000):
    return value if type(value) is int and 0 <= value <= maximum else None


def to_full(value, now):
    try:
        target = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if target.tzinfo is None:
            return 'Time unavailable'
        minutes = max(0, math.ceil((target.timestamp() - now) / 60))
        if minutes == 0:
            return 'Full'
        hours, minutes = divmod(minutes, 60)
        return (f'{hours}h {minutes:02d}m' if hours else f'{minutes}m') + ' to full'
    except (AttributeError, ValueError, OverflowError, OSError):
        return 'Time unavailable'


def anchor_age(value, now):
    try:
        observed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if observed.tzinfo is None:
            return ''
        seconds = now - observed.timestamp()
        if seconds < 0:
            return ''
        if seconds < 60:
            return 'set just now'
        amount, unit = (int(seconds // 86400), 'd') if seconds >= 86400 else (int(seconds // 3600), 'h') if seconds >= 3600 else (int(seconds // 60), 'm')
        return f'set {amount}{unit} ago'
    except (AttributeError, ValueError, OverflowError, OSError):
        return ''


def dashboard_content(widget, stats=None, *, now=None):
    settings = dict(widget['settings'])
    if stats is None:
        return settings
    now = time.time() if now is None else now
    if settings['source'] == 't3-threads':
        snapshot = getattr(stats, 't3_activity', None)
        snapshot = snapshot if isinstance(snapshot, dict) else {}
        status = snapshot.get('status')
        working = whole(snapshot.get('working'), 100000) if status == 'live' else None
        rows = []
        for row in snapshot.get('threads', [])[:5] if isinstance(snapshot.get('threads'), list) else []:
            if isinstance(row, dict) and working is not None:
                rows.append({'title': clean(row.get('title')) or 'Untitled thread',
                             'provider': clean(row.get('provider'), 24),
                             'status': clean(row.get('status'), 24)})
        payload = {'working': working, 'threads': rows,
                   'note': 'Live T3 activity' if working is not None else clean(snapshot.get('note')) or 'T3 activity unavailable'}
        if working is not None:
            observed = clean(snapshot.get('observedAt'), 40)
            if observed:
                payload['note'] += ' · ' + observed[11:16] + ' UTC'
        settings.update(value=str(working) if working is not None else '—', unit='working',
                        detail=json.dumps(payload, ensure_ascii=True, allow_nan=False))
        return settings
    snapshot = getattr(stats, 'game_resources', None)
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    input_rows = snapshot.get('games', [])
    rows = {row.get('id'): row for row in input_rows[:3] if isinstance(row, dict)} if isinstance(input_rows, list) else {}
    games = []
    for game_id, name, resource in GAME_LABELS:
        row = rows.get(game_id, {})
        status = row.get('status')
        current = whole(row.get('current')) if status in ('estimate', 'full') else None
        capacity = whole(row.get('capacity'))
        if current is not None:
            remaining = 'Above cap' if capacity is not None and current > capacity else 'Full' if status == 'full' else to_full(row.get('fullAt'), now)
        elif status == 'not-configured':
            remaining = 'Set in Game timers'
        else:
            remaining = 'Check timer · clock ahead' if clean(row.get('note')).startswith('Check timer') else 'Timer unavailable'
        games.append({'name': name, 'resource': resource, 'current': current,
                      'capacity': capacity, 'remaining': remaining,
                      'status': 'estimate' if current is not None else 'not-configured' if status == 'not-configured' else 'unavailable',
                      'age': anchor_age(row.get('observedAt'), now) if current is not None else ''})
    settings.update(value='', unit='', detail=json.dumps({'games': games, 'note': 'Timer estimates · update after spending'}, ensure_ascii=True, allow_nan=False))
    return settings


class DashboardStats:
    def __init__(self, parent, activity=None, games=None):
        self.parent = parent
        self.t3_activity = activity
        self.game_resources = games

    def __getattr__(self, name):
        return getattr(self.parent, name, None)


def dashboard_rows(detail):
    try:
        value = json.loads(detail) if len(detail) <= 32768 else {}
    except (ValueError, TypeError, RecursionError):
        value = {}
    value = value if isinstance(value, dict) else {}
    working = whole(value.get('working'), 100000)
    input_threads = value.get('threads', [])
    threads = [{'title': clean(row.get('title')) or 'Untitled thread',
                'provider': clean(row.get('provider'), 24), 'status': clean(row.get('status'), 24)}
               for row in input_threads[:5] if isinstance(row, dict)] if isinstance(input_threads, list) and working is not None else []
    input_games = value.get('games', [])
    games = [{'name': clean(row.get('name')), 'resource': clean(row.get('resource')),
              'current': whole(row.get('current')) if row.get('status') in ('estimate', 'full', 'demo') else None,
              'capacity': whole(row.get('capacity')), 'remaining': clean(row.get('remaining')),
              'status': clean(row.get('status'), 24), 'age': clean(row.get('age'), 24)}
             for row in input_games[:3] if isinstance(row, dict)] if isinstance(input_games, list) else []
    return {'working': working, 'threads': threads, 'games': games, 'note': clean(value.get('note'))}


def dashboard_geometry(width, height, source):
    padding = min(28, max(4, width // 8))
    threads = source == 't3-threads'
    stride = 46 if threads else min(90, max(1, (height - 74) // 3))
    capacity = max(0, min(5, (height - 150) // stride)) if threads else 3 if stride >= 44 else 0
    return {'padding': padding, 'top': 168 if threads else 58, 'stride': stride,
            'capacity': capacity, 'available': max(1, width - padding * 2)}


def short_dashboard_text(text, available, size, mono=False):
    capacity = max(1, math.floor(available / (size * (.6 if mono else .55))))
    return text if len(text) <= capacity else text[:capacity - 1] + '…'
