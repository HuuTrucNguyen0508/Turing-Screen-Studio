"""Format collected snapshots; this module performs no I/O."""

from __future__ import annotations

from datetime import datetime, timezone
import math

USAGE_SOURCES = (
    'codex-tokens', 'codex-cost', 'codex-weekly', 'codex-reset', 'codex-models',
    'claude-tokens', 'claude-cost', 'claude-session', 'claude-weekly', 'claude-reset', 'claude-models',
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
    if value >= 1_000_000:
        return f'{value / 1_000_000:.1f}', 'M tokens'
    if value >= 1000:
        return f'{value / 1000:.1f}', 'K tokens'
    return f'{value:.0f}', 'tokens'


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
    if source == 'storage':
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
                    tokens = count + ('M' if suffix.startswith('M') else 'K' if suffix.startswith('K') else '')
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
