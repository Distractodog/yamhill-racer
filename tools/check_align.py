import sys, numpy as np
sys.path.insert(0, 'tools')
from PIL import Image
import mapdata, align
masks = mapdata.map_masks()
sat = np.array(Image.open('data/raw/naip.jpg').convert('RGB'))
COL = {'black': (255,255,255), 'longwalk': (255,40,40), 'overgrown': (255,170,0), 'odyssey': (60,200,255),
       'ripps': (255,255,0), 'agony': (255,0,200), 'waterfall': (80,80,255)}
for k, c in COL.items():
    ys, xs = np.nonzero(masks[k])
    p = align.map_to_sat(xs, ys).round().astype(int)
    ok = (p[:,0]>=0)&(p[:,0]<2048)&(p[:,1]>=0)&(p[:,1]<2048)
    sat[p[ok,1], p[ok,0]] = c
Image.fromarray(sat[300:1600, 300:1300]).save('data/raw/align_check.jpg', quality=88)
