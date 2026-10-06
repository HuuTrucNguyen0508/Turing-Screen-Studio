"""Display preparation for filesystem cards; discovery belongs to the collector."""
from __future__ import annotations
import json
from copy import deepcopy
import math
import re
from pathlib import Path

# A bundled deterministic asset, loaded once; rendering never discovers mounts.
SAMPLE_STORAGE = json.loads((Path(__file__).resolve().parents[2] / 'public/storage-sample.json').read_text())


def storage_geometry(width: int, height: int, style: str) -> dict:
    table = style == 'table' and width >= 460
    start = 96 if table else 80
    stride = 46 if table else 70 if style == 'bars' else 62
    return dict(table=table, start=start, stride=stride,
                capacity=max(0, (height - start - 38) // stride))


def storage_size(value: object) -> str:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return '—'
    unit = 'TiB' if value >= 1024 else 'GiB'
    size = value / 1024 if unit == 'TiB' else value
    rounded = math.floor(size * 10 + .5) / 10
    return f'{rounded:g} {unit}'


def storage_short(value: str, characters: int) -> str:
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    return value if len(value) <= characters else value[:max(0, characters - 1)] + '…'


def storage_content(widget: dict, snapshot: object = None, *, preview: bool = False) -> dict:
    settings = dict(widget['settings'])
    data = SAMPLE_STORAGE if preview or settings.get('source', 'sample') == 'sample' else (
        snapshot.get('mountedStorage') if isinstance(snapshot, dict) else None)
    data = data if isinstance(data, dict) else {}
    raw = data.get('mounts', [])
    mounts = [deepcopy(row) for row in raw if isinstance(row, dict) and isinstance(row.get('mount'), str)] if isinstance(raw, list) else []
    errors = data.get('errors', [])
    settings.update(mounts=mounts, stale=data.get('stale', True), errors=list(errors) if isinstance(errors, list) else ['invalid_storage_errors'],
                    sample=preview or settings.get('source', 'sample') == 'sample')
    return settings
