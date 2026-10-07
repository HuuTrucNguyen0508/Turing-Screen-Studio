"""Saved card colors and literal clock ink, without hardware or local state."""

import base64
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import unittest

from PIL import Image, ImageChops

from turzx_studio.design import resolve_elements
from turzx_studio.layout import (PALETTE_ROLES, effective_widget_palette, parse_layout,
                                serialize_layout, validate_layout)
from turzx_studio.renderer import LayoutRenderer

ROOT = Path(__file__).resolve().parents[2]


def uri(pixel):
    output = BytesIO()
    Image.new('RGBA', (1, 1), pixel).save(output, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode()


def rgb(color):
    return tuple(int(color[index:index + 2], 16) for index in (1, 3, 5))


def pixel_colors(image):
    return {color for _, color in image.getcolors(image.width * image.height)}


class WidgetColorTests(unittest.TestCase):
    def setUp(self):
        self.doc = parse_layout((ROOT / 'public/sample-layout.json').read_text())
        self.doc.update(canvas={'width': 800, 'height': 400}, chrome='none')
        self.doc['widgets'] = []
        self.renderer = LayoutRenderer()
        self.settings = {
            'metric': {'label': 'CPU', 'value': '42', 'unit': '%', 'detail': 'Sample'},
            'weather': {'location': 'Paris', 'temperature': '19', 'unit': 'C',
                        'condition': 'Clear', 'high': '22', 'low': '14'},
            'clock': {'label': 'Clock', 'time': '14:32', 'date': 'Today',
                      'format': '12h', 'showDate': True},
            'text': {'label': 'Note', 'text': 'Saved colors'},
            'gauge': {'label': 'CPU', 'value': 42, 'min': 0, 'max': 100,
                      'unit': '%', 'detail': 'Sample'},
            'storage': {'label': 'Drives', 'style': 'bars'},
            'image': {'label': 'Image', 'data': uri((255, 0, 0, 128)),
                      'fit': 'contain', 'opacity': 100},
        }
        self.overrides = dict(zip(PALETTE_ROLES, (
            '#010203', '#112233', '#00AAAA', '#0000AA', '#AA00AA',
            '#AA0000', '#00AA00', '#445566')))

    def widget(self, kind, **extra):
        return {'id': kind, 'type': kind, 'x': 20, 'y': 20,
                'width': 300, 'height': 224,
                'settings': deepcopy(self.settings[kind]), **extra}

    def test_all_widget_types_roundtrip_in_canonical_detached_order(self):
        raw = dict(reversed(list(self.overrides.items())))
        widgets = [self.widget(kind, colors=raw) for kind in self.settings]
        doc = {**self.doc, 'widgets': widgets}
        canonical = validate_layout(doc)
        self.assertEqual(parse_layout(serialize_layout(doc)), canonical)
        for widget in canonical['widgets']:
            self.assertEqual(list(widget['colors']), list(PALETTE_ROLES))
            self.assertEqual(list(widget)[-1], 'colors')
            self.assertIsNot(widget['colors'], raw)
        canonical['widgets'][0]['colors']['primary'] = '#abcdef'
        self.assertEqual(raw['primary'], '#AA0000')
        for kind in self.settings:
            self.assertNotIn('colors', validate_layout({**self.doc, 'widgets': [self.widget(kind)]})['widgets'][0])

    def test_invalid_color_objects_roles_and_values_have_precise_paths(self):
        for colors in (None, [], True, 42, 'primary', {}, {'name': '#123456'},
                       {'unknown': '#123456'}, *({'primary': value} for value in
                         ('#abc', '#12345', '#1234567', '#12345g', '#123456\n',
                          'red', '123456', '', True, 42, None))):
            with self.subTest(colors=colors), self.assertRaisesRegex(ValueError, r'^\$\.widgets\[0\]\.colors'):
                validate_layout({**self.doc, 'widgets': [self.widget('metric', colors=colors)]})

    def test_effective_palette_is_detached_and_preserves_base_and_neighbors(self):
        for base in (self.doc['palette'], {**self.doc['palette'], 'name': 'Live', 'text': '#abcdef'}):
            before = deepcopy(base)
            colors = effective_widget_palette(base, self.widget('metric', colors={'primary': '#123456'}))
            self.assertEqual(colors, {**base, 'primary': '#123456'})
            colors['text'] = '#000000'
            self.assertEqual(base, before)
            self.assertEqual(effective_widget_palette(base, self.widget('metric')), base)

    def test_every_card_uses_overrides_for_background_border_and_content_with_saved_or_live_palette(self):
        live = {**self.doc['palette'], 'name': 'Live', 'surface': '#234567', 'outline': '#765432'}
        for kind in self.settings.keys() - {'image'}:
            for palette in (None, live):
                widget = self.widget(kind, colors=self.overrides)
                neighbor = {**self.widget(kind), 'id': 'neighbor', 'x': 360}
                doc = {**self.doc, 'widgets': [widget, neighbor]}
                before = deepcopy(doc)
                image = self.renderer.render(doc, palette=palette)
                base = palette or self.doc['palette']
                with self.subTest(kind=kind, palette=palette):
                    self.assertEqual(image.getpixel((21, 130)), rgb(self.overrides['surface']))
                    self.assertEqual(image.getpixel((20, 130)), rgb(self.overrides['outline']))
                    self.assertEqual(image.getpixel((361, 130)), rgb(base['surface']))
                    self.assertEqual(image.getpixel((360, 130)), rgb(base['outline']))
                    self.assertEqual(image.getpixel((0, 0)), rgb(base['background']))
                    pixels = pixel_colors(image.crop((20, 20, 320, 244)))
                    ink = {rgb(self.overrides[key]) for key in ('text', 'muted', 'primary', 'secondary')}
                    self.assertTrue(pixels & ink)
                    self.assertEqual(doc, before)

    def test_widget_colors_leave_canvas_header_footer_and_other_cards_unchanged(self):
        doc = parse_layout((ROOT / 'public/sample-layout.json').read_text())
        plain = self.renderer.render(doc)
        colored = deepcopy(doc)
        colored['widgets'][0]['colors'] = self.overrides
        image = self.renderer.render(colored)
        changed = ImageChops.difference(plain, image).getbbox()
        widget = doc['widgets'][0]
        self.assertEqual(changed, (widget['x'], widget['y'], widget['x'] + widget['width'], widget['y'] + widget['height']))

    def test_image_background_and_border_are_independent_explicit_overrides(self):
        bottom = self.widget('image')
        bottom['settings'].update(data=uri((0, 0, 255, 255)), fit='stretch')
        top = self.widget('image')
        top.update(id='top')
        top['settings'].update(data=uri((255, 0, 0, 0)), fit='stretch', opacity=0)
        for overrides in (None, {'primary': '#123456'}, {'surface': '#112233'},
                          {'outline': '#445566'}, {'surface': '#112233', 'outline': '#445566'}):
            widget = {**top, **({'colors': overrides} if overrides else {})}
            image = self.renderer.render({**self.doc, 'widgets': [bottom, widget]})
            with self.subTest(overrides=overrides):
                self.assertEqual(image.getpixel((21, 130)), rgb((overrides or {}).get('surface', '#0000ff')))
                self.assertEqual(image.getpixel((20, 130)), rgb((overrides or {}).get('outline', (overrides or {}).get('surface', '#0000ff'))))
                self.assertEqual(image.getpixel((19, 130)), rgb(self.doc['palette']['background']))

    def test_image_alpha_blends_with_explicit_surface_instead_of_canvas_and_border_stays_opaque(self):
        widget = self.widget('image', colors={'surface': '#112233', 'outline': '#445566'})
        widget['settings'].update(fit='stretch', opacity=50)
        image = self.renderer.render({**self.doc, 'widgets': [widget]})
        expected = tuple(round((red * 64 + base * 191) / 255) for red, base in zip((255, 0, 0), rgb('#112233')))
        self.assertEqual(image.getpixel((21, 130)), expected)
        self.assertEqual(image.getpixel((20, 130)), rgb('#445566'))

    def test_literal_clock_time_colors_digits_and_suffix_while_named_role_keeps_muted_suffix(self):
        for color in ('#FF0033', 'secondary'):
            widget = self.widget('clock', colors=self.overrides,
                                 design={'elements': {'label': {'hidden': True},
                                                      'time': {'color': color},
                                                      'date': {'hidden': True}}})
            image = self.renderer.render({**self.doc, 'widgets': [widget]})
            element = resolve_elements(widget)[1]
            digits_width = self.renderer._font('mono', element['size']).getlength(element['text'])
            left = int(widget['x'] + element['x'])
            suffix_left = int(left + digits_width + element['gap'])
            baseline = widget['y'] + element['y']
            expected = color if color.startswith('#') else self.overrides[color]
            suffix_color = color if color.startswith('#') else self.overrides['muted']
            with self.subTest(color=color):
                digits = pixel_colors(image.crop((left, baseline - element['size'], suffix_left, baseline)))
                suffix = pixel_colors(image.crop((suffix_left, baseline - element['suffixSize'], widget['x'] + widget['width'] - 2, baseline)))
                self.assertIn(rgb(expected), digits)
                self.assertIn(rgb(suffix_color), suffix)
                self.assertEqual(element['suffixColor'], color if color.startswith('#') else 'muted')

    def test_literal_label_date_and_24_hour_time_use_exact_ink_with_a_live_palette(self):
        widget = self.widget('clock', design={'elements': {
            'label': {'color': '#aa1234'}, 'time': {'color': '#34aa12'}, 'date': {'color': '#1234aa'}}})
        widget['settings']['format'] = '24h'
        live = {**self.doc['palette'], 'text': '#ffffff', 'muted': '#ffffff', 'primary': '#ffffff'}
        image = self.renderer.render({**self.doc, 'widgets': [widget]}, palette=live)
        pixels = pixel_colors(image)
        for color in ('#aa1234', '#34aa12', '#1234aa'):
            self.assertIn(rgb(color), pixels)


if __name__ == '__main__':
    unittest.main()
