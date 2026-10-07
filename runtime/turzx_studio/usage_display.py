"""Format collected snapshots; this module performs no I/O."""

from __future__ import annotations

from datetime import datetime, timezone
import math

USAGE_SOURCES = (
    'codex-tokens', 'codex-cost', 'codex-weekly', 'codex-reset', 'codex-models',
    'claude-tokens', 'claude-cost', 'claude-session', 'claude-weekly', 'claude-reset', 'claude-models',
    'usage-tokens-30d', 'usage-cost-30d', 'usage-limits',
    'storage',
)


def _number(value):
    return value if type(value) in (int, float) and math.isfinite(value) else None


def _time(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (AttributeError, ValueError, OverflowError):
        return None


def _stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).strftime('%H:%M UTC')
    except (AttributeError, ValueError):
        return 'time unavailable'


def _count(value):
    if value >= 1_000_000_000:
        return f'{value / 1_000_000_000:.1f}', 'B tokens'
    if value >= 1_000_000:
        return f'{value / 1_000_000:.1f}', 'M tokens'
    if value >= 1000:
        return f'{value / 1000:.1f}', 'K tokens'
    return f'{value:.0f}', 'tokens'


def _mapping(value):
    return value if isinstance(value, dict) else {}


def _nonnegative(value):
    value = _number(value)
    return value if value is not None and value >= 0 else None


def _fresh_state(provider, cost=False):
    freshness = _mapping(provider.get('freshness'))
    tokens = _mapping(freshness.get('tokens'))
    stale = tokens.get('stale', True) or tokens.get('status') in ('stale', 'unavailable')
    if cost and provider.get('costKind') != 'reported' and not _empty_cache(provider):
        pricing = _mapping(freshness.get('pricing'))
        stale = stale or pricing.get('stale', True) or pricing.get('status') == 'unavailable'
    return 'stale' if stale else 'cached'


def _empty_cache(provider):
    tokens = _mapping(_mapping(provider.get('freshness')).get('tokens'))
    return (provider.get('records') == 0 and provider.get('total') == 0
            and tokens.get('status') in ('cached', 'stale'))


def _priced_records(provider):
    return sum(_nonnegative(provider.get(key)) or 0 for key in ('reportedRecords', 'estimatedRecords'))


def _period_cost(provider):
    """Return an amount and whether it covers only the priced records."""
    complete = _nonnegative(provider.get('costUSD'))
    if (complete is not None and provider.get('costKind') in ('reported', 'estimate')
            and not (_nonnegative(provider.get('unpricedRecords')) or 0)):
        return complete, False
    known = _nonnegative(provider.get('knownCostUSD'))
    if known is not None and _priced_records(provider) > 0:
        return known, True
    if _empty_cache(provider):
        return 0, False
    return None, False


def _period_content(snapshot, cost, gauge):
    period = _mapping(_mapping(snapshot.get('periods')).get('last30days'))
    if _mapping(period.get('scope')).get('period', 'last30days') != 'last30days':
        period = {}
    providers = _mapping(period.get('providers'))
    names = ['codex', 'claude']
    cursor = _mapping(providers.get('cursor'))
    # A missing Cursor source cannot establish zero historical consumption.
    if not _empty_cache(cursor) or (_nonnegative(cursor.get('records')) or 0) > 0:
        names.append('cursor')
    amounts, rows, states = [], [], []
    partial = False
    observations = []
    gaps = []
    for name in names:
        provider = _mapping(providers.get(name))
        if cost:
            amount, incomplete = _period_cost(provider)
        else:
            amount, incomplete = _nonnegative(provider.get('total')), False
            if amount == 0 and provider.get('records') == 0 and not _empty_cache(provider):
                amount = None
        partial = partial or incomplete or amount is None
        state = _fresh_state(provider, cost) if amount is not None else 'Unavailable'
        if amount is None:
            gaps.append(name.title())
        if amount is not None:
            observed = _time(_mapping(_mapping(provider.get('freshness')).get('tokens')).get('observedAt'))
            if observed is not None:
                observations.append(observed)
            amounts.append(amount)
            states.append(state)
        if amount is None:
            display = '—'
        elif cost:
            display = f'{amount:.2f}' + ('+' if incomplete else '')
        else:
            count, suffix = _count(amount)
            display = count + (suffix[0] if suffix[0] in 'KMB' else '')
        if incomplete:
            state = 'partial · ' + state
        rows.append(f'{name.title()}\t{display}\t{state}')
    try:
        value = math.fsum(amounts) if amounts else None
    except OverflowError:
        value = None
    unit = 'USD' if cost else 'tokens'
    text = '—'
    if value is None:
        note = ('API estimate unavailable' if cost else 'Usage unavailable') + ' · Last 30 days'
    else:
        text, unit = (f'{value:.2f}', 'USD') if cost else _count(value)
        if partial:
            text += '+'
        label = ('Partial API estimate' if partial else 'API estimate') if cost else ('Partial' if partial else '')
        state = 'stale' if 'stale' in states else 'cached'
        if observations:
            state += ' as of ' + datetime.fromtimestamp(min(observations), timezone.utc).strftime('%d %b %H:%M UTC')
        if gaps:
            label += ' · ' + ', '.join(gaps) + ' unavailable'
        note = ' · '.join(part for part in (label, 'Last 30 days', state) if part)
    if gauge and not cost:
        unit = 'tokens'
    return value, text, unit, '\n'.join([note, *rows])


