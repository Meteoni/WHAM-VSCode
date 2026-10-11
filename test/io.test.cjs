const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { defaults } = require('../dist/config');
const { writeOutput } = require('../dist/io');

test('Windows replacement retries a brief file lock and preserves intervening edits', { skip: process.platform !== 'win32' }, async () => {
  const root = path.resolve('work', 'file-lock-' + Date.now()), output = path.join(root, 'output/mod.wh.cpp');
  await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, 'old');
  const rename = fs.rename, project = { root, config: { ...defaults } };
  let attempts = 0;
  try {
    fs.rename = async (...args) => { if (++attempts === 1) throw Object.assign(new Error('locked'), { code: 'EPERM' }); return rename(...args); };
    await writeOutput(project, output, Buffer.from('new')); assert.equal(attempts, 2); assert.equal(await fs.readFile(output, 'utf8'), 'new');
    fs.rename = async () => { await fs.writeFile(output, 'user edit'); throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
    await assert.rejects(writeOutput(project, output, Buffer.from('overwrite')), /Destination changed/);
    assert.equal(await fs.readFile(output, 'utf8'), 'user edit'); assert.deepEqual(await fs.readdir(path.dirname(output)), ['mod.wh.cpp']);
  } finally { fs.rename = rename; await fs.rm(root, { recursive: true, force: true }); }
});
