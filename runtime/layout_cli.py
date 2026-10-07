"""Generate and preview layouts offline; apply through the guarded Studio API."""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from turzx_studio.layout import parse_layout, revision, serialize_layout, validate_layout

ROOT = Path(__file__).resolve().parents[1]
MAX_BYTES = 1024 * 1024


def read_json(path: Path):
    if not path.is_file() or path.stat().st_size > MAX_BYTES:
        raise ValueError('JSON input exceeds the 1 MB limit')
    # Use the runtime's strict JSON parser, including duplicate-key rejection.
    from turzx_studio.layout import _json
    with path.open('rb') as stream:
        data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError('JSON input exceeds the 1 MB limit')
    return _json(data.decode('utf-8'))


def catalog() -> dict:
    return read_json(ROOT / 'public/widget-catalog.json')


def browse_catalog(search: str = '', group: str | None = None) -> dict:
    result = catalog()
    if group and group not in {item['id'] for item in result['groups']}:
        raise ValueError('Unknown widget group. Run pnpm layout catalog for available groups.')
    terms = search.casefold().split()
    names = {item['id']: item['name'] for item in result['groups']}
    matches = []
    for item in result['widgets']:
        text = ' '.join(str(item.get(field, '')) for field in
                        ('id', 'name', 'group', 'family', 'variant', 'description', 'type'))
        text += ' ' + names[item['group']] + ' ' + item['settings'].get('source', '')
        if (not group or item['group'] == group) and all(term in text.casefold() for term in terms):
            matches.append(item)
    result['widgets'] = matches
    return result


def presets() -> dict:
    return read_json(ROOT / 'public/layout-presets.json')


def generate(spec: dict) -> dict:
    """Expand small template-based specs into the canonical layout contract."""
    if not isinstance(spec, dict) or set(spec) - {'name', 'canvas', 'palette', 'paletteMode', 'widgets'}:
        raise ValueError('Spec accepts name, canvas, palette, paletteMode and widgets only')
    sample = read_json(ROOT / 'public/sample-layout.json')
    templates = {item['id']: item for item in catalog()['widgets']}
    raw = spec.get('widgets')
    if not isinstance(raw, list):
        raise ValueError('Spec.widgets must be an array of widget templates')
    widgets = []
    canvas = spec.get('canvas', sample['canvas'])
    if not isinstance(canvas, dict):
        raise ValueError('Spec.canvas must contain width and height')
    x, y, row_height = 64, 160, 0
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict) or set(entry) - {'template', 'id', 'x', 'y', 'width', 'height', 'settings', 'design'}:
            raise ValueError(f'Spec.widgets[{index}] accepts template, id, geometry, settings and design only')
        identifier = entry.get('template')
        if not isinstance(identifier, str) or identifier not in templates:
            raise ValueError(f'Spec.widgets[{index}].template must be a catalog ID')
        template = templates[identifier]
        width, height = entry.get('width', template['width']), entry.get('height', template['height'])
        if type(width) is not int or type(height) is not int or width < 1 or height < 1:
            raise ValueError(f'Spec.widgets[{index}] dimensions must be positive integers')
        if 'x' not in entry and x + width > canvas.get('width', 0) - 64:
            x, y, row_height = 64, y + row_height + 24, 0
        settings = entry.get('settings', {})
        if not isinstance(settings, dict):
            raise ValueError(f'Spec.widgets[{index}].settings must be an object')
        widgets.append({'id': entry.get('id', f'{identifier}-{index + 1}'), 'type': template['type'],
                        'x': entry.get('x', x), 'y': entry.get('y', y),
                        'width': width, 'height': height,
                        'settings': {**deepcopy(template['settings']), **settings},
                        **({'design': deepcopy(entry.get('design', template.get('design')))} if 'design' in entry or 'design' in template else {})})
        x += width + 24
        row_height = max(row_height, height)
    return validate_layout({'version': 1, 'name': spec.get('name', 'Generated dashboard'),
                            'canvas': canvas, 'palette': spec.get('palette', sample['palette']),
                            'widgets': widgets, 'paletteMode': spec.get('paletteMode', 'live')})


