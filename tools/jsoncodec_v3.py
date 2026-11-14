"""Lossless G3E1 geometry: pooled roads and exact integer-delta matrices."""
import copy
import json
import math
MAGIC = 'G3E1'
GROUPS = ('paths', 'physPaths')


def dumps(value):
    return json.dumps(value, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')


def matrix(rows, scales):
    if not rows or any(not isinstance(r, list) or len(r) != len(scales) for r in rows):
        return rows
    prev = [0]*len(scales); flat = []; zeros = []
    for row in rows:
        current = []
        for v, scale in zip(row, scales):
            if type(v) not in (int, float) or not math.isfinite(v):
                return rows
            q = round(v*scale)
            if abs(q) > 2**52 or q/scale != v:
                return rows
            current.append(q)
            if v == 0 and math.copysign(1, v) < 0: zeros.append(len(flat)+len(current)-1)
        flat.extend(x-y for x,y in zip(current,prev)); prev = current
    if any(abs(d)>2**53-1 for d in flat): return rows
    return {'$d': [scales, flat, zeros]}


def compact(tile):
    obj = copy.deepcopy(tile); pool = []; seen = {}
    for group in GROUPS:
        if group not in obj: continue
        refs = []
        for original in obj[group]:
            key = dumps(original)
            if key not in seen:
                road = copy.deepcopy(original)
                road['pts'] = matrix(road['pts'], [100,100])
                if 'yc' in road: road['yc'] = matrix(road['yc'], [1000,10000])
                seen[key] = len(pool); pool.append(road)
            refs.append(seen[key])
        obj[group] = {'$p': refs}
    for b in obj.get('buildings', []): b['pts'] = matrix(b['pts'], [100,100])
    for group in ('junctions','physJunctions'):
        for j in obj.get(group, []):
            encoded = matrix([j['c']], [100,100,1000])
            if isinstance(encoded, dict): j['c'] = encoded
            j['ring'] = matrix(j['ring'], [100,100,1000,1])
    return {'format': MAGIC, 'roads': pool, 'tile': obj}


def encode(tile):
    return dumps(compact(tile))


def unpack_matrix(value, scales):
    if isinstance(value, list):
        if any(not isinstance(r,list) or len(r)!=len(scales) or any(type(v) not in (int,float) or not math.isfinite(v) for v in r) for r in value): raise ValueError('Invalid raw geometry matrix')
        return value
    if not isinstance(value, dict) or set(value) != {'$d'}: raise ValueError('Invalid geometry matrix tag')
    data = value['$d']
    if not isinstance(data,list) or len(data)!=3: raise ValueError('Invalid geometry matrix')
    actual,flat,zeros = data; n=len(scales)
    if actual!=scales or not isinstance(flat,list) or not isinstance(zeros,list) or len(flat)%n:
        raise ValueError('Invalid geometry matrix dimensions')
    prev=[0]*n; out=[]
    for i in range(0,len(flat),n):
        row=[]
        for j in range(n):
            d=flat[i+j]
            if type(d)!=int or abs(d)>2**53-1: raise ValueError('Invalid geometry delta')
            prev[j]+=d
            if abs(prev[j])>2**52: raise ValueError('Geometry coordinate overflow')
            row.append(prev[j]/scales[j])
        out.append(row)
    seen=set()
    for i in zeros:
        if type(i)!=int or i<0 or i>=len(flat) or i in seen or out[i//n][i%n]!=0:
            raise ValueError('Invalid negative-zero index')
        seen.add(i);out[i//n][i%n]=-0.0
    return out


def decode(value):
    if not isinstance(value,dict) or value.get('format')!=MAGIC: return value
    if set(value)!={'format','roads','tile'} or not isinstance(value['roads'],list) or not isinstance(value['tile'],dict):
        raise ValueError('Invalid geometry wrapper')
    obj=copy.deepcopy(value['tile']);pool=copy.deepcopy(value['roads'])
    try:
        for road in pool:
            road['pts']=unpack_matrix(road['pts'],[100,100])
            if 'yc' in road:road['yc']=unpack_matrix(road['yc'],[1000,10000])
        for group in GROUPS:
            if group not in obj:continue
            refs=obj[group]
            if not isinstance(refs,dict) or set(refs)!={'$p'} or not isinstance(refs['$p'],list):raise ValueError('Invalid road references')
            if any(type(i)!=int or i<0 or i>=len(pool) for i in refs['$p']):raise ValueError('Invalid road index')
            obj[group]=[copy.deepcopy(pool[i]) for i in refs['$p']]
        for b in obj.get('buildings',[]):b['pts']=unpack_matrix(b['pts'],[100,100])
        for group in ('junctions','physJunctions'):
            for j in obj.get(group,[]):
                if isinstance(j['c'],dict):
                    c=unpack_matrix(j['c'],[100,100,1000])
                    if len(c)!=1:raise ValueError('Invalid junction center')
                    j['c']=c[0]
                else: j['c']=unpack_matrix([j['c']],[100,100,1000])[0]
                j['ring']=unpack_matrix(j['ring'],[100,100,1000,1])
    except (KeyError,TypeError,IndexError) as e:raise ValueError('Malformed geometry wrapper') from e
    dumps(obj)  # rejects nonfinite numeric values
    return obj


def decode_bytes(payload):
    parsed=json.loads(payload)
    if not isinstance(parsed,dict) or parsed.get('format')!=MAGIC:return payload
    return dumps(decode(parsed))
