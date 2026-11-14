"""Compare source assets with packed assets, one tile at a time.

python tools/verify_pack.py SOURCE DESTINATION [tx,tz ...] [--report report.json]
V1/v2 require byte-identical data. V3 verifies quantization and physics bounds,
exact raster/pond data, tree appearance inputs and shared height core seams.
The size table always covers every asset, even for a selected tile check.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import sys
import struct
import numpy as np
import tilefmt

# Size cap for a full v3 check of game/assets. It was 450 MB while v3 was meant to round heights/trees/roads; exact
# (lossless) packing came out at ~556 MB because any rounding changed how the cars drive (2026-11-14). Ethan accepted
# that: 450 MB was only a target. The hard limit is GitHub Pages' ~1 GB published site, and the coming full-map rebuild
# for bridges and ramps needs room under it. 700 MB leaves ~144 MB for that rebuild and ~300 MB below the Pages limit.
SIZE_LIMIT_BYTES = 700_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def finite(value):
    if isinstance(value, dict):
        return all(finite(v) for v in value.values())
    if isinstance(value, list):
        return all(finite(v) for v in value)
    return not isinstance(value, float) or np.isfinite(value)


def delta(a, b, label, bound=.01):
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    require(a.shape == b.shape and np.isfinite(a).all() and np.isfinite(b).all(), label+' shape/nonfinite')
    error = float(np.abs(a-b).max(initial=0))
    require(error <= bound, f'{label} error {error:.12g} exceeds {bound}')
    return error


def exact_geometry(a, b, path='geometry'):
    """Compare decoded JSON values, including IEEE negative zero and booleans."""
    if isinstance(a,dict):
        require(isinstance(b,dict) and a.keys()==b.keys(),path+' exact keys differ')
        for key in a:exact_geometry(a[key],b[key],path+'.'+key)
    elif isinstance(a,list):
        require(isinstance(b,list) and len(a)==len(b),path+' exact list differs')
        for i,(x,y) in enumerate(zip(a,b)):exact_geometry(x,y,path+f'[{i}]')
    elif type(a) in (int,float):
        require(type(b) in (int,float) and a==b and struct.pack('<d',float(a))==struct.pack('<d',float(b)),path+' exact number differs')
    else:
        require(type(a)==type(b) and a==b,path+' exact value differs')


def geometry(a, b):
    require(finite(a) and finite(b), 'nonfinite tile JSON')
    require(a.keys() == b.keys(), 'tile JSON keys differ')
    maxima = {'geometry_coordinate_error': 0., 'geometry_height_error': 0., 'road_overlay_bound': 0.}
    groups = {'buildings', 'paths', 'physPaths', 'junctions', 'physJunctions'}
    for key in a.keys()-groups:
        require(a[key] == b[key], f'tile JSON {key} differs')
    for key in groups & a.keys():
        require(len(a[key]) == len(b[key]), key+' count differs')
        for old, new in zip(a[key], b[key]):
            require(old.keys() == new.keys(), key+' item keys differ')
            mutable = {'pts','h'} if key == 'buildings' else {'pts','yc'} if key in ('paths','physPaths') else {'c','ring'}
            for prop in old.keys()-mutable:
                require(old[prop] == new[prop], key+' metadata '+prop+' differs')
            if key == 'buildings':
                maxima['geometry_coordinate_error'] = max(maxima['geometry_coordinate_error'], delta(old['pts'],new['pts'],'building coordinates'))
                maxima['geometry_height_error'] = max(maxima['geometry_height_error'], delta(old['h'],new['h'],'building height'))
            elif key in ('paths','physPaths'):
                # Keeping the domain and interpolation unchanged is necessary
                # for the following complete-strip height bound to be valid.
                delta(old['pts'],new['pts'],key+' coordinates',0)
                if 'yc' in old:
                    x,y = np.asarray(old['yc'],float),np.asarray(new['yc'],float)
                    require(x.shape == y.shape and x.ndim == 2 and x.shape[1] == 2, key+' yc shape')
                    e = np.abs(x-y)
                    bound = float((e[:,0]+old['w']/2*e[:,1]).max(initial=0))
                    require(bound <= .01, f'{key} overlay bound {bound:.12g} exceeds 0.01')
                    maxima['road_overlay_bound'] = max(maxima['road_overlay_bound'],bound)
                    maxima['geometry_height_error'] = max(maxima['geometry_height_error'],float(e[:,0].max(initial=0)))
            else:
                require(len(old['ring']) == len(new['ring']),key+' ring length')
                for x,y in zip([old['c'],*old['ring']], [new['c'],*new['ring']]):
                    require(len(x) == len(y),key+' point length')
                    delta(x[:2],y[:2],key+' coordinates',0)
                    maxima['geometry_height_error'] = max(maxima['geometry_height_error'],delta(x[2],y[2],key+' height'))
                    require(x[3:] == y[3:],key+' ring flags differ')
    return maxima


def check_receipt(source, destination, files):
    receipt = json.loads((destination/'v3.json').read_text())
    require(isinstance(receipt,dict) and set(receipt) in ({'version','source','files'},{'version','source','files','profiles'}) and receipt.get('version') == 3, 'invalid v3 receipt schema')
    require(isinstance(receipt['files'],dict) and set(receipt['files']) == files, 'invalid v3 receipt file set')
    def digest(path):
        return hashlib.sha256(path.read_bytes()).hexdigest()
    require(receipt['source'] == {p.name:digest(p) for p in source.iterdir() if p.is_file()}, 'v3 receipt source checksums differ')
    require(receipt['files'] == {name:digest(destination/name) for name in files}, 'v3 receipt destination checksums differ')
    if 'profiles' in receipt:
        profiles=receipt['profiles']
        require(isinstance(profiles,dict) and set(profiles)==files,'invalid v3 receipt profiles schema')
        for name,profile in profiles.items():
            require(isinstance(profile,dict) and set(profile)=={'codec','source'},'invalid v3 receipt profile schema')
            codec=profile['codec']
            require(isinstance(codec,str) and (codec=='legacy-unrecorded' or (len(codec)==64 and all(c in '0123456789abcdef' for c in codec))),'invalid v3 receipt codec profile')
            original=('ground.jpg' if 'ground.jpg' in receipt['source'] else 'ground.png') if name=='ground.webp' else (name if name in receipt['source'] else name.removesuffix('.gz'))
            require(profile['source']==receipt['source'].get(original),'v3 receipt profile source checksum differs')



def sizes(root, exclude_baseline=False):
    table = {}
    for p in Path(root).rglob('*'):
        if not p.is_file():
            continue
        rel = p.relative_to(root)
        if exclude_baseline and rel == Path('baseline.json'):
            continue
        if rel.parts[0] == 'tiles':
            name = p.name.removesuffix('.gz')
            group = 'tiles/ground' if name.startswith('ground.') else 'tiles/'+name
        elif rel.parts[0] == 'minimap-detail':
            group = 'minimap-detail'
        elif len(rel.parts) == 1:
            group = p.name
        else:
            group = rel.parts[0]+'/*'
        table[group] = table.get(group,0)+p.stat().st_size
    return table


def verify(src, dst, only=()):
    src,dst = Path(src),Path(dst)
    world = json.loads((dst/'world.json').read_text())
    version = world.get('packed')
    require(version in (1,2,3), 'world.json must specify supported packed version 1, 2 or 3')
    tiles = [tuple(map(int,t.split(','))) for t in only] if only else [tuple(t) for t in world['tiles']]
    errors=[]; maxima={};edges={};means=[];trees_count=0;seams=0;exact_trees=0;exact_json=0;exact_heights=0
    def record(label,error):
        message=str(error).replace(str(src),'SOURCE').replace(str(dst),'DESTINATION')
        errors.append({'location':label,'error':message})
    if version == 3:
        try:
            sw=json.loads((src/'world.json').read_text())
            require(sw.get('packed') in (None,1,2), 'source must be plain/v1/v2 baseline')
            require({k:v for k,v in sw.items() if k!='packed'} == {k:v for k,v in world.items() if k!='packed'},'world metadata differs')
            require(tiles and len(set(tiles)) == len(tiles),'empty or duplicate tile set')
            expected={f'{x}_{z}' for x,z in world['tiles']}
            require({p.name for p in (dst/'tiles').iterdir() if p.is_dir()} == expected,'destination tile directory set differs')
            require(all(t in map(tuple,world['tiles']) for t in tiles),'selected tile absent from manifest')
        except Exception as e: record('world.json',e)
    for tx,tz in tiles:
        label=f'{tx}_{tz}';s=src/'tiles'/label;d=dst/'tiles'/label
        try:
            if version in (1,2):
                diffs=[name for name in ('height.bin','surface.bin','ponds.bin','trees.bin','tile.json') if tilefmt.read_bytes(s,name)!=tilefmt.read_bytes(d,name)]
                print(f'tile {tx},{tz}: arrays '+('IDENTICAL' if not diffs else 'DIFFER: '+', '.join(diffs)),flush=True)
                require(not diffs,'arrays differ: '+', '.join(diffs))
            else:
                files = {'height.bin.gz','surface.bin.gz','ponds.bin.gz','trees.bin.gz','tile.json.gz','ground.webp'}
                actual = {p.name for p in d.iterdir()}
                require(actual in (files,files|{'v3.json'}),'v3 tile filename set differs')
                if 'v3.json' in actual:
                    check_receipt(s,d,files)
                for name,magic in [('height.bin.gz',b'H3Q0'),('trees.bin.gz',b'TRV3')]:
                    require(gzip.decompress((d/name).read_bytes()).startswith(magic),name+' is not v3')
                ah=np.frombuffer(tilefmt.read_bytes(s,'height.bin'),'<f4');bh=np.frombuffer(tilefmt.read_bytes(d,'height.bin'),'<f4')
                err=delta(ah,bh,'heights');maxima['height_error']=max(maxima.get('height_error',0),err)
                height_payload=gzip.decompress((d/'height.bin.gz').read_bytes())
                if len(height_payload)>=16 and struct.unpack_from('<H',height_payload,6)[0]==8:
                    require(ah.tobytes()==bh.tobytes(),'exact height sample bits differ')
                    exact_heights+=1
                side=world['hn']+2*world['hm'];require(bh.size==side*side,'height grid size')
                h=bh.reshape(side,side);lo=world['hm'];hi=lo+world['hn']-1
                edges[(tx,tz)]=[h[lo:hi+1,lo].copy(),h[lo:hi+1,hi].copy(),h[lo,lo:hi+1].copy(),h[hi,lo:hi+1].copy()]
                for name in ('surface.bin','ponds.bin'):
                    require(tilefmt.read_bytes(s,name)==tilefmt.read_bytes(d,name),name+' differs')
                a=np.frombuffer(tilefmt.read_bytes(s,'trees.bin'),'<f4').reshape(-1,4);b=np.frombuffer(tilefmt.read_bytes(d,'trees.bin'),'<f4').reshape(-1,4)
                require(a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all(),'tree count/nonfinite')
                require(a[:,2:].tobytes()==b[:,2:].tobytes(),'tree heights/types/order differ')
                radial=float(np.linalg.norm(a[:,:2].astype(float)-b[:,:2],axis=1).max(initial=0))
                require(radial<=.02,f'tree radial error {radial:.12g} exceeds 0.02')
                origin=np.array([tx*world['tile']-world['tile']/2,tz*world['tile']-world['tile']/2])
                require(np.array_equal(np.floor((a[:,:2].astype(float)-origin)/250),np.floor((b[:,:2].astype(float)-origin)/250)),'tree render bucket/order differs')
                tree_payload=gzip.decompress((d/'trees.bin.gz').read_bytes())
                if len(tree_payload)>=20 and struct.unpack_from('<I',tree_payload,16)[0]==0xffffffff:
                    require(a.tobytes()==b.tobytes(),'exact tree record bits differ')
                    exact_trees+=1
                maxima['tree_radial_error']=max(maxima.get('tree_radial_error',0),radial);trees_count+=len(a)
                aj=json.loads(tilefmt.read_bytes(s,'tile.json'));bj=json.loads(tilefmt.read_bytes(d,'tile.json'))
                for key,value in geometry(aj,bj).items():maxima[key]=max(maxima.get(key,0),value)
                stored_json=json.loads(gzip.decompress((d/'tile.json.gz').read_bytes()))
                if isinstance(stored_json,dict) and stored_json.get('format')=='G3E1':
                    exact_geometry(aj,bj)
                    exact_json+=1
                print(f'tile {tx},{tz}: v3 PASS height {err:.8f}, trees {radial:.8f}',flush=True)
            a=np.asarray(tilefmt.read_ground(s),np.int16);b=np.asarray(tilefmt.read_ground(d),np.int16)
            require(a.shape==b.shape,'ground image shape differs');means.append(float(np.abs(a-b).mean()))
        except Exception as e:
            record('tiles/'+label,e);print(f'tile {tx},{tz}: FAIL {errors[-1]["error"]}',flush=True)
    for (tx,tz),edge in edges.items():
        for neighbour,i,j in [((tx+1,tz),1,0),((tx,tz+1),3,2)]:
            if neighbour in edges:
                seams+=1
                if edge[i].tobytes()!=edges[neighbour][j].tobytes():record('height seams',f'{tx},{tz} to {neighbour[0]},{neighbour[1]} differ')
    before,after=sizes(src,exclude_baseline=True),sizes(dst);table=[]
    print('Asset type | before bytes | after bytes | saved bytes')
    for kind in sorted(before.keys()|after.keys()):
        a,b=before.get(kind,0),after.get(kind,0);table.append({'type':kind,'before':a,'after':b,'saved':a-b});print(f'{kind} | {a} | {b} | {a-b}')
    total_before,total_after=sum(before.values()),sum(after.values());print(f'TOTAL | {total_before} | {total_after} | {total_before-total_after}')
    if version == 3 and not only and total_after > SIZE_LIMIT_BYTES:
        record('asset size',f'{total_after} bytes exceeds {SIZE_LIMIT_BYTES} byte limit')
    report={'version':version,'tiles_checked':len(tiles),'tree_count':trees_count,'exact_height_tiles_checked':exact_heights,'exact_tree_tiles_checked':exact_trees,'exact_geometry_tiles_checked':exact_json,'shared_core_seams_checked':seams,'max_errors':maxima,'ground_mean_absolute_channel_error':float(np.mean(means)) if means else None,'size_table':table,'total_before_bytes':total_before,'total_after_bytes':total_after,'size_limit_bytes':SIZE_LIMIT_BYTES if version == 3 and not only else None,'errors':errors,'passed':not errors}
    print(f'{len(tiles)} tiles checked, {len(errors)} failures')
    return report


def main(src,dst,only,report_path=None):
    try:report=verify(src,dst,only)
    except Exception as e:print(str(e),file=sys.stderr);return 1
    if report_path:Path(report_path).write_text(json.dumps(report,indent=2,allow_nan=False)+'\n')
    return 0 if report['passed'] else 1


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('src');p.add_argument('dst');p.add_argument('tiles',nargs='*');p.add_argument('--report');a=p.parse_args()
    sys.exit(main(a.src,a.dst,a.tiles,a.report))
