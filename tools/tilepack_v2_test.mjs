// Cross-language lossless decoding: Python writes fixtures, the actual browser/Node reader decodes them.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readTileData, gunzip, unshuffle4, groundFile } from '../game/src/tilepack.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yr-tilepack-v2-'));
try {
  const python = spawnSync(process.env.PYTHON || '.venv/bin/python', ['tools/tilefmt_v2_test.py', root], { encoding: 'utf8' });
  assert.equal(python.status, 0, python.stderr || python.error?.message); console.log(python.stdout.trim());
  const expected = JSON.parse(await fs.readFile(path.join(root, 'expected.json'), 'utf8'));
  for (const version of [0, 1, 2]) {
    const requests = [];
    const read = async name => { requests.push(name); const b = await fs.readFile(path.join(root, String(version), name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    const data = await readTileData(read, version);
    for (const [key, name] of [['hbuf','height.bin'],['sbuf','surface.bin'],['tbuf','trees.bin'],['pbuf','ponds.bin']]) {
      assert.equal(Buffer.from(data[key]).toString('hex'), expected[name], `${version}/${name} differs`);
    }
    assert.deepEqual(data.tile, JSON.parse(Buffer.from(expected['tile.json'], 'hex')));
    assert(requests.includes(version === 2 ? 'trees.bin.gz' : 'trees.bin'));
    assert.equal(groundFile(version), version ? 'ground.jpg' : 'ground.png', 'imagery unchanged');
  }
  const empty = await fs.readFile(path.join(root,'empty','trees.bin.gz'));
  assert.equal(unshuffle4(await gunzip(empty)).byteLength, 0);
  console.log('PASS actual JS reader plain/v1/v2 bit-exact arrays/JSON, correct tree filenames, empty trees, unchanged image format');
} finally { await fs.rm(root, { recursive: true, force: true }); }
