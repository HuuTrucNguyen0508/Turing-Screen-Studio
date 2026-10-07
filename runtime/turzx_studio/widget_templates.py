"""Guarded custom widget copies. Placed layouts never reference this file."""

from datetime import datetime, timezone
import hashlib
import json
import re
import uuid

from .archives import _read_regular
from .layout import validate_layout
from .storage import atomic_write

MAX_BYTES = 256 * 1024
MAX_WIDGETS = 64
JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def normalized_name(value):
    return value.strip(JS_WHITESPACE)


def utf16_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


ID = re.compile(r'[a-z0-9][a-z0-9-]{0,47}\Z')


def validate_templates(raw):
    if type(raw) is not dict or set(raw) != {'version', 'widgets'} or type(raw['version']) is not int or raw['version'] != 1:
        raise ValueError('Custom widgets require exactly version 1 and widgets')
    if type(raw['widgets']) is not list or len(raw['widgets']) > MAX_WIDGETS:
        raise ValueError('Custom widgets accept at most 64 templates')
    result, ids, names = [], set(), set()
    for index, entry in enumerate(raw['widgets']):
        path = f'widgets[{index}]'
        if type(entry) is not dict or set(entry) != {'id', 'name', 'widget'}:
            raise ValueError(f'{path} requires exactly id, name, widget')
        identifier, name, widget = entry['id'], entry['name'], entry['widget']
        if not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier in ids:
            raise ValueError(f'{path}.id is invalid or duplicated')
        if not isinstance(name, str) or not 1 <= utf16_length(normalized_name(name)) <= 60 or normalized_name(name).lower() in names:
            raise ValueError(f'{path}.name must be unique and 1 to 60 characters')
        ids.add(identifier); names.add(normalized_name(name).lower())
        if type(widget) is not dict or set(widget) not in ({'type', 'width', 'height', 'settings'}, {'type', 'width', 'height', 'settings', 'design'}):
            raise ValueError(f'{path}.widget accepts type, width, height, settings and optional design')
        roles = ('background', 'surface', 'surfaceRaised', 'text', 'muted', 'primary', 'secondary', 'outline')
        document = validate_layout({'version': 1, 'name': 'Template', 'canvas': {'width': 1280, 'height': 800},
                                    'palette': {'name': 'Template', **{key: '#000000' for key in roles}},
                                    'widgets': [{'id': identifier, 'x': 0, 'y': 0, **widget}]}, panel=True)
        checked = document['widgets'][0]
        copy = {key: checked[key] for key in ('type', 'width', 'height', 'settings')}
        if 'design' in checked:
            copy['design'] = checked['design']
        result.append({'id': identifier, 'name': normalized_name(name), 'widget': copy})
    library = {'version': 1, 'widgets': result}
    if len(encode_templates(library)) > MAX_BYTES:
        raise ValueError('Custom widgets exceed the 256 KB limit')
    return library


def encode_templates(document):
    text = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False)
    def surrogate(match):
        value = match.group()
        return chr(0x10000 + (ord(value[0]) - 0xd800) * 0x400 + ord(value[1]) - 0xdc00) if len(value) == 2 else f'\\u{ord(value):04x}'
    return (re.sub(r'[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]', surrogate, text) + '\n').encode('utf-8')


def templates_revision(document):
    return hashlib.sha256(encode_templates(document)).hexdigest()


class WidgetTemplates:
    def __init__(self, paths):
        self.paths = paths
        self.path = paths.state_dir / 'widgets.json'

    def read(self):
        try:
            data = _read_regular(self.path, MAX_BYTES)
        except FileNotFoundError:
            return {'version': 1, 'widgets': []}
        from .layout import _json
        return validate_templates(_json(data.decode('utf-8')))

    def write(self, document):
        encoded = encode_templates(validate_templates(document))
        try:
            previous = _read_regular(self.path, MAX_BYTES)
        except FileNotFoundError:
            previous = None
        if previous == encoded:
            return
        if previous is not None:
            root = self.paths.older_configs / 'custom-widgets'
            name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + hashlib.sha256(previous).hexdigest()[:12] + '-' + uuid.uuid4().hex[:8] + '.json'
            atomic_write(root / name, previous)
        atomic_write(self.path, encoded)
