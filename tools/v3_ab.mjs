// Reproducible forward A/B: frozen v2 physics/data, then exactly one v3 decoded field.
// node tools/v3_ab.mjs --component hbuf --section diagnostic --out work/v3/followup
// Baseline: --component baseline --section all. Repeat with --label baseline-2.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync,spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const flags={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw Error('Arguments require --name value');flags[process.argv[i].slice(2)]=process.argv[i+1]}
const repo=path.resolve(flags.repo||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const component=flags.component||'baseline',section=flags.section||'diagnostic',label=flags.label||component;
if(!['baseline','hbuf','tbuf','tile','sbuf'].includes(component)||!['all','diagnostic'].includes(section)||!/^[a-z0-9_-]+$/i.test(label))throw Error('Invalid component, section or label');
const out=path.resolve(repo,flags.out||'work/v3/followup'),base=path.resolve(repo,flags.baseline||'work/v3/baseline-assets'),candidate=path.resolve(repo,flags.candidate||'game/assets');
fs.mkdirSync(out,{recursive:true});
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const decoder=path.join(out,'decoder');fs.mkdirSync(decoder,{recursive:true});
for(const name of ['tilepack.js','heightcodec_v3.js','treecodec_v3.js','geometrycodec_v3.js']){
 const dest=path.join(decoder,name);if(!fs.existsSync(dest))fs.copyFileSync(path.join(repo,'game/src',name),dest);
}
const sourceResult=spawnSync('git',['show','67327f0:tools/drive.mjs'],{cwd:repo,encoding:'utf8'});if(sourceResult.status!==0)throw Error(sourceResult.stderr);
let source=sourceResult.stdout;
// Use a simple URL-prefix replacement so static and dynamic imports share the frozen baseline modules.
source=sourceResult.stdout.replaceAll("'../game/","'"+pathToFileURL(path.join(repo,'work/v3/before-game/game/')).href);
source=source.replace("from 'three'","from '"+pathToFileURL(path.join(repo,'node_modules/three/build/three.module.js')).href+"'");
const loaderURL=pathToFileURL(path.join(decoder,'tilepack.js')).href;
source=source.replace("import fs from 'fs';",`import fs from 'fs';\nimport {readTileData as readCandidate} from ${JSON.stringify(loaderURL)};\nconst V3_FIELD=${JSON.stringify(component)}, V3_ASSETS=${JSON.stringify(candidate+'/')};`);
const old='  W.add(makeTileData(WJ, tx, tz, await readTileData(async f => ab(d + f), WJ.packed)));';
if(!source.includes(old))throw Error('Baseline drive load hook changed');
source=source.replace(old,`  const decoded = await readTileData(async f => ab(d + f), WJ.packed);\n  if(V3_FIELD!=='baseline'){\n    const candidate=await readCandidate(async f=>ab(V3_ASSETS+'tiles/'+tx+'_'+tz+'/'+f),3);\n    decoded[V3_FIELD]=candidate[V3_FIELD];\n  }\n  W.add(makeTileData(WJ,tx,tz,decoded));`);
if(section==='diagnostic')for(const name of ['hills','walls','jet'])source=source.replace(`which === '${name}'`,`which === '${name}' || which === 'diagnostic'`);
// Full map always loaded; no subset assumption and no production asset writes.
const script=path.join(out,`${label}-drive.mjs`),log=path.join(out,`${label}.txt`);fs.writeFileSync(script,source);
const metadata={baselineCommit:'67327f0',component,direction:'v2 base + one v3 decoded field',section,baselineWorldHash:hash(path.join(base,'world.json')),candidateWorldHash:hash(path.join(candidate,'world.json')),decoderHashes:Object.fromEntries(['tilepack.js','heightcodec_v3.js','treecodec_v3.js','geometrycodec_v3.js'].map(n=>[n,hash(path.join(decoder,n))])),sourceHash:createHash('sha256').update(sourceResult.stdout).digest('hex'),log:path.basename(log),started:new Date().toISOString()};
fs.writeFileSync(path.join(out,`${label}.json`),JSON.stringify(metadata,null,2)+'\n');
const fd=fs.openSync(log,'w');
const child=spawn(process.execPath,['--max-old-space-size=8192',script,section],{cwd:repo,env:{...process.env,YR_ASSETS:base,ONLY:section==='diagnostic'?'north':''},stdio:['ignore',fd,fd]});
const [code,signal]=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve([code,signal])));fs.closeSync(fd);
metadata.exitCode=code;metadata.signal=signal;metadata.finished=new Date().toISOString();
fs.writeFileSync(path.join(out,`${label}.json`),JSON.stringify(metadata,null,2)+'\n');console.log(JSON.stringify(metadata));process.exitCode=code??1;
