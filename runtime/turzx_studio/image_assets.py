"""Embedded, static PNG validation and bounded decoding. No paths or network IO."""

from __future__ import annotations

import base64
import binascii
from collections import OrderedDict
import hashlib
from io import BytesIO
import re
import struct
from threading import RLock
import zlib

from PIL import Image, ImageOps

MAX_IMAGE_DATA_BYTES = 512 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 16_000_000
MAX_CACHE_BYTES = 16 * 1024 * 1024
MAX_CACHE_ENTRIES = 4
_PREFIX = 'data:image/png;base64,'
_cache: OrderedDict[str, Image.Image] = OrderedDict()
_verified: OrderedDict[str, tuple[int, int]] = OrderedDict()
_lock = RLock()


def _png_bytes(data: str) -> bytes:
    if not isinstance(data, str):
        raise ValueError('expected a string')
    if len(data) > MAX_IMAGE_DATA_BYTES:
        raise ValueError('image exceeds the 512 KiB limit; resize or compress it before importing')
    if not data.startswith(_PREFIX):
        raise ValueError('expected an embedded PNG data URI; import an image to convert it to PNG')
    encoded = data[len(_PREFIX):]
    if not encoded or len(encoded) % 4 or not re.fullmatch(r'[A-Za-z0-9+/]+={0,2}', encoded):
        raise ValueError('invalid PNG base64')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError('invalid PNG base64') from error
    if base64.b64encode(raw).decode('ascii') != encoded:
        raise ValueError('invalid PNG base64 padding')
    if len(raw) > MAX_IMAGE_DATA_BYTES:
        raise ValueError('decoded PNG exceeds the 512 KiB limit')
    return raw


def _structure(raw: bytes) -> tuple[int, int]:
    def invalid():
        raise ValueError('invalid or unsupported PNG image')

    if len(raw) < 57 or raw[:8] != b'\x89PNG\r\n\x1a\n':
        invalid()
    offset = 8
    has_data = has_palette = data_ended = ended = False
    width = height = 0
    while offset + 12 <= len(raw):
        length = struct.unpack_from('>I', raw, offset)[0]
        end = offset + 12 + length
        if end > len(raw):
            invalid()
        kind = raw[offset + 4:offset + 8]
        if not re.fullmatch(b'[A-Za-z]{4}', kind) or not 65 <= kind[2] <= 90:
            invalid()
        if zlib.crc32(raw[offset + 4:end - 4]) != struct.unpack_from('>I', raw, end - 4)[0]:
            invalid()
        if offset == 8:
            if kind != b'IHDR' or length != 13:
                invalid()
            width, height, depth, color, compression, filtering, interlace = struct.unpack_from('>IIBBBBB', raw, offset + 8)
            if not width or not height or width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION or width * height > MAX_IMAGE_PIXELS:
                raise ValueError('PNG dimensions must be at most 4096 per side and 16 million pixels')
            depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
            if depth not in depths.get(color, ()) or compression or filtering or interlace > 1:
                invalid()
        elif kind in (b'IHDR', b'acTL', b'fcTL', b'fdAT'):
            invalid()
        elif kind == b'PLTE':
            if has_palette or has_data or not length or length > 768 or length % 3:
                invalid()
            has_palette = True
        elif kind == b'IDAT':
            if data_ended or (raw[25] == 3 and not has_palette):
                invalid()
            has_data = True
        elif kind == b'IEND':
            if length or not has_data or end != len(raw):
                invalid()
            ended = True
        else:
            if 65 <= kind[0] <= 90:
                invalid()
            if has_data:
                data_ended = True
        offset = end
    if not ended or offset != len(raw):
        invalid()
    return width, height


def _decode(raw: bytes) -> Image.Image:
    try:
        # Restrict plugin selection as well as checking the PNG signature.
        with Image.open(BytesIO(raw), formats=['PNG']) as image:
            if getattr(image, 'n_frames', 1) != 1:
                raise ValueError('animated PNG is unsupported')
            image.verify()
        with Image.open(BytesIO(raw), formats=['PNG']) as image:
            image.load()
            return image.convert('RGBA')
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError) as error:
        raise ValueError('invalid or unsupported PNG image') from error


def _remember(digest: str, image: Image.Image) -> None:
    size = image.width * image.height * 4
    if size > MAX_CACHE_BYTES:
        return
    while _cache and (len(_cache) >= MAX_CACHE_ENTRIES or
                      sum(item.width * item.height * 4 for item in _cache.values()) + size > MAX_CACHE_BYTES):
        _cache.popitem(last=False)
    _cache[digest] = image


def validate_image_data(data: str) -> str:
    raw = _png_bytes(data)
    digest = hashlib.sha256(raw).hexdigest()
    with _lock:
        if digest in _verified:
            _verified.move_to_end(digest)
            return data
        dimensions = _structure(raw)
        image = _decode(raw)
        if image.size != dimensions:
            raise ValueError('PNG dimensions do not match the decoded image')
        _remember(digest, image)
        _verified[digest] = dimensions
        if len(_verified) > 32:
            _verified.popitem(last=False)
    return data


def decode_image(data: str) -> Image.Image:
    """Return a detached RGBA image; cache at most four images and 16 MiB of pixels."""
    validate_image_data(data)
    raw = _png_bytes(data)
    digest = hashlib.sha256(raw).hexdigest()
    with _lock:
        if digest in _cache:
            _cache.move_to_end(digest)
            return _cache[digest].copy()
        image = _decode(raw)
        _remember(digest, image)
        return image.copy() if digest in _cache else image


def render_image(data: str, width: int, height: int, fit: str, opacity: int) -> Image.Image:
    """Center and clip image pixels to an RGBA widget rectangle."""
    source = decode_image(data)
    if fit == 'stretch':
        pixels = source.resize((width, height), Image.Resampling.LANCZOS)
        position = (0, 0)
    elif fit == 'cover':
        # Crop before resizing so extreme widget ratios cannot allocate huge images.
        pixels = ImageOps.fit(source, (width, height), method=Image.Resampling.LANCZOS)
        position = (0, 0)
    else:
        scale = min(width / source.width, height / source.height)
        size = (max(1, min(width, round(source.width * scale))), max(1, min(height, round(source.height * scale))))
        pixels = source.resize(size, Image.Resampling.LANCZOS)
        position = ((width - size[0]) // 2, (height - size[1]) // 2)
    if opacity != 100:
        pixels.putalpha(pixels.getchannel('A').point([round(alpha * opacity / 100) for alpha in range(256)]))
    layer = Image.new('RGBA', (width, height))
    layer.paste(pixels, position)
    return layer
