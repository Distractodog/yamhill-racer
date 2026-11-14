"""Requantize detail maps and correct campus without raw-data rebuilding.

Provide --assets and --backup (a separate scratch directory). Backups remain
immutable; hash-checked state makes retries deterministic, including after a
write interrupted before state was saved. No existing output is requantized.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
from PIL import Image
from imagecodec_v3 import encode_detail
from build_minimap_detail import bake_detail


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data):
    tmp = path.with_name(path.name+'.tmp')
    tmp.write_bytes(data)
    os.replace(tmp, path)


def patch_overview(image, campus, world, meta):
    """Replace only campus tile pixels; existing rim shading is outside this box."""
    size, mpp = world['tile'], meta['mpp']
    x0 = z0 = -size/2
    rim = world.get('rim')
    if rim:
        assert all((x-rim['cx'])**2+(z-rim['cz'])**2 < (rim['r']-50)**2
                   for x in (x0,x0+size) for z in (z0,z0+size)), 'Campus patch overlaps rim shading'
    values = [(x0-meta['extent'][0])/mpp, (z0-meta['extent'][1])/mpp, size/mpp]
    assert all(abs(v-round(v)) < 1e-8 for v in values), 'Campus must align to map pixels'
    left, top, n = map(round, values)
    assert left >= 0 and top >= 0 and left+n <= image.width and top+n <= image.height
    image.paste(campus.resize((n,n), Image.Resampling.LANCZOS),(left,top))
    return left,top,left+n,top+n


def repack(assets, backup):
    assets, backup = Path(assets), Path(backup)
    assert assets.resolve() not in (backup.resolve(), *backup.resolve().parents), 'Backup must be outside published assets'
    backup.mkdir(parents=True, exist_ok=True)
    state_path = backup/'maps-state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'version':1,'items':{}}
    assert state['version'] == 1
    world = json.loads((assets/'world.json').read_text())
    meta = json.loads((assets/'minimap.json').read_text())
    # Include actual runtime exporter/model dependencies in campus retry identity.
    root = Path(__file__).resolve().parents[1]
    sources = [root/'game/src/campustrack.js',root/'game/src/campustrackmodel.js',
               root/'tools/export_track_map.mjs',root/'tools/campusmap_v3.py',root/'tools/build_minimap_detail.py']
    sources += sorted(p for p in (assets/'tiles/0_0').iterdir() if p.is_file())
    campus_key = digest(b''.join(p.read_bytes() for p in sources))
    def original(rel):
        dest = backup/rel
        if not dest.exists():
            dest.parent.mkdir(parents=True,exist_ok=True)
            atomic(dest,(assets/rel).read_bytes())
        return dest.read_bytes()
    def convert(rel, key, create):
        raw = original(rel)
        identity = digest(raw+key.encode())
        old = state['items'].get(rel)
        if old and old['input'] == identity and digest((assets/rel).read_bytes()) == old['output']:
            return False
        encoded = create(raw)
        atomic(assets/rel,encoded)
        state['items'][rel] = {'input':identity,'output':digest(encoded),'before':len(raw),'after':len(encoded)}
        atomic(state_path,(json.dumps(state,sort_keys=True,indent=2)+'\n').encode())
        return True
    campus = None
    for tx,tz in world['tiles']:
        rel = f'minimap-detail/{tx}_{tz}.webp'
        if (tx,tz) == (0,0):
            campus = bake_detail(world,assets,tx,tz)
            changed = convert(rel,'campus-v1-'+campus_key,lambda raw:encode_detail(campus))
        else:
            changed = convert(rel,'webp75-method6-v1',lambda raw:encode_detail(Image.open(io.BytesIO(raw))))
        print(('converted ' if changed else 'verified existing ')+rel,flush=True)
    assert campus is not None, 'Campus tile missing'
    def overview(raw):
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        assert list(image.size) == meta['size']
        patch_overview(image,campus,world,meta)
        out = io.BytesIO(); image.save(out,'JPEG',quality=82,subsampling=0,optimize=True)
        return out.getvalue()
    convert('minimap.jpg','overview-campus-v1-'+campus_key+json.dumps(meta,sort_keys=True),overview)
    # JPEG is encoded once from immutable original on retries. Decoded pixels
    # outside patch can have normal recompression error; no image resize occurs.
    return state


if __name__ == '__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--assets',type=Path,required=True)
    p.add_argument('--backup',type=Path,required=True)
    args=p.parse_args(); result=repack(args.assets,args.backup)
    print('Map totals:',sum(v['before'] for v in result['items'].values()),'->',sum(v['after'] for v in result['items'].values()))
