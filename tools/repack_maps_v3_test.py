import tempfile
from pathlib import Path
import json
from PIL import Image
import repack_maps_v3 as maps

# Use tiny synthetic maps to test unchanged outside pixels before JPEG encoding,
# backup/retry integrity and skip decisions without converting real assets.
a=Image.new('RGB',(100,100),(10,20,30));c=Image.new('RGB',(20,20),(200,50,20))
box=maps.patch_overview(a,c,{'tile':20},{'mpp':1,'extent':[-50,-50,50,50]})
assert box==(40,40,60,60) and a.getpixel((50,50))==(200,50,20)
assert a.getpixel((0,0))==(10,20,30)
with tempfile.TemporaryDirectory() as d:
    base=Path(d);assets=base/'assets';backup=base/'backup'
    (assets/'minimap-detail').mkdir(parents=True);(assets/'tiles/0_0').mkdir(parents=True)
    (assets/'world.json').write_text(json.dumps({'tile':20,'tiles':[[0,0],[1,0]]}))
    (assets/'minimap.json').write_text(json.dumps({'mpp':1,'size':[100,100],'extent':[-50,-50,50,50]}))
    for k in ('0_0','1_0'): c.save(assets/'minimap-detail'/f'{k}.webp','WEBP',quality=88)
    a.save(assets/'minimap.jpg','JPEG')
    maps.bake_detail=lambda *args:c.copy()
    first=maps.repack(assets,backup); outputs={k:(assets/k).read_bytes() for k in first['items']}
    times={k:(assets/k).stat().st_mtime_ns for k in outputs}
    maps.repack(assets,backup)
    assert times=={k:(assets/k).stat().st_mtime_ns for k in outputs}, 'verified outputs should not be rewritten'
    (assets/'minimap-detail/1_0.webp').write_bytes(b'interrupted')
    maps.repack(assets,backup)
    assert outputs=={k:(assets/k).read_bytes() for k in outputs}, 'repair must use immutable originals'
print('PASS: local patch, deterministic immutable backups, hash-verified skips, corrupted-output recovery')