def summary(document: dict) -> dict:
    overlaps = []
    for index, a in enumerate(document['widgets']):
        for b in document['widgets'][index + 1:]:
            if (a['x'] < b['x'] + b['width'] and b['x'] < a['x'] + a['width'] and
                    a['y'] < b['y'] + b['height'] and b['y'] < a['y'] + a['height']):
                overlaps.append([a['id'], b['id']])
    return {'name': document['name'], 'revision': revision(document),
            'widgetCount': len(document['widgets']), 'canvas': document['canvas'],
            'overlaps': overlaps}


def write_layout(path: Path, document: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(serialize_layout(document), encoding='utf-8')


def api(base: str, path: str, document=None, if_match: str | None = None):
    parsed = urlsplit(base)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or
            parsed.username or parsed.password or parsed.path not in ('', '/') or
            parsed.query or parsed.fragment):
        raise ValueError('Studio URL must be an HTTP loopback origin, such as http://127.0.0.1:5174')
    headers = {'Accept': 'application/json'}
    data = None
    if document is not None:
        data = json.dumps(document, ensure_ascii=True, allow_nan=False).encode('utf-8')
        if len(data) > MAX_BYTES:
            raise ValueError('JSON request exceeds the 1 MB limit')
        headers.update({'Content-Type': 'application/json', 'If-Match': if_match or ''})
    request = Request(base.rstrip('/') + path, data=data, headers=headers)
    try:
        with urlopen(request, timeout=15) as response:
            return json.load(response)
    except HTTPError as error:
        try:
            message = json.load(error).get('error', str(error))
        except (ValueError, AttributeError):
            message = str(error)
        raise ValueError(f'Studio HTTP {error.code}: {message}') from error
    except URLError as error:
        raise ValueError(f'Studio is unavailable. Start pnpm studio. {error.reason}') from error


def apply(base: str, document: dict, if_match: str, wait_seconds: float) -> dict:
    document = validate_layout(document, panel=True)
    result = api(base, '/api/layout', document, if_match)
    result = {'revision': result['revision'], 'archive': result.get('archive'), 'accepted': False}
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        status = api(base, '/api/status')
        if (status.get('runtimeRunning') and status.get('connected') and
                status.get('view') == 'stats' and not status.get('error') and
                status.get('requestedRevision') == result['revision'] == status.get('appliedRevision')):
            result['accepted'] = True
            break
        time.sleep(.5)
    return result


