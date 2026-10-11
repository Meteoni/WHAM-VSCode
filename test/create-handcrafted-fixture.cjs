// This fixture is assembled independently of the generation engine.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const files = { 'src/mod.cpp': '#include "a.h"\nint root;\n', 'src/a.h': '#include "b.h"\nint a;\n', 'src/b.h': 'int b;' };
const hash = text => createHash('sha256').update(text).digest('hex');
const record = value => '// WHAM@1 ' + JSON.stringify(value) + '\n';
const container = record({ type: 'include', id: 1, path: 'src/a.h', original: Buffer.from('#include "a.h"\n').toString('base64'), before: '', tail: '' }) +
  record({ type: 'include', id: 2, path: 'src/b.h', original: Buffer.from('#include "b.h"\n').toString('base64'), before: '', tail: '\n' }) +
  'int b;\n' + record({ type: 'include-end', id: 2 }) + 'int a;\n' + record({ type: 'include-end', id: 1 }) + 'int root;\n' +
  record({ type: 'manifest', version: 1, root: 'src/mod.cpp', files: Object.entries(files).map(([file, contents]) => ({ path: file, hash: hash(contents), bom: false })),
    config: { formatVersion: 1, sourceDirectory: 'src', outputDirectory: 'output', entries: ['mod.cpp'], exclude: [], includeDirectories: ['src'], externalIncludes: [], inlineAngleIncludes: false, generate: 'onSave', debounceMs: 250 }, tail: '' });
const destination = path.join(__dirname, 'fixtures');
for (const [file, contents] of Object.entries(files)) { const target = path.join(destination, 'expected', file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); }
fs.writeFileSync(path.join(destination, 'handcrafted.wh.cpp'), container);
