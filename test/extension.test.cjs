const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { defaults } = require('../dist/config');
const { restoreSource } = require('../dist/engine');

test('adapter sidebar, serialized saves, dependencies, output protection and config controls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wham-adapter-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, debounceMs: 10 }));
  await fs.writeFile(path.join(root, 'src/one.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/two.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint shared = 1;\n');
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode/settings.json'), '{"[cpp]":{"editor.tabSize":2,"editor.insertSpaces":false}}');
  await fs.writeFile(path.join(root, '.vscode/c_cpp_properties.json'), JSON.stringify({ configurations: [{ name: 'Windhawk (WHAM)', compilerPath: path.join(root, 'installation/Compiler/bin/clang++.exe') }] }));
  await fs.mkdir(path.join(root, 'installation')); await fs.writeFile(path.join(root, 'installation/windhawk.ini'), '[Storage]\nPortable=1\n');
  await fs.mkdir(path.join(root,'installation/Compiler/bin'),{recursive:true});await fs.mkdir(path.join(root,'installation/Compiler/include'),{recursive:true});
  for(const file of ['bin/clang++.exe','bin/clangd.exe','include/windhawk_api.h'])await fs.writeFile(path.join(root,'installation/Compiler',file),'fixture');
  let receive, provider, onSave, onChange;
  let noInstallations=false, singleVerifies=0;
  const commands = new Map(), watchers = [], messages = [], documents = [], stored = {}, globalStored = {}, generations = new Map();
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
  Module._load = function(name, ...args) {
    if(name==='vscode')return mock;
    if(name==='./compiler' && args[0]?.filename.endsWith('dist'+path.sep+'extension.js'))return {checkModBuild:async(root,source,signal,onOutput,version,syntaxOnly)=>{assert.equal(syntaxOnly,true);singleVerifies++;}};
    if(name==='./setup' && args[0]?.filename.endsWith('dist'+path.sep+'extension.js')){const setup=load.call(this,name,...args);return {...setup,findWindhawk:async()=>noInstallations?[]:setup.findWindhawk()};}
    if(name==='./engine' && args[0]?.filename.endsWith('dist'+path.sep+'extension.js')) {
      const engine=load.call(this,name,...args);
      return {...engine,generateEntry:(project,entry,...rest)=>{generations.set(entry,(generations.get(entry)||0)+1);return engine.generateEntry(project,entry,...rest);}};
    }
    return load.call(this,name,...args);
  };
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
    assert.equal(commands.size, 10); assert.equal(project().entries.length, 2);
    assert.equal(project().editor.installationPath, path.join(root, 'installation')); assert.equal(project().editor.indentSize, 2); assert.equal(project().editor.indentStyle, 'tabs');
    // Local preference saves never write generation, formatting, or editor files.
    const filesBeforePreferences = await Promise.all(['windhawk-amalgamation.json', '.vscode/settings.json', '.vscode/c_cpp_properties.json'].map(file => fs.readFile(path.join(root, file))));
    await receive({ action: 'computerPreferences', settings: { installationPath: path.join(root, 'installation'), elevation: 'none', gsudoPath: '', integration: 'clangd' } });
    await receive({ action: 'projectPreferences', root, settings: { integration: 'default' } });
    assert.equal(project().editor.installationPath, path.join(root, 'installation')); assert.equal(project().editor.integration, 'clangd');
    assert.deepEqual(globalStored.localPreferences.projects[root], {});
    const filesAfterPreferences = await Promise.all(['windhawk-amalgamation.json', '.vscode/settings.json', '.vscode/c_cpp_properties.json'].map(file => fs.readFile(path.join(root, file))));
    assert.deepEqual(filesAfterPreferences, filesBeforePreferences);
    // External editor-file changes must not override an explicitly saved default.
    watchers[0].change(Uri.file(path.join(root, '.vscode/c_cpp_properties.json')));
    await settle(() => project().editor.integration === 'clangd');
    await receive({ action: 'projectPreferences', root, settings: { integration: 'cpp' } });
    assert.match(project().entries[0].metadata.diagnostics[0].message, /No Windhawk/);
    const one = path.join(root, 'src/one.cpp'), oneOutput = path.join(root, 'output/one.wh.cpp'), twoOutput = path.join(root, 'output/two.wh.cpp');
    const shared = path.join(root, 'src/shared.h');
    const third=path.join(root,'src/third.cpp'),thirdOutput=path.join(root,'output/third.wh.cpp'),privateHeader=path.join(root,'src/private.h'),nestedHeader=path.join(root,'src/nested.h');
    await fs.writeFile(third,'#include "private.h"\n');
    await fs.writeFile(privateHeader,'#include "nested.h"\n');await fs.writeFile(nestedHeader,'int private_value = 1;\n');
    watchers[0].create(Uri.file(third));
    await settle(()=>project()?.entries.length===3 && project().entries.every(entry=>entry.status==='current'));
    await new Promise(resolve=>setTimeout(resolve,450)); generations.clear();
    await fs.appendFile(one,'// only this entry changed\n');onSave({uri:Uri.file(one)});watchers[0].change(Uri.file(one));
    await settle(async()=> (await fs.readFile(oneOutput,'utf8')).includes('only this entry changed'));
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.ok(generations.get(one));assert.equal(generations.get(path.join(root,'src/two.cpp')),undefined);assert.equal(generations.get(third),undefined,'Independent mods are not expanded after a .cpp save');
    generations.clear();
    const outputTime=(await fs.stat(oneOutput)).mtimeMs;
    const future=new Date(Date.now()+2000);await fs.utimes(shared,future,future);onSave({uri:Uri.file(shared)});
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.equal(generations.size,0,'Timestamp-only changes reuse expansions');assert.equal((await fs.stat(oneOutput)).mtimeMs,outputTime);
    // Transitive dependencies affect just the owning mod, even when timestamps are preserved.
    const previousStat=await fs.stat(nestedHeader);await fs.writeFile(nestedHeader,'int private_value = 2;\n');await fs.utimes(nestedHeader,previousStat.atime,previousStat.mtime);watchers[0].change(Uri.file(nestedHeader));
    await settle(async()=> (await fs.readFile(thirdOutput,'utf8')).includes('private_value = 2'));
    await new Promise(resolve=>setTimeout(resolve,450));
    assert.ok(generations.get(third));assert.equal(generations.get(one),undefined);assert.equal(generations.get(path.join(root,'src/two.cpp')),undefined);
    generations.clear();await fs.writeFile(shared,'#pragma once\nint shared = 9;\n');onSave({uri:Uri.file(shared)});
    await settle(async()=> (await fs.readFile(oneOutput,'utf8')).includes('shared = 9') && (await fs.readFile(twoOutput,'utf8')).includes('shared = 9'));
    await new Promise(resolve=>setTimeout(resolve,450));assert.equal(generations.get(third),undefined,'Shared headers do not affect independent mods');
    await fs.rm(third);watchers[0].delete(Uri.file(third));await settle(()=>project()?.entries.length===2);

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
    await new Promise(resolve => setTimeout(resolve, 450)); assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 3'));
    documents.length = 0;
    // Config is persisted from sidebar; manual mode suppresses source-save writes.
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10, generate: 'manual' } });
    assert.equal(JSON.parse(await fs.readFile(path.join(root, 'windhawk-amalgamation.json'))).generate, 'manual');
    const manualOutput = await fs.readFile(twoOutput);
    await fs.writeFile(shared, '#pragma once\nint shared = 5;\n'); onSave({ uri: Uri.file(shared) });
    await new Promise(resolve => setTimeout(resolve, 450)); assert.deepEqual(await fs.readFile(twoOutput), manualOutput, 'Manual source saves do not write output');
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
    // Command actions go directly to the only mod.
    mock.window.showQuickPick=async()=>{throw new Error('A single mod does not need a picker');};
    let directDiffs=0;mock.commands.executeCommand=async(command)=>{if(command==='vscode.diff')directDiffs++;};
    await commands.get('windhawk.compare')();assert.equal(directDiffs,1);
    await commands.get('windhawk.verify')();assert.equal(singleVerifies,1);
    // Cancelling a button choice leaves the selected folder untouched.
    const canceledRoot=path.join(root,'canceled-setup');await fs.mkdir(canceledRoot);
    mock.window.showOpenDialog=async()=>[Uri.file(canceledRoot)];
    mock.window.showQuickPick=async()=>{throw new Error('Fixed setup choices must not have a search input');};
    let canceledDialog;
    mock.window.showInformationMessage=async(message,options,...choices)=>{if(options?.modal)canceledDialog={message,choices};return undefined;};
    await receive({action:'initialize',mode:'Create a new project',openProject:false});
    assert.equal(canceledDialog.message,'New project location');assert.deepEqual(canceledDialog.choices,['Create folder','Use empty folder']);assert.deepEqual(await fs.readdir(canceledRoot),[]);
    // Setup completes editor configuration before switching folders; preferences survive the switch.
    const newRoot = path.join(root, 'new-project'); await fs.mkdir(newRoot);
    mock.window.showOpenDialog = async () => [Uri.file(newRoot)];
    mock.window.showQuickPick = async () => { throw new Error('Fixed setup choices must use buttons'); };
    mock.window.showInformationMessage = async (message,options,...choices) => {
      if(!options?.modal)return;
      assert.equal(options.modal,true);
      const titles=choices.map(choice=>typeof choice==='string'?choice:choice.title);
      const title=titles.includes('Use empty folder')?'Use empty folder':titles.includes('Indentation only')?'Indentation only':'2 spaces';
      return choices[titles.indexOf(title)];
    };
    const opened = [];
    mock.commands.executeCommand = async (...args) => {
      if (args[0] === 'vscode.openFolder') {
        assert.equal(JSON.parse(await fs.readFile(path.join(newRoot,'.vscode/settings.json'),'utf8'))['[cpp]']['editor.tabSize'],messages.filter(message=>message.type==='state').at(-1).projects.find(project=>project.root===newRoot).editor.indentSize);
        assert.ok((await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8')).includes('editor.tabSize'));
        opened.push(args);
      }
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: true });
    assert.equal(opened.length, 1,JSON.stringify(messages.filter(message=>message.type==='error').slice(-2))); assert.equal(opened[0][1].fsPath, newRoot); assert.equal(opened[0][2], false);
    assert.equal(globalStored.recentProjects[0], newRoot);
    const loadedProjects=messages.filter(message=>message.type==='state').at(-1).projects;
    assert.ok(loadedProjects.every(project=>project.editor.installationPath===path.join(root,'installation')),'Every project uses the global installation, including indentation-only setup');
    assert.ok(Object.values(globalStored.localPreferences.projects).every(project=>project.installationPath===undefined));
    // Apply is direct; Review opens a diff without changing files or preferences.
    const settings={...require('../dist/setup').editorDefaults,...globalStored.localPreferences.projects[newRoot],indentSize:4};
    mock.window.showQuickPick=async()=>{throw new Error('Apply must not ask for a second confirmation');};
    await receive({action:'editor',root:newRoot,settings});assert.equal(JSON.parse(await fs.readFile(path.join(newRoot,'.vscode/settings.json'),'utf8'))['[cpp]']['editor.tabSize'],4);
    const beforeReview=await fs.readFile(path.join(newRoot,'.vscode/settings.json'));
    let reviewDiffs=0;const executeBeforeReview=mock.commands.executeCommand;
    mock.commands.executeCommand=async(command,...args)=>{if(command==='vscode.diff')reviewDiffs++;else await executeBeforeReview(command,...args);};
    mock.window.showQuickPick=async(choices,options)=>{assert.equal(options.title,'Review editor changes');assert.ok(!choices.includes('Apply reviewed editor settings'));return choices[0];};
    const savedBeforeReview=messages.filter(message=>message.type==='editorSaved').length;
    await receive({action:'reviewEditor',root:newRoot,settings:{...settings,indentSize:3}});
    assert.equal(reviewDiffs,1);assert.equal(globalStored.localPreferences.projects[newRoot].indentSize,undefined);assert.deepEqual(await fs.readFile(path.join(newRoot,'.vscode/settings.json')),beforeReview);assert.equal(messages.filter(message=>message.type==='editorSaved').length,savedBeforeReview);
    documents.push({uri:Uri.file(path.join(newRoot,'.vscode/settings.json')),isDirty:true});
    await receive({action:'editor',root:newRoot,settings:{...settings,indentSize:3}});documents.length=0;
    assert.match(messages.at(-1).message,/Save or revert/);assert.deepEqual(await fs.readFile(path.join(newRoot,'.vscode/settings.json')),beforeReview);
    // Two conflicting recovery copies compare directly without left/right pickers.
    let conflictPicks=0,copyDiffs=0;
    mock.window.showOpenDialog=async()=>[Uri.file(oneOutput),Uri.file(twoOutput)];
    mock.window.showQuickPick=async(choices,options)=>{assert.match(options.title,/Resolve conflicting/);return conflictPicks++===0?choices.find(choice=>choice.compare):undefined;};
    mock.commands.executeCommand=async(command)=>{if(command==='vscode.diff')copyDiffs++;};
    await receive({action:'initialize',mode:'Recover one or more .wh.cpp files',openProject:false});assert.equal(copyDiffs,1);assert.equal(conflictPicks,2);
    // No installations means Browse goes directly to the folder dialog.
    noInstallations=true;let folderPick=0;
    mock.window.showQuickPick=async()=>{throw new Error('A lone Browse option is unnecessary');};
    mock.window.showOpenDialog=async()=>{folderPick++;return [Uri.file(path.join(root,'installation'))];};
    await receive({action:'browseComputerInstallation'});assert.equal(folderPick,1);assert.equal(messages.at(-1).type,'computerInstallation');
    noInstallations=false;mock.commands.executeCommand=executeBeforeReview;
    // Opening existing projects performs no editor review or Git writes.
    const beforeSettings = await fs.readFile(path.join(newRoot, '.vscode/settings.json'));
    const beforeIgnore = await fs.readFile(path.join(newRoot, '.gitignore'));
    const pickerTitles = [];
    mock.window.showQuickPick = async (choices, options) => {
      pickerTitles.push(options.title);
      assert.ok(choices.some(choice => choice.label === 'Browse for a project folder…'));
      assert.equal(choices[0].detail, newRoot);
      return choices[0];
    };
    await receive({ action: 'initialize', mode: 'Open an existing project', openProject: false });
    assert.equal(opened.length, 2); assert.deepEqual(pickerTitles, ['Open WHAM project']);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.vscode/settings.json')), beforeSettings);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.gitignore')), beforeIgnore);
    const dropdownChoices = messages.filter(message => message.type === 'state').at(-1).projectChoices;
    const beforeOpenCount = opened.length;
    mock.window.showQuickPick = async () => { throw new Error('Dropdown selection must not show another picker'); };
    await receive({ action: 'openProject', projectRoot: newRoot });
    assert.equal(opened.length, beforeOpenCount + 1);
    assert.equal(opened.at(-1)[1].fsPath, newRoot);
    assert.equal(dropdownChoices.at(-1).label, 'Browse for a project folder…');
    assert.equal(dropdownChoices[0].root, newRoot);
    // Cold boot uses global history, without loading recent folders as active projects.
    for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    mock.workspace.workspaceFolders = []; delete stored.additionalRoots;
    const movedRoot = path.join(root, 'moved-project');
    globalStored.recentProjects.push(movedRoot);
    await extension.activate(context);
    provider.resolveWebviewView({ webview: { cspSource: 'test-resource:', asWebviewUri: uri => uri.toString(), postMessage: async message => { messages.push(message); }, onDidReceiveMessage(fn) { receive = fn; return disposable(); } } });
    assert.equal(messages.filter(message => message.type === 'state').at(-1).projects.length, 0);
    mock.commands.executeCommand = async (...args) => { if (args[0] === 'vscode.openFolder') opened.push(args); };
    mock.window.showQuickPick = async choices => { assert.deepEqual(choices, dropdownChoices); return choices[0]; };
    await commands.get('windhawk.openProject')();
    assert.equal(opened.at(-1)[1].fsPath, newRoot);
    assert.ok(!globalStored.recentProjects.includes(movedRoot));
    // Recovery can create an initial commit, but never commits into an existing repo.
    const recoveredRoot = path.join(root, 'recovered-project'); await fs.mkdir(recoveredRoot);
    const git = process.env.WHAM_TEST_GIT || 'git';
    const gitRun = (...args) => execFileSync(git, ['-C', recoveredRoot, ...args], { encoding: 'utf8', stdio: 'pipe' });
    mock.window.showOpenDialog = async options => [Uri.file(options.filters ? twoOutput : recoveredRoot)];
    mock.window.showQuickPick = async choices => {
      if (choices[0]?.label === 'Write reconstructed tree') return choices[0];
      throw new Error('Recovery file picker should only show files');
    };
    mock.window.showInformationMessage = async (message,options,...choices) => {
      if(!options?.modal)return;
      const titles=choices.map(choice=>typeof choice==='string'?choice:choice.title);
      if(titles.includes('Recover files'))return 'Recover files';
      if (titles.includes('Use this folder')) return 'Use this folder';
      if (titles.includes('Indentation only')) {
        gitRun('config', 'user.name', 'WHAM Test'); gitRun('config', 'user.email', 'wham-test@example.invalid');
        gitRun('config', 'commit.gpgsign', 'false'); gitRun('config', 'core.hooksPath', path.join(recoveredRoot, 'empty-hooks'));
        return choices[titles.indexOf('Indentation only')];
      }
      return choices[titles.indexOf('2 spaces')];
    };
    await receive({ action: 'initialize', mode: 'Recover one or more .wh.cpp files', openProject: false, initialCommit: true });
    const recoveredHead = gitRun('rev-parse', 'HEAD');
    assert.ok(gitRun('ls-tree', '-r', '--name-only', 'HEAD').includes('src/shared.h'));
    assert.equal(gitRun('status', '--porcelain').trim(), '');
    assert.equal(globalStored.recentProjects[0], recoveredRoot);
    await fs.writeFile(path.join(recoveredRoot, 'user.txt'), 'user staged changes'); gitRun('add', 'user.txt');
    mock.window.showQuickPick = async choices => choices[0]?.label === 'Write reconstructed tree' ? choices[0] : undefined;
    mock.window.showInformationMessage = async (message,options,...choices) => {if(!options?.modal)return;return choices.find(choice=>['Use this folder','Recover files','Skip'].includes(typeof choice==='string'?choice:choice.title));};
    await receive({ action: 'initialize', mode: 'Recover one or more .wh.cpp files', openProject: false, initialCommit: true });
    assert.equal(gitRun('rev-parse', 'HEAD'), recoveredHead);
    assert.equal(gitRun('diff', '--cached', '--name-only').trim(), 'user.txt');
    await fs.writeFile(path.join(recoveredRoot,'src/shared.h'),'user edit before recovery');
    let replaceConfirmations=0,reviewNotifications=0,recoveryDiffs=0;
    mock.window.showQuickPick=async(choices,options)=>{assert.equal(options.title,'Review recovered files');return choices.find(choice=>choice.file==='src/shared.h');};
    const executeBeforeRecovery=mock.commands.executeCommand;
    mock.commands.executeCommand=async(command,...args)=>{if(command==='vscode.diff')recoveryDiffs++;else await executeBeforeRecovery(command,...args);};
    mock.window.showWarningMessage=async(message,options,...choices)=>{
      assert.ok(options.detail.includes('src/shared.h'));assert.ok(choices.includes('Recover and replace'));
      if(options.modal){assert.equal(message,'Recover source files');replaceConfirmations++;return 'Review files…';}
      reviewNotifications++;assert.equal(recoveryDiffs,1);assert.equal(await fs.readFile(path.join(recoveredRoot,'src/shared.h'),'utf8'),'user edit before recovery');return 'Recover and replace';
    };
    await receive({action:'initialize',mode:'Recover one or more .wh.cpp files',openProject:false});assert.equal(replaceConfirmations,1);assert.equal(reviewNotifications,1);assert.ok((await fs.readFile(path.join(recoveredRoot,'src/shared.h'),'utf8')).includes('shared'));
    await fs.writeFile(path.join(recoveredRoot,'src/shared.h'),'before external change');
    mock.window.showWarningMessage=async()=>{await fs.writeFile(path.join(recoveredRoot,'src/shared.h'),'external change during confirmation');return 'Recover and replace';};
    await receive({action:'initialize',mode:'Recover one or more .wh.cpp files',openProject:false});assert.match(messages.at(-1).message,/Recovery destination changed/);assert.equal(await fs.readFile(path.join(recoveredRoot,'src/shared.h'),'utf8'),'external change during confirmation');
    // A failed initial commit still opens a fully configured new project.
    const failedRoot = path.join(root, 'failed-commit'); await fs.mkdir(failedRoot);
    const warnings = [];
    mock.window.showWarningMessage = async message => { warnings.push(message); };
    mock.window.showOpenDialog = async () => [Uri.file(failedRoot)];
    mock.window.showQuickPick = async () => { throw new Error('Fixed setup choices must use buttons'); };
    mock.window.showInformationMessage = async (message,options,...choices) => {
      if(!options?.modal)return;
      const titles=choices.map(choice=>typeof choice==='string'?choice:choice.title);
      if (titles.includes('Use empty folder')) return 'Use empty folder';
      if (titles.includes('Indentation only')) {
        for (const key of ['user.name', 'user.email']) execFileSync(git, ['-C', failedRoot, 'config', key, ''], { stdio: 'pipe' });
        return choices[titles.indexOf('Indentation only')];
      }
      return choices[titles.indexOf('2 spaces')];
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: true, initialCommit: true });
    assert.equal(opened.at(-1)[1].fsPath, failedRoot);
    assert.match(warnings.at(-1), /initial commit failed/);
    assert.equal(JSON.parse(await fs.readFile(path.join(failedRoot,'.vscode/settings.json'),'utf8'))['[cpp]']['editor.tabSize'],2);
    // Browsing a plain source project adds WHAM config, without editor prompts.
    const plainRoot = path.join(root, 'plain-project'); await fs.mkdir(plainRoot);
    mock.window.showQuickPick = async choices => choices.find(choice => choice.label === 'Browse for a project folder…');
    mock.window.showOpenDialog = async () => [Uri.file(plainRoot)];
    mock.window.showQuickPick = async () => { throw new Error('Browse must open the folder dialog directly'); };
    await receive({ action: 'openProject', browse: true });
    assert.ok((await fs.stat(path.join(plainRoot, 'windhawk-amalgamation.json'))).isFile());
    await assert.rejects(fs.stat(path.join(plainRoot, '.vscode/settings.json')), /ENOENT/);
    assert.equal(opened.at(-1)[1].fsPath, plainRoot);
    assert.equal(globalStored.recentProjects[0], plainRoot);
    // With no recent history, opening goes straight to a folder picker.
    for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    globalStored.recentProjects = []; delete stored.additionalRoots;
    mock.window.showQuickPick = async () => { throw new Error('Unexpected setup/recent picker'); };
    await extension.activate(context);
    await commands.get('windhawk.openProject')();
    assert.equal(globalStored.recentProjects[0], plainRoot);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
