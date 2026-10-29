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
  assert.ok(source.startsWith('// WHAM@5 begin 1: src/a.h\n'));
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
test('divergent retained conditional copies still report a conflict', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#include "a.h"\n', 'src/a.h': '#pragma once\nint edit = 1;\n' });
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
  for (const content of [Buffer.from([0xff]), '// WHAM@1 {"type":"manifest"}\n', '// WHAM@5 begin 1: src/a.h\n']) {
    const input = fixture({ 'src/mod.cpp': content }); const generated = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access); assert.equal(generated.bytes, undefined);
  }
});
test('edited synthetic code, malformed nesting and unknown versions stop recovery', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n', 'src/a.h': '#pragma once\nint a;\n' });
  const source = generated.bytes.toString();
  for (const broken of [source.replace('#define WHAM_ONCE_', '#define BAD_'), source.replace('// WHAM@5 end 1', '// WHAM@5 end 999'), source.replace('// WHAM@5 ', '// WHAM@9 '), source.replace('"version": 5', '"version": 9')]) assert.throws(() => restoreSource(Buffer.from(broken)));
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


test('v5 wraps long recovery strings without changing escapes, Unicode or source bytes', async () => {
  const directive = '#include "a.h" // ' + '\\'.repeat(800) + '😀'.repeat(400) + ' */ end\r\n';
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': directive, 'src/a.h': '#pragma once\nint a;' },
    { externalIncludes: ['sdk-' + '\\'.repeat(500) + '😀'.repeat(200)] });
  const source = generated.bytes.toString(), footer = source.slice(source.indexOf('// #region WHAM recovery'));
  assert.equal(recovered.manifest.version, 5);
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

test('v5 rejects damaged framing, payload prefixes, continuations and mixed boundary versions', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n', 'src/a.h': 'int a;' });
  const source = generated.bytes.toString();
  for (const broken of [
    source.replace('// #region WHAM recovery\n', ''),
    source.replace('// WHAM@5 recovery-begin\n', ''),
    source.replace('// WHAM@5 recovery-end\n', ''),
    source.replace('// #endregion\n', ''),
    source.replace('// clang-format off\n', ''),
    source.replace('// clang-format on\n', ''),
    source.replace('// {\n', '//+ {\n'),
    source.replace('//   "type":', '    "type":'),
    source.replace('// WHAM@5 begin', '// WHAM@2 begin'),
    source + 'int unexpected;\n'
  ]) assert.throws(() => restoreSource(Buffer.from(broken)));
});


test('legacy v3 repeated headers recover exactly and upgrade to v5', async () => {
  const legacy = restoreSource(await fs.readFile(path.join(__dirname, 'fixtures/repeated-v3.wh.cpp')));
  assert.equal(legacy.manifest.version, 3);
  assert.equal(legacy.files.get('src/mod.cpp')[0].bytes.toString(), '#include "shared.h"\r\n#include "shared.h"\n');
  assert.equal(legacy.files.get('src/shared.h')[0].bytes.toString(), '#pragma once\r\nint shared = 1;');
  assert.deepEqual(legacy.conflicts, []);
  const { generated } = await roundTrip(Object.fromEntries([...legacy.files].map(([file, copies]) => [file, copies[0].bytes])));
  assert.ok(generated.bytes.toString().includes('// WHAM@5 reference 5: src/shared.h -> 1'));
});

test('once references recover every include, byte formatting, BOM and edited retained body', async () => {
  const root = '\uFEFF#include "shared.h"\r\n/* prefix */ # include "shared.h" // keep this\n#include "shared.h"';
  const header = '\uFEFF// original\n# pragma once\r\n#define ARM64 1\nint shared = 1;';
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': root, 'src/shared.h': header });
  const output = generated.bytes.toString();
  assert.equal((output.match(/int shared = 1;/g) || []).length, 1);
  assert.equal((output.match(/WHAM@5 reference \d+:/g) || []).length, 2);
  assert.equal(recovered.files.get('src/shared.h')[0].occurrences.length, 3);
  assert.ok(output.includes('#define ARM64 1'));
  const edited = restoreSource(Buffer.from(output.replace('int shared = 1;', 'int shared = 2;')));
  assert.deepEqual(edited.conflicts, []);
  assert.equal(edited.files.get('src/shared.h')[0].bytes.toString(), header.replace('shared = 1', 'shared = 2'));
  assert.equal(edited.files.get('src/shared.h')[0].changed, true);
  assert.equal(edited.files.get('src/shared.h')[0].occurrences.length, 3);
  assert.equal(edited.files.get('src/mod.cpp')[0].bytes.toString(), root);
});

test('conditional first copies stay expanded until an unconditional inclusion establishes proof', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#include "a.h"\n#if OTHER\n#include "a.h"\n#endif\n#include "a.h"\n', 'src/a.h': '#pragma once\nint shared;\n' });
  const source = generated.bytes.toString();
  assert.equal((source.match(/int shared;/g) || []).length, 2);
  assert.equal((source.match(/WHAM@5 reference \d+:/g) || []).length, 2);
  const conditionalOnly = await roundTrip({ 'src/mod.cpp': '#if FLAG\n#include "a.h"\n#else\n#include "a.h"\n#endif\n', 'src/a.h': '#pragma once\nint shared;\n' });
  assert.ok(!conditionalOnly.generated.bytes.toString().includes('WHAM@5 reference'));
});

