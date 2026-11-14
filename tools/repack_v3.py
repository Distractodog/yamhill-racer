"""Repack existing v2 assets in place, one tile at a time, without raw data.

  .venv/bin/python tools/repack_v3.py

Immutable backups live outside the published game. Each tile is built in a
temporary directory, hash-checked, then installed. A per-tile receipt allows
safe resume after interruption; world.json changes only after all tiles finish.
--limit N deliberately stops after N conversions for resumability checks.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import tilefmt
import ast
import zlib

ROOT = Path(__file__).resolve().parents[1]
FILES = ('height.bin.gz', 'surface.bin.gz', 'ponds.bin.gz', 'trees.bin.gz', 'tile.json.gz', 'ground.webp')
RECEIPT = 'v3.json'


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            digest.update(block)
    return digest.hexdigest()



def source_hashes(directory):
    return {str(p.relative_to(directory)): sha(p) for p in sorted(directory.rglob('*'))
            if p.is_file() and p != directory/'baseline.json'}


def overlaps(a, b):
    return a == b or a in b.parents or b in a.parents


def atomic_json(path, data):
    temp = path.with_name(path.name+'.tmp')
    temp.write_text(json.dumps(data, sort_keys=True, separators=(',', ':'))+'\n')
    os.replace(temp, path)


def prepare_backup(assets, backup):
    if overlaps(assets, backup):
        raise ValueError('Backup and published assets must be separate directories')
    if backup.exists():
        if not (backup/'baseline.json').is_file():
            raise ValueError('Backup exists without a completed baseline receipt')
        receipt = json.loads((backup/'baseline.json').read_text())
        if receipt.get('version') != 2 or receipt.get('files') != source_hashes(backup):
            raise ValueError('Immutable backup failed checksum validation')
        world = json.loads((backup/'world.json').read_text())
        if world.get('packed') != 2:
            raise ValueError('Backup must contain the original v2 data')
        return world
    world = json.loads((assets/'world.json').read_text())
    if world.get('packed') != 2:
        raise ValueError('Initial conversion requires v2 assets')
    backup.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='v3-backup-', dir=backup.parent) as temp:
        staged = Path(temp)/'assets'
        shutil.copytree(assets, staged)
        atomic_json(staged/'baseline.json', {'version': 2, 'files': source_hashes(staged)})
        staged.rename(backup)
    return world


def verify_receipt(tile, source):
    receipt = json.loads((tile/RECEIPT).read_text())
    if (not isinstance(receipt, dict) or receipt.get('version') != 3
            or not isinstance(receipt.get('files'), dict) or set(receipt['files']) != set(FILES)):
        raise ValueError('Invalid v3 tile receipt')
    if set(p.name for p in tile.iterdir()) != set(FILES) | {RECEIPT}:
        raise ValueError('Unexpected/stale files in v3 tile')
    if receipt['source'] != {p.name: sha(p) for p in sorted(source.iterdir()) if p.is_file()}:
        raise ValueError('V2 source changed since conversion')
    for name, digest in receipt['files'].items():
        if sha(tile/name) != digest:
            raise ValueError('V3 tile failed checksum: '+tile.name+'/'+name)


REFRESH = {'height.bin', 'trees.bin', 'tile.json'}
OBSOLETE = {'height.bin','surface.bin','ponds.bin','trees.bin','tile.json','ground.jpg','ground.png'}


def codec_profile(name):
    modules = {'height.bin.gz':'heightcodec_v3.py','trees.bin.gz':'treecodec_v3.py',
               'tile.json.gz':'jsoncodec_v3.py','ground.webp':'imagecodec_v3.py'}
    parts = [b'v3-file-profile-1', zlib.ZLIB_VERSION.encode()]
    source=(ROOT/'tools/tilefmt.py').read_text()
    function_name='write_ground' if name=='ground.webp' else 'write_bytes'
    node=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name==function_name)
    parts.append(ast.get_source_segment(source,node).encode())
    if name in modules: parts.append((ROOT/'tools'/modules[name]).read_bytes())
    return hashlib.sha256(b'\0'.join(parts)).hexdigest()


def repack(assets, backup, scratch, limit=None, refresh=None):
    selected = set(FILES) if refresh is None else {name+'.gz' for name in refresh}
    if refresh is not None and (not refresh or set(refresh)-REFRESH):
        raise ValueError('Unknown/empty refresh list; use height.bin,trees.bin,tile.json')
    assets, backup, scratch = (Path(p).resolve() for p in (assets, backup, scratch))
    if overlaps(assets, scratch) or overlaps(backup, scratch):
        raise ValueError('Scratch must not overlap assets or backup')
    world = prepare_backup(assets, backup)
    scratch.mkdir(parents=True, exist_ok=True)
    # Fail before changing any tiles if user files are present. Cleanup is a
    # separate authorized action, never inferred from a filename suffix.
    for tx,tz in world['tiles']:
        target=assets/'tiles'/f'{tx}_{tz}'
        if target.exists() and set(p.name for p in target.iterdir())-set(FILES)-OBSOLETE-{RECEIPT}:
            raise ValueError('Unexpected files in target tile '+target.name)
    profiles={name:codec_profile(name) for name in FILES}
    converted = skipped = 0
    for tx, tz in world['tiles']:
        key=f'{tx}_{tz}';target,source=assets/'tiles'/key,backup/'tiles'/key
        source_digests={p.name:sha(p) for p in sorted(source.iterdir()) if p.is_file()}
        try:
            receipt=json.loads((target/RECEIPT).read_text())
            if not isinstance(receipt,dict) or receipt.get('version')!=3 or receipt.get('source')!=source_digests or not isinstance(receipt.get('files'),dict) or set(receipt['files'])!=set(FILES): receipt={}
        except (ValueError,TypeError,OSError):receipt={}
        old_profiles=receipt.get('profiles',{})
        if not isinstance(old_profiles,dict):old_profiles={}
        expected={name:{'codec':profiles[name],'source':source_digests['ground.jpg' if name=='ground.webp' else name]} for name in FILES}
        reusable={name for name in FILES if (target/name).is_file() and receipt.get('files',{}).get(name)==sha(target/name)}
        rebuild=set(FILES)-reusable
        rebuild|={name for name in selected if old_profiles.get(name)!=expected[name]}
        if not rebuild and not any((target/name).exists() for name in OBSOLETE):
            skipped+=1;continue
        if limit is not None and converted>=limit:return {'complete':False,'converted':converted,'skipped':skipped}
        with tempfile.TemporaryDirectory(prefix='tile-v3-',dir=scratch) as temp:
            staged=Path(temp)/key;staged.mkdir()
            new_profiles={}
            for name in FILES:
                if name not in rebuild:
                    shutil.copyfile(target/name,staged/name)
                    new_profiles[name]=old_profiles.get(name,{'codec':'legacy-unrecorded','source':expected[name]['source']})
                elif name=='ground.webp':
                    with tilefmt.read_ground(source) as image:tilefmt.write_ground(staged,image)
                    new_profiles[name]=expected[name]
                else:
                    rawname=name.removesuffix('.gz')
                    tilefmt.write_bytes(staged,rawname,tilefmt.read_bytes(source,rawname))
                    new_profiles[name]=expected[name]
            for name in ('height.bin','surface.bin','ponds.bin','trees.bin'):
                if len(tilefmt.read_bytes(staged,name))!=len(tilefmt.read_bytes(source,name)):raise ValueError('Decoded size mismatch: '+key+'/'+name)
            tilefmt.read_json(staged)
            atomic_json(staged/RECEIPT,{'version':3,'source':source_digests,'files':{name:sha(staged/name) for name in FILES},'profiles':new_profiles})
            verify_receipt(staged,source)
            target.mkdir(parents=True,exist_ok=True)
            # No tile-directory renames. A partial install leaves an absent or
            # mismatching receipt, so the next run repairs from trusted v2 data.
            for name in FILES:os.replace(staged/name,target/name)
            for name in OBSOLETE:
                if (target/name).exists():(target/name).unlink()
            os.replace(staged/RECEIPT,target/RECEIPT)
        converted+=1;print(f'{converted+skipped}/{len(world["tiles"])} {key}',flush=True)
    world['packed']=3;atomic_json(assets/'world.json',world)
    return {'complete':True,'converted':converted,'skipped':skipped}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--assets', type=Path, default=ROOT/'game/assets')
    parser.add_argument('--backup', type=Path, default=ROOT/'work/v3/baseline-assets')
    parser.add_argument('--scratch', type=Path, default=ROOT/'work/v3/staging')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--refresh', help='Comma-separated height.bin,trees.bin,tile.json; preserve other validated files')
    args = parser.parse_args()
    print(json.dumps(repack(args.assets, args.backup, args.scratch, args.limit, args.refresh.split(',') if args.refresh is not None else None), sort_keys=True))
