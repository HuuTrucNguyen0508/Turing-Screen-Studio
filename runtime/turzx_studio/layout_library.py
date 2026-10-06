"""Ordered saved dashboards, independent of the panel's active layout file."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import re
import stat

from .layout import _json, revision, validate_layout
from .storage import Paths, atomic_write

MAX_BYTES = 1024 * 1024
MAX_ENTRIES = 12
LAYOUT_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


class LibraryTooLarge(ValueError):
    pass


def _encode(library: dict) -> bytes:
    return (json.dumps(library, ensure_ascii=True, indent=2, allow_nan=False) + '\n').encode('utf-8')


def library_revision(library: dict) -> str:
    return hashlib.sha256(_encode(library)).hexdigest()


def validate_library(raw: object) -> dict:
    if type(raw) is not dict or set(raw) != {'entries'}:
        raise ValueError('Saved layouts accept exactly an entries array')
    entries = raw['entries']
    if not isinstance(entries, list) or len(entries) > MAX_ENTRIES:
        raise ValueError(f'Saved layouts must be an array of at most {MAX_ENTRIES} entries')
    result, identifiers, documents = [], set(), set()
    for index, entry in enumerate(entries):
        prefix = f'entries[{index}]'
        if type(entry) is not dict or set(entry) != {'id', 'name', 'document'}:
            raise ValueError(f'{prefix} requires exactly id, name and document')
        identifier, name = entry['id'], entry['name']
        if not isinstance(identifier, str) or not LAYOUT_ID.fullmatch(identifier):
            raise ValueError(f'{prefix}.id must be 1 to 64 ASCII letters, digits, underscores or hyphens, starting with a letter or digit')
        if identifier in identifiers:
            raise ValueError(f'{prefix}.id duplicates another saved layout')
        identifiers.add(identifier)
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError(f'{prefix}.name must be nonempty and at most 120 characters')
        try:
            document = validate_layout(entry['document'], panel=True)
        except ValueError as error:
            raise ValueError(f'{prefix}.document: {error}') from error
        checksum = revision(document)
        if checksum in documents:
            raise ValueError(f'{prefix}.document is already in Saved layouts. Edit or update the existing entry instead of adding an identical copy.')
        documents.add(checksum)
        result.append({'id': identifier, 'name': name, 'document': document})
    library = {'entries': result}
    if len(_encode(library)) > MAX_BYTES:
        raise LibraryTooLarge('Saved layouts exceed the 1 MB limit')
    return library


def _read_json(path: Path) -> object:
    descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('Saved layouts must be a regular JSON file')
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise LibraryTooLarge('Saved layouts exceed the 1 MB limit')
    return _json(data.decode('utf-8'))


def active_id(library: dict, panel_revision: str) -> str | None:
    return next((entry['id'] for entry in library['entries']
                 if revision(entry['document']) == panel_revision), None)


def select_entry(library: dict, panel_revision: str, raw: object) -> dict:
    if type(raw) is not dict or set(raw) not in ({'direction'}, {'id'}, {'slot'}):
        raise ValueError('Switch requires exactly direction (next or previous), id, or slot (1 to 12)')
    if 'direction' in raw:
        if raw['direction'] not in ('next', 'previous'):
            raise ValueError('Switch direction must be next or previous')
    elif 'slot' in raw:
        if type(raw['slot']) is not int or not 1 <= raw['slot'] <= MAX_ENTRIES:
            raise ValueError('Saved layout slot must be an integer from 1 to 12')
    elif not isinstance(raw['id'], str) or not LAYOUT_ID.fullmatch(raw['id']):
        raise ValueError('Invalid saved layout ID; use pnpm layout saved for choices')
    entries = library['entries']
    if not entries:
        raise ValueError('No saved layouts are available. Add a layout to the saved dashboard library before switching.')
    if 'slot' in raw:
        if raw['slot'] > len(entries):
            raise ValueError('This saved layout slot is not configured. Use pnpm layout saved for available slots.')
        return entries[raw['slot'] - 1]
    if 'id' in raw:
        entry = next((entry for entry in entries if entry['id'] == raw['id']), None)
        if entry is None:
            raise ValueError('Unknown saved layout ID; use pnpm layout saved for choices')
        return entry
    current = active_id(library, panel_revision)
    if current is None:
        return entries[0 if raw['direction'] == 'next' else -1]
    index = next(index for index, entry in enumerate(entries) if entry['id'] == current)
    offset = 1 if raw['direction'] == 'next' else -1
    for step in range(1, len(entries) + 1):
        candidate = entries[(index + step * offset) % len(entries)]
        if revision(candidate['document']) != panel_revision:
            return candidate
    return entries[index]


class LayoutLibrary:
    """File operations require the caller's layout_write_lock transaction."""

    def __init__(self, paths: Paths, presets: Path) -> None:
        self.path = paths.state_dir / 'layouts.json'
        self.presets = presets

    def read(self) -> dict:
        return validate_library(_read_json(self.path))

    def initial(self, current: dict) -> dict:
        presets = _read_json(self.presets)
        if not isinstance(presets, dict) or not isinstance(presets.get('presets'), list):
            raise ValueError('Bundled layout presets are invalid')
        entries = [{'id': 'current', 'name': current['name'].strip()[:120], 'document': current}]
        for identifier, name in (('system-overview', 'System overview'), ('ai-usage', 'AI usage'),
                                 ('focus', 'Focus'), ('gauge-designs', 'Gauge designs'), ('classic', 'Classic layout')):
            matches = [preset for preset in presets['presets']
                       if isinstance(preset, dict) and preset.get('id') == identifier]
            if len(matches) != 1:
                raise ValueError(f'Bundled preset {identifier} is missing or duplicated')
            document = validate_layout(matches[0].get('document'), panel=True)
            document['palette'] = deepcopy(current['palette'])
            document.pop('paletteMode', None)
            if 'paletteMode' in current:
                document['paletteMode'] = current['paletteMode']
            if (current['name'].casefold() == document['name'].casefold()
                    or revision(current) == revision(document)):
                continue
            entries.append({'id': identifier, 'name': name, 'document': document})
            if len(entries) == 4:
                break
        return validate_library({'entries': entries})

    def write(self, library: dict) -> None:
        canonical = validate_library(library)
        atomic_write(self.path, _encode(canonical))
