// NAIP tile 0_0 (1 m/pixel) survey additions. Positions/roof colours are measured;
// heights and seating details are modest architectural approximations, not photogrammetry.
const AX = [0.2133, 0.9770], EAST = [AX[1], -AX[0]];
export const STAND = { c: [-621.5, 42.5], L: 66, W: 8, angle: Math.atan2(AX[1], AX[0]) * 180 / Math.PI };
export const standAt = (along, east) => [STAND.c[0] + AX[0] * along + EAST[0] * east, STAND.c[1] + AX[1] * along + EAST[1] * east];
const concrete = [0.68, 0.69, 0.67], metal = [0.66, 0.69, 0.70], roof = [0.48, 0.19, 0.18];
const rect = (c, L, W, a = STAND.angle) => ({ c, L, W, a });
const block = (name, c, L, W, h, color = concrete) => ({ name, rect: rect(c,L,W), h, wall: color, roof: { type: 'flat', color, parapet: 0 } });
const boxes = [];
// Seven rows, broken by three access aisles. Seats rise westwards, facing the track.
for (let row=0;row<7;row++) for (const [a,b] of [[-31,-17],[-15,-1],[1,15],[17,31]]) {
  boxes.push({ c:standAt((a+b)/2,2.9-row*.95),L:b-a,W:.42,a:STAND.angle,y0:.42+row*.4,y1:.52+row*.4,color:metal });
}
// Back guardrail and roof posts; no unverified press box.
for (let u=-32;u<=32;u+=8) for (const e of [-3.6,3.6]) boxes.push({c:standAt(u,e),L:.18,W:.18,a:STAND.angle,y0:0,y1:5.2,color:[.35,.38,.38]});
for (const y of [3.25,3.8]) boxes.push({c:standAt(0,-3.6),L:65,W:.09,a:STAND.angle,y0:y,y1:y+.09,color:metal});
for (const u of [-32,32]) for (let i=0;i<7;i++) boxes.push({c:standAt(u,2.9-i*.95),L:.09,W:1,a:STAND.angle,y0:1.25+i*.4,y1:1.34+i*.4,color:metal});
const tiers = Array.from({length:7},(_,i)=>block(`seating tier ${i+1}`,standAt(0,2.9-i*.95),64,.95,.12+i*.4));
tiers[0].boxes=boxes;
// Half-rise stairs in the aisles, visibly distinguishable from the full seating risers.
for(const u of [-16,0,16]) for(let i=0;i<14;i++) tiers.push(block('aisle step',standAt(u,3.14-i*.475),1.8,.475,.12+i*.2));
const shed = (name,c,L,W,a) => ({name,osm:[c],floorAt:c,dy:.12,
  parts:[{rect:rect(c,L,W,a),h:3.1,wall:[.83,.84,.79],roof:{type:'gable',color:[.82,.85,.83],pitch:12,over:.25}}]});
export const SAT_BUILDINGS = [
  {name:'Track covered bleachers',osm:[[-603.2,53.6]],floorAt:STAND.c,dy:.08,satelliteDetail:true,
    phys:[[[-32,-3.375],[32,-3.375],[32,3.375],[-32,3.375]].map(([u,v])=>standAt(u,v))],parts:tiers},
  // An independent elevated solid keeps the seating open below the roof, including collision.
  {name:'Track grandstand roof',osm:[],floorAt:STAND.c,dy:5.1,elevated:true,satelliteDetail:true,
    parts:[{rect:rect(STAND.c,67,8.6),h:.16,openWalls:true,wall:roof,roof:{type:'gable',color:roof,pitch:7,over:.15}}]},
  shed('North meadow shed',[-563,-568],22,16,-32),
  shed('Tennis utility building',[-532.5,-134.6],26,11,67),
];
// Four tennis courts, measured as a single rectangle; no invented car park under them.
export const COURTS = { c:[-461,-163], L:69, W:35, a:87 };
export function courtXZ(u,v) {
  const a=COURTS.a*Math.PI/180;
  return [COURTS.c[0]+Math.cos(a)*u-Math.sin(a)*v,COURTS.c[1]+Math.sin(a)*u+Math.cos(a)*v];
}
export const courtPoly = [[-34.5,-17.5],[34.5,-17.5],[34.5,17.5],[-34.5,17.5]].map(([u,v])=>courtXZ(u,v));
export const APRON = [[-626,7],[-615,5],[-600,76],[-611,78]];
