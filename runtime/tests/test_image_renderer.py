"""Embedded image contract and compositing, without files, services or USB."""

import base64
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
import struct
import unittest
import zlib

from PIL import Image, ImageChops

from turzx_studio import image_assets
from turzx_studio.image_assets import MAX_IMAGE_DATA_BYTES, decode_image, render_image
from turzx_studio.layout import parse_layout, serialize_layout, validate_layout
from turzx_studio.renderer import LayoutRenderer


def uri(image):
    output = BytesIO()
    image.save(output, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(output.getvalue()).decode('ascii')


def raw_uri(raw):
    return 'data:image/png;base64,' + base64.b64encode(raw).decode('ascii')


def chunk(kind, data):
    body = kind + data
    return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body))


class ImageTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads((Path(__file__).resolve().parents[2] / 'public/sample-layout.json').read_text())
        self.doc.update(chrome='none', canvas={'width': 30, 'height': 30})
        self.widget = {'id': 'image', 'type': 'image', 'x': 5, 'y': 6, 'width': 12, 'height': 10,
                       'settings': {'label': 'Icon', 'data': uri(Image.new('RGBA', (4, 2), (255, 0, 0, 128))),
                                    'fit': 'contain', 'opacity': 100}}
        self.doc['widgets'] = [self.widget]
        self.renderer = LayoutRenderer()

    def test_roundtrip_all_fits_opacities_and_detached_document(self):
        for fit in ('contain', 'cover', 'stretch'):
            for opacity in (0, 53, 100):
                self.widget['settings'].update(fit=fit, opacity=opacity)
                actual = validate_layout(self.doc)
                self.assertEqual(list(actual['widgets'][0]['settings']), ['label', 'data', 'fit', 'opacity'])
                self.assertEqual(parse_layout(serialize_layout(actual)), self.doc)
                self.assertIsNot(actual['widgets'][0]['settings'], self.widget['settings'])

    def test_rejects_urls_paths_svg_invalid_base64_and_header(self):
        for data in ('https://example.com/icon.png', '/tmp/icon.png', 'file:///icon.png', 'javascript:alert(1)',
                     'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,/9j/',
                     'data:image/png;base64,', 'data:image/png;base64,!!!!', 'data:image/png;base64,YQ=',
                     'data:image/png;base64,YR==', 'data:image/png;base64,YQ==\n', 'data:image/png;base64,aGVsbG8='):
            with self.subTest(data=data), self.assertRaisesRegex(ValueError, r'widgets\[0\].settings.data'):
                validate_layout({**self.doc, 'widgets': [{**self.widget, 'settings': {**self.widget['settings'], 'data': data}}]})

    def test_rejects_bad_checksums_truncation_trailing_bytes_animation_and_invalid_pixels(self):
        raw = base64.b64decode(self.widget['settings']['data'].split(',')[1])
        corrupt = bytearray(raw)
        corrupt[32] ^= 1
        animated = raw[:33] + chunk(b'acTL', struct.pack('>II', 2, 0)) + raw[33:]
        # Valid CRCs and dimensions do not excuse an invalid deflate stream.
        bad_pixels = raw[:33] + chunk(b'IDAT', b'not a deflate stream') + chunk(b'IEND', b'')
        for data in (bytes(corrupt), raw[:-1], raw + b'extra', animated, bad_pixels):
            with self.subTest(data=data[:40]), self.assertRaisesRegex(ValueError, 'invalid or unsupported PNG'):
                validate_layout({**self.doc, 'widgets': [{**self.widget, 'settings': {**self.widget['settings'], 'data': raw_uri(data)}}]})

    def test_bounds_bytes_dimensions_and_total_pixels_before_pillow_decode(self):
        raw = base64.b64decode(self.widget['settings']['data'].split(',')[1])
        for width, height in ((0, 1), (4097, 1), (4096, 4096)):
            header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
            data = raw_uri(raw[:8] + chunk(b'IHDR', header) + raw[33:])
            with self.subTest(width=width, height=height), self.assertRaisesRegex(ValueError, 'PNG dimensions'):
                image_assets.validate_image_data(data)
        with self.assertRaisesRegex(ValueError, '512 KiB'):
            image_assets.validate_image_data('data:image/png;base64,' + 'A' * MAX_IMAGE_DATA_BYTES)

    def test_settings_are_strict(self):
        for key, value in [('opacity', -1), ('opacity', 101), ('opacity', 1.5), ('opacity', True), ('opacity', '50'),
                           ('opacity', None), ('fit', 'tile'), ('source', 'sample'), ('url', '/tmp/icon.png')]:
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, f'settings.{key}'):
                validate_layout({**self.doc, 'widgets': [{**self.widget, 'settings': {**self.widget['settings'], key: value}}]})
        for key in ('label', 'data', 'fit', 'opacity'):
            document = deepcopy(self.doc)
            del document['widgets'][0]['settings'][key]
            with self.subTest(missing=key), self.assertRaisesRegex(ValueError, f'settings.{key}: required field'):
                validate_layout(document)
        with self.assertRaisesRegex(ValueError, 'image cards have no editable elements'):
            validate_layout({**self.doc, 'widgets': [{**self.widget, 'design': {}}]})

    def test_contain_is_centered_and_alpha_opacity_preserve_background(self):
        background = self.renderer.render({**self.doc, 'widgets': []})
        before = deepcopy(self.doc)
        rendered = self.renderer.render(self.doc)
        self.assertEqual(self.doc, before)
        self.assertEqual(ImageChops.difference(background, rendered).getbbox(), (5, 8, 17, 14))
        base = background.getpixel((6, 9))
        expected = tuple(round((red * 128 + original * 127) / 255) for red, original in zip((255, 0, 0), base))
        self.assertEqual(rendered.getpixel((6, 9)), expected)
        self.widget['settings']['opacity'] = 50
        rendered = self.renderer.render(self.doc)
        expected = tuple(round((red * 64 + original * 191) / 255) for red, original in zip((255, 0, 0), base))
        self.assertEqual(rendered.getpixel((6, 9)), expected)
        self.widget['settings']['opacity'] = 0
        self.assertEqual(self.renderer.render(self.doc).tobytes(), background.tobytes())

    def test_transparent_pixels_preserve_prior_image_layer(self):
        bottom = {**self.widget, 'id': 'bottom', 'settings': {**self.widget['settings'], 'data': uri(Image.new('RGBA', (1, 1), (0, 0, 255, 255))), 'fit': 'stretch'}}
        top = {**self.widget, 'settings': {**self.widget['settings'], 'data': uri(Image.new('RGBA', (1, 1), (255, 0, 0, 0))), 'fit': 'stretch'}}
        rendered = self.renderer.render({**self.doc, 'widgets': [bottom, top]})
        self.assertEqual(rendered.getpixel((5, 6)), (0, 0, 255))

    def test_cover_center_crop_stretch_and_tiny_images_are_clipped(self):
        source = Image.new('RGBA', (6, 2), (0, 255, 0, 255))
        source.paste((255, 0, 0, 255), (0, 0, 2, 2))
        source.paste((0, 0, 255, 255), (4, 0, 6, 2))
        data = uri(source)
        cover = render_image(data, 2, 2, 'cover', 100)
        self.assertEqual(cover.tobytes(), bytes((0, 255, 0, 255)) * 4)
        stretch = render_image(data, 6, 2, 'stretch', 100)
        self.assertEqual(stretch.tobytes(), source.tobytes())
        background = self.renderer.render({**self.doc, 'widgets': []})
        for fit in ('contain', 'cover', 'stretch'):
            for width, height in ((1, 1), (1, 17), (17, 1), (12, 10)):
                widget = {**self.widget, 'width': width, 'height': height, 'settings': {**self.widget['settings'], 'data': data, 'fit': fit}}
                rendered = self.renderer.render({**self.doc, 'widgets': [widget]})
                x0, y0, x1, y1 = ImageChops.difference(background, rendered).getbbox()
                with self.subTest(fit=fit, size=(width, height)):
                    self.assertGreaterEqual(x0, 5)
                    self.assertGreaterEqual(y0, 6)
                    self.assertLessEqual(x1, 5 + width)
                    self.assertLessEqual(y1, 6 + height)

    def test_cache_is_detached_bounded_and_uses_content_digests(self):
        data = self.widget['settings']['data']
        first = decode_image(data)
        first.putpixel((0, 0), (0, 0, 0, 0))
        self.assertEqual(decode_image(data).getpixel((0, 0)), (255, 0, 0, 128))
        for red in range(7):
            decode_image(uri(Image.new('RGBA', (3, 2), (red, 0, 0, 255))))
        self.assertLessEqual(len(image_assets._cache), image_assets.MAX_CACHE_ENTRIES)
        self.assertLessEqual(sum(i.width * i.height * 4 for i in image_assets._cache.values()), image_assets.MAX_CACHE_BYTES)
        self.assertTrue(all(len(digest) == 64 for digest in image_assets._cache))

    def test_total_layout_size_reports_resize_action_and_counts_utf8(self):
        raw = base64.b64decode(self.widget['settings']['data'].split(',')[1])
        data = raw_uri(raw[:33] + chunk(b'tEXt', b'Note\0' + b'A' * 280000) + raw[33:])
        self.assertLess(len(data), MAX_IMAGE_DATA_BYTES)
        widget = {**self.widget, 'settings': {**self.widget['settings'], 'data': data}}
        document = {**self.doc, 'widgets': [{**widget, 'id': str(i)} for i in range(3)]}
        with self.assertRaisesRegex(ValueError, '1 MiB limit; resize or remove embedded images'):
            serialize_layout(document)
        with self.assertRaisesRegex(ValueError, '1 MiB limit'):
            parse_layout(json.dumps(document))
        with self.assertRaisesRegex(ValueError, '1 MiB limit'):
            serialize_layout({**self.doc, 'name': '🌕' * 270000})

    def test_cache_evicts_by_pixel_memory_as_well_as_entry_count(self):
        first = uri(Image.new('RGBA', (1500, 1500), (0, 255, 0, 255)))
        second = uri(Image.new('RGBA', (1500, 1500), (0, 0, 255, 255)))
        image_assets.validate_image_data(first)
        image_assets.validate_image_data(second)
        self.assertLessEqual(sum(i.width * i.height * 4 for i in image_assets._cache.values()), image_assets.MAX_CACHE_BYTES)
        self.assertEqual(sum(i.size == (1500, 1500) for i in image_assets._cache.values()), 1)


if __name__ == '__main__':
    unittest.main()
