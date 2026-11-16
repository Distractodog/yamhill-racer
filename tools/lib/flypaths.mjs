// Flight paths for the fly-lag measurements (tools/fly_lag_sim.mjs in Node, tools/fly_lag_test.mjs in the browser).
// A path is a pure function of time: path.at(t) → { x, z, yaw, bank, vx, vz, w } (metres, m/s; yaw: forward =
// (sin, cos); w = turn rate, rad/s, + = yaw increasing). makePath uses nothing outside itself, so a browser script can
// send its source to page.evaluate.
//   const p = makePath({ place: 'mcminnville', path: 'circle', kmh: 1000 }); const s = p.at(2.5);
export const PLACES = {
  // start point and the heading a straight line flies (chosen to stay over map tiles for ~12 km)
  mcminnville: { x: 19100, z: -11000, yaw: -Math.PI / 2, label: 'McMinnville' },
  sheridan: { x: 3800, z: 1400, yaw: Math.PI / 2, label: 'Sheridan' },
  forest: { x: 0, z: -20000, yaw: Math.PI / 2, label: 'forest (N woods)' },
  farmland: { x: 9000, z: 6000, yaw: -Math.PI / 2, label: 'farmland' },
};
// tools/stream_test.mjs's run: the car carried west → east at z = 1500 from x = -4800 (9.6 km)
export const STREAM_RUN = { name: 'STREAM car straight 1000', place: 'stream', path: 'straight', kmh: 1000, seconds: 9600 / (1000 / 3.6),
  places: { stream: { x: -4800, z: 1500, yaw: Math.PI / 2, label: 'stream test line' } } };
// jet top speeds (km/h): fighter ~1733 (AGENTS.md), stealth ~25% faster (vehicletypes.js)
export const MAX_KMH = { fighter: 1733, stealth: 2170 };
export const TURN_ACC = 120;           // m/s² sideways in a turn (5 game g; the fighter allows 8, the stealth 10)

// places / turnAcc are parameters (not module variables) so the function's source runs on its own in a page
export function makePath({ place, path, kmh, seconds = null }, places = PLACES, turnAcc = TURN_ACC) {
  const P = places[place], v = kmh / 3.6;
  const w0 = turnAcc / v;              // turn rate at that pull
  // circle: 1.15 turns; S-turns: ±120° each way; straight: 18 s
  const dur = seconds ?? (path === 'circle' ? 1.15 * 2 * Math.PI / w0 : path === 'sturn' ? Math.max(18, 4 * (2 * Math.PI / 3) / w0) : 18);
  const half = (2 * Math.PI / 3) / w0;           // one S leg (120° of heading); the first is half as long so the
  const rate = t => path === 'circle' ? w0 : path === 'sturn' ? w0 * (Math.floor(t / half + 0.5) % 2 ? -1 : 1) : 0;   // S swings either side of the start line
  // integrate once at 240 Hz into a table
  const H = 1 / 240, n = Math.ceil(dur / H) + 2, X = new Float64Array(n), Z = new Float64Array(n), Y = new Float64Array(n), R = new Float64Array(n);
  let x = P.x, z = P.z, yaw = P.yaw;
  for (let i = 0; i < n; i++) {
    const w = rate(i * H);
    X[i] = x; Z[i] = z; Y[i] = yaw; R[i] = w;
    yaw += w * H; x += Math.sin(yaw) * v * H; z += Math.cos(yaw) * v * H;
  }
  return {
    duration: dur, kmh, v,
    at(t) {
      const f = Math.max(0, Math.min(n - 1.001, t / H)), i = Math.floor(f), a = f - i;
      const yaw = Y[i] + (Y[i + 1] - Y[i]) * a, w = R[i];
      return { x: X[i] + (X[i + 1] - X[i]) * a, z: Z[i] + (Z[i + 1] - Z[i]) * a, yaw, w, vx: Math.sin(yaw) * v, vz: Math.cos(yaw) * v,
        bank: Math.atan2(w * v, 24) };       // the bank a coordinated turn at game gravity needs
    },
  };
}

// the scenario list: name → { place, path, kmh, type }. allStealth: the stealth at every speed too (by default it only
// adds its higher top speed)
export function scenarios({ places = Object.keys(PLACES), paths = ['straight', 'circle', 'sturn'], speeds = [600, 1000, 'max'], types = ['fighter', 'stealth'], allStealth = false } = {}) {
  const out = [];
  for (const place of places) for (const path of paths) for (const sp of speeds) for (const type of types) {
    if (type === 'stealth' && sp !== 'max' && !allStealth) continue;
    const kmh = sp === 'max' ? MAX_KMH[type] : sp;
    out.push({ name: `${place} ${path} ${type} ${kmh}`, place, path, kmh, type });
  }
  return out;
}
