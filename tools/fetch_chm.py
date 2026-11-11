"""Canopy height (metres) for the satellite extent -> data/raw/chm.npy (2048^2, float32)."""
import json, numpy as np, rasterio
from rasterio.warp import reproject, Resampling
from rasterio.transform import from_bounds
URL = '/vsicurl/https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/021230222.tif'
e = json.load(open('data/raw/naip_info.json'))['extent']
dst = np.zeros((2048, 2048), np.float32)
with rasterio.open(URL) as src:
    reproject(rasterio.band(src, 1), dst, dst_transform=from_bounds(e['xmin'], e['ymin'], e['xmax'], e['ymax'], 2048, 2048),
              dst_crs='EPSG:3857', resampling=Resampling.average)
np.save('data/raw/chm.npy', dst)
