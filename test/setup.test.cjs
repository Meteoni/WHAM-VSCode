const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse } = require('jsonc-parser');
const { defaults } = require('../dist/config');
const { generateEntry, restoreSource } = require('../dist/engine');
const { setupProject, gitStatus, editorConfiguration, readEditorSettings, mergeRecoveries } = require('../dist/setup');
const { nodeFiles, commitRestore } = require('../dist/io');

test('new Git setup and ignore rules are idempotent and preserve an enclosing repository', async () => {
  const root = path.resolve('work', 'git-setup-' + Date.now()); await fs.mkdir(root, { recursive: true });
  const git = process.env.WHAM_TEST_GIT || 'git';
  try {
    await fs.writeFile(path.join(root, '.gitignore'), '# keep this\nprivate/\n');
    await setupProject(root, { git }); await setupProject(root, { git });
    assert.ok((await fs.stat(path.join(root, '.git'))).isDirectory());
    const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8'); assert.ok(ignore.startsWith('# keep this\nprivate/\n'));
    assert.equal(ignore.split('/output/').length - 1, 1);
    const status = await gitStatus(root, git); assert.ok(status.branch); assert.ok(status.changes > 0);
    const child = path.join(root, 'nested'); await fs.mkdir(child); await setupProject(child, { git });
    await assert.rejects(fs.stat(path.join(child, '.git')), /ENOENT/);
    assert.equal((await gitStatus(child, git)).root.toLowerCase(), root.split(path.sep).join('/').toLowerCase());
    execFileSync(git, ['-C', root, 'check-ignore', 'output/anything.wh.cpp']);
    for (const file of ['.vscode/settings.json', '.vscode/c_cpp_properties.json', '.clangd']) execFileSync(git, ['-C', root, 'check-ignore', file]);
    for (const file of ['windhawk-amalgamation.json', '.clang-format', '.vscode/extensions.json']) assert.throws(() => execFileSync(git, ['-C', root, 'check-ignore', file], { stdio: 'pipe' }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('editor configuration resolves Windhawk APIs and preserves existing JSONC and formatting options', async () => {
  const root = path.resolve('work', 'editor-setup-' + Date.now());
  const installation = path.join(root, 'windhawk'); await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await fs.mkdir(path.join(installation, 'Compiler/bin'), { recursive: true }); await fs.mkdir(path.join(installation, 'Compiler/include'), { recursive: true });
  for (const file of ['Compiler/bin/clang++.exe', 'Compiler/bin/clangd.exe', 'Compiler/include/windhawk_api.h']) await fs.writeFile(path.join(installation, file), 'fixture');
  try {
    await fs.writeFile(path.join(root, '.vscode/settings.json'), '// keep comment\n{ "files.autoSave": "off", "[cpp]": {"editor.wordWrap": "on"}, }\n');
    await fs.writeFile(path.join(root, '.vscode/c_cpp_properties.json'), '{"configurations":[{"name":"Other","defines":["USER"]}],"version":4}');
    await fs.writeFile(path.join(root, '.clang-format'), 'BasedOnStyle: Microsoft\nColumnLimit: 120\nIndentWidth: 4\n');
    await fs.writeFile(path.join(root, '.clangd'), 'Diagnostics:\n  UnusedIncludes: None\n');
    const project = { root, config: { ...defaults } }, editor = { installationPath: installation, integration: 'both', indentStyle: 'tabs', indentSize: 3 };
    const files = await editorConfiguration(project, editor);
    const settings = files.get('.vscode/settings.json').toString(); assert.ok(settings.includes('// keep comment'));
    const parsed = parse(settings); assert.equal(parsed['files.autoSave'], 'off'); assert.equal(parsed['[cpp]']['editor.wordWrap'], 'on'); assert.equal(parsed['[cpp]']['editor.tabSize'], 3); assert.equal(parsed['[cpp]']['editor.insertSpaces'], false);
    const properties = parse(files.get('.vscode/c_cpp_properties.json').toString()); assert.equal(properties.configurations[0].name, 'Other');
    const config = properties.configurations.find(item => item.name === 'Windhawk (WHAM)'); assert.ok(config.defines.includes('WH_MOD')); assert.ok(config.defines.includes('WH_EDITING')); assert.ok(config.forcedInclude[0].endsWith('windhawk_api.h')); assert.deepEqual(config.compilerArgs, ['-target', 'x86_64-w64-mingw32']);
    const format = files.get('.clang-format').toString(); assert.ok(format.includes('ColumnLimit: 120')); assert.ok(format.includes('UseTab: Always')); assert.ok(format.includes('IndentWidth: 3'));
    const clangd = files.get('.clangd').toString(); assert.ok(clangd.startsWith('Diagnostics:\n  UnusedIncludes: None')); assert.ok(clangd.includes('-DWH_MOD'));
    for (const [file, bytes] of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), bytes); }
    const repeated = await editorConfiguration(project, editor); for (const [file, bytes] of repeated) assert.deepEqual(bytes, files.get(file), file);
    const applied = await readEditorSettings(root);
    assert.equal(applied.installationPath, installation); assert.equal(applied.indentSize, 3); assert.equal(applied.indentStyle, 'tabs'); assert.equal(applied.integration, 'both');
    await fs.rm(path.join(root, '.vscode/settings.json')); await fs.rm(path.join(root, '.vscode/c_cpp_properties.json'));
    const formattingOnly = await readEditorSettings(root, editor); assert.equal(formattingOnly.indentSize, 3); assert.equal(formattingOnly.indentStyle, 'tabs'); assert.equal(formattingOnly.installationPath, installation);
    await fs.writeFile(path.join(root, '.vscode/settings.json'), '{broken'); await fs.writeFile(path.join(root, '.clang-format'), 'IndentWidth: [broken');
    assert.deepEqual(await readEditorSettings(root, editor), editor);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('recover multiple mods, deduplicate shared files, retain entries and detect divergent copies', async () => {
  const root = path.resolve('work', 'multi-restore-' + Date.now()); await fs.mkdir(path.join(root, 'src'), { recursive: true });
  try {
    await fs.writeFile(path.join(root, 'src/a.cpp'), '#include "shared.h"\nint a;\n');
    await fs.writeFile(path.join(root, 'src/b.cpp'), '#include "shared.h"\nint b;\n');
    await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint shared = 1;\n');
    const project = { root, config: { ...defaults } };
    const a = await generateEntry(project, path.join(root, 'src/a.cpp'), nodeFiles), b = await generateEntry(project, path.join(root, 'src/b.cpp'), nodeFiles);
    const combined = mergeRecoveries([restoreSource(a.bytes), restoreSource(b.bytes)]); assert.equal(combined.files.size, 3); assert.equal(combined.conflicts.length, 0); assert.deepEqual(combined.manifest.config.entries, ['a.cpp', 'b.cpp']);
    await commitRestore(combined, path.join(root, 'recovered'));
    const edited = restoreSource(Buffer.from(b.bytes.toString().replace('shared = 1', 'shared = 2')));
    const conflict = mergeRecoveries([restoreSource(a.bytes), edited]); assert.deepEqual(conflict.conflicts, ['src/shared.h']);
    await assert.rejects(commitRestore(conflict, path.join(root, 'blocked')), /Unresolved/); await assert.rejects(fs.stat(path.join(root, 'blocked')), /ENOENT/);
    assert.ok(!JSON.stringify(combined.manifest.config).includes(root));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
