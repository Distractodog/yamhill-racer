// CLI-only tests: none of these paths import Puppeteer or launch a browser.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const run=args=>spawnSync(process.execPath,['tools/v3_screens.mjs',...args],{encoding:'utf8'});
let r=run(['--help']);assert.equal(r.status,0);assert.match(r.stdout,/Usage:/);
r=run(['--before','http://127.0.0.1:8001/','--after','http://127.0.0.1:8002/','--out','unused','--chrome','definitely-not-a-browser','--dry-run']);assert.equal(r.status,0,r.stderr);const plan=JSON.parse(r.stdout);assert.equal(plan.captures,8);assert.equal(Object.keys(plan.spots).length,4);assert.match(plan.mode,/not launched/);
for(const args of [[],['--before'],['--wat'],['--before','file:///tmp/game','--after','https://example.com','--out','unused','--dry-run']])assert.notEqual(run(args).status,0);
console.log('PASS: help, dry-run plan, four fixtures/eight captures, missing/unknown/invalid URL rejection; no browser launched');
