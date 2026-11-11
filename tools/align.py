"""Map px (Delphiantrailsmap.png) <-> satellite px (data/raw/naip.jpg, 2048x2048).
Affine fit from landmarks visible in both."""
import numpy as np
# (map x, map y) -> (sat x, sat y)
CP = [
    ((700, 1108), (698, 1050)),   # running track centre
    ((775, 920),  (762, 930)),    # tennis courts
    ((360, 1000), (470, 983)),    # pond 7
    ((545, 1295), (590, 1180)),   # playground ponds
    ((740, 1215), (732, 1125)),   # gym
    ((720, 1385), (720, 1225)),   # main building
]
src = np.array([c[0] for c in CP], float); dst = np.array([c[1] for c in CP], float)
A = np.c_[src, np.ones(len(src))]
M, *_ = np.linalg.lstsq(A, dst, rcond=None)        # 3x2: sat = [mx,my,1] @ M
Minv, *_ = np.linalg.lstsq(np.c_[dst, np.ones(len(dst))], src, rcond=None)
def map_to_sat(x, y): return np.c_[x, y, np.ones(np.size(x))] @ M
def sat_to_map(x, y): return np.c_[x, y, np.ones(np.size(x))] @ Minv
if __name__ == '__main__':
    res = A @ M - dst
    print('residual px', np.round(np.hypot(*res.T), 1))
