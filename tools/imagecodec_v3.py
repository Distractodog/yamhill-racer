"""Deterministic full-resolution WebP encoding for tile format v3."""
import io
from PIL import Image

GROUND_QUALITY = 86
DETAIL_QUALITY = 75
WEBP_METHOD = 6


def encode_webp(image, quality):
    """Preserve pixel dimensions and RGB/sRGB interpretation; no palette or resize."""
    if quality not in (GROUND_QUALITY, DETAIL_QUALITY):
        raise ValueError('Use a measured v3 image quality')
    out = io.BytesIO()
    image.convert('RGB').save(out, 'WEBP', quality=quality, method=WEBP_METHOD)
    return out.getvalue()


def encode_ground(image):
    return encode_webp(image, GROUND_QUALITY)


def encode_detail(image):
    return encode_webp(image, DETAIL_QUALITY)
