"""Full-resolution deterministic 20-tile SSIM check; writes a portable JSON report.

  .venv/bin/python tools/image_ssim_v3.py --assets game/assets --out work/image-ssim.json
  Add --converted other/assets to compare actual converted files instead of encoding.
Requires scikit-image. Sources must be the pre-conversion v2 images.
"""
import argparse
import io
import json
from pathlib import Path
import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity
from imagecodec_v3 import encode_ground, encode_detail, GROUND_QUALITY, DETAIL_QUALITY, WEBP_METHOD


def verify(assets, converted=None):
    paths = sorted((assets / 'tiles').glob('*/ground.jpg'))
    if len(paths) < 20:
        raise ValueError('Need at least 20 original ground JPEG tiles')
    sample = [paths[round(i * (len(paths)-1) / 19)] for i in range(20)]
    rows = []
    for path in sample:
        row = {'tile': path.parent.name}
        for kind, source, encode in [('ground', path, encode_ground),
                                     ('detail', assets/'minimap-detail'/(path.parent.name+'.webp'), encode_detail)]:
            with Image.open(source) as opened:
                original = opened.convert('RGB')
            if converted is None:
                raw = encode(original)
            else:
                destination = (converted/'tiles'/path.parent.name/'ground.webp' if kind == 'ground'
                               else converted/'minimap-detail'/(path.parent.name+'.webp'))
                raw = destination.read_bytes()
            with Image.open(io.BytesIO(raw)) as opened:
                decoded = opened.convert('RGB')
            if decoded.size != original.size:
                raise ValueError(f'{path.parent.name} {kind}: image dimensions changed')
            score = structural_similarity(np.asarray(original), np.asarray(decoded), channel_axis=2, data_range=255)
            row[kind] = {'ssim': float(score), 'before': source.stat().st_size, 'after': len(raw)}
        rows.append(row)
        print(f'{len(rows)}/20 {row["tile"]}: ground {row["ground"]["ssim"]:.6f}, detail {row["detail"]["ssim"]:.6f}', flush=True)
    summary = {}
    for kind, threshold in [('ground', .97), ('detail', .95)]:
        values = [r[kind] for r in rows]
        before, after = (sum(v[k] for v in values) for k in ('before','after'))
        mean = sum(v['ssim'] for v in values) / len(values)
        summary[kind] = {'meanSSIM': mean, 'minSSIM': min(v['ssim'] for v in values),
                         'threshold': threshold, 'pass': mean >= threshold,
                         'sampleBefore': before, 'sampleAfter': after, 'byteRatio': after/before}
    return {'selection': '20 evenly spaced lexicographically sorted ground JPEG paths, endpoints inclusive',
            'method': 'Full-resolution RGB skimage structural_similarity defaults: 7x7 window, sample covariance, data_range255',
            'comparison': 'actual converted files' if converted else 'fresh deterministic encoding',
            'quality': {'ground': GROUND_QUALITY, 'detail': DETAIL_QUALITY, 'method': WEBP_METHOD},
            'summary': summary, 'rows': rows, 'pass': all(s['pass'] for s in summary.values())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, required=True)
    parser.add_argument('--converted', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    report = verify(args.assets, args.converted)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps(report['summary'], indent=2))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