def switch(base: str, selection: dict, if_match: str | None = None) -> dict:
    api(base, '/api/layouts')
    current = api(base, '/api/layout')
    return api(base, '/api/layouts/switch', selection, if_match if if_match is not None else current['revision'])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:5174', help='Loopback Studio origin for connected commands')
    commands = parser.add_subparsers(dest='command', required=True)
    browse = commands.add_parser('catalog', help='Browse widget templates and variants')
    browse.add_argument('--search', default='', help='Search names, families, variants and descriptions')
    browse.add_argument('--group', help='Filter by a group ID from the catalog')
    commands.add_parser('presets', help='List designed starter dashboards')
    create = commands.add_parser('generate', help='Create a layout without touching the panel')
    inputs = create.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--preset')
    inputs.add_argument('--spec', type=Path)
    create.add_argument('--output', type=Path, required=True)
    check = commands.add_parser('validate', help='Check a layout and report overlaps')
    check.add_argument('file', type=Path)
    check.add_argument('--panel', action='store_true')
    preview = commands.add_parser('preview', help='Render a deterministic PNG without USB or sensors')
    preview.add_argument('file', type=Path)
    preview.add_argument('--output', type=Path, required=True)
    current = commands.add_parser('current', help='Read the panel layout and its revision')
    current.add_argument('--output', type=Path)
    commands.add_parser('history', help='List archived older configurations')
    commands.add_parser('saved', help='Read the ordered saved dashboard library')
    for direction in ('next', 'previous'):
        rotate = commands.add_parser(direction, help=f'Switch to the {direction} saved dashboard')
        rotate.add_argument('--if-match', help='Override the latest panel revision for a guarded switch')
    use = commands.add_parser('use', help='Switch to a saved dashboard by ID')
    use.add_argument('id')
    use.add_argument('--if-match', help='Override the latest panel revision for a guarded switch')
    slot = commands.add_parser('slot', help='Switch to a saved dashboard by its ordered slot')
    slot.add_argument('slot', type=int)
    slot.add_argument('--if-match', help='Override the latest panel revision for a guarded switch')
    save = commands.add_parser('apply', help='Archive the current layout and save a replacement')
    save.add_argument('file', type=Path)
    save.add_argument('--if-match', required=True, help='Revision obtained from current before editing')
    save.add_argument('--wait', type=float, default=15, help='Seconds to await panel acceptance; 0 saves only')
    restore = commands.add_parser('restore', help='Restore an archive, preserving the current layout first')
    restore.add_argument('id')
    restore.add_argument('--if-match', required=True)
    restore.add_argument('--wait', type=float, default=15)
    args = parser.parse_args(argv)
    try:
        if hasattr(args, 'wait') and (not 0 <= args.wait <= 60):
            raise ValueError('--wait must be between 0 and 60 seconds')
        if args.command == 'catalog':
            result = browse_catalog(args.search, args.group)
        elif args.command == 'presets':
            result = [{'id': p['id'], 'name': p['name'], 'description': p['description']} for p in presets()['presets']]
        elif args.command == 'generate':
            if args.spec:
                document = generate(read_json(args.spec))
            else:
                found = next((p for p in presets()['presets'] if p['id'] == args.preset), None)
                if found is None:
                    raise ValueError('Unknown preset. Run pnpm layout presets for choices.')
                document = validate_layout(found['document'])
            write_layout(args.output, document)
            result = {**summary(document), 'output': str(args.output)}
        elif args.command in ('validate', 'preview'):
            document = validate_layout(read_json(args.file), panel=getattr(args, 'panel', False))
            result = summary(document)
            if args.command == 'preview':
                from turzx_studio.renderer import LayoutRenderer
                args.output.parent.mkdir(parents=True, exist_ok=True)
                image = LayoutRenderer(font_dir=Path.home() / 'Documents/turing-smart-screen-python/res/fonts').render(document)
                try:
                    image.save(args.output, format='PNG')
                finally:
                    image.close()
                result['output'] = str(args.output)
        elif args.command == 'current':
            result = api(args.url, '/api/layout')
            if args.output:
                write_layout(args.output, validate_layout(result['document']))
                result = {'revision': result['revision'], 'output': str(args.output)}
        elif args.command == 'history':
            result = api(args.url, '/api/history')
        elif args.command == 'saved':
            result = api(args.url, '/api/layouts')
        elif args.command in ('next', 'previous', 'use', 'slot'):
            if args.command == 'use':
                selection = {'id': args.id}
            elif args.command == 'slot':
                if not 1 <= args.slot <= 12:
                    raise ValueError('Saved layout slot must be an integer from 1 to 12')
                selection = {'slot': args.slot}
            else:
                selection = {'direction': args.command}
            result = switch(args.url, selection, args.if_match)
        else:
            if args.command == 'restore':
                from turzx_studio.archives import ARCHIVE_ID
                if not ARCHIVE_ID.fullmatch(args.id):
                    raise ValueError('Invalid archived layout ID; use pnpm layout history')
                document = api(args.url, '/api/history/' + args.id)['document']
            else:
                document = validate_layout(read_json(args.file), panel=True)
            result = apply(args.url, document, args.if_match, args.wait)
        print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        if args.command in ('apply', 'restore') and args.wait > 0 and not result['accepted']:
            print('Layout saved, but panel acceptance is still pending. Inspect pnpm layout current and /api/status before retrying.', file=sys.stderr)
            return 2
        return 0
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f'Layout command failed: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
