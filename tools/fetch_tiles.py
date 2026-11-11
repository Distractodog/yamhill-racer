"""Downloads the raw data for every 2 km map tile into data/raw/tiles/<tx>_<tz>/.

World frame (same as the original campus map): metres, x east, z south, origin = centre of the original
campus satellite image (data/raw/naip_info.json). Tile (tx, tz) covers x in [tx*2000-1000, tx*2000+1000],
z likewise. Each tile is fetched with a MARGIN of extra ground on every side so smoothing and edges match up.

Per tile:  naip.jpg   satellite, 1 m/px (tile + margin)
           dem.npy    elevation, float32, 4 m grid aligned to world multiples of 4 m (tile + margin)
           chm.npy    tree height (m), 1 m/px, same footprint as naip.jpg
Whole region: data/raw/osm_region.json (roads, buildings, water, waterways)

Usage: .venv/bin/python tools/fetch_tiles.py [--only tx,tz]
"""
import io, json, math, os, sys, time, urllib.parse, urllib.request
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'data', 'raw')
TILE, MARGIN = 2000, 64
TX = range(-2, 3)          # x: -5000 .. 5000 m  (Willamina -> Sheridan)
TZ = range(-1, 3)          # z: -3000 .. 5000 m
HSTEP = 4.0                # height grid spacing (m)
SAT_PX = 1.0               # satellite / tree-height pixel size (m)
R = 6378137.0
e = json.load(open(os.path.join(RAW, 'naip_info.json')))['extent']
CX, CY = (e['xmin'] + e['xmax']) / 2, (e['ymin'] + e['ymax']) / 2
LAT_C = math.degrees(2 * math.atan(math.exp(CY / R)) - math.pi / 2)
K = math.cos(math.radians(LAT_C))          # web-mercator metres -> real metres (constant across the region)


def merc_bbox(x0, z0, x1, z1):
    """world rectangle -> web mercator bbox (xmin, ymin, xmax, ymax)"""
    return (CX + x0 / K, CY - z1 / K, CX + x1 / K, CY - z0 / K)


def world_to_lonlat(x, z):
    mx, my = CX + x / K, CY - z / K
    return math.degrees(mx / R), math.degrees(2 * math.atan(math.exp(my / R)) - math.pi / 2)


def get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'yamhill-racer-tile-fetch'})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as ex:
            if k == tries - 1: raise
            time.sleep(3 + 5 * k)


def fetch_tile(tx, tz):
    out = os.path.join(RAW, 'tiles', f'{tx}_{tz}')
    os.makedirs(out, exist_ok=True)
    x0, z0 = tx * TILE - TILE / 2 - MARGIN, tz * TILE - TILE / 2 - MARGIN
    x1, z1 = x0 + TILE + 2 * MARGIN, z0 + TILE + 2 * MARGIN
    n_sat = int(round((x1 - x0) / SAT_PX))
    bb = merc_bbox(x0, z0, x1, z1)
    q = lambda d: urllib.parse.urlencode(d)
    if not os.path.exists(os.path.join(out, 'naip.jpg')):
        img = get('https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?' + q(dict(
            bbox=','.join(map(str, bb)), bboxSR=3857, imageSR=3857, size=f'{n_sat},{n_sat}', format='jpg', f='image')))
        Image.open(io.BytesIO(img)).convert('RGB').save(os.path.join(out, 'naip.jpg'), quality=92)
    if not os.path.exists(os.path.join(out, 'dem.npy')):
        # vertex-aligned grid: pixel centres sit exactly on multiples of HSTEP
        n_h = int(round((x1 - x0) / HSTEP)) + 1
        hb = merc_bbox(x0 - HSTEP / 2, z0 - HSTEP / 2, x1 + HSTEP / 2, z1 + HSTEP / 2)
        tif = get('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?' + q(dict(
            bbox=','.join(map(str, hb)), bboxSR=3857, imageSR=3857, size=f'{n_h},{n_h}', format='tiff', pixelType='F32',
            interpolation='RSP_BilinearInterpolation', f='image')))
        np.save(os.path.join(out, 'dem.npy'), np.array(Image.open(io.BytesIO(tif))).astype(np.float32))
    if not os.path.exists(os.path.join(out, 'chm.npy')):
        import rasterio
        from rasterio.warp import reproject, Resampling
        from rasterio.transform import from_bounds
        dst = np.zeros((n_sat, n_sat), np.float32)
        for key in chm_tiles(x0, z0, x1, z1):
            part = np.zeros_like(dst)
            with rasterio.open(f'/vsicurl/https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/{key}.tif') as src:
                reproject(rasterio.band(src, 1), part, dst_transform=from_bounds(*bb, n_sat, n_sat), dst_crs='EPSG:3857',
                          resampling=Resampling.average)
            dst = np.maximum(dst, part)
        np.save(os.path.join(out, 'chm.npy'), dst)
    return out


def quadkey(lat, lon, z=9):
    n = 2 ** z; x = int((lon + 180) / 360 * n); y = int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)
    return ''.join(str(((x >> i) & 1) + 2 * ((y >> i) & 1)) for i in range(z - 1, -1, -1))


def chm_tiles(x0, z0, x1, z1):
    keys = set()
    for x in (x0, x1):
        for z in (z0, z1):
            lon, lat = world_to_lonlat(x, z); keys.add(quadkey(lat, lon))
    return sorted(keys)


def fetch_osm():
    path = os.path.join(RAW, 'osm_region.json')
    if os.path.exists(path): return
    lon0, lat1 = world_to_lonlat(TX.start * TILE - TILE, TZ.start * TILE - TILE)
    lon1, lat0 = world_to_lonlat((TX.stop - 1) * TILE + TILE, (TZ.stop - 1) * TILE + TILE)
    bb = f'{lat0},{lon0},{lat1},{lon1}'
    query = f'[out:json][timeout:180];(way["highway"]({bb});way["building"]({bb});way["natural"="water"]({bb});' \
            f'way["waterway"~"river|stream|canal"]({bb});relation["natural"="water"]({bb}););out tags geom;'
    data = get('https://overpass-api.de/api/interpreter?' + urllib.parse.urlencode({'data': query}))
    open(path, 'wb').write(data)


if __name__ == '__main__':
    only = None
    if '--only' in sys.argv: only = tuple(map(int, sys.argv[sys.argv.index('--only') + 1].split(',')))
    fetch_osm(); print('osm ok', flush=True)
    for tz in TZ:
        for tx in TX:
            if only and (tx, tz) != only: continue
            t = time.time(); fetch_tile(tx, tz); print(f'tile {tx},{tz} ok ({time.time() - t:.0f}s)', flush=True)
