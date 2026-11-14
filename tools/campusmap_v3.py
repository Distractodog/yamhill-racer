"""Paint the current runtime track into a minimap image without duplicated geometry."""
import json
import math
import subprocess
from pathlib import Path
from functools import lru_cache
from PIL import Image, ImageDraw


@lru_cache(maxsize=1)
def track_triangles():
    root = Path(__file__).resolve().parents[1]
    data = json.loads(subprocess.check_output(['node', str(root/'tools/export_track_map.mjs')], cwd=root))
    assert data['source'] == 'game/src/campustrackmodel.js' and data['triangles']
    return data['triangles']


def paint_track(image, x0, z0, mpp, triangles=None):
    """In-place local overlay. Image pixel (0,0) maps to world (x0,z0)."""
    triangles = track_triangles() if triangles is None else triangles
    points = [p for t in triangles for p in t['pts']]
    left = max(0, math.floor((min(p[0] for p in points)-x0)/mpp)-2)
    top = max(0, math.floor((min(p[1] for p in points)-z0)/mpp)-2)
    right = min(image.width, math.ceil((max(p[0] for p in points)-x0)/mpp)+2)
    bottom = min(image.height, math.ceil((max(p[1] for p in points)-z0)/mpp)+2)
    if right <= left or bottom <= top:
        return None
    # Small supersampled transparent patch gives subpixel lane lines coverage;
    # outside model geometry existing road/building/terrain pixels stay intact.
    ss = 8
    overlay = Image.new('RGBA', ((right-left)*ss,(bottom-top)*ss))
    draw = ImageDraw.Draw(overlay)
    for t in triangles:
        pts = [(((x-x0)/mpp-left)*ss,((z-z0)/mpp-top)*ss) for x,z in t['pts']]
        draw.polygon(pts, fill=tuple(t['rgb'])+(255,))
    overlay = overlay.resize((right-left,bottom-top), Image.Resampling.LANCZOS)
    image.paste(overlay,(left,top),overlay)
    return left,top,right,bottom
