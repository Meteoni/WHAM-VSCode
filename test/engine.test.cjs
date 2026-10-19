const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { defaults, validateConfig, discoverEntries, outputPath } = require('../dist/config');
const { generateEntry, restoreSource, checksum } = require('../dist/engine');
const { scanSource } = require('../dist/scanner');
const { commitRestore, nodeFiles } = require('../dist/io');

function fixture(contents, configuration = {}) {
  const root = path.resolve('work', 'fixture');
  const buffers = new Map(Object.entries(contents).map(([file, content]) => [path.join(root, file), Buffer.isBuffer(content) ? content : Buffer.from(content)]));
  const access = {
    read: async file => { if (!buffers.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return buffers.get(file); },
    identity: async file => { if (file !== path.join(root, 'src') && !buffers.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return file; },
    list: async directory => [...buffers.keys()].filter(file => file.startsWith(directory + path.sep))
  };
  return { project: { root, config: validateConfig(configuration) }, access, buffers };
}
async function roundTrip(contents, configuration = {}, entry = 'src/mod.cpp') {
  const input = fixture(contents, configuration);
  const generated = await generateEntry(input.project, path.join(input.project.root, entry), input.access);
  assert.ok(generated.bytes, JSON.stringify(generated.diagnostics));
  const recovered = restoreSource(generated.bytes);
  assert.equal(recovered.conflicts.length, 0);
  for (const [file, candidates] of recovered.files) assert.deepEqual(candidates[0].bytes, input.buffers.get(path.join(input.project.root, file)), file);
  const replay = fixture(Object.fromEntries([...recovered.files].map(([file, candidates]) => [file, candidates[0].bytes])), recovered.manifest.config);
  const regenerated = await generateEntry(replay.project, path.join(replay.project.root, entry), replay.access);
  assert.deepEqual(regenerated.bytes, generated.bytes);
  return { ...input, generated, recovered };
}

test('hand-constructed nested v1 container restores exact files', async () => {
  const fixtureRoot = path.join(__dirname, 'fixtures');
  const recovered = restoreSource(await fs.readFile(path.join(fixtureRoot, 'handcrafted.wh.cpp')));
  for (const [file, candidates] of recovered.files) assert.deepEqual(candidates[0].bytes, await fs.readFile(path.join(fixtureRoot, 'expected', file)));
});

test('hand-constructed compact v2 container restores exact directive and missing final newline', () => {
  const root = '#include "a.h"\r\n', child = 'int a;';
  const manifest = { type: 'manifest', version: 2, root: 'src/mod.cpp', config: { ...defaults }, tail: '',
    files: [{ path: 'src/mod.cpp', hash: checksum(root), bom: false }, { path: 'src/a.h', hash: checksum(child), bom: false }],
    records: [{ type: 'include', id: 1, path: 'src/a.h', directive: root, separatorAfter: '\n' }] };
  const container = `// WHAM@2 begin 1: src/a.h\n${child}\n// WHAM@2 end 1\n// WHAM@2 recovery ${JSON.stringify(manifest)}\n`;
  const restored = restoreSource(Buffer.from(container));
  assert.equal(restored.files.get('src/mod.cpp')[0].bytes.toString(), root); assert.equal(restored.files.get('src/a.h')[0].bytes.toString(), child);
  assert.equal(restored.conflicts.length, 0);
});

test('compact markers keep recovery fields in the footer and reject mismatched or unused data', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\r\n', 'src/a.h': 'int a;' });
  const source = generated.bytes.toString();
  assert.ok(source.startsWith('// WHAM@3 begin 1: src/a.h\n'));
  const body = source.slice(0, source.indexOf('// #region WHAM recovery'));
  assert.ok(!body.includes('original') && !body.includes('before') && !body.includes('{'));
  assert.ok(source.includes('"directive": "#include \\"a.h\\"\\r\\n"'));
  for (const broken of [source.replace('begin 1: src/a.h', 'begin 1: src/other.h'), source.replace('end 1', 'end 99'),
    source.replace('"id": 1', '"id": 2'), source.replace('"records": [', '"records": [\n// {"type":"include","id":99,"path":"src/a.h"},')]) assert.throws(() => restoreSource(Buffer.from(broken)));
});
test('nested source preserves Windhawk metadata and explicit included cpp', async () => {
  const metadata = '// ==WindhawkMod==\n// @id demo\n// ==/WindhawkMod==\n/*\n# include "not-real.h"\n*/\n';
  const result = await roundTrip({ 'src/mod.cpp': metadata + '#include "a.hpp"\n#include "impl.cpp"\n', 'src/a.hpp': '#include "nested/b.h"\n', 'src/nested/b.h': 'const int answer = 42;\n', 'src/impl.cpp': 'void run() {}\n', 'src/unused.h': 'unused' });
  assert.ok(result.generated.bytes.toString().startsWith(metadata)); assert.equal(result.recovered.files.size, 4);
});
test('once headers are repeated in inactive branches and restored verbatim', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#include "a.h"\n', 'src/a.h': '// hello\n# pragma once\nint shared = 1;\n' });
  assert.equal((generated.bytes.toString().match(/int shared = 1;/g) || []).length, 2);
  assert.equal((generated.bytes.toString().match(/#ifndef WHAM_ONCE_/g) || []).length, 2);
});
test('traditional guards and X-macro headers preserve repeat semantics', async () => {
  await roundTrip({ 'src/mod.cpp': '#include "guard.h"\n#include "repeat.inc"\n#include "repeat.inc"\n', 'src/guard.h': '#ifndef GUARD\n#define GUARD\nint x;\n#endif\n', 'src/repeat.inc': 'ITEM(one)\nITEM(two)\n' });
});
test('lexical context, continuations, comments before directives, and raw markers', async () => {
  const source = 'const char* s = R"tag(\n#include "fake.h"\n// WHAM@1 {"type":"fake"}\n)tag";\nconst char* q = "#include \\\"fake.h\\\"";\n/* prefix */ # include \\\n "real.h" // trailing\n/* spanning\n*/#include "real.h"\n';
  const { generated } = await roundTrip({ 'src/mod.cpp': source, 'src/real.h': '/* #include "fake.h" */\n' });
  assert.equal(generated.diagnostics.length, 0);
});
test('mixed newlines, BOM, empty files, and missing final newline round trip', async () => {
  await roundTrip({ 'src/mod.cpp': '\uFEFF// mod\r\n#include "empty.h"\n#include "bom.h"\r\n#include "tail.h"', 'src/empty.h': '', 'src/bom.h': '\uFEFF#pragma once\r\nconst int y = 1;\n', 'src/tail.h': 'int z;' });
  await roundTrip({ 'src/mod.cpp': '', 'src/unused.h': '' });
  await roundTrip({ 'src/mod.cpp': '\uFEFF#include "empty.h"', 'src/empty.h': '\uFEFF' });
});
test('digit separators and multiline trailing include comments preserve directive boundaries', async () => {
  await roundTrip({ 'src/mod.cpp': "int count = 1'000;\n#include \"a.h\" /* trailing\n comment */\n", 'src/a.h': 'int a;\n' });
});
test('include search uses relative location before declared directories', async () => {
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': '#include "one/a.h"\n', 'src/one/a.h': '#include "same.h"\n', 'src/one/same.h': 'int correct;', 'src/two/same.h': 'int wrong;' }, { includeDirectories: ['src/two', 'src'] });
  assert.equal(recovered.files.size, 3); assert.ok(!generated.bytes.toString().includes('int wrong'));
});
test('separate entries share dependencies but recover independently', async () => {
  const input = fixture({ 'src/a.cpp': '#include "shared.h"\n', 'src/nested/b.cpp': '#include "../shared.h"\n', 'src/shared.h': 'int x;\n' });
  const entries = await discoverEntries(input.project, input.access); assert.equal(entries.length, 2);
  for (const entry of entries) {
    const generated = await generateEntry(input.project, entry, input.access); assert.equal(generated.dependencies.size, 2); assert.equal(restoreSource(generated.bytes).files.size, 2);
  }
  assert.equal(outputPath(input.project, entries[1]), path.join(input.project.root, 'output/nested/b.wh.cpp'));
});
test('output collisions diagnosed, wh suffix retained', async () => {
  const input = fixture({ 'src/a.cpp': '', 'src/a.wh.cpp': '' });
  await assert.rejects(discoverEntries(input.project, input.access), /collision/);
  assert.equal(outputPath(input.project, path.join(input.project.root, 'src/a.wh.cpp')), path.join(input.project.root, 'output/a.wh.cpp'));
});
test('edits to root and nested header land in their original files', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\nint root = 1;', 'src/a.h': '#include "b.h"\nint parent = 1;\n', 'src/b.h': 'int child = 1;\n' });
  const recovered = restoreSource(Buffer.from(generated.bytes.toString().replace('int child = 1', 'int child = 2').replace('int root = 1', 'int root = 2')));
  assert.ok(recovered.files.get('src/b.h')[0].bytes.toString().includes('child = 2'));
  assert.ok(!recovered.files.get('src/a.h')[0].changed); assert.ok(recovered.files.get('src/mod.cpp')[0].changed);
});
test('divergent repeated edits always report a conflict', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': '#pragma once\nint edit = 1;\n' });
  const edited = restoreSource(Buffer.from(generated.bytes.toString().replace('int edit = 1;', 'int edit = 2;')));
  assert.deepEqual(edited.conflicts, ['src/a.h']); assert.equal(edited.files.get('src/a.h').filter(candidate => candidate.changed).length, 1);
});
test('missing inactive include, recursion, macros, and late pragma fail', async () => {
  for (const [contents, message] of [
    [{ 'src/mod.cpp': '#if 0\n#include "missing.h"\n#endif' }, /Missing local/],
    [{ 'src/mod.cpp': '#include "a.h"', 'src/a.h': '#include "mod.cpp"' }, /cycle/],
    [{ 'src/mod.cpp': '#include HEADER' }, /Macro include/],
    [{ 'src/mod.cpp': '#include "a.h"', 'src/a.h': 'int a;\n#pragma once\n' }, /pragma once/],
    [{ 'src/mod.cpp': '#include "a.h"', 'src/a.h': '#if FLAG\n#pragma once\n#endif' }, /pragma once/],
    [{ 'src/mod.cpp': '#include_next "a.h"' }, /include_next/],
    [{ 'src/mod.cpp': '#if __has_include("a.h")\n#endif' }, /__has_include/]
  ]) {
    const input = fixture(contents); const result = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access);
    assert.equal(result.bytes, undefined); assert.match(result.diagnostics.map(item => item.message).join('\n'), message);
  }
});
test('external SDK and macro include rules preserve exact directives', async () => {
  await roundTrip({ 'src/mod.cpp': '#include "sdk.h" // sdk\n#include HEADER\n#include <windows.h>\n' }, { externalIncludes: ['sdk.h', 'HEADER'] });
});
test('angle expansion is optional and uses configured directories', async () => {
  const { recovered } = await roundTrip({ 'src/mod.cpp': '#include <local.h>\n#include <windows.h>\n', 'src/local.h': 'int local;\n' }, { inlineAngleIncludes: true });
  assert.equal(recovered.files.size, 2);
});
test('strict UTF-8 and reserved recovery comments fail generation', async () => {
  for (const content of [Buffer.from([0xff]), '// WHAM@1 {"type":"manifest"}\n', '// WHAM@3 begin 1: src/a.h\n']) {
    const input = fixture({ 'src/mod.cpp': content }); const generated = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access); assert.equal(generated.bytes, undefined);
  }
});
test('edited synthetic code, malformed nesting and unknown versions stop recovery', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n', 'src/a.h': '#pragma once\nint a;\n' });
  const source = generated.bytes.toString();
  for (const broken of [source.replace('#define WHAM_ONCE_', '#define BAD_'), source.replace('// WHAM@3 end 1', '// WHAM@3 end 999'), source.replace('// WHAM@3 ', '// WHAM@9 '), source.replace('"version": 3', '"version": 9')]) assert.throws(() => restoreSource(Buffer.from(broken)));
});
test('traversal, case collisions, and duplicate IDs are rejected', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "b.h"\n', 'src/a.h': 'int a;\n', 'src/b.h': 'int b;\n' });
  for (const modified of [generated.bytes.toString().replaceAll('src/a.h', '../a.h'), generated.bytes.toString().replaceAll('src/b.h', 'src/A.h'), generated.bytes.toString().replace('"id": 2', '"id": 1')]) assert.throws(() => restoreSource(Buffer.from(modified)));
});
test('config paths cannot overlap or escape', () => {
  for (const config of [{ sourceDirectory: '../src' }, { outputDirectory: 'src/out' }, { sourceDirectory: 'Output' }, { includeDirectories: ['/sdk'] }, { debounceMs: -1 }, { entries: ['../*.cpp'] }]) assert.throws(() => validateConfig(config));
});
test('recovery refuses conflicts and overwrite before creating files', async () => {
  const destination = path.resolve('work', 'restore-' + Date.now());
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': 'int a;\n' });
  const conflicted = restoreSource(Buffer.from(generated.bytes.toString().replace('int a;', 'int edit;')));
  await assert.rejects(commitRestore(conflicted, destination), /Unresolved/);
  await assert.rejects(fs.stat(destination), /ENOENT/);
  const clean = restoreSource(generated.bytes);
  await commitRestore(clean, destination);
  assert.deepEqual(await fs.readFile(path.join(destination, 'src/mod.cpp')), clean.files.get('src/mod.cpp')[0].bytes);
  await fs.writeFile(path.join(destination, 'src/a.h'), 'preserve me');
  await assert.rejects(commitRestore(clean, destination), /differs/);
  assert.equal(await fs.readFile(path.join(destination, 'src/a.h'), 'utf8'), 'preserve me');
  await fs.rm(destination, { recursive: true, force: true });
});
test('source changes during repeated expansion are diagnosed', async () => {
  const input = fixture({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': 'int a;' });
  const read = input.access.read; let reads = 0;
  input.access.read = async file => { const bytes = await read(file); return file.endsWith('a.h') && ++reads > 1 ? Buffer.from('int b;') : bytes; };
  const generated = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access);
  assert.equal(generated.bytes, undefined); assert.match(generated.diagnostics.map(item => item.message).join(), /changed during/);
});
test('source symlink escapes and ambiguous canonical aliases are rejected', async () => {
  const input = fixture({ 'src/mod.cpp': '#include "a.h"\n', 'src/a.h': 'int a;' });
  const identity = input.access.identity;
  input.access.identity = async file => file.endsWith('a.h') ? path.resolve('work/outside/a.h') : identity(file);
  const escaped = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access);
  assert.equal(escaped.bytes, undefined); assert.match(escaped.diagnostics.map(item => item.message).join(), /Symlink escapes/);
  const alias = fixture({ 'src/mod.cpp': '#include "a.h"\n#include "alias.h"\n', 'src/a.h': 'int a;', 'src/alias.h': 'int a;' });
  const canonical = alias.access.identity;
  alias.access.identity = async file => file.endsWith('alias.h') ? path.join(alias.project.root, 'src/a.h') : canonical(file);
  const ambiguous = await generateEntry(alias.project, path.join(alias.project.root, 'src/mod.cpp'), alias.access);
  assert.equal(ambiguous.bytes, undefined); assert.match(ambiguous.diagnostics.map(item => item.message).join(), /Ambiguous/);
});
test('recovery stops at a destination junction before writing anything', async () => {
  const root = path.resolve('work', 'junction-' + Date.now()), outside = path.join(root, 'outside'), destination = path.join(root, 'destination');
  await fs.mkdir(outside, { recursive: true }); await fs.mkdir(destination);
  try {
    await fs.symlink(outside, path.join(destination, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    const { recovered } = await roundTrip({ 'src/mod.cpp': 'int a;' });
    await assert.rejects(commitRestore(recovered, destination), /symlink/);
    assert.deepEqual(await fs.readdir(outside), []); await assert.rejects(fs.stat(path.join(destination, 'windhawk-amalgamation.json')), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('v3 wraps long recovery strings without changing escapes, Unicode or source bytes', async () => {
  const directive = '#include "a.h" // ' + '\\'.repeat(800) + '😀'.repeat(400) + ' */ end\r\n';
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': directive, 'src/a.h': '#pragma once\nint a;' },
    { externalIncludes: ['sdk-' + '\\'.repeat(500) + '😀'.repeat(200)] });
  const source = generated.bytes.toString(), footer = source.slice(source.indexOf('// #region WHAM recovery'));
  assert.equal(recovered.manifest.version, 3);
  assert.ok(footer.includes('\n//+ '));
  for (const line of footer.split('\n')) {
    assert.ok(line.length <= 120, `Footer line has ${line.length} characters`);
    assert.ok(!line.endsWith('\\'), 'C++ must not splice recovery comment lines');
    assert.ok(!line.includes('\uFFFD'), 'Wrapping must not split a Unicode surrogate pair');
  }
  assert.equal(recovered.files.get('src/mod.cpp')[0].bytes.toString(), directive);
  const rootSpans = generated.spans.filter(span => span.path.endsWith('mod.cpp'));
  assert.ok(rootSpans.every(span => span.outputEnd <= source.indexOf('// #region WHAM recovery')));
});

test('v3 rejects damaged framing, payload prefixes, continuations and mixed boundary versions', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n', 'src/a.h': 'int a;' });
  const source = generated.bytes.toString();
  for (const broken of [
    source.replace('// #region WHAM recovery\n', ''),
    source.replace('// WHAM@3 recovery-begin\n', ''),
    source.replace('// WHAM@3 recovery-end\n', ''),
    source.replace('// #endregion\n', ''),
    source.replace('// clang-format off\n', ''),
    source.replace('// clang-format on\n', ''),
    source.replace('// {\n', '//+ {\n'),
    source.replace('//   "type":', '    "type":'),
    source.replace('// WHAM@3 begin', '// WHAM@2 begin'),
    source + 'int unexpected;\n'
  ]) assert.throws(() => restoreSource(Buffer.from(broken)));
});
