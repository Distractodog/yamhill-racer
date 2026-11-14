# Yamhill Racer

A low-poly open-world racing game set on real roads and forest trails in Yamhill County, Oregon —
from Willamina through the hills to Sheridan (about 10 × 8 km). Runs in the browser, no install.

**Play:** https://distractodog.github.io/yamhill-racer/

## Controls
| Key | |
|---|---|
| W / S or ↑ / ↓ | throttle / brake (and reverse) |
| A / D or ← / → | steer |
| Space | handbrake — tap it while steering to drift |
| R | back to a recent spot on the road |
| H | back to the Delphian campus |
| C | change camera |
| T | car tuning panel |

A gamepad works too (right trigger, left trigger, left stick, A for handbrake).

## How the world is made
- **Ground** — USGS 3DEP lidar elevation.
- **Forest** — trees are placed wherever the canopy-height data says trees really are.
- **Roads, buildings, lakes** — OpenStreetMap, widened so they're raceable; extra building outlines from Overture Maps (Microsoft ML buildings).
- **Trails** — traced from a hand-drawn trail map.
- The map is cut into 2 km tiles that stream in as you drive.

`tools/fetch_tiles.py` downloads the raw data per tile and `tools/build_tiles.py` bakes `game/assets/`.
`npm run drive` runs headless physics test drives. The game itself is plain ES modules + three.js (no build step):
serve `game/` with any static web server.

## Credits & data licences
- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
- Extra building outlines: © OpenStreetMap contributors, Microsoft, and [Overture Maps Foundation](https://docs.overturemaps.org/attribution/) (buildings theme, ODbL).
- Elevation: USGS 3D Elevation Program; imagery used to colour the ground: USDA NAIP (both public domain).
- Tree heights: Meta & World Resources Institute, *High Resolution Canopy Height Maps* (CC BY 4.0).
- Engine sound: real BMW 120d recordings by GiocoSound on [Freesound](https://freesound.org/people/GiocoSound/packs/22622/) (CC0).
- Rendering: [three.js](https://threejs.org) (MIT).