test('conditional ancestry propagates through nested includes and ordinary guards', async () => {
  for (const [root, wrapper] of [
    ['#if FLAG\n#include "wrapper.h"\n#endif\n#include "a.h"\n', '#include "a.h"\n'],
    ['#include "wrapper.h"\n#include "a.h"\n', '#ifndef WRAPPER_H\n#define WRAPPER_H\n#include "a.h"\n#endif\n'],
    ['#if FLAG\n#include "wrapper.h"\n#endif\n#include "a.h"\n', '#pragma once\n#include "a.h"\n']
  ]) {
    const { generated } = await roundTrip({ 'src/mod.cpp': root, 'src/wrapper.h': wrapper, 'src/a.h': '#pragma once\nint shared;\n' });
    assert.equal((generated.bytes.toString().match(/int shared;/g) || []).length, 2);
    assert.ok(!generated.bytes.toString().includes('WHAM@5 reference'));
  }
});

test('unconditional nested includes establish proof and referenced parents preserve nested recovery', async () => {
  for (const wrapper of ['#include "a.h"\n', '#pragma once\n#include "a.h"\n']) {
    const { generated, recovered } = await roundTrip({ 'src/mod.cpp': '#include "wrapper.h"\n#include "wrapper.h"\n#include "a.h"\n', 'src/wrapper.h': wrapper, 'src/a.h': '#pragma once\nint shared;\n' });
    assert.equal((generated.bytes.toString().match(/int shared;/g) || []).length, 1);
    assert.equal(recovered.files.size, 3);
    assert.equal(recovered.files.get('src/wrapper.h')[0].occurrences.length, 2);
    const edited = restoreSource(Buffer.from(generated.bytes.toString().replace('int shared;', 'int edited;')));
    assert.equal(edited.files.get('src/a.h')[0].bytes.toString(), '#pragma once\nint edited;\n');
    assert.equal(edited.files.get('src/wrapper.h')[0].changed, false);
  }
});

