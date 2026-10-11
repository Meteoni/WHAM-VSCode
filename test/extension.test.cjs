const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const Module = require('node:module');
const { defaults } = require('../dist/config');
const { restoreSource } = require('../dist/engine');

test('adapter sidebar, serialized saves, dependencies, output protection and config controls', async () => {
  const root = path.resolve('work', 'adapter-' + Date.now());
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, debounceMs: 10 }));
  await fs.writeFile(path.join(root, 'src/one.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/two.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint shared = 1;\n');
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode/settings.json'), '{"[cpp]":{"editor.tabSize":2,"editor.insertSpaces":false}}');
  await fs.writeFile(path.join(root, '.vscode/c_cpp_properties.json'), JSON.stringify({ configurations: [{ name: 'Windhawk (WHAM)', compilerPath: path.join(root, 'installation/Compiler/bin/clang++.exe') }] }));
  let receive, provider, onSave, onChange;
  const commands = new Map(), watchers = [], messages = [], documents = [], stored = {}, globalStored = {};
  const disposable = () => ({ dispose() {} });
  const Uri = {
    file(file) { return { fsPath: file, scheme: 'file', toString: () => 'file:' + file }; },
    from(value) { return { ...value, toString: () => value.scheme + ':' + value.path }; },
    joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  };
  const mock = {
    Uri, StatusBarAlignment: { Left: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1 }, extensions: { getExtension: () => undefined },
    Range: class {}, Diagnostic: class {}, RelativePattern: class { constructor(root, pattern) { this.root = root; this.pattern = pattern; } },
    languages: { createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(root) }], textDocuments: documents,
      getConfiguration: () => ({ get: () => undefined }),
      registerTextDocumentContentProvider: disposable,
      createFileSystemWatcher() {
        const watcher = { ...disposable(), onDidChange(fn) { this.change = fn; return disposable(); }, onDidCreate(fn) { this.create = fn; return disposable(); }, onDidDelete(fn) { this.delete = fn; return disposable(); } };
        watchers.push(watcher); return watcher;
      },
      onDidSaveTextDocument(fn) { onSave = fn; return disposable(); },
      onDidChangeTextDocument(fn) { onChange = fn; return disposable(); },
      onDidChangeWorkspaceFolders: disposable
    },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, append() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      registerWebviewViewProvider(id, value) { provider = value; return disposable(); },
      showWarningMessage: async () => undefined,
      showErrorMessage: async message => { throw new Error(message); },
      showInformationMessage: async () => undefined
    },
    commands: { registerCommand(id, fn) { commands.set(id, fn); return disposable(); }, executeCommand: async () => undefined }
  };
  const context = { extensionUri: Uri.file(path.resolve('.')), subscriptions: [], workspaceState: { get: (key, fallback) => stored[key] ?? fallback, update: async (key, value) => { stored[key] = value; } } };
  context.globalState = { get: (key, fallback) => globalStored[key] ?? fallback, update: async (key, value) => { globalStored[key] = value; } };
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? mock : load.call(this, name, ...args); };
  let extension;
  try { delete require.cache[require.resolve('../dist/extension')]; extension = require('../dist/extension'); }
  finally { Module._load = load; }
  try {
    await extension.activate(context);
    provider.resolveWebviewView({ webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri.toString(), postMessage: async message => { messages.push(message); }, onDidReceiveMessage(fn) { receive = fn; return disposable(); } } });
    const settle = async (predicate) => {
      for (let count = 0; count < 500; count++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.fail('Adapter did not reach expected state: ' + JSON.stringify(project()));
    };
    const project = () => messages.filter(message => message.type === 'state').at(-1)?.projects[0];
    await settle(() => project()?.entries.every(entry => entry.status === 'current'));
    assert.equal(commands.size, 9); assert.equal(project().entries.length, 2);
    assert.equal(project().editor.installationPath, path.join(root, 'installation')); assert.equal(project().editor.indentSize, 2); assert.equal(project().editor.indentStyle, 'tabs');
    assert.match(project().entries[0].metadata.diagnostics[0].message, /No Windhawk/);
    const one = path.join(root, 'src/one.cpp'), oneOutput = path.join(root, 'output/one.wh.cpp'), twoOutput = path.join(root, 'output/two.wh.cpp');
    const shared = path.join(root, 'src/shared.h');
    await fs.writeFile(shared, '#pragma once\nint shared = 2;\n');
    onSave({ uri: Uri.file(shared) }); watchers[0].change(Uri.file(shared));
    await settle(async () => (await fs.readFile(oneOutput, 'utf8')).includes('shared = 2') && (await fs.readFile(twoOutput, 'utf8')).includes('shared = 2'));
    // A generated-output watcher event does not enqueue generation.
    const owned = await fs.readFile(oneOutput); watchers[0].change(Uri.file(oneOutput));
    await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(await fs.readFile(oneOutput), owned);
    await fs.writeFile(oneOutput, owned.toString().replace('shared = 2', 'shared = 99'));
    watchers[0].change(Uri.file(oneOutput));
    await fs.writeFile(shared, '#pragma once\nint shared = 3;\n'); onSave({ uri: Uri.file(shared) });
    await settle(async () => project()?.entries.find(entry => entry.path === one)?.status === 'blocked' && (await fs.readFile(twoOutput, 'utf8')).includes('shared = 3'));
    assert.ok((await fs.readFile(oneOutput, 'utf8')).includes('shared = 99'));
    assert.ok(restoreSource(await fs.readFile(oneOutput)).files.get('src/shared.h')[0].changed);
    // Dirty output buffers are protected even when disk output is unchanged.
    const dirty = { uri: Uri.file(twoOutput), isDirty: true }; documents.push(dirty); onChange({ document: dirty });
    await fs.writeFile(shared, '#pragma once\nint shared = 4;\n'); onSave({ uri: Uri.file(shared) });
    await settle(() => project()?.entries.find(entry => entry.path !== one)?.status === 'blocked');
    await new Promise(resolve => setTimeout(resolve, 30)); assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 3'));
    documents.length = 0;
    // Config is persisted from sidebar; manual mode suppresses source-save writes.
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10, generate: 'manual' } });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'windhawk-amalgamation.json'))).generate, 'manual');
    await fs.writeFile(shared, '#pragma once\nint shared = 5;\n'); onSave({ uri: Uri.file(shared) });
    await new Promise(resolve => setTimeout(resolve, 40)); assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 3'));
    const two = path.join(root, 'src/two.cpp'); await fs.appendFile(two, '// saved in manual mode\n'); onSave({ uri: Uri.file(two) });
    await settle(() => project()?.entries.find(entry => entry.path === two)?.status === 'stale');
    const metadataSource = '// ==WindhawkMod==\n// @id two\n// @name Second Mod\n// @version 1.0\n// ==/WindhawkMod==\n#include "shared.h"\n';
    await fs.writeFile(two, metadataSource); onSave({ uri: Uri.file(two) });
    await settle(() => project()?.entries.find(entry => entry.path === two)?.metadata.fields.name?.[0] === 'Second Mod');
    const dirtySource = { uri: Uri.file(two), isDirty: true, getText: () => metadataSource.replace('Second Mod', 'Unsaved Name') };
    documents.push(dirtySource); onChange({ document: dirtySource });
    assert.equal(project().entries.find(entry => entry.path === two).metadata.fields.name[0], 'Unsaved Name');
    documents.length = 0;
    await receive({ action: 'generate', root, entry: path.join(root, 'src/two.cpp') });
    assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 5'));
    // A failed resolution is retried when the missing header appears.
    await fs.writeFile(path.join(root, 'src/new.cpp'), '#include "missing.h"\n'); watchers[0].create(Uri.file(path.join(root, 'src/new.cpp')));
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10 } });
    assert.equal(project().entries.find(entry => entry.path.endsWith('new.cpp')).status, 'stale');
    await fs.writeFile(path.join(root, 'src/missing.h'), 'int found;\n'); watchers[0].create(Uri.file(path.join(root, 'src/missing.h')));
    await settle(async () => { try { return (await fs.readFile(path.join(root, 'output/new.wh.cpp'), 'utf8')).includes('int found'); } catch { return false; } });
    // Deleting entries removes only unchanged outputs with established ownership.
    await fs.rm(path.join(root, 'src/new.cpp')); watchers[0].delete(Uri.file(path.join(root, 'src/new.cpp')));
    await settle(async () => { try { await fs.stat(path.join(root, 'output/new.wh.cpp')); return false; } catch { return true; } });
    await fs.rm(one); watchers[0].delete(Uri.file(one));
    await settle(() => project()?.entries.length === 1);
    assert.ok((await fs.readFile(oneOutput, 'utf8')).includes('shared = 99'));
    // Setup completes editor configuration before switching folders; preferences survive the switch.
    const newRoot = path.join(root, 'new-project'); await fs.mkdir(newRoot);
    mock.window.showOpenDialog = async () => [Uri.file(newRoot)];
    mock.window.showQuickPick = async choices => choices.includes('Use this empty folder') ? 'Use this empty folder' : choices.includes('Configure indentation only') ? 'Configure indentation only' : '2 spaces';
    const opened = [];
    mock.commands.executeCommand = async (...args) => {
      if (args[0] === 'vscode.openFolder') {
        assert.equal(globalStored.editorSettings[newRoot].indentSize, 2);
        assert.ok((await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8')).includes('editor.tabSize'));
        opened.push(args);
      }
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: true });
    assert.equal(opened.length, 1); assert.equal(opened[0][1].fsPath, newRoot); assert.equal(opened[0][2], false);
    await receive({ action: 'initialize', mode: 'Use an existing project', openProject: false });
    assert.equal(opened.length, 1);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
