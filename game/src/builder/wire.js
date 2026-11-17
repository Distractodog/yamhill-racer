// Bounded chunks fit the relay's 16 KiB message limit, including JSON escaping.
export const CHUNK_SIZE=6000, MAX_CHUNKS=86;
export function layoutChunks(code, revision) {
  if(typeof code!=='string' || code.length>512000)throw new Error('Layout is too large.');
  const total=Math.max(1,Math.ceil(code.length/CHUNK_SIZE));
  return Array.from({length:total},(_,index)=>({t:'layout',revision,index,total,data:code.slice(index*CHUNK_SIZE,(index+1)*CHUNK_SIZE)}));
}
export function validChunk(m) {
  return m && m.t==='layout' && typeof m.revision==='string' && /^[a-zA-Z0-9_-]{1,64}$/.test(m.revision) &&
    Number.isInteger(m.total) && m.total>=1 && m.total<=MAX_CHUNKS && Number.isInteger(m.index) && m.index>=0 && m.index<m.total &&
    typeof m.data==='string' && m.data.length<=CHUNK_SIZE;
}
export function acceptChunk(pending,m) {
  if(!validChunk(m))return {pending,complete:null};
  if(!pending || pending.revision!==m.revision || pending.total!==m.total)pending={revision:m.revision,total:m.total,chunks:{}};
  pending.chunks[m.index]=m;
  if(Object.keys(pending.chunks).length!==pending.total)return {pending,complete:null};
  const complete=Array.from({length:pending.total},(_,i)=>pending.chunks[i]);
  return {pending:null,complete};
}
