# Yamhill Racer

A low-poly open-world racing game set on real roads and forest trails in Yamhill County, Oregon —
from Willamina through Sheridan and the hills to McMinnville. Runs in the browser, no install.

**Play:** https://distractodog.github.io/yamhill-racer/

## Make it yours

- Choose a spawn point on the map each time you open the game. **H** returns to that point for the rest of the session.
- Open **Garage** during free roam for vehicle paint, trim, wheels, liveries, race numbers and rider colors. Rotate the preview by dragging and zoom with the wheel. Save up to three looks per vehicle; **Wash & repair** removes dust, wetness and scuffs.
- Earn **Delphian green** by finishing the Long Walk climb, **Trail explorer** by finishing all three dirt-bike races, and **Sky captain** by finishing both jet races. Race progress and saved looks stay in your browser; previous best times count toward unlocks.
- Open **Atmosphere** for midday, golden hour, misty morning, dusk, night or rain. Weather, wear and cosmetics change appearance without changing vehicle performance or grip.
- The flat map zooms from the whole valley down to streets and buildings, revealing more detail as you zoom. Click to place a navigation pin.

## Controls

| Key | |
|---|---|
| W / S or ↑ / ↓ | throttle / brake (and reverse) |
| A / D or ← / → | steer |
| Space | handbrake — tap it while steering to drift |
| R | back to a recent spot on the road |
| H | return to your chosen spawn |
| C | change camera |
| T | vehicle tuning panel |
| V | choose car, dirt bike or jet |
| J | race list |
| F | flip upright / level the jet |
| G | open / fold the car or bike glider |
| M | full map |
| + / −, scroll or pinch | zoom the map around the pointer |
| 0 | fit the whole map |
| P | remove the map pin |
| Esc | close a menu or map; otherwise leave the race |

Drag to pan the map. **Garage**, **Atmosphere**, and **How to play?** are in the top menu; Help includes the bike and jet controls.

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

### Road directions

While on a road, open the map (M), click ↱ Directions, then click a road destination.
The green line follows connected asphalt/gravel roads. Turn prompts and remaining distance
stay visible while driving; leaving the route recalculates when you return to a road.
Use the × on the directions prompt to clear the route. Ordinary map pins still work.

After rebuilding tile roads, run `python3 tools/build_navigation.py` to refresh
`game/assets/navigation.json`. Verify with `node tools/navigation_test.mjs`.
Roof support and terrain-aligned track paint have regression checks in
`tools/roof_landing_test.mjs` and `tools/terrainpaint_test.mjs`.
