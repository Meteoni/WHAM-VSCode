const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { defaults } = require('../dist/config');
const { parseMetadata } = require('../dist/metadata');
const { WindhawkError } = require('../dist/windhawk');

test('runtime controls submit a fixed snapshot, preserve enabled state/builds, map errors and gate old Windhawk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wham-runtime-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const entry = path.join(root, 'src/mod.cpp'), header = path.join(root, 'src/header.h');
  const original = '// ==WindhawkMod==\n// @id runtime-test\n// @name Runtime test\n// @version 1.0\n// ==/WindhawkMod==\n#include "header.h"\n';
  await fs.writeFile(entry, original); await fs.writeFile(header, '#pragma once\nint shared = 1;\n');
  await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, generate: 'manual' }));
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(path.join(root, '.vscode/c_cpp_properties.json'), JSON.stringify({ configurations: [{ name: 'Windhawk (WHAM)', compilerPath: path.join(root, 'installation/Compiler/bin/clang++.exe') }] }));
  await fs.mkdir(path.join(root, 'installation')); await fs.writeFile(path.join(root, 'installation/windhawk.ini'), '[Storage]\nPortable=1\n');
  let libraryFileName, installedSource, disabled = true, fail = false, holdCompile, releaseCompile, oldVersion = false, parserUnavailable = false, sourceUnavailable = false, compileWarnings = false, failEnable = false, holdEnable = false, releaseEnable;
  const calls = [], detailViews = [];
  let holdTest = false, testStarted = false, testBuilds = 0, holdVerify = false, verifyStarted = false, checkWarnings=false, failCheck=false,customVerifyWarnings=false,customVerifyFailure=false;
  let coreReads = 0, runtimeReads = 0, outputShows = 0, generations = 0, sidebarView, editorPanels = 0;
  const fakeDetails = {
    createDetailsView: (extensionUri, webview, data, callbacks) => {
      const details = { callbacks, data, update: async next => { details.data = next; }, dispose: () => { details.disposed = true; } };
      webview.html = 'Immediate details shell'; detailViews.push(details); return details;
    },
    createDetailsPanel: async () => { editorPanels++; return { panel: { reveal() {}, dispose() {}, onDidDispose() {} }, update: async () => {}, dispose() {} }; }
  };
  const fakeWindhawk = {
    closeElevationSessions: async () => {},
    WindhawkError, previewLanguage: require('../dist/windhawk').previewLanguage,
    inspectWindhawk: async root => ({ root, parser: !oldVersion && !parserUnavailable, cli: !oldVersion, sourceRead: !oldVersion, version: oldVersion ? '1.7.3' : '2.0.0-alpha.7', notice: oldVersion ? 'Update Windhawk to use these controls.' : undefined }),
    invokeWindhawkCore: async (root, command, params) => {
      coreReads++;
      if (command === 'parseModSource') {
        const parsed = parseMetadata(params.source, entry);
        return { metadata: Object.fromEntries(Object.entries(parsed.fields).map(([key,value]) => [key,value[0]])), readme: null, initialSettings: null, errors: {} };
      }

      throw Error('Unexpected core command: ' + command);
    },
    runWindhawkProcess: async (executable,args,input,options) => {
      verifyStarted = true; assert.ok(args.includes('-fsyntax-only'));
      assert.equal(options.elevation, undefined, 'Syntax checks stay unelevated');
      if (holdVerify) await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new WindhawkError('Stopped','CANCELED')),{once:true}));
      return {code:customVerifyFailure?1:0,stdout:'',stderr:customVerifyWarnings?'fixture.cpp:1:1: warning: fixture warning':''};
    },
    readInstalledMod: async (root, id) => { runtimeReads++; assert.equal(id,'local@runtime-test'); return {config:installedSource?{disabled,libraryFileName}:null}; },
    readInstalledSources: async (root, ids) => { runtimeReads++; assert.deepEqual(ids,['local@runtime-test']); if(sourceUnavailable)throw new WindhawkError('Source export unavailable.','INVALID_REQUEST'); return new Map(installedSource?[['local@runtime-test',installedSource]]:[]); },
    runWindhawkCli: async (root, args, input, onOutput, signal, elevation) => {
      assert.deepEqual(elevation, { elevation: 'gsudo', gsudoPath: '' }, 'Installed-mod writes use this installation’s local elevation preference');
      calls.push({ args, input });
      if (args[1] === 'install') {
        if (holdCompile) await new Promise((resolve,reject) => { releaseCompile = resolve; signal.addEventListener('abort',()=>reject(new WindhawkError('Stopped','CANCELED')),{once:true}); });
        if (fail) {
          const line = input.slice(0,input.indexOf('int shared')).split('\n').length;
          throw new WindhawkError('Compiler failed.', 'COMPILER_FAILED', { output: `mod.wh.cpp:${line}:1: error: fixture compile error\n` });
        }
        installedSource = input.replace(/\r?\n/g,'\r\n');
        disabled = args.includes('--disabled');
        libraryFileName = 'runtime-test_' + calls.length + '.dll';
        return { id: 'local@runtime-test', config: {libraryFileName}, warnings: compileWarnings ? 'fixture warning' : '' };
      }
      assert.equal(args[2], 'local@runtime-test');
      if(failEnable)throw new WindhawkError('Toggle failed.','ACCESS_DENIED');
      if(holdEnable)await new Promise(resolve=>{releaseEnable=resolve;});
      disabled = args[1] === 'disable'; return {id:args[2],enabled:!disabled,changed:true};
    }
  };
  let receive, provider, onSave, onChange;
  const commands = new Map(), watchers = [], messages = [], documents = [], stored = {}, problems = new Map(), notices = [];
  const globalStored = { localPreferences: { version: 1, computer: { installationPath: path.join(root, 'installation'), integration: 'cpp',
    installations: { [path.resolve(root, 'installation').toLowerCase()]: { elevation: 'gsudo', gsudoPath: '' } } }, projects: {} } };
  const disposable = () => ({ dispose() {} });
  const Uri = {
    file(file) { return { fsPath: file, scheme: 'file', toString: () => 'file:' + file }; },
    from(value) { return { ...value, toString: () => value.scheme + ':' + value.path }; },
    joinPath(base, ...parts) { return Uri.file(path.join(base.fsPath, ...parts)); }
  };
  const mock = {
    Uri, StatusBarAlignment: { Left: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1 }, extensions: { getExtension: () => undefined },
    Range: class { constructor(line, character) { this.start = {line, character}; } }, Diagnostic: class { constructor(range, message, severity) { Object.assign(this,{range,message,severity}); } }, RelativePattern: class { constructor(root, pattern) { this.root = root; this.pattern = pattern; } },
    languages: { createDiagnosticCollection: () => ({ ...disposable(), clear() { problems.clear(); }, set(uri, items) { problems.set(uri.fsPath, items); } }) },
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
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, append() {}, show() { outputShows++; } }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      registerWebviewViewProvider(id, value) { provider = value; return disposable(); },
      showWarningMessage: async () => undefined,
      showErrorMessage: async message => { notices.push(message); },
      showInformationMessage: async message => { notices.push(message); }
    },
    commands: { registerCommand(id, fn) { commands.set(id, fn); return disposable(); }, executeCommand: async () => undefined }
  };
  const context = { extensionUri: Uri.file(path.resolve('.')), subscriptions: [], workspaceState: { get: (key, fallback) => stored[key] ?? fallback, update: async (key, value) => { stored[key] = value; } } };
  context.globalState = { get: (key, fallback) => globalStored[key] ?? fallback, update: async (key, value) => { globalStored[key] = value; } };
  const load = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return mock;
    if (args[0]?.filename.endsWith('dist' + path.sep + 'extension.js')) {
      if (name === './windhawk') return fakeWindhawk;
      if (name === './engine') { const engine=load.call(this,name,...args); return {...engine,generateEntry:(...values)=>{generations++;return engine.generateEntry(...values);}}; }
      if (name === './details') return fakeDetails;
      if (name === './compiler') return {checkModBuild:async(root,source,signal,onOutput,version,syntaxOnly)=>{
        if(syntaxOnly)verifyStarted=true;else{testBuilds++;testStarted=true;}
        assert.ok(source.includes('runtime-test')); assert.equal(signal.aborted,false);
        if (syntaxOnly && holdVerify) await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new WindhawkError('Stopped','CANCELED')),{once:true}));
        if (!syntaxOnly && holdTest) await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new WindhawkError('Stopped','CANCELED')),{once:true}));
        if(failCheck)throw new WindhawkError('Fixture compiler failure','COMPILER_FAILED');
        return {warnings:checkWarnings};
      }};
    }
    return load.call(this, name, ...args);
  };
  let extension;
  try { delete require.cache[require.resolve('../dist/extension')]; extension = require('../dist/extension'); }
  finally { Module._load = load; }
  const contextView = () => {
    sidebarView = { webview: { cspSource:'test:', asWebviewUri:uri => uri.toString(), postMessage:async message => { messages.push(message); }, onDidReceiveMessage(fn) { receive=fn; return disposable(); } } };
    provider.resolveWebviewView(sidebarView);
  };
  const current = () => messages.filter(message => message.type==='state').at(-1)?.projects[0]?.entries[0];
  const until = async predicate => { for (let attempt=0;attempt<300;attempt++) { if(await predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); } assert.fail('Runtime state did not settle: '+JSON.stringify(current())); };
  try {
    await extension.activate(context); contextView();
    await until(()=>messages.filter(message=>message.type==='state').at(-1)?.projects[0]?.windhawk?.cli);
    assert.equal(current().runtime.installed,false);
    const readsBeforeOpening = coreReads;
    await receive({ action:'details', root, entry });
    assert.equal(sidebarView.webview.html, 'Immediate details shell');
    assert.equal(editorPanels, 0, 'Mod details default to the sidebar');
    assert.equal(coreReads, readsBeforeOpening, 'Opening details does not wait for project-wide core reads');
    const pollsBeforePreview=runtimeReads;
    await detailViews.at(-1).callbacks.onRefresh();
    assert.equal(runtimeReads,pollsBeforePreview,'Refreshing Draft never polls installed mods');
    await detailViews.at(-1).callbacks.onNavigate('settings');
    assert.ok(detailViews.at(-1).disposed);
    assert.ok(sidebarView.webview.html.includes('id="page-project"'));
    const initialState = /window\.whamSidebarState = ([\s\S]*?); window\.whamSidebarState\.page = ("[^"]+");/.exec(sidebarView.webview.html);
    assert.ok(initialState, 'Returning embeds cached state before the sidebar script');
    assert.equal(JSON.parse(initialState[1]).selected, root);
    assert.equal(JSON.parse(initialState[2]), 'settings');
    await receive({ action:'ready' });
    assert.equal(messages.filter(message=>message.type==='state').at(-1).page, 'settings');
    const noticesBeforeLateMessage = notices.length;
    await receive({ action:'modAction', modAction:'open', details:true });
    assert.equal(notices.length, noticesBeforeLateMessage, 'Late preview messages are ignored after returning');
    await receive({ action:'compile', root, entry });
    assert.equal(calls[0].args[1], 'install'); assert.ok(calls[0].args.includes('--disabled')); assert.ok(calls[0].input.includes('int shared = 1'));
    assert.equal(current().runtime.enabled,false); assert.equal(current().runtime.changesPending,false);
    await receive({action:'compile',root,entry});assert.ok(calls.at(-1).args.includes('--disabled'),'Disabled recompilation stays explicitly disabled');
    assert.equal(outputShows,0,'Successful installs do not open Output');
    const beforeTest={calls:calls.length,source:installedSource,library:libraryFileName};
    await receive({action:'testCompile',root,entry});
    assert.equal(calls.length,beforeTest.calls);assert.equal(installedSource,beforeTest.source);assert.equal(libraryFileName,beforeTest.library);
    assert.equal(outputShows,0,'Clean Test build stays quiet');
    await receive({action:'verify',root,entry});assert.equal(outputShows,0,'Clean Verify stays quiet');
    checkWarnings=true;
    let reveals=outputShows;await receive({action:'testCompile',root,entry});assert.equal(outputShows,reveals+1,'Test build warnings reveal Output');
    reveals=outputShows;await receive({action:'verify',root,entry});assert.equal(outputShows,reveals+1,'Verify warnings reveal Output');
    checkWarnings=false;failCheck=true;
    reveals=outputShows;await receive({action:'testCompile',root,entry});assert.equal(outputShows,reveals+1,'Test build failures reveal Output');
    reveals=outputShows;await receive({action:'verify',root,entry});assert.equal(outputShows,reveals+1,'Verify failures reveal Output');
    failCheck=false;
    reveals=outputShows;await receive({action:'logs'});assert.equal(outputShows,reveals+1,'Explicit Show log always reveals Output');
    const beforeStop={source:installedSource,library:libraryFileName,proof:JSON.stringify(globalStored.compiledSnapshots),notices:notices.length};
    for (const action of ['compile','testCompile','verify']) {
      holdCompile=action==='compile'; releaseCompile=undefined;
      holdTest=action==='testCompile'; testStarted=false;
      holdVerify=action==='verify'; verifyStarted=false;
      const running=receive({action,root,entry});
      await until(()=>action==='compile'?releaseCompile:action==='testCompile'?testStarted:verifyStarted);
      assert.equal(current().runtime.busy,true);
      await receive({action:'stopCompile',root,entry}); await running;
      assert.equal(current().runtime.busy,false); assert.equal(current().runtime.operation,undefined); assert.equal(current().runtime.stopping,false);
      assert.equal(installedSource,beforeStop.source);assert.equal(libraryFileName,beforeStop.library);assert.equal(JSON.stringify(globalStored.compiledSnapshots),beforeStop.proof);
    }
    assert.equal(notices.length,beforeStop.notices,'Cancellation does not show failure notifications');
    assert.equal(outputShows,reveals+1,'Stopped checks do not reveal Output');
    holdCompile=holdTest=holdVerify=false;
    await new Promise(resolve=>setTimeout(resolve,450)); // Settle the earlier Draft debounce.
    const beforeToggle={calls:calls.length,reads:runtimeReads,core:coreReads,generations,source:installedSource,output:outputShows};
    holdEnable=true;
    const enabling=receive({action:'enable',root,entry,enabled:true});await until(()=>releaseEnable);
    assert.equal(current().runtime.operation,'enable');assert.equal(current().runtime.enabled,false);
    await receive({action:'enable',root,entry,enabled:true}); // Disabled controls also have a backend guard.
    releaseEnable();await enabling;holdEnable=false;
    assert.deepEqual(calls.slice(beforeToggle.calls).map(call=>call.args),[['mod','enable','local@runtime-test']]);
    assert.equal(runtimeReads,beforeToggle.reads);assert.equal(coreReads,beforeToggle.core);
    assert.equal(generations,beforeToggle.generations);assert.equal(installedSource,beforeToggle.source);assert.equal(outputShows,beforeToggle.output);
    assert.equal(current().runtime.enabled,true);assert.equal(current().runtime.busy,false);assert.equal(current().runtime.operation,undefined);
    const beforeDisable={calls:calls.length,reads:runtimeReads,generations};
    await receive({action:'enable',root,entry,enabled:false});
    assert.deepEqual(calls.slice(beforeDisable.calls).map(call=>call.args),[['mod','disable','local@runtime-test']]);
    assert.equal(runtimeReads,beforeDisable.reads);assert.equal(generations,beforeDisable.generations);assert.equal(current().runtime.enabled,false);
    failEnable=true;await receive({action:'enable',root,entry,enabled:true});failEnable=false;
    assert.equal(current().runtime.enabled,false);assert.equal(current().runtime.busy,false);assert.match(current().runtime.error,/Toggle failed/);
    await receive({action:'enable',root,entry,enabled:true});assert.equal(current().runtime.enabled,true);
    // Different cards/projects can target the same installed mod. They share one
    // operation owner, and either card can stop that owner's compilation.
    const peerRoot = path.join(root, 'peer-project'), peerEntry = path.join(peerRoot, 'src/mod.cpp');
    await fs.mkdir(path.dirname(peerEntry), { recursive: true });
    await fs.writeFile(peerEntry, original.replace('#include "header.h"', 'int shared = 1;'));
    await fs.writeFile(path.join(peerRoot, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, generate: 'manual' }));
    globalStored.recentProjects = [peerRoot];
    mock.window.showOpenDialog = async () => [Uri.file(peerRoot)];
    await receive({ action: 'openProject', browse: true });
    const peer = () => messages.filter(message => message.type === 'state').at(-1)?.projects.find(project => project.root === peerRoot)?.entries[0];
    await until(() => peer()?.runtime.installed);
    holdCompile = true; releaseCompile = undefined;
    let sharedCompile = receive({ action: 'compile', root, entry });
    await until(() => releaseCompile);
    assert.equal(peer().runtime.busy, true); assert.equal(peer().runtime.operation, 'compile');
    const sharedCalls = calls.length;
    await receive({ action: 'enable', root: peerRoot, entry: peerEntry, enabled: false });
    await receive({ action: 'compile', root: peerRoot, entry: peerEntry });
    assert.equal(calls.length, sharedCalls, 'Peer writes cannot overwrite the active compilation');
    releaseCompile(); await sharedCompile;
    assert.equal(peer().runtime.busy, false); assert.equal(peer().runtime.enabled, true);
    releaseCompile = undefined;
    sharedCompile = receive({ action: 'compile', root, entry }); await until(() => releaseCompile);
    const sharedProof = JSON.stringify(globalStored.compiledSnapshots);
    await receive({ action: 'stopCompile', root: peerRoot, entry: peerEntry }); await sharedCompile;
    assert.equal(JSON.stringify(globalStored.compiledSnapshots), sharedProof);
    assert.equal(peer().runtime.busy, false); holdCompile = false;
    holdEnable = true; releaseEnable = undefined;
    const sharedToggle = receive({ action: 'enable', root: peerRoot, entry: peerEntry, enabled: false });
    await until(() => releaseEnable); assert.equal(current().runtime.busy, true);
    const toggleCalls = calls.length;
    await receive({ action: 'enable', root, entry, enabled: true });
    assert.equal(calls.length, toggleCalls);
    releaseEnable(); await sharedToggle; holdEnable = false;
    assert.equal(current().runtime.enabled, false); assert.equal(peer().runtime.enabled, false);
    await receive({ action: 'enable', root, entry, enabled: true });
    assert.equal(peer().runtime.enabled, true);
    delete mock.window.showOpenDialog;
    sourceUnavailable=true;
    await receive({action:'compile',root,entry});
    assert.equal(current().runtime.changesPending,false,'A missing source snapshot is not marked uncompiled');
    assert.equal(current().runtime.compileStatus,'current','Successful compile does not depend on Windhawk saved-source export');
    const outputBeforeWarnings=outputShows; sourceUnavailable=false;compileWarnings=true;
    await receive({action:'compile',root,entry});compileWarnings=false;
    assert.equal(outputShows,outputBeforeWarnings+1,'Compiler warnings open Output');assert.equal(current().runtime.error,undefined);
    const pollsBeforeEdit=runtimeReads;
    await fs.writeFile(header, '#pragma once\nint shared = 2;\n'); onSave({uri:Uri.file(header)});
    await until(()=>current().runtime.changesPending);
    assert.equal(runtimeReads,pollsBeforeEdit,'Source edits use the cached installed snapshot');
    await receive({ action:'compile', root, entry });
    assert.ok(!calls.at(-1).args.includes('--disabled')); assert.equal(current().runtime.enabled,true); assert.equal(current().runtime.changesPending,false);
    // Editing continues while a build of the saved snapshot is running.
    holdCompile = true;
    const compiling = receive({ action:'compile', root, entry }); await until(()=>releaseCompile);
    const dirty = { uri:Uri.file(entry), isDirty:true, getText:()=>original+'int newer_draft;\n' }; documents.push(dirty); onChange({document:dirty});
    assert.equal(current().runtime.busy,true);
    releaseCompile(); await compiling; holdCompile=false;
    assert.ok(!calls.at(-1).input.includes('newer_draft')); assert.equal(current().runtime.changesPending,true);
    documents.length=0; onChange({document:{...dirty,isDirty:false,getText:()=>original}});
    await until(()=>!current().runtime.changesPending && current().status==='current');
    fail=true; const previousBuild=installedSource, beforeFailedOutput=outputShows;
    await receive({ action:'compile', root, entry });
    assert.equal(outputShows,beforeFailedOutput+1,'Compiler failures open Output');
    assert.equal(installedSource,previousBuild); assert.equal(current().runtime.enabled,true); assert.match(current().runtime.error,/Compiler failed/);
    assert.ok(problems.get(header)?.some(item=>item.message==='fixture compile error' && item.range.start.line===1));
    await receive({ action:'enable', root, entry, enabled:false }); assert.equal(current().runtime.enabled,false);
    for(const subscription of context.subscriptions.splice(0))subscription.dispose();
    parserUnavailable=true; fail=false;
    await extension.activate(context); contextView();
    await until(()=>messages.filter(message=>message.type==='state').at(-1)?.projects[0]?.windhawk?.parser===false);
    assert.equal(current().status,'current','Output freshness survives reactivation');
    assert.equal(current().runtime.compileStatus,'current','Successful build snapshot survives reactivation');
    // Saving Windhawk source without building must never establish a new baseline.
    installedSource += '\n// saved externally without compiling\n';
    await fs.writeFile(header, '#pragma once\nint shared = 7;\n'); onSave({uri:Uri.file(header)});
    await until(()=>current().runtime.changesPending);
    // Windhawk can save exactly our current Draft while retaining the old DLL.
    installedSource = (await require('../dist/engine').generateEntry({root,config:JSON.parse(await fs.readFile(path.join(root,'windhawk-amalgamation.json'),'utf8'))},entry,require('../dist/io').nodeFiles)).bytes.toString();
    const readsBeforeSavedSource=runtimeReads;
    for(const subscription of context.subscriptions.splice(0))subscription.dispose();
    await extension.activate(context); contextView();
    await until(()=>runtimeReads>readsBeforeSavedSource && current()?.runtime?.compileStatus==='uncompiled');
    assert.equal(current().runtime.changesPending,true,'Matching saved Windhawk source cannot prove the old DLL compiled it');
    libraryFileName = 'external-build.dll'; const readsBeforeReopen=runtimeReads;
    for(const subscription of context.subscriptions.splice(0))subscription.dispose();
    await extension.activate(context); contextView();
    await until(()=>runtimeReads>readsBeforeReopen && current()?.runtime?.compileStatus==='unknown' && messages.filter(message=>message.type==='state').at(-1)?.projects[0]?.windhawk?.cli);
    assert.equal(current().runtime.changesPending,false,'External builds are unknown, not assumed current or uncompiled');
    const coreBeforeCompile=coreReads;
    await receive({action:'compile',root,entry});
    assert.equal(coreReads,coreBeforeCompile,'Compile does not call the optional native parser');
    assert.equal(current().runtime.changesPending,false);
    await receive({action:'enable',root,entry,enabled:true}); assert.equal(current().runtime.enabled,true);
    for(const subscription of context.subscriptions.splice(0))subscription.dispose();
    oldVersion=true; await extension.activate(context); contextView();
    await until(()=>messages.filter(message=>message.type==='state').at(-1)?.projects[0]?.windhawk?.cli===false);
    const before=calls.length;
    await receive({ action:'compile', root, entry }); assert.equal(calls.length,before); assert.match(notices.at(-1),/Update Windhawk/);
    const checksBeforeOld=testBuilds;await receive({action:'testCompile',root,entry});assert.equal(testBuilds,checksBeforeOld+1,'Test build does not require the install CLI');assert.equal(calls.length,before);
    await receive({ action:'details', root, entry });
    assert.equal(sidebarView.webview.html, 'Immediate details shell');
    assert.equal(detailViews.at(-1).data.parsed.metadata.name, 'Runtime test', 'Older Windhawk still has a Draft preview');
    assert.ok(detailViews.at(-1).data.source.includes('int shared = 7'));
    await detailViews.at(-1).callbacks.onNavigate('project');
    // The optional custom compiler follows the same reveal policy.
    globalStored.localPreferences.computer.installationPath='';
    await receive({action:'projectPreferences',root,settings:{integration:'default'}});
    mock.window.showInputBox=async options=>options.title==='Compiler executable'?'fixture-compiler.exe':JSON.stringify(['-fsyntax-only']);
    let customOutput=outputShows;await receive({action:'verify',root,entry});assert.equal(outputShows,customOutput,'A clean custom compiler stays quiet');
    customVerifyWarnings=true;await receive({action:'verify',root,entry});assert.equal(outputShows,customOutput+1,'Custom compiler warnings reveal Output');
    customVerifyWarnings=false;customVerifyFailure=true;customOutput=outputShows;
    await receive({action:'verify',root,entry});assert.equal(outputShows,customOutput+1,'Custom compiler failures reveal Output');
  } finally {
    for(const subscription of context.subscriptions)subscription.dispose();
    await fs.rm(root,{recursive:true,force:true});
  }
});
