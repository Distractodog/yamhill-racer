"""Shared overview/detail road strokes: link strips retain their baked lane width."""
def paint_roads(draw, tiles, px, mpp, palette):
    for kind in ('trail', 'gravel', 'asphalt'):
        fill, edge, width = palette[kind]
        lines, gores = [], []
        for tile in tiles:
            for road in tile['paths']:
                if road['kind'] != kind:
                    continue
                # Main roads keep the cartographic width; a link uses its actual narrower strip.
                w = min(width, road['w']) if '_link' in road.get('cls', '').split(':')[0] else width
                lines.append(([px(p) for p in road['pts']], w))
            for junction in tile.get('junctions', []):
                if junction['kind'] != kind:
                    continue
                ring = junction['ring']
                if junction.get('gore'):
                    gores.append([px(p) for p in ring])
                    continue
                for i, p in enumerate(ring):
                    if p[3] == 0:
                        q = ring[(i + 1) % len(ring)]
                        lines.append(([px(junction['c']), px([(p[0]+q[0])/2, (p[1]+q[1])/2])], width))
        for color, extra in ((edge, 4), (fill, 0)):
            for points, w in lines:
                if len(points) > 1:
                    draw.line(points, fill=color, width=max(1, round((w+extra)/mpp)), joint='curve')
            # A gore is pavement, not a full-width spoke that would swallow the split.
            for polygon in gores:
                draw.polygon(polygon, fill=color)
