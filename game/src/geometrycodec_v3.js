// Lossless G3E1 wrapper; legacy JSON remains accepted during tool migration.
const clone = value => structuredClone(value);
function matrix(value, scales) {
  if (Array.isArray(value)) {if(value.some(r=>!Array.isArray(r)||r.length!==scales.length||r.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw Error('Invalid raw geometry matrix');return value;}
  if (!value || Object.keys(value).join() !== '$d' || !Array.isArray(value.$d) || value.$d.length !== 3) throw Error('Invalid geometry matrix');
  const [actual, flat, zeros] = value.$d, n = scales.length;
  if (!Array.isArray(actual) || actual.length !== n || actual.some((s,i)=>s!==scales[i]) || !Array.isArray(flat) || !Array.isArray(zeros) || flat.length%n) throw Error('Invalid geometry matrix dimensions');
  const prev=Array(n).fill(0),out=[];
  for(let i=0;i<flat.length;i+=n){const row=[];for(let j=0;j<n;j++){
    if(!Number.isSafeInteger(flat[i+j]))throw Error('Invalid geometry delta');
    prev[j]+=flat[i+j];if(!Number.isSafeInteger(prev[j])||Math.abs(prev[j])>2**52)throw Error('Geometry coordinate overflow');
    row.push(prev[j]/scales[j]);
  }out.push(row);}
  const seen=new Set();for(const i of zeros){if(!Number.isInteger(i)||i<0||i>=flat.length||seen.has(i)||out[Math.floor(i/n)][i%n]!==0)throw Error('Invalid negative-zero index');seen.add(i);out[Math.floor(i/n)][i%n]=-0;}
  return out;
}
export function decodeGeometry(value) {
  const steps=decodeGeometrySteps(value);let r;while(!(r=steps.next()).done);return r.value;
}
// The same decode in pieces (a town tile takes ~50-150 ms in one go): yields 'geometry' every ~`budget` points, so
// world.js can spread it over frames. inPlace: decode into `value.tile` itself (a fresh JSON.parse nobody else holds).
export function* decodeGeometrySteps(value,{inPlace=false,budget=6000}={}) {
  if(!value||value.format!=='G3E1')return value;
  if(Object.keys(value).sort().join()!=='format,roads,tile'||!Array.isArray(value.roads)||!value.tile||typeof value.tile!=='object'||Array.isArray(value.tile))throw Error('Invalid geometry wrapper');
  let work=0;const tick=n=>(work+=n)>budget?(work=0,true):false,rows=v=>v?.$d?.[1]?.length??v?.length??1;
  const obj=inPlace?value.tile:clone(value.tile),pool=inPlace?value.roads:clone(value.roads);
  for(const r of pool){if(!r||typeof r!=='object'||!('pts'in r))throw Error('Invalid pooled road');r.pts=matrix(r.pts,[100,100]);if('yc'in r)r.yc=matrix(r.yc,[1000,10000]);if(tick(r.pts.length*2))yield 'geometry';}
  for(const k of ['paths','physPaths'])if(k in obj){const refs=obj[k];if(!refs||Object.keys(refs).join()!=='$p'||!Array.isArray(refs.$p))throw Error('Invalid road references');const out=[];for(const i of refs.$p){if(!Number.isInteger(i)||i<0||i>=pool.length)throw Error('Invalid road index');out.push(clone(pool[i]));if(tick(pool[i].pts.length))yield 'geometry';}obj[k]=out;}
  for(const b of obj.buildings||[]){const n=rows(b.pts);b.pts=matrix(b.pts,[100,100]);if(tick(n))yield 'geometry';}
  for(const k of ['junctions','physJunctions'])for(const j of obj[k]||[]){if(j.c&&!Array.isArray(j.c)){const c=matrix(j.c,[100,100,1000]);if(c.length!==1)throw Error('Invalid junction center');j.c=c[0];}else j.c=matrix([j.c],[100,100,1000])[0];j.ring=matrix(j.ring,[100,100,1000,1]);if(tick(j.ring.length))yield 'geometry';}
  return obj;
}
