"""Geometric checks for connections in the baked race-route graph."""


def junction_supports(junction, point, height, tolerance=.15):
    """A strip end must touch the drawn junction at its own height.

    A junction's bounding radius alone can reach a neighbouring trail several
    metres below it. Linking that trail directly to the junction centre makes
    the race cut across an undriveable bank. Use the same triangle fan as the
    drawn/queryable junction, including small rounding tolerance at its mouths.
    """
    x, z = point
    cx, cz, cy = junction['c']
    ring = junction['ring']
    for a, b in zip(ring, ring[1:] + ring[:1]):
        ax, az, ay = a[:3]
        bx, bz, by = b[:3]
        ux, uz, vx, vz = ax - cx, az - cz, bx - cx, bz - cz
        determinant = ux * vz - uz * vx
        if abs(determinant) < 1e-8:
            continue
        u = ((x - cx) * vz - (z - cz) * vx) / determinant
        v = (ux * (z - cz) - uz * (x - cx)) / determinant
        if u >= -.01 and v >= -.01 and u + v <= 1.01:
            y = cy + u * (ay - cy) + v * (by - cy)
            if abs(y - height) <= tolerance:
                return True
    return False