test('ordinary guard undefines, architecture defines and repeatable headers are never deduplicated', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "guard.h"\n#undef GUARD_H\n#define ARM64 1\n#include "guard.h"\n#include "repeat.inc"\n#include "repeat.inc"\n', 'src/guard.h': '#ifndef GUARD_H\n#define GUARD_H\n#define VALUE ARM64\n#endif\n', 'src/repeat.inc': 'ITEM(ARM64)\n' });
  const body = generated.bytes.toString().split('// #region WHAM recovery')[0];
  assert.ok(!body.includes('WHAM@5 reference'));
  assert.equal((body.match(/#define GUARD_H/g) || []).length, 2);
  assert.equal((body.match(/#define VALUE ARM64/g) || []).length, 2);
  assert.equal((body.match(/ITEM\(ARM64\)/g) || []).length, 2);
});

test('identical bytes in different once headers keep distinct identities', async () => {
  const header = '#pragma once\nITEM(value)\n';
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "b.h"\n#include "a.h"\n#include "b.h"\n', 'src/a.h': header, 'src/b.h': header });
  const body = generated.bytes.toString().split('// #region WHAM recovery')[0];
  assert.equal((body.match(/ITEM\(value\)/g) || []).length, 2);
  assert.equal((body.match(/WHAM@5 reference \d+:/g) || []).length, 2);
  assert.equal(recovered.files.size, 3);
});

test('reference comments advance original parent source lines without creating code spans', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\nint after;\n', 'src/a.h': '#pragma once\nint shared;\n' });
  const output = generated.bytes.toString();
  const span = generated.spans.find(span => output.slice(span.outputStart, span.outputEnd).includes('int after;'));
  assert.ok(span.path.endsWith('mod.cpp'));
  assert.equal(span.sourceLine, 2);
  assert.equal(output.slice(span.outputStart, span.outputEnd), 'int after;\n');
});

test('deduplicated headers are still reread to catch concurrent source changes', async () => {
  const input = fixture({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': '#pragma once\nint original;\n' });
  const read = input.access.read; let reads = 0;
  input.access.read = async file => file.endsWith('a.h') && ++reads > 1 ? Buffer.from('#pragma once\nint changed;\n') : read(file);
  const generated = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), input.access);
  assert.equal(generated.bytes, undefined);
  assert.match(JSON.stringify(generated.diagnostics), /Source changed during generation/);
});

test('v5 rejects dangling, cross-file, forward, chained and mismatched references', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n#include "a.h"\n', 'src/a.h': '#pragma once\nint shared;\n' });
  const source = generated.bytes.toString();
  const reference = '// WHAM@5 reference 5: src/a.h -> 1\n';
  assert.ok(source.includes(reference));
  for (const broken of [
    source.replace(reference, ''),
    source.replace(reference, reference.replace('-> 1', '-> 3')),
    source.replace(reference, reference.replace('src/a.h', 'src/other.h')),
    source.replace(reference, reference.replace('reference 5', 'reference 1')),
    source.replaceAll('"bodyId": 1', '"bodyId": 99').replaceAll('-> 1', '-> 99'),
    source.replaceAll('"bodyId": 1', '"bodyId": 5').replaceAll('-> 1', '-> 5'),
    source.replace(reference, '').replace('// WHAM@5 begin 1:', reference + '// WHAM@5 begin 1:')
  ]) assert.throws(() => restoreSource(Buffer.from(broken)));
});

test('hand-constructed v4 references restore both original directives', () => {
  const root = '#include "a.h"\r\n# include "a.h"';
  const manifest = { type: 'manifest', version: 4, root: 'src/mod.cpp', config: { ...defaults }, tail: '',
    files: [{ path: 'src/mod.cpp', hash: checksum(root), bom: false }, { path: 'src/a.h', hash: checksum('int a;\n'), bom: false }],
    records: [{ type: 'include', id: 1, path: 'src/a.h', directive: '#include "a.h"\r\n' },
              { type: 'reference', id: 2, path: 'src/a.h', bodyId: 1, directive: '# include "a.h"' }] };
  const footer = '// #region WHAM recovery\n// clang-format off\n// WHAM@4 recovery-begin\n' + JSON.stringify(manifest, null, 2).split('\n').map(line => '// ' + line).join('\n') + '\n// WHAM@4 recovery-end\n// clang-format on\n// #endregion\n';
  const restored = restoreSource(Buffer.from('// WHAM@4 begin 1: src/a.h\nint a;\n// WHAM@4 end 1\n// WHAM@4 reference 2: src/a.h -> 1\n' + footer));
  assert.equal(restored.files.get('src/mod.cpp')[0].bytes.toString(), root);
  assert.deepEqual(restored.files.get('src/a.h')[0].occurrences, [1, 2]);
  assert.deepEqual(restored.conflicts, []);
});


test('frozen v4 output remains recoverable and regenerates as v5', async () => {
  const previous = restoreSource(await fs.readFile(path.join(__dirname, 'fixtures/repeated-v4.wh.cpp')));
  assert.equal(previous.manifest.version, 4);
  assert.deepEqual(previous.conflicts, []);
  const current = await roundTrip(Object.fromEntries([...previous.files].map(([file, copies]) => [file, copies[0].bytes])));
  assert.equal(current.recovered.manifest.version, 5);
});

test('macro-only conventional guards compact after a proven inclusion', async () => {
  const { generated, recovered } = await roundTrip({
    'src/mod.cpp': '#include "a.h"\r\n#include "a.h"\n#include "a.h"',
    'src/a.h': '\uFEFF/* header */\r\n#ifndef A_H\r\n#define A_H\r\n#define VALUE 42\n#endif /* A_H */'
  });
  const body = generated.bytes.toString().split('// #region WHAM recovery')[0];
  assert.equal((body.match(/#define VALUE 42/g) || []).length, 1);
  assert.equal((body.match(/WHAM@5 reference/g) || []).length, 2);
  assert.equal(recovered.files.get('src/a.h')[0].occurrences.length, 3);
});

test('partial compaction preserves repeatable directives, comments, BOM, and missing newline', async () => {
  const header = '\uFEFF/* prefix */ #ifndef A_H\r\n#define A_H\n#define VALUE 42\r\n#endif\r\n// repeat this\n#undef MODE\n#define MODE 2';
  const { generated, recovered } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\r\n#include "a.h"\n', 'src/a.h': header });
  const body = generated.bytes.toString().split('// #region WHAM recovery')[0];
  assert.equal((body.match(/#define VALUE 42/g) || []).length, 1);
  assert.equal((body.match(/#define MODE 2/g) || []).length, 2);
  assert.ok(body.includes('WHAM@5 fragment'));
  assert.equal(recovered.files.get('src/a.h')[0].bytes.toString(), header);
  const edited = restoreSource(Buffer.from(generated.bytes.toString().replace('#define VALUE 42', '#define VALUE 43')));
  assert.deepEqual(edited.conflicts, []);
  assert.ok(edited.files.get('src/a.h')[0].bytes.toString().includes('VALUE 43'));
});

test('partial compaction reconstructs nested includes and detects differing visible remainders', async () => {
  const { generated } = await roundTrip({
    'src/mod.cpp': '#include "a.h"\n#include "a.h"\n',
    'src/a.h': '#ifndef A_H\n#define A_H\n#include "values.h"\n#endif\n#undef MODE\n#define MODE 1\n',
    'src/values.h': '#define VALUE 1\n'
  });
  assert.ok(generated.bytes.toString().includes('WHAM@5 fragment'));
  const commonEdit = restoreSource(Buffer.from(generated.bytes.toString().replace('#define VALUE 1', '#define VALUE 2')));
  assert.deepEqual(commonEdit.conflicts, []);
  assert.ok(commonEdit.files.get('src/values.h')[0].changed);
  assert.ok(!commonEdit.files.get('src/a.h')[0].changed);
  const differing = restoreSource(Buffer.from(generated.bytes.toString().replace('#define MODE 1', '#define MODE 2')));
  assert.deepEqual(differing.conflicts, ['src/a.h']);
});

test('conditional proofs merge only facts true on every reachable path', async () => {
  const header = '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n';
  for (const middle of [
    '#if FLAG\n#define A_H\n#else\n#define A_H\n#endif\n',
    '#undef FLAG\n#ifdef FLAG\n#undef A_H\n#else\n#define A_H\n#endif\n',
    '#if defined(A_H)\n#define A_H\n#else\n#define A_H\n#endif\n'
  ]) {
    const { generated } = await roundTrip({ 'src/mod.cpp': '#if 0\n#include "a.h"\n#endif\n' + middle + '#include "a.h"\n', 'src/a.h': header });
    assert.ok(generated.bytes.toString().includes('WHAM@5 reference'), middle);
  }
  for (const middle of [
    '#if FLAG\n#define A_H\n#endif\n',
    '#if FLAG\n#define A_H\n#else\n#undef A_H\n#endif\n',
    '#if FLAG\n#define A_H\n#elif OTHER\n#define A_H\n#endif\n'
  ]) {
    const { generated } = await roundTrip({ 'src/mod.cpp': '#if 0\n#include "a.h"\n#endif\n' + middle + '#include "a.h"\n', 'src/a.h': header });
    assert.ok(!generated.bytes.toString().includes('WHAM@5 reference'), middle);
  }
});

test('unknown code, macro expressions, pragmas, and external includes discard guard proofs', async () => {
  const header = '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n';
  for (const barrier of [
    '#undef A_H\n', 'MACRO_THAT_MIGHT_RESTORE_GUARDS\n', '_Pragma("pop_macro(\\"A_H\\")")\n',
    '#pragma pop_macro("A_H")\n', '#include <external.h>\n', '#include SDK_HEADER\n',
    '#if UNKNOWN_EXPRESSION\n#endif\n', '#line LINE_NUMBER\n'
  ]) {
    const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n' + barrier + '#include "a.h"\n', 'src/a.h': header }, { externalIncludes: ['SDK_HEADER'] });
    assert.ok(!generated.bytes.toString().includes('WHAM@5 reference'), barrier);
  }
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': '#ifndef A_H\n#define A_H\nstruct Shared {};\n#endif\n' });
  assert.ok(!generated.bytes.toString().includes('WHAM@5 reference'));
});

test('partial compaction rechecks the proof after the header prefix executes', async () => {
  const { generated } = await roundTrip({
    'src/mod.cpp': '#include "a.h"\n#include "a.h"\n',
    'src/a.h': '#undef A_H\n#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n'
  });
  assert.ok(!generated.bytes.toString().includes('WHAM@5 fragment'));
  assert.equal((generated.bytes.toString().split('// #region WHAM recovery')[0].match(/#define VALUE 42/g) || []).length, 2);
});

test('unrecognized guards and architecture values remain unchanged', async () => {
  for (const header of [
    '#ifndef A_H\n#define A_H\n#else\n#define OTHER 2\n#endif\n',
    '#ifndef A_H\n#define A_H\n#endif\n#ifndef B_H\n#define B_H\n#endif\n',
    '#ifndef A_H\nint active;\n#define A_H\n#endif\n',
    '#if !defined(A_H)\n#define A_H\n#endif\n'
  ]) {
    const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': header });
    assert.ok(!/WHAM@5 (?:fragment|reference)/.test(generated.bytes.toString()));
  }
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n',
    'src/a.h': '#ifndef A_H\n#define A_H\n#if defined(__x86_64__)\n#define ARCH 64\n#else\n#define ARCH 32\n#endif\n#endif\n' });
  assert.ok(generated.bytes.toString().includes('#if defined(__x86_64__)'));
  assert.ok(generated.bytes.toString().includes('WHAM@5 reference'));
});

test('fragment markers preserve source-line spans for the visible remainder', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n',
    'src/a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n#undef MODE\n#define MODE 1\n' });
  const fragments = generated.spans.filter(span => span.path.endsWith('a.h') && generated.bytes.toString().slice(span.outputStart, span.outputEnd).includes('#undef MODE'));
  assert.equal(fragments.length, 2);
  for (const span of fragments) {
    const prefix = generated.bytes.toString().slice(span.outputStart, span.outputEnd).split('#undef MODE')[0];
    assert.equal(span.sourceLine + prefix.split('\n').length - 1, 4);
  }
});

test('fragment recovery rejects forged targets and changed or ambiguous guard boundaries', async () => {
  const { generated } = await roundTrip({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n',
    'src/a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n#undef MODE\n#define MODE 1\n' });
  const source = generated.bytes.toString();
  assert.ok(source.includes('// WHAM@5 fragment 3: src/a.h [A_H] -> 1\n'));
  for (const damaged of [
    source.replace('[A_H]', '[OTHER]'),
    source.replace('// WHAM@5 fragment 3: src/a.h [A_H] -> 1\n', '').replace('// WHAM@5 begin 2: src/a.h', '// WHAM@5 fragment 3: src/a.h [A_H] -> 1\n// WHAM@5 begin 2: src/a.h'), source.replace('"bodyId": 1', '"bodyId": 2'),
    source.replace('"lines": 4', '"lines": -1'), source.replace('"guard": "A_H"', '"guard": "OTHER"'),
    source.replace('#ifndef A_H', '#ifndef RENAMED'),
    source.replace('#define A_H', '#define RENAMED'),
    source.replace('#define VALUE 42', '#define VALUE 42\n#else\n#define OTHER 1'),
    source.replace('#define VALUE 42', '#define VALUE 42\n#endif\n#ifndef B_H\n#define B_H')
  ]) assert.throws(() => restoreSource(Buffer.from(damaged)));
});

test('guard compaction still detects concurrent source changes and keeps dependencies', async () => {
  const input = fixture({ 'src/mod.cpp': '#include "a.h"\n#include "a.h"\n', 'src/a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' });
  let reads = 0;
  const access = { ...input.access, read: async file => {
    const bytes = await input.access.read(file);
    return file.endsWith('a.h') && ++reads > 1 ? Buffer.from(bytes.toString().replace('42','43')) : bytes;
  }};
  const generated = await generateEntry(input.project, path.join(input.project.root, 'src/mod.cpp'), access);
  assert.ok(!generated.bytes);
  assert.ok(generated.diagnostics.some(item => item.message.includes('changed during generation')));
});


test('conditional pragma-once execution cannot manufacture an ordinary guard proof', async () => {
  for (const suffix of ['', '#undef MODE\n#define MODE 1\n']) {
    const { generated } = await roundTrip({
      'src/mod.cpp': '#if FLAG\n#include "once.h"\n#endif\n#undef A_H\n#if 0\n#include "a.h"\n#endif\n#include "once.h"\n#include "a.h"\n',
      'src/once.h': '#pragma once\n#define A_H\n',
      'src/a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' + suffix
    });
    const source = generated.bytes.toString().split('// #region WHAM recovery')[0];
    assert.ok(!/WHAM@5 (?:reference|fragment) \d+: src\/a.h/.test(source));
  }
});