def _quota_window(limit):
    minutes = _number(limit.get('windowMinutes'))
    if minutes is not None:
        if minutes == 300:
            return 'five_hour'
        if minutes == 10080 and limit.get('accountWeekly', True) and limit.get('id') in ('primary', 'secondary', 'weekly', 'seven_day'):
            return 'weekly'
        return None
    # Older snapshots identified Claude notices by id alone.
    return limit.get('id') if limit.get('id') in ('five_hour', 'weekly') else None


def _quota_reset(limit, now):
    reset = _time(limit.get('resetsAt'))
    estimated = limit.get('resetKind') == 'notice_relative_estimate'
    if reset is None or now is None:
        return 'reset unavailable', False
    if reset <= now:
        return 'reset time passed' + (' · estimate' if estimated else ''), True
    minutes = math.ceil((reset - now) / 60)
    hours, minutes = divmod(minutes, 60)
    days, hours = divmod(hours, 24)
    duration = f'{days}d {hours}h' if days else f'{hours}h {minutes:02d}m' if hours else f'{minutes}m'
    return 'resets ' + duration + (' · estimate' if estimated else ''), False


def _quota_content(snapshot):
    providers = _mapping(snapshot.get('providers'))
    now = _time(snapshot.get('servedAt') or snapshot.get('readAt'))
    rows, observations = [], []
    for name in ('codex', 'claude'):
        provider = _mapping(providers.get(name))
        windows = _mapping(provider.get('quotaWindows'))
        freshness = _mapping(_mapping(provider.get('freshness')).get('limits'))
        limits = provider.get('limits')
        newest = {}
        for limit in limits if isinstance(limits, list) else []:
            if not isinstance(limit, dict):
                continue
            window = _quota_window(limit)
            stamp = _time(limit.get('observedAt'))
            rank = stamp if stamp is not None else -math.inf
            if window and (window not in newest or rank > newest[window][0]):
                newest[window] = rank, limit
        for window, label in (('five_hour', '5-hour'), ('weekly', 'Weekly')):
            if windows.get(window) == 'unsupported':
                continue
            limit = newest.get(window, (None, {}))[1]
            percent = _number(limit.get('usedPercent'))
            known = percent is not None and 0 <= percent <= 100
            reset, passed = _quota_reset(limit, now)
            state = 'stale' if limit.get('stale', True) or freshness.get('stale') or passed else 'cached'
            if not known:
                state = 'Unavailable' + (' · stale' if limit and state == 'stale' else '')
            observed = _time(limit.get('observedAt'))
            if observed is not None:
                observations.append((observed, limit.get('observedAt')))
            display = f'{percent:g}' if known else '-'
            rows.append(f'{name.title()}\t{label}\t{display}\t{reset}\t{state}')
    note = ('Last observations · ' + datetime.fromtimestamp(min(observations)[0], timezone.utc).strftime('%d %b %H:%M UTC')) if observations else 'Quota observations unavailable'
    return None, '—', '', '\n'.join([note, *rows])


