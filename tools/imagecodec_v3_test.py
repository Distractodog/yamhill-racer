"""Unit contract; full-resolution 20-tile SSIM research is a separate report."""
import io
import numpy as np
from PIL import Image
from imagecodec_v3 import encode_ground, encode_detail

y, x = np.mgrid[:127, :131]
image = Image.fromarray(np.stack([(x*3)%256, (y*3)%256, (x+y)%256], axis=-1).astype('uint8'))
for encode in (encode_ground, encode_detail):
    a = encode(image)
    assert a == encode(image), 'repeat builds must be deterministic'
    decoded = Image.open(io.BytesIO(a))
    assert decoded.format == 'WEBP' and decoded.size == image.size and decoded.mode == 'RGB'
    assert a[:4] == b'RIFF' and a[8:12] == b'WEBP'
print('PASS: deterministic WebP, unchanged dimensions, RGB, both quality settings')
