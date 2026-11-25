const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateConfig } = require('../dist/config');
const { checksum, generateEntry } = require('../dist/engine');
const projects = require('../dist/projects');

const root = path.resolve('work', 'projects-fixture');
const entryPath = path.join(root, 'src', 'mod.cpp');
const generation = (dependencies = [], attempts = []) => ({
  dependencies: new Map(dependencies.map(file => [file, 'hash'])),
  attempts,
  spans: [],
  diagnostics: []
});

/** A recovery container for `files` (relative to root), generated from `entry`. */
async function container(files, entry = 'src/mod.cpp') {
  const buffers = new Map(Object.entries(files).map(([file, text]) => [path.join(root, file), Buffer.from(text)]));
  const access = {
    read: async file => buffers.get(file) ?? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    identity: async file =>
      file === path.join(root, 'src') || buffers.has(file)
        ? file
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    list: async () => [...buffers.keys()]
  };
  const result = await generateEntry({ root, config: validateConfig({}) }, path.join(root, entry), access);
  assert.ok(result.bytes, JSON.stringify(result.diagnostics));
  return result.bytes;
}

test('path keys and mod IDs', () => {
  assert.equal(projects.sameFile('C:\\A\\b.cpp', 'c:\\a\\B.CPP'), process.platform === 'win32');
  assert.equal(
    projects.installedModKey('C:\\Windhawk\\', 'local@x'),
    projects.installedModKey('c:\\windhawk', 'local@x')
  );
  assert.equal(projects.localModId('my-mod-2'), 'local@my-mod-2');
  for (const id of ['My-Mod', 'mod_1', '', undefined, 7]) assert.equal(projects.localModId(id), undefined);
  assert.equal(projects.sourceHash('\uFEFFa\r\nb\rc'), projects.sourceHash('a\nb\nc'));
});

test('setBusy keeps the sidebar runtime view in step', () => {
  const entry = {
    path: entryPath,
    output: '',
    status: 'current',
    stopping: true,
    runtime: { installed: true, enabled: true, changesPending: false, busy: false, stopping: true }
  };
  projects.setBusy(entry, 'compile');
  assert.deepEqual(
    [entry.busy, entry.stopping, entry.runtime.busy, entry.runtime.operation, entry.runtime.stopping],
    ['compile', false, true, 'compile', false]
  );
  projects.setBusy(entry, undefined);
  assert.deepEqual([entry.busy, entry.runtime.busy, entry.runtime.operation], [undefined, false, undefined]);
  const bare = { path: entryPath, output: '', status: 'stale' };
  projects.setBusy(bare, 'verify');
  assert.equal(bare.busy, 'verify');
});

test('dependsOn covers the entry, dependencies, failed include searches, and prefers the Draft', () => {
  const header = path.join(root, 'src', 'shared.h'),
    searched = path.join(root, 'include', 'missing.h');
  const entry = {
    path: entryPath,
    output: '',
    status: 'current',
    result: generation([path.join(root, 'src', 'old.h')])
  };
  assert.ok(projects.dependsOn(entry, entryPath));
  assert.ok(projects.dependsOn(entry, path.join(root, 'src', 'old.h')));
  entry.draft = generation([header], [searched]);
  assert.ok(!projects.dependsOn(entry, path.join(root, 'src', 'old.h')), 'The Draft replaces the saved generation');
  assert.ok(projects.dependsOn(entry, header));
  assert.ok(projects.dependsOn(entry, searched), 'Creating a searched-for header changes the entry');
  assert.equal(projects.dependsOn(entry, header.toUpperCase()), process.platform === 'win32');
  assert.ok(!projects.dependsOn(entry, path.join(root, 'src', 'unrelated.h')));
});

test('ownedOutput accepts only what WHAM wrote or an unedited container for the same entry', async () => {
  const sources = {
    'src/mod.cpp': '#include "shared.h"\nint mod;\n',
    'src/shared.h': 'int shared;\n',
    'src/other.cpp': 'int other;\n'
  };
  const bytes = await container(sources);
  const entry = { path: entryPath, output: '', status: 'stale' };
  assert.ok(projects.ownedOutput(bytes, entry, root), 'An unedited container recovers cleanly');
  const edited = Buffer.from(bytes.toString().replace('int shared;', 'int shared = 2;'));
  assert.ok(!projects.ownedOutput(edited, entry, root), 'Edits inside the output must be preserved');
  assert.ok(projects.ownedOutput(edited, entry, root, edited), 'Unless it is exactly what WHAM is about to write');
  assert.ok(projects.ownedOutput(edited, { ...entry, ownedHash: checksum(edited) }, root), 'Or what WHAM wrote last');
  assert.ok(
    !projects.ownedOutput(await container(sources, 'src/other.cpp'), entry, root),
    "Another entry's output is not ours"
  );
  assert.ok(!projects.ownedOutput(Buffer.from('int handwritten;\n'), entry, root));
});

test('compileStatus links an installed build to the Draft it was compiled from', () => {
  const draft = { ...generation(), bytes: Buffer.from('int mod;\n') };
  const build = { sourceHash: projects.sourceHash('int mod;\r\n'), libraryFileName: 'mod_1.dll' };
  const entry = installed => ({ path: entryPath, output: '', status: 'current', draft, installed });
  const installed = { config: { disabled: false, libraryFileName: 'mod_1.dll' } };
  assert.equal(projects.compileStatus(entry(undefined), build), 'unknown', 'Installed state not read yet');
  assert.equal(projects.compileStatus(entry({ config: null }), build), 'uncompiled', 'Not installed');
  assert.equal(projects.compileStatus(entry(installed), undefined), 'unknown', 'Built outside WHAM');
  assert.equal(
    projects.compileStatus(entry({ config: { disabled: false, libraryFileName: 'mod_2.dll' } }), build),
    'unknown',
    'Rebuilt since'
  );
  assert.equal(projects.compileStatus(entry(installed), build), 'current');
  assert.equal(
    projects.compileStatus({ ...entry(installed), draft: { ...draft, bytes: Buffer.from('int edited;\n') } }, build),
    'uncompiled'
  );
});

test('projectSummary reports the most urgent entry status', () => {
  const state = (...statuses) => ({ entries: new Map(statuses.map((status, index) => [String(index), { status }])) });
  assert.equal(projects.projectSummary(undefined), 'current');
  assert.equal(projects.projectSummary({ ...state('generating'), error: 'bad config' }), 'configuration error');
  assert.equal(projects.projectSummary(state('blocked', 'generating')), 'generating');
  assert.equal(projects.projectSummary(state('stale', 'blocked')), 'output edits');
  assert.equal(projects.projectSummary(state('current', 'pending')), 'stale');
  assert.equal(projects.projectSummary(state('current', 'current')), 'current');
});