def usage_content(widget: dict, snapshot: dict | None) -> dict | None:
    """Return display settings for an opted-in source, never a sample fallback.

    A collector snapshot's servedAt pins countdown formatting to that snapshot.
    Gauge readings remain numeric and unavailable readings remain None.
    """
    settings = dict(widget['settings'])
    source = settings.get('source')
    if source not in USAGE_SOURCES:
        return None
    snapshot = snapshot if isinstance(snapshot, dict) else {}
    value, unit, detail = None, '', 'Usage unavailable'
    text = '—'
    if source in ('usage-tokens-30d', 'usage-cost-30d'):
        value, text, unit, detail = _period_content(snapshot, source == 'usage-cost-30d', widget['type'] == 'gauge')
    elif source == 'usage-limits':
        value, text, unit, detail = _quota_content(snapshot)
    elif source == 'storage':
        storage = snapshot.get('storage', {})
        value = _number(storage.get('usedPercent'))
        unit = '%'
        used, free, total = [_number(storage.get(key)) for key in ('usedGiB', 'freeGiB', 'totalGiB')]
        if value is not None and all(item is not None for item in (used, free, total)):
            text = f'{value:.0f}'
            detail = f'{used:.1f}/{total:.0f} GiB used · {free:.1f} free'
        else:
            value, detail = None, 'Root storage unavailable'
    else:
        provider_name, metric = source.split('-', 1)
        provider = snapshot.get('providers', {}).get(provider_name, {})
        freshness = provider.get('freshness', {})
        observed = freshness.get('tokens', {}).get('observedAt')
        scope = f'UTC today · cached {_stamp(observed)}'
        if metric == 'tokens':
            value = _number(provider.get('total'))
            if value is not None:
                text, unit = _count(value)
                if widget['type'] == 'gauge':
                    unit = 'tokens'
                detail = scope
        elif metric == 'cost':
            value = _number(provider.get('costUSD'))
            kind = provider.get('costKind')
            if value is not None and kind in ('estimate', 'reported'):
                text, unit = f'{value:.2f}', 'USD'
                pricing = freshness.get('pricing', {})
                stale = freshness.get('tokens', {}).get('stale', True) or (
                    kind == 'estimate' and (pricing.get('stale', True) or pricing.get('status') == 'unavailable'))
                detail = f'{"API estimate" if kind == "estimate" else "Reported API cost"} · {"stale" if stale else "cached"} {_stamp(observed)} · UTC today'
            else:
                value, detail = None, 'Cost unavailable · subscription bill unknown'
        elif metric == 'models':
            models = provider.get('perModel', [])
            if _number(provider.get('total')) is not None:
                value, text, unit = len(models), str(len(models)), 'models'
                pricing = freshness.get('pricing', {})
                stale = freshness.get('tokens', {}).get('stale', True) or pricing.get('stale', True)
                kind = 'API reported' if all(model.get('costKind') == 'reported' for model in models) else 'API est.'
                note = f'*{kind} · {"stale" if stale else "cached"} {_stamp(observed)}'
                rows = []
                for model in models:
                    total = _number(model.get('total'))
                    cost = _number(model.get('costUSD'))
                    count, suffix = _count(total) if total is not None else ('—', '')
                    tokens = count + (suffix[0] if suffix and suffix[0] in 'KMB' else '')
                    name = str(model.get('model', 'Unknown')).replace('\n', ' ').replace('\t', ' ')
                    rows.append(f'{name}\t{tokens}\t{cost:.2f}' if cost is not None else f'{name}\t{tokens}\t—')
                detail = '\n'.join([note, *rows]) if rows else 'No usage recorded today'
        else:
            limits = provider.get('limits', [])
            session = provider_name == 'claude' and metric in ('reset', 'session')
            candidates = [limit for limit in limits if isinstance(limit, dict) and (
                limit.get('id') == 'five_hour' if session else
                (_number(limit.get('windowMinutes')) or 0) >= 10080)]
            limit = max(candidates, key=lambda item: str(item.get('observedAt', '')), default=None)
            if limit is not None:
                state = 'Stale' if limit.get('stale', True) else 'Cached'
                reset = _time(limit.get('resetsAt'))
                now = _time(snapshot.get('servedAt') or snapshot.get('readAt'))
                if metric == 'reset':
                    if reset is not None and now is not None and reset > now:
                        minutes = math.ceil((reset - now) / 60)
                        value, text = minutes, f'{minutes // 60}h {minutes % 60:02d}m'
                        detail = f'{limit.get("label", "Limit")} reset · {state.lower()}'
                        if limit.get('resetKind') == 'notice_relative_estimate':
                            detail += ' estimate'
                    elif reset is not None and now is not None:
                        text, detail = 'Unconfirmed', 'Reset time passed · awaiting provider data'
                else:
                    value = _number(limit.get('usedPercent'))
                    if value is not None and 0 <= value <= 100:
                        text, unit = f'{value:g}', '%'
                        detail = f'{limit.get("label", "Limit")} · {state.lower()} {_stamp(limit.get("observedAt"))}'
                    else:
                        value = None
            else:
                detail = f'{"Weekly" if metric == "weekly" else "Session" if metric == "session" else "Reset"} limit unavailable'
        if freshness.get('tokens', {}).get('stale') and metric == 'tokens' and value is not None:
            detail = 'Stale · ' + detail
    settings.update(value=value if widget['type'] == 'gauge' else text, unit=unit, detail=detail)
    return settings


class UsageStats:
    """Add a usage snapshot without mutating the original dashboard stats."""

    def __init__(self, stats, snapshot):
        self._stats = stats
        self.ai_usage = snapshot

    def __getattr__(self, name):
        return getattr(self._stats, name)
