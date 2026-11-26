const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const { defaults } = require('../dist/config');
const { restoreSource } = require('../dist/engine');

test('adapter sidebar, serialized saves, dependencies, output protection and config controls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wham-adapter-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, debounceMs: 10 }));
  await fs.writeFile(path.join(root, 'src/one.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/two.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint shared = 1;\n');
  await fs.mkdir(path.join(root, '.vscode'));
  await fs.writeFile(
    path.join(root, '.vscode/settings.json'),
    JSON.stringify({
      '[cpp]': { 'editor.tabSize': 2, 'editor.insertSpaces': false },
      'clangd.path': path.join(root, 'installation/Compiler/bin/clangd.exe'),
      'C_Cpp.intelliSenseEngine': 'disabled'
    })
  );
  await fs.writeFile(
    path.join(root, '.vscode/c_cpp_properties.json'),
    JSON.stringify({
      configurations: [
        { name: 'Windhawk (WHAM)', compilerPath: path.join(root, 'installation/Compiler/bin/clang++.exe') }
      ]
    })
  );
  await fs.writeFile(path.join(root, '.clangd'), 'CompileFlags:\n  Add: [-DWH_EDITING]\n');
  await fs.mkdir(path.join(root, 'installation'));
  await fs.writeFile(path.join(root, 'installation/windhawk.ini'), '[Storage]\nPortable=1\n');
  await fs.mkdir(path.join(root, 'installation/Compiler/bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'installation/Compiler/include'), { recursive: true });
  for (const file of ['bin/clang++.exe', 'bin/clangd.exe', 'include/windhawk_api.h'])
    await fs.writeFile(path.join(root, 'installation/Compiler', file), 'fixture');
  let receive, provider, onSave, onChange, onFolders, onWindowStateChange;
  let noInstallations = false,
    singleVerifies = 0,
    elevationCloses = 0;
  let holdGenerationFor,
    releaseGeneration,
    projectLoads = 0,
    entryScans = 0;
  const sourceReads = new Map();
  const legacyPreferences = {
    version: 2,
    computer: { installationPath: '', integration: 'cpp', installations: {} },
    projects: { [root]: { integration: 'both' } }
  };
  let localPreferenceWrites = 0;
  const commands = new Map(),
    watchers = [],
    messages = [],
    documents = [],
    stored = {},
    globalStored = { localPreferences: structuredClone(legacyPreferences) },
    generations = new Map(),
    // VS Code settings as user-level values, and the target of each write.
    vscodeSettings = {},
    settingTargets = {};
  let onSettings, beforeSettingWrite, beforeInspectInstallation, runtimeCalls, editorGitChecks;
  const workspaceSettings = {};
  const disposable = () => ({ dispose() {} });
  const Uri = {
    file(file) {
      return { fsPath: file, scheme: 'file', toString: () => 'file:' + file };
    },
    from(value) {
      return { ...value, toString: () => value.scheme + ':' + value.path };
    },
    joinPath(base, ...parts) {
      return Uri.file(path.join(base.fsPath, ...parts));
    }
  };
  const mock = {
    Uri,
    StatusBarAlignment: { Left: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    extensions: { getExtension: () => undefined },
    Range: class {},
    Diagnostic: class {},
    RelativePattern: class {
      constructor(root, pattern) {
        this.root = root;
        this.pattern = pattern;
      }
    },
    languages: { createDiagnosticCollection: () => ({ ...disposable(), clear() {}, set() {} }) },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(root) }],
      textDocuments: documents,
      getConfiguration: (section, scope) => ({
        get: key => workspaceSettings[section + '.' + key] ?? vscodeSettings[section + '.' + key],
        inspect: key => ({
          globalValue: vscodeSettings[section + '.' + key],
          workspaceValue: workspaceSettings[section + '.' + key],
          // VS Code exposes the same settings file at both levels when one folder is open.
          workspaceFolderValue: scope?.fsPath === root ? workspaceSettings[section + '.' + key] : undefined
        }),
        async update(key, value, target) {
          const name = section + '.' + key;
          if (target === 3 && key === 'debounceMs') throw new Error('Window settings cannot target a folder');
          if (beforeSettingWrite) await beforeSettingWrite(key, value);
          const settings = target === 2 ? workspaceSettings : vscodeSettings;
          settings[name] = value;
          settingTargets[name] = target;
          onSettings?.({ affectsConfiguration: changed => changed === name });
        }
      }),
      onDidChangeConfiguration(fn) {
        onSettings = fn;
        return disposable();
      },
      registerTextDocumentContentProvider: disposable,
      createFileSystemWatcher(pattern) {
        const watcher = {
          root: pattern.root,
          dispose() {
            this.disposed = true;
          },
          onDidChange(fn) {
            this.change = fn;
            return disposable();
          },
          onDidCreate(fn) {
            this.create = fn;
            return disposable();
          },
          onDidDelete(fn) {
            this.delete = fn;
            return disposable();
          }
        };
        watchers.push(watcher);
        return watcher;
      },
      onDidSaveTextDocument(fn) {
        onSave = fn;
        return disposable();
      },
      onDidChangeTextDocument(fn) {
        onChange = fn;
        return disposable();
      },
      onDidChangeWorkspaceFolders(fn) {
        onFolders = fn;
        return disposable();
      }
    },
    window: {
      createOutputChannel: () => ({ ...disposable(), appendLine() {}, append() {}, show() {} }),
      createStatusBarItem: () => ({ ...disposable(), show() {} }),
      onDidChangeWindowState(fn) {
        onWindowStateChange = fn;
        return disposable();
      },
      registerWebviewViewProvider(id, value) {
        provider = value;
        return disposable();
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async message => {
        throw new Error(message);
      },
      showInformationMessage: async () => undefined
    },
    commands: {
      registerCommand(id, fn) {
        commands.set(id, fn);
        return disposable();
      },
      executeCommand: async () => undefined
    }
  };
  const context = {
    extensionUri: Uri.file(path.resolve('.')),
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => stored[key] ?? fallback,
      update: async (key, value) => {
        stored[key] = value;
      }
    }
  };
  context.globalState = {
    get: (key, fallback) => globalStored[key] ?? fallback,
    update: async (key, value) => {
      if (key === 'localPreferences') localPreferenceWrites++;
      globalStored[key] = value;
    }
  };
  // The adapter's own modules: extension.js and the pipeline and runtime modules it delegates to.
  const fromAdapter = parent => /dist[\\/](extension|generation|runtime)\.js$/.test(parent?.filename ?? '');
  const load = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'vscode') return mock;
    if (name === './windhawk' && fromAdapter(args[0])) {
      const windhawk = load.call(this, name, ...args);
      return {
        ...windhawk,
        inspectWindhawk: async root => {
          const installation = runtimeCalls ? { root, parser: false, cli: true } : await windhawk.inspectWindhawk(root);
          await beforeInspectInstallation?.(root);
          return installation;
        },
        readInstalledMod: (root, id) =>
          runtimeCalls && id === 'local@settings-race'
            ? Promise.resolve({ config: { disabled: true } })
            : windhawk.readInstalledMod(root, id),
        runWindhawkCli: async (root, args, input, onOutput, signal, elevation) => {
          if (!runtimeCalls) return windhawk.runWindhawkCli(root, args, input, onOutput, signal, elevation);
          runtimeCalls.push({ root, action: args[1], elevation });
          return args[1] === 'install' ? { id: 'local@settings-race' } : { id: args[2], enabled: args[1] === 'enable' };
        },
        inspectElevation: async () => ({ notice: 'fixture ready' }),
        closeElevationSessions: async () => {
          elevationCloses++;
        }
      };
    }
    if (name === './compiler' && fromAdapter(args[0]))
      return {
        checkModBuild: async (root, source, signal, onOutput, version, syntaxOnly) => {
          assert.equal(syntaxOnly, true);
          singleVerifies++;
        }
      };
    if (name === './setup' && fromAdapter(args[0])) {
      const setup = load.call(this, name, ...args);
      return {
        ...setup,
        findWindhawk: async () => (noInstallations ? [] : setup.findWindhawk()),
        trackedEditorFiles: (...args) => {
          const check = setup.trackedEditorFiles(...args);
          editorGitChecks?.push(check);
          return check;
        }
      };
    }
    if (name === './io' && fromAdapter(args[0])) {
      const io = load.call(this, name, ...args);
      return {
        ...io,
        loadProject: async (...args) => {
          projectLoads++;
          return io.loadProject(...args);
        },
        nodeFiles: {
          ...io.nodeFiles,
          read: async file => {
            sourceReads.set(file, (sourceReads.get(file) || 0) + 1);
            return io.nodeFiles.read(file);
          }
        }
      };
    }
    if (name === './config' && fromAdapter(args[0])) {
      const config = load.call(this, name, ...args);
      return {
        ...config,
        discoverEntries: async (...args) => {
          entryScans++;
          return config.discoverEntries(...args);
        }
      };
    }
    if (name === './engine' && fromAdapter(args[0])) {
      const engine = load.call(this, name, ...args);
      return {
        ...engine,
        generateEntry: async (project, entry, ...rest) => {
          generations.set(entry, (generations.get(entry) || 0) + 1);
          const result = await engine.generateEntry(project, entry, ...rest);
          if (entry === holdGenerationFor)
            await new Promise(resolve => {
              releaseGeneration = resolve;
            });
          return result;
        }
      };
    }
    return load.call(this, name, ...args);
  };
  let extension;
  try {
    delete require.cache[require.resolve('../dist/extension')];
    delete require.cache[require.resolve('../dist/generation')];
    delete require.cache[require.resolve('../dist/runtime')];
    extension = require('../dist/extension');
  } finally {
    Module._load = load;
  }
  try {
    await t.test('a rejected computer migration leaves WHAM active and can be retried', async () => {
      const data = {
        localPreferences: {
          ...legacyPreferences,
          computer: { ...legacyPreferences.computer, integration: 'both' }
        }
      };
      const migrationContext = {
        ...context,
        subscriptions: [],
        globalState: {
          get: (key, fallback) => data[key] ?? fallback,
          update: async (key, value) => (data[key] = value)
        }
      };
      const folders = mock.workspace.workspaceFolders;
      mock.workspace.workspaceFolders = [];
      beforeSettingWrite = async () => {
        throw new Error('Cannot write invalid user settings');
      };
      try {
        await extension.activate(migrationContext);
        assert.ok(commands.has('windhawk.openProject'));
        assert.equal(data.computerPreferencesMigrated, undefined);
        for (const subscription of migrationContext.subscriptions.splice(0)) subscription.dispose();
        beforeSettingWrite = undefined;
        await extension.activate(migrationContext);
        assert.equal(vscodeSettings['wham.languageService'], 'both');
        assert.equal(data.computerPreferencesMigrated, true);
      } finally {
        for (const subscription of migrationContext.subscriptions) subscription.dispose();
        mock.workspace.workspaceFolders = folders;
        beforeSettingWrite = undefined;
        delete vscodeSettings['wham.languageService'];
      }
    });
    await extension.activate(context);
    provider.resolveWebviewView({
      webview: {
        cspSource: 'test-resource:',
        asWebviewUri: uri => uri.toString(),
        postMessage: async message => {
          messages.push(message);
        },
        onDidReceiveMessage(fn) {
          receive = fn;
          return disposable();
        }
      }
    });
    const settle = async predicate => {
      for (let count = 0; count < 500; count++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('Adapter did not reach expected state: ' + JSON.stringify(project()));
    };
    const sidebarState = () => messages.filter(message => message.type === 'state').at(-1);
    const project = (projectRoot = root) => sidebarState()?.projects.find(project => project.root === projectRoot);
    await settle(() => project()?.entries.every(entry => entry.status === 'current'));
    // Typing in files outside every project must not rebuild diagnostics or the sidebar.
    const statesBeforeTyping = messages.filter(message => message.type === 'state').length;
    onChange({
      document: { uri: Uri.file(path.join(os.tmpdir(), 'unrelated.cpp')), isDirty: true, getText: () => 'int x;' }
    });
    assert.equal(messages.filter(message => message.type === 'state').length, statesBeforeTyping);
    const contributed = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')).contributes.commands.map(
      command => command.command
    );
    assert.deepEqual([...commands.keys()].sort(), contributed.sort());
    assert.equal(project().entries.length, 2);
    assert.equal(project().editor.installationPath, path.join(root, 'installation'));
    assert.equal(sidebarState().computer.integration, 'cpp');
    assert.equal(project().editor.integration, 'clangd');
    assert.equal(project().editor.indentSize, 2);
    assert.equal(project().editor.indentStyle, 'tabs');
    await settle(() => project().editorNeedsApply === true);
    // Computer preference changes never write generation, formatting, or editor files.
    const projectFiles = [
      'windhawk-amalgamation.json',
      '.vscode/settings.json',
      '.vscode/c_cpp_properties.json',
      '.clangd'
    ];
    const filesBeforePreferences = await Promise.all(projectFiles.map(file => fs.readFile(path.join(root, file))));
    await receive({
      action: 'computerPreferences',
      settings: {
        installationPath: path.join(root, 'installation'),
        elevation: 'none',
        gsudoPath: '',
        integration: 'clangd'
      }
    });
    // Computer preferences are user-level VS Code settings.
    assert.equal(vscodeSettings['wham.windhawkPath'], path.join(root, 'installation'));
    assert.equal(vscodeSettings['wham.languageService'], 'clangd');
    assert.equal(settingTargets['wham.languageService'], mock.ConfigurationTarget.Global);
    assert.equal(vscodeSettings['wham.elevation'], undefined, 'Defaults are not written');
    const savedComputer = structuredClone(vscodeSettings),
      closesBeforeCheck = elevationCloses;
    await receive({
      action: 'checkElevation',
      settings: {
        installationPath: path.join(root, 'installation'),
        elevation: 'gsudo',
        gsudoPath: 'fixture-gsudo',
        integration: 'cpp'
      }
    });
    assert.deepEqual(vscodeSettings, savedComputer, 'Checking elevation saves nothing');
    assert.equal(elevationCloses, closesBeforeCheck);
    const elevationSettings = {
      installationPath: path.join(root, 'installation'),
      elevation: 'gsudo',
      gsudoPath: 'fixture-gsudo',
      integration: 'clangd'
    };
    await receive({ action: 'computerPreferences', settings: elevationSettings });
    assert.equal(elevationCloses, closesBeforeCheck + 1);
    await receive({ action: 'computerPreferences', settings: elevationSettings });
    assert.equal(elevationCloses, closesBeforeCheck + 1, 'Unchanged preferences retain approval');
    await receive({ action: 'computerPreferences', settings: { ...elevationSettings, integration: 'cpp' } });
    assert.equal(elevationCloses, closesBeforeCheck + 1, 'Language service changes retain approval');
    await receive({
      action: 'computerPreferences',
      settings: {
        ...elevationSettings,
        installationPath: '"' + path.join(root, 'installation') + '"',
        gsudoPath: '"another-gsudo"'
      }
    });
    assert.equal(elevationCloses, closesBeforeCheck + 2);
    assert.equal(vscodeSettings['wham.windhawkPath'], path.join(root, 'installation'));
    assert.equal(vscodeSettings['wham.gsudoPath'], 'another-gsudo');
    assert.equal(vscodeSettings['wham.elevation'], 'gsudo');
    await receive({
      action: 'computerPreferences',
      settings: { ...elevationSettings, elevation: 'none', gsudoPath: '' }
    });
    const unconfiguredRoot = path.join(root, 'unconfigured');
    await fs.mkdir(path.join(unconfiguredRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(unconfiguredRoot, 'windhawk-amalgamation.json'), JSON.stringify(defaults));
    onFolders({ added: [{ uri: Uri.file(unconfiguredRoot) }], removed: [] });
    await settle(() => project(unconfiguredRoot)?.editor.integration === 'clangd');
    // Edits in the Settings editor apply too: a new default language service, and a new
    // elevation method closing the previous approval.
    const closesBeforeHandEdit = elevationCloses;
    await mock.workspace.getConfiguration('wham').update('languageService', 'both', mock.ConfigurationTarget.Global);
    await settle(() => project(unconfiguredRoot)?.editor.integration === 'both');
    assert.equal(project().editor.integration, 'clangd');
    await assert.rejects(fs.stat(path.join(unconfiguredRoot, '.vscode')), { code: 'ENOENT' });
    await assert.rejects(fs.stat(path.join(unconfiguredRoot, '.clangd')), { code: 'ENOENT' });
    await mock.workspace.getConfiguration('wham').update('elevation', 'sudo', mock.ConfigurationTarget.Global);
    await settle(() => project().elevation === 'sudo');
    assert.equal(elevationCloses, closesBeforeHandEdit + 1);
    await mock.workspace.getConfiguration('wham').update('elevation', 'none', mock.ConfigurationTarget.Global);
    await mock.workspace.getConfiguration('wham').update('languageService', 'clangd', mock.ConfigurationTarget.Global);
    const normalComputerSettings = { ...elevationSettings, elevation: 'none', gsudoPath: '' };
    await receive({ action: 'computerPreferences', settings: normalComputerSettings });
    await t.test('a failed computer save applies successful writes and concurrent Settings edits', async () => {
      beforeSettingWrite = async key => {
        if (key !== 'gsudoPath') return;
        await mock.workspace
          .getConfiguration('wham')
          .update('languageService', 'both', mock.ConfigurationTarget.Global);
        throw new Error('User settings changed while WHAM was saving');
      };
      const closesBeforeRejectedSave = elevationCloses;
      await receive({ action: 'computerPreferences', settings: elevationSettings });
      beforeSettingWrite = undefined;
      try {
        assert.equal(messages.at(-1).type, 'error');
        assert.equal(project(unconfiguredRoot)?.editor.integration, 'both');
        assert.equal(elevationCloses, closesBeforeRejectedSave + 1);
      } finally {
        await receive({ action: 'computerPreferences', settings: normalComputerSettings });
      }
    });
    await t.test('opening a project respects an explicitly cleared Windhawk installation', async openingTest => {
      await mock.workspace.getConfiguration('wham').update('windhawkPath', '', mock.ConfigurationTarget.Global);
      const copiedRoot = path.join(root, 'copied');
      await fs.mkdir(copiedRoot);
      await fs.cp(path.join(root, '.vscode'), path.join(copiedRoot, '.vscode'), { recursive: true });
      await fs.writeFile(path.join(copiedRoot, 'windhawk-amalgamation.json'), JSON.stringify(defaults));
      onFolders({ added: [{ uri: Uri.file(copiedRoot) }], removed: [] });
      try {
        await settle(
          () => project(copiedRoot)?.git !== undefined || project(copiedRoot)?.editorNeedsApply !== undefined
        );
        assert.equal(vscodeSettings['wham.windhawkPath'], '');
        assert.equal(project(copiedRoot).editor.installationPath, '');
        await openingTest.test('a rejected automatic installation write still allows the project to load', async () => {
          onFolders({ added: [], removed: [{ uri: Uri.file(copiedRoot) }] });
          delete vscodeSettings['wham.windhawkPath'];
          beforeSettingWrite = async key => {
            if (key === 'windhawkPath') throw new Error('Cannot write invalid user settings');
          };
          try {
            onFolders({ added: [{ uri: Uri.file(copiedRoot) }], removed: [] });
            await settle(() => project(copiedRoot)?.editorNeedsApply !== undefined);
            assert.equal(project(copiedRoot).editor.installationPath, '');
          } finally {
            beforeSettingWrite = undefined;
          }
        });
      } finally {
        onFolders({ added: [], removed: [{ uri: Uri.file(copiedRoot) }] });
        await receive({ action: 'computerPreferences', settings: normalComputerSettings });
      }
    });
    onFolders({ added: [], removed: [{ uri: Uri.file(unconfiguredRoot) }] });
    await t.test('an earlier runtime poll cannot overwrite a new Windhawk installation', async () => {
      const oldInstallation = normalComputerSettings.installationPath;
      const newInstallation = path.join(root, 'new-installation');
      const cli = path.join(oldInstallation, 'windhawk-cli.exe');
      await fs.mkdir(newInstallation);
      await fs.copyFile(path.join(oldInstallation, 'windhawk.ini'), path.join(newInstallation, 'windhawk.ini'));
      await fs.writeFile(cli, 'fixture');
      let releasePoll;
      const inspected = new Promise(resolve => {
        beforeInspectInstallation = async installation => {
          if (installation !== oldInstallation) return;
          beforeInspectInstallation = undefined;
          await new Promise(release => {
            releasePoll = release;
            resolve();
          });
        };
      });
      try {
        onWindowStateChange({ focused: true });
        await inspected;
        const saving = receive({
          action: 'computerPreferences',
          settings: { ...normalComputerSettings, installationPath: newInstallation }
        });
        // Let an unqueued save finish before the older poll gets its result back.
        await Promise.race([saving, new Promise(resolve => setTimeout(resolve, 1500))]);
        releasePoll();
        await saving;
        await receive({ action: 'generate', root, entry: path.join(root, 'src/one.cpp') });
        assert.equal(project().windhawk.root, newInstallation);
        assert.equal(project().editor.installationPath, newInstallation);
      } finally {
        releasePoll?.();
        beforeInspectInstallation = undefined;
        await fs.unlink(cli);
        await receive({ action: 'computerPreferences', settings: normalComputerSettings });
      }
    });
    await t.test('installed-mod operations use matching settings while projects refresh', async () => {
      const oldInstallation = normalComputerSettings.installationPath;
      const newInstallation = path.join(root, 'settings-race-installation');
      const runtimeRoot = path.join(root, 'settings-race-project');
      const entry = path.join(runtimeRoot, 'src/mod.cpp');
      await fs.mkdir(path.dirname(entry), { recursive: true });
      await fs.writeFile(path.join(runtimeRoot, 'windhawk-amalgamation.json'), JSON.stringify(defaults));
      await fs.writeFile(
        entry,
        '// ==WindhawkMod==\n// @id settings-race\n// @name Settings race\n// @version 1.0\n// ==/WindhawkMod==\nint mod;\n'
      );
      await fs.mkdir(newInstallation);
      await fs.copyFile(path.join(oldInstallation, 'windhawk.ini'), path.join(newInstallation, 'windhawk.ini'));
      const newElevation = { elevation: 'gsudo', gsudoPath: 'new-gsudo' };
      const releaseProbes = [];
      let saving;
      runtimeCalls = [];
      try {
        onFolders({ added: [{ uri: Uri.file(runtimeRoot) }], removed: [] });
        await settle(() => project(runtimeRoot)?.entries[0]?.runtime.installed);
        beforeInspectInstallation = async installation => {
          if (installation === newInstallation) await new Promise(resolve => releaseProbes.push(resolve));
        };
        saving = receive({
          action: 'computerPreferences',
          settings: { ...normalComputerSettings, installationPath: newInstallation, ...newElevation }
        });
        const compile = () => receive({ action: 'compile', root: runtimeRoot, entry });
        const toggle = enabled => receive({ action: 'enable', root: runtimeRoot, entry, enabled });
        // Hold the first project's refresh so the next project still has its old installation.
        await settle(() => releaseProbes.length === 1);
        await toggle(true);
        await toggle(false);
        await compile();
        releaseProbes[0]();
        // Start operations again while this project's new installation is being detected.
        await settle(() => releaseProbes.length === 2);
        await toggle(true);
        await toggle(false);
        const compiling = compile();
        beforeInspectInstallation = undefined;
        releaseProbes[1]();
        await Promise.all([saving, compiling]);
        await toggle(true);
        const oldElevation = { elevation: 'none', gsudoPath: '' };
        await receive({
          action: 'computerPreferences',
          settings: { ...normalComputerSettings, installationPath: newInstallation }
        });
        await toggle(false);
        const oldCalls = ['enable', 'disable', 'install'].map(action => ({
          root: oldInstallation,
          action,
          elevation: oldElevation
        }));
        assert.deepEqual(runtimeCalls, [
          ...oldCalls,
          ...oldCalls,
          { root: newInstallation, action: 'enable', elevation: newElevation },
          { root: newInstallation, action: 'disable', elevation: oldElevation }
        ]);
      } finally {
        beforeInspectInstallation = undefined;
        for (const release of releaseProbes) release();
        await saving;
        onFolders({ added: [], removed: [{ uri: Uri.file(runtimeRoot) }] });
        runtimeCalls = undefined;
        await receive({ action: 'computerPreferences', settings: normalComputerSettings });
      }
    });
    const filesAfterPreferences = await Promise.all(projectFiles.map(file => fs.readFile(path.join(root, file))));
    assert.deepEqual(filesAfterPreferences, filesBeforePreferences);
    const settingsFile = path.join(root, '.vscode/settings.json');
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        ...JSON.parse(filesBeforePreferences[1]),
        'C_Cpp.intelliSenseEngine': 'default',
        'clangd.enable': false
      })
    );
    watchers[0].change(Uri.file(settingsFile));
    await settle(() => project().editor.integration === 'cpp');
    await receive({ action: 'select', root });
    assert.match(project().entries[0].metadata.diagnostics[0].message, /No Windhawk/);
    const one = path.join(root, 'src/one.cpp'),
      oneOutput = path.join(root, 'output/one.wh.cpp'),
      twoOutput = path.join(root, 'output/two.wh.cpp');
    const shared = path.join(root, 'src/shared.h');
    const third = path.join(root, 'src/third.cpp'),
      thirdOutput = path.join(root, 'output/third.wh.cpp'),
      privateHeader = path.join(root, 'src/private.h'),
      nestedHeader = path.join(root, 'src/nested.h');
    await fs.writeFile(third, '#include "private.h"\n');
    await fs.writeFile(privateHeader, '#include "nested.h"\n');
    await fs.writeFile(nestedHeader, 'int private_value = 1;\n');
    watchers[0].create(Uri.file(third));
    await settle(() => project()?.entries.length === 3 && project().entries.every(entry => entry.status === 'current'));
    await new Promise(resolve => setTimeout(resolve, 450));
    generations.clear();
    const discoveryBeforeSave = { loads: projectLoads, scans: entryScans };
    sourceReads.clear();
    // A typing refresh scheduled before Save is consumed by the generation batch.
    const savedSource = {
      uri: Uri.file(one),
      isDirty: true,
      getText: () => '#include "shared.h"\n// only this entry changed\n'
    };
    documents.push(savedSource);
    onChange({ document: savedSource });
    documents.length = 0;
    await fs.appendFile(one, '// only this entry changed\n');
    onSave({ uri: Uri.file(one) });
    watchers[0].change(Uri.file(one));
    await settle(async () => (await fs.readFile(oneOutput, 'utf8')).includes('only this entry changed'));
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(generations.get(one));
    assert.equal(generations.get(path.join(root, 'src/two.cpp')), undefined);
    assert.equal(generations.get(third), undefined, 'Independent mods are not expanded after a .cpp save');
    assert.deepEqual(
      { loads: projectLoads, scans: entryScans },
      discoveryBeforeSave,
      'Ordinary saves do not reload config or rescan entry files'
    );
    assert.ok(
      sourceReads.get(one) <= 3,
      `Save and typing share one Draft reconciliation (entry reads: ${sourceReads.get(one)})`
    );
    assert.equal(sourceReads.get(third), undefined, 'Unrelated entry source is not reread');
    generations.clear();
    const outputTime = (await fs.stat(oneOutput)).mtimeMs;
    const future = new Date(Date.now() + 2000);
    await fs.utimes(shared, future, future);
    onSave({ uri: Uri.file(shared) });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(generations.size, 0, 'Timestamp-only changes reuse expansions');
    assert.equal((await fs.stat(oneOutput)).mtimeMs, outputTime);
    // Transitive dependencies affect just the owning mod, even when timestamps are preserved.
    const previousStat = await fs.stat(nestedHeader);
    await fs.writeFile(nestedHeader, 'int private_value = 2;\n');
    await fs.utimes(nestedHeader, previousStat.atime, previousStat.mtime);
    watchers[0].change(Uri.file(nestedHeader));
    await settle(async () => (await fs.readFile(thirdOutput, 'utf8')).includes('private_value = 2'));
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok(generations.get(third));
    assert.equal(generations.get(one), undefined);
    assert.equal(generations.get(path.join(root, 'src/two.cpp')), undefined);
    generations.clear();
    await fs.writeFile(shared, '#pragma once\nint shared = 9;\n');
    onSave({ uri: Uri.file(shared) });
    await settle(
      async () =>
        (await fs.readFile(oneOutput, 'utf8')).includes('shared = 9') &&
        (await fs.readFile(twoOutput, 'utf8')).includes('shared = 9')
    );
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(generations.get(third), undefined, 'Shared headers do not affect independent mods');
    await fs.rm(third);
    watchers[0].delete(Uri.file(third));
    await settle(() => project()?.entries.length === 2);

    await fs.writeFile(shared, '#pragma once\nint shared = 2;\n');
    onSave({ uri: Uri.file(shared) });
    watchers[0].change(Uri.file(shared));
    await settle(
      async () =>
        (await fs.readFile(oneOutput, 'utf8')).includes('shared = 2') &&
        (await fs.readFile(twoOutput, 'utf8')).includes('shared = 2')
    );
    // A generated-output watcher event does not enqueue generation.
    const owned = await fs.readFile(oneOutput);
    watchers[0].change(Uri.file(oneOutput));
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(await fs.readFile(oneOutput), owned);
    await fs.writeFile(oneOutput, owned.toString().replace('shared = 2', 'shared = 99'));
    watchers[0].change(Uri.file(oneOutput));
    await fs.writeFile(shared, '#pragma once\nint shared = 3;\n');
    onSave({ uri: Uri.file(shared) });
    await settle(
      async () =>
        project()?.entries.find(entry => entry.path === one)?.status === 'blocked' &&
        (await fs.readFile(twoOutput, 'utf8')).includes('shared = 3')
    );
    assert.ok((await fs.readFile(oneOutput, 'utf8')).includes('shared = 99'));
    assert.ok(restoreSource(await fs.readFile(oneOutput)).files.get('src/shared.h')[0].changed);
    // Dirty output buffers are protected even when disk output is unchanged.
    const dirty = { uri: Uri.file(twoOutput), isDirty: true };
    documents.push(dirty);
    onChange({ document: dirty });
    await fs.writeFile(shared, '#pragma once\nint shared = 4;\n');
    onSave({ uri: Uri.file(shared) });
    await settle(() => project()?.entries.find(entry => entry.path !== one)?.status === 'blocked');
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 3'));
    documents.length = 0;
    // Manual mode from the sidebar goes to this project's folder settings, not the project
    // file, and suppresses source-save writes.
    const configBefore = await fs.readFile(path.join(root, 'windhawk-amalgamation.json'));
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10, generate: 'manual' } });
    assert.equal(vscodeSettings['wham.generate'], 'manual');
    assert.equal(settingTargets['wham.generate'], mock.ConfigurationTarget.WorkspaceFolder);
    assert.equal(vscodeSettings['wham.debounceMs'], undefined, 'An unchanged debounce is not written');
    assert.deepEqual(await fs.readFile(path.join(root, 'windhawk-amalgamation.json')), configBefore);
    assert.equal(project().config.generate, 'manual');
    const manualOutput = await fs.readFile(twoOutput);
    await fs.writeFile(shared, '#pragma once\nint shared = 5;\n');
    onSave({ uri: Uri.file(shared) });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(await fs.readFile(twoOutput), manualOutput, 'Manual source saves do not write output');
    const two = path.join(root, 'src/two.cpp');
    await fs.appendFile(two, '// saved in manual mode\n');
    onSave({ uri: Uri.file(two) });
    await settle(() => project()?.entries.find(entry => entry.path === two)?.status === 'stale');
    const metadataSource =
      '// ==WindhawkMod==\n// @id two\n// @name Second Mod\n// @version 1.0\n// ==/WindhawkMod==\n#include "shared.h"\n';
    await fs.writeFile(two, metadataSource);
    onSave({ uri: Uri.file(two) });
    await settle(
      () => project()?.entries.find(entry => entry.path === two)?.metadata.fields.name?.[0] === 'Second Mod'
    );
    const dirtySource = {
      uri: Uri.file(two),
      isDirty: true,
      getText: () => metadataSource.replace('Second Mod', 'Unsaved Name')
    };
    documents.push(dirtySource);
    onChange({ document: dirtySource });
    assert.equal(project().entries.find(entry => entry.path === two).metadata.fields.name[0], 'Unsaved Name');
    documents.length = 0;
    await receive({ action: 'generate', root, entry: path.join(root, 'src/two.cpp') });
    assert.ok((await fs.readFile(twoOutput, 'utf8')).includes('shared = 5'));
    // A failed resolution is retried when the missing header appears.
    await fs.writeFile(path.join(root, 'src/new.cpp'), '#include "missing.h"\n');
    watchers[0].create(Uri.file(path.join(root, 'src/new.cpp')));
    // Back to After save: the new entry is discovered and generated, and fails on its missing header.
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10 } });
    await settle(() => project()?.entries.find(entry => entry.path.endsWith('new.cpp'))?.status === 'stale');
    await fs.writeFile(path.join(root, 'src/missing.h'), 'int found;\n');
    watchers[0].create(Uri.file(path.join(root, 'src/missing.h')));
    await settle(async () => {
      try {
        return (await fs.readFile(path.join(root, 'output/new.wh.cpp'), 'utf8')).includes('int found');
      } catch {
        return false;
      }
    });
    // Deleting entries removes only unchanged outputs with established ownership.
    await fs.rm(path.join(root, 'src/new.cpp'));
    watchers[0].delete(Uri.file(path.join(root, 'src/new.cpp')));
    await settle(async () => {
      try {
        await fs.stat(path.join(root, 'output/new.wh.cpp'));
        return false;
      } catch {
        return true;
      }
    });
    await fs.rm(one);
    watchers[0].delete(Uri.file(one));
    await settle(() => project()?.entries.length === 1);
    assert.ok((await fs.readFile(oneOutput, 'utf8')).includes('shared = 99'));
    await t.test('a rejected timing migration leaves the legacy config on disk', async () => {
      const configFile = path.join(root, 'windhawk-amalgamation.json');
      const legacyConfig = await fs.readFile(configFile, 'utf8');
      beforeSettingWrite = async key => {
        if (key === 'debounceMs') throw new Error('User settings has unsaved changes');
      };
      try {
        await receive({ action: 'config', root, config: { ...project().config, inlineAngleIncludes: true } });
        assert.equal(messages.at(-1).type, 'error');
        assert.equal(await fs.readFile(configFile, 'utf8'), legacyConfig);
      } finally {
        beforeSettingWrite = undefined;
        if ((await fs.readFile(configFile, 'utf8')) !== legacyConfig) {
          await fs.writeFile(configFile, legacyConfig);
          watchers[0].change(Uri.file(configFile));
          await settle(() => project().config.inlineAngleIncludes === false);
        }
      }
    });
    // A new output directory is ignored like the one setup created; existing rules stay.
    await t.test('a rejected ignore rule leaves the existing layout on disk', async () => {
      const ignoreFile = path.join(root, '.gitignore');
      const previousIgnore = await fs.readFile(ignoreFile).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (previousIgnore) await fs.unlink(ignoreFile);
      await fs.mkdir(ignoreFile);
      const configFile = path.join(root, 'windhawk-amalgamation.json');
      const layoutBeforeFailedMove = await fs.readFile(configFile, 'utf8');
      await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10, outputDirectory: 'build' } });
      await fs.rmdir(ignoreFile);
      if (previousIgnore) await fs.writeFile(ignoreFile, previousIgnore);
      assert.equal(messages.at(-1).type, 'error');
      assert.equal(await fs.readFile(configFile, 'utf8'), layoutBeforeFailedMove);
    });
    await t.test('moving output adds a literal ignore rule for brackets in the directory name', async () => {
      await receive({
        action: 'config',
        root,
        config: { ...defaults, debounceMs: 10, outputDirectory: 'build[local]' }
      });
      assert.match(await fs.readFile(path.join(root, '.gitignore'), 'utf8'), /\/build\\\[local\\\]\//);
    });
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10, outputDirectory: 'build' } });
    await receive({ action: 'config', root, config: { ...defaults, debounceMs: 10 } });
    const ignoreLines = (await fs.readFile(path.join(root, '.gitignore'), 'utf8')).split(/\r?\n/);
    assert.ok(ignoreLines.includes('/build/'));
    assert.equal(ignoreLines.filter(line => line === '/output/').length, 1);
    // Rewriting the layout drops the file's timing; the settings keep the timing that was in effect.
    const rewritten = JSON.parse(await fs.readFile(path.join(root, 'windhawk-amalgamation.json')));
    assert.ok(!('generate' in rewritten) && !('debounceMs' in rewritten));
    assert.equal(vscodeSettings['wham.debounceMs'], 10);
    assert.equal(settingTargets['wham.debounceMs'], mock.ConfigurationTarget.Global);
    assert.equal(project().config.debounceMs, 10);
    await t.test(
      'timing settings preserve the debounce and refresh Draft after switching to Manual',
      async timingTest => {
        const configuration = mock.workspace.getConfiguration('wham');
        const originalSource = await fs.readFile(two, 'utf8');
        const before = await fs.readFile(twoOutput);
        await configuration.update('debounceMs', 10000, mock.ConfigurationTarget.Workspace);
        await fs.writeFile(two, originalSource.replace('Second Mod', 'Debounce Changed'));
        onSave({ uri: Uri.file(two) });
        await configuration.update('debounceMs', 9000, mock.ConfigurationTarget.Workspace);
        try {
          await timingTest.test('changing just the debounce does not generate a waiting save immediately', async () => {
            await new Promise(resolve => setTimeout(resolve, 450));
            assert.deepEqual(await fs.readFile(twoOutput), before);
          });
          const beforeManual = await fs.readFile(twoOutput);
          await fs.writeFile(two, originalSource.replace('Second Mod', 'Saved During Debounce'));
          onSave({ uri: Uri.file(two) });
          await commands.get('windhawk.toggleOnSave')();
          await settle(() => project().entries[0].metadata.fields.name[0] === 'Saved During Debounce');
          assert.deepEqual(await fs.readFile(twoOutput), beforeManual);
        } finally {
          delete workspaceSettings['wham.debounceMs'];
          await fs.writeFile(two, originalSource);
          onSave({ uri: Uri.file(two) });
          await receive({ action: 'generate', root, entry: two });
          await commands.get('windhawk.toggleOnSave')();
        }
      }
    );
    await t.test('a single-folder workspace can save its window-scoped debounce override', async () => {
      await mock.workspace.getConfiguration('wham').update('debounceMs', 30, mock.ConfigurationTarget.Workspace);
      try {
        await receive({ action: 'config', root, config: { ...project().config, debounceMs: 40 } });
        assert.equal(workspaceSettings['wham.debounceMs'], 40);
        assert.equal(settingTargets['wham.debounceMs'], mock.ConfigurationTarget.Workspace);
      } finally {
        delete workspaceSettings['wham.debounceMs'];
      }
    });
    // The command flips this project's setting.
    await commands.get('windhawk.toggleOnSave')();
    assert.equal(vscodeSettings['wham.generate'], 'manual');
    await commands.get('windhawk.toggleOnSave')();
    assert.equal(vscodeSettings['wham.generate'], 'onSave');
    // Command actions go directly to the only mod.
    mock.window.showQuickPick = async () => {
      throw new Error('A single mod does not need a picker');
    };
    let directDiffs = 0;
    mock.commands.executeCommand = async command => {
      if (command === 'vscode.diff') directDiffs++;
    };
    await commands.get('windhawk.compare')();
    assert.equal(directDiffs, 1);
    await commands.get('windhawk.verify')();
    assert.equal(singleVerifies, 1);
    // Cancelling a button choice leaves the selected folder untouched.
    const canceledRoot = path.join(root, 'canceled-setup');
    await fs.mkdir(canceledRoot);
    mock.window.showOpenDialog = async () => [Uri.file(canceledRoot)];
    mock.window.showQuickPick = async () => {
      throw new Error('Fixed setup choices must not have a search input');
    };
    let canceledDialog;
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (options?.modal) canceledDialog = { message, choices };
      return undefined;
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: false });
    assert.equal(canceledDialog.message, 'New project location');
    assert.deepEqual(canceledDialog.choices, ['Create folder', 'Use empty folder']);
    assert.deepEqual(await fs.readdir(canceledRoot), []);
    // Setup completes editor configuration before switching folders; preferences survive the switch.
    const newRoot = path.join(root, 'new-project');
    await fs.mkdir(newRoot);
    mock.window.showOpenDialog = async () => [Uri.file(newRoot)];
    mock.window.showQuickPick = async () => {
      throw new Error('Fixed setup choices must use buttons');
    };
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (!options?.modal) return;
      assert.equal(options.modal, true);
      const titles = choices.map(choice => (typeof choice === 'string' ? choice : choice.title));
      const title = titles.includes('Use empty folder')
        ? 'Use empty folder'
        : titles.includes('Customize…')
          ? 'Customize…'
          : titles.includes('Indentation only')
            ? 'Indentation only'
            : '2 spaces';
      return choices[titles.indexOf(title)];
    };
    const opened = [];
    mock.commands.executeCommand = async (...args) => {
      if (args[0] === 'vscode.openFolder') {
        assert.equal(
          JSON.parse(await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8'))['[cpp]']['editor.tabSize'],
          messages
            .filter(message => message.type === 'state')
            .at(-1)
            .projects.find(project => project.root === newRoot).editor.indentSize
        );
        assert.ok((await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8')).includes('editor.tabSize'));
        opened.push(args);
      }
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: true });
    assert.equal(opened.length, 1, JSON.stringify(messages.filter(message => message.type === 'error').slice(-2)));
    assert.equal(opened[0][1].fsPath, newRoot);
    assert.equal(opened[0][2], false);
    assert.equal(globalStored.recentProjects[0], newRoot);
    const loadedProjects = messages.filter(message => message.type === 'state').at(-1).projects;
    assert.ok(
      loadedProjects.every(project => project.editor.installationPath === path.join(root, 'installation')),
      'Every project uses the global installation, including indentation-only setup'
    );
    const editorProject = () => project(newRoot);
    assert.equal(editorProject().editor.integration, 'clangd', 'Indentation-only setup uses the computer default');
    // Default Apply reuses the summary, without installation or indentation prompts.
    const setupDialogs = [];
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (!options?.modal) return;
      setupDialogs.push(message);
      assert.equal(message, 'Set up the editor?');
      assert.match(options.detail, /Windhawk: .*installation\nLanguage service: clangd\nIndentation: 2 spaces/);
      assert.deepEqual(
        choices.map(choice => choice.title),
        ['Apply', 'Customize…', 'Skip']
      );
      return choices[0];
    };
    await commands.get('windhawk.configureEditor')();
    assert.deepEqual(setupDialogs, ['Set up the editor?']);
    const beforeSkip = await fs.readFile(path.join(newRoot, '.vscode/settings.json'));
    mock.window.showInformationMessage = async (message, options, ...choices) =>
      choices.find(choice => choice.title === 'Skip');
    await commands.get('windhawk.configureEditor')();
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.vscode/settings.json')), beforeSkip);
    // Customize changes the service and indentation, with no final confirmation.
    const customDialogs = [];
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      customDialogs.push(message);
      const title =
        message === 'Set up the editor?'
          ? 'Customize…'
          : message === 'Choose language service'
            ? 'Microsoft C/C++'
            : 'Tabs';
      return choices.find(choice => choice.title === title);
    };
    mock.window.showQuickPick = async choices => choices[0];
    await commands.get('windhawk.configureEditor')();
    assert.deepEqual(customDialogs, ['Set up the editor?', 'Choose language service', 'Choose indentation']);
    assert.equal(editorProject().editor.integration, 'cpp');
    const customized = JSON.parse(await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8'))['[cpp]'];
    assert.equal(customized['editor.insertSpaces'], false);
    assert.equal(customized['editor.tabSize'], 2, 'Tabs preserve the existing display width');
    // Apply is direct; Review opens a diff without changing the files or the reported service.
    const settings = {
      ...require('../dist/setup').editorDefaults,
      indentSize: 4
    };
    mock.window.showQuickPick = async () => {
      throw new Error('Apply must not ask for a second confirmation');
    };
    await receive({ action: 'editor', root: newRoot, settings });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8'))['[cpp]']['editor.tabSize'],
      4
    );
    assert.equal(editorProject().editorNeedsApply, false, 'A complete applied configuration has no pending work');
    await fs.unlink(path.join(newRoot, '.vscode/c_cpp_properties.json'));
    watchers
      .find(watcher => watcher.root === newRoot)
      .delete(Uri.file(path.join(newRoot, '.vscode/c_cpp_properties.json')));
    await settle(() => editorProject().editorNeedsApply === true);
    await receive({ action: 'editor', root: newRoot, settings });
    assert.equal(
      editorProject().editorNeedsApply,
      false,
      'Apply restores missing configuration without requiring a field edit'
    );
    const beforeReview = await fs.readFile(path.join(newRoot, '.vscode/settings.json'));
    let reviewDiffs = 0;
    const executeBeforeReview = mock.commands.executeCommand;
    mock.commands.executeCommand = async (command, ...args) => {
      if (command === 'vscode.diff') reviewDiffs++;
      else await executeBeforeReview(command, ...args);
    };
    mock.window.showQuickPick = async (choices, options) => {
      assert.equal(options.title, 'Review editor changes');
      assert.ok(!choices.includes('Apply reviewed editor settings'));
      return choices[0];
    };
    const savedBeforeReview = messages.filter(message => message.type === 'editorSaved').length;
    await receive({
      action: 'reviewEditor',
      root: newRoot,
      settings: { ...settings, integration: 'clangd', indentSize: 3 }
    });
    assert.equal(editorProject().editor.integration, 'cpp');
    assert.equal(reviewDiffs, 1);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.vscode/settings.json')), beforeReview);
    assert.equal(messages.filter(message => message.type === 'editorSaved').length, savedBeforeReview);
    documents.push({ uri: Uri.file(path.join(newRoot, '.vscode/settings.json')), isDirty: true });
    await receive({ action: 'editor', root: newRoot, settings: { ...settings, indentSize: 3 } });
    documents.length = 0;
    assert.match(messages.at(-1).message, /Save or revert/);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.vscode/settings.json')), beforeReview);
    await receive({ action: 'editor', root: newRoot, settings: { ...settings, integration: 'clangd' } });
    const appliedSettings = JSON.parse(await fs.readFile(path.join(newRoot, '.vscode/settings.json'), 'utf8'));
    assert.equal(appliedSettings['clangd.enable'], true);
    assert.equal(appliedSettings['C_Cpp.intelliSenseEngine'], 'disabled');
    assert.match(await fs.readFile(path.join(newRoot, '.clangd'), 'utf8'), /WHAM editor configuration begin/);
    assert.equal(editorProject().editor.integration, 'clangd');
    assert.equal(editorProject().editorNeedsApply, false);
    await t.test('Apply offers to untrack local editor files only when Git tracks them', async () => {
      const git = process.env.WHAM_TEST_GIT || 'git';
      const gitRun = (...args) => execFileSync(git, ['-C', newRoot, ...args], { encoding: 'utf8', stdio: 'pipe' });
      const file = '.vscode/settings.json',
        settingsFile = path.join(newRoot, file),
        unrelated = 'unrelated.txt';
      const apply = { action: 'editor', root: newRoot, settings: { ...settings, integration: 'clangd' } };
      const warnings = [];
      let answerWarning;
      const originalWarning = mock.window.showWarningMessage;
      editorGitChecks = [];
      mock.window.showWarningMessage = (message, ...buttons) => {
        warnings.push({ message, buttons });
        return new Promise(resolve => (answerWarning = resolve));
      };
      try {
        await receive(apply);
        assert.deepEqual(await editorGitChecks.at(-1), []);
        assert.equal(warnings.length, 0, 'An untracked editor file does not trigger a warning');
        gitRun('add', '-f', '--', file);
        gitRun(
          '-c',
          'user.name=WHAM Test',
          '-c',
          'user.email=wham-test@example.invalid',
          '-c',
          'commit.gpgsign=false',
          '-c',
          `core.hooksPath=${path.join(newRoot, 'empty-hooks')}`,
          'commit',
          '-m',
          'Track editor settings',
          '--',
          file
        );
        await fs.writeFile(path.join(newRoot, unrelated), 'keep staged\n');
        gitRun('add', '--', unrelated);
        const cachedBefore = gitRun('diff', '--cached');
        const statusBefore = gitRun('status', '--porcelain=v1', '--untracked-files=all');
        const settingsBefore = await fs.readFile(settingsFile);
        await receive({ ...apply, action: 'reviewEditor', settings: { ...apply.settings, indentSize: 3 } });
        assert.equal(editorGitChecks.length, 1, 'Review never checks for tracked files');
        assert.equal(warnings.length, 0);

        vscodeSettings['git.path'] = path.join(newRoot, 'missing-git.exe');
        await receive(apply);
        assert.deepEqual(await editorGitChecks.at(-1), []);
        assert.equal(warnings.length, 0, 'An unavailable configured Git executable does not trigger a warning');
        vscodeSettings['git.path'] = git;

        const saved = messages.filter(message => message.type === 'editorSaved').length;
        await receive(apply);
        assert.deepEqual(await editorGitChecks.at(-1), [file]);
        assert.equal(messages.filter(message => message.type === 'editorSaved').length, saved + 1);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0].message, /\.vscode\/settings\.json.*this computer's Windhawk paths/);
        assert.deepEqual(warnings[0].buttons, ['Stop tracking']);
        answerWarning(undefined);
        assert.equal(gitRun('status', '--porcelain=v1', '--untracked-files=all'), statusBefore);
        assert.equal(gitRun('diff', '--cached'), cachedBefore);
        assert.deepEqual(await fs.readFile(settingsFile), settingsBefore);

        await receive(apply);
        assert.deepEqual(await editorGitChecks.at(-1), [file]);
        assert.equal(warnings.length, 2);
        const changesBefore = editorProject().git.changes;
        answerWarning('Stop tracking');
        await settle(() => editorProject().git.changes === changesBefore + 1);
        assert.equal(gitRun('ls-files', '--', file), '');
        assert.equal(gitRun('status', '--porcelain=v1', '--untracked-files=all'), `D  ${file}\n${statusBefore}`);
        assert.equal(gitRun('diff', '--cached', '--', unrelated), cachedBefore);
        assert.deepEqual(await fs.readFile(settingsFile), settingsBefore);

        await receive({ ...apply, root });
        assert.deepEqual(await editorGitChecks.at(-1), []);
        assert.equal(warnings.length, 2, 'A project outside Git does not trigger a warning');
      } finally {
        answerWarning?.(undefined);
        editorGitChecks = undefined;
        mock.window.showWarningMessage = originalWarning;
        delete vscodeSettings['git.path'];
      }
    });
    // Two conflicting recovery copies compare directly without left/right pickers.
    let conflictPicks = 0,
      copyDiffs = 0;
    mock.window.showOpenDialog = async () => [Uri.file(oneOutput), Uri.file(twoOutput)];
    mock.window.showQuickPick = async (choices, options) => {
      assert.match(options.title, /Resolve conflicting/);
      return conflictPicks++ === 0 ? choices.find(choice => choice.compare) : undefined;
    };
    mock.commands.executeCommand = async command => {
      if (command === 'vscode.diff') copyDiffs++;
    };
    await receive({ action: 'initialize', mode: 'Recover one or more .wh.cpp files', openProject: false });
    assert.equal(copyDiffs, 1);
    assert.equal(conflictPicks, 2);
    // No installations means Browse goes directly to the folder dialog.
    noInstallations = true;
    let folderPick = 0;
    mock.window.showQuickPick = async () => {
      throw new Error('A lone Browse option is unnecessary');
    };
    mock.window.showOpenDialog = async () => {
      folderPick++;
      return [Uri.file(path.join(root, 'installation'))];
    };
    await receive({ action: 'browseComputerInstallation' });
    assert.equal(folderPick, 1);
    assert.equal(messages.at(-1).type, 'computerInstallation');
    noInstallations = false;
    mock.commands.executeCommand = executeBeforeReview;
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
    assert.equal(opened.length, 2);
    assert.deepEqual(pickerTitles, ['Open WHAM project']);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.vscode/settings.json')), beforeSettings);
    assert.deepEqual(await fs.readFile(path.join(newRoot, '.gitignore')), beforeIgnore);
    const dropdownChoices = messages.filter(message => message.type === 'state').at(-1).projectChoices;
    const beforeOpenCount = opened.length;
    mock.window.showQuickPick = async () => {
      throw new Error('Dropdown selection must not show another picker');
    };
    await receive({ action: 'openProject', projectRoot: newRoot });
    assert.equal(opened.length, beforeOpenCount + 1);
    assert.equal(opened.at(-1)[1].fsPath, newRoot);
    assert.equal(dropdownChoices.at(-1).label, 'Browse for a project folder…');
    assert.equal(dropdownChoices[0].root, newRoot);
    // Cold boot uses global history, without loading recent folders as active projects.
    for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    mock.workspace.workspaceFolders = [];
    delete stored.additionalRoots;
    const movedRoot = path.join(root, 'moved-project');
    globalStored.recentProjects.push(movedRoot);
    await extension.activate(context);
    provider.resolveWebviewView({
      webview: {
        cspSource: 'test-resource:',
        asWebviewUri: uri => uri.toString(),
        postMessage: async message => {
          messages.push(message);
        },
        onDidReceiveMessage(fn) {
          receive = fn;
          return disposable();
        }
      }
    });
    assert.equal(messages.filter(message => message.type === 'state').at(-1).projects.length, 0);
    mock.commands.executeCommand = async (...args) => {
      if (args[0] === 'vscode.openFolder') opened.push(args);
    };
    mock.window.showQuickPick = async choices => {
      assert.deepEqual(choices, dropdownChoices);
      return choices[0];
    };
    await commands.get('windhawk.openProject')();
    assert.equal(opened.at(-1)[1].fsPath, newRoot);
    assert.ok(!globalStored.recentProjects.includes(movedRoot));
    // Recovery can create an initial commit, but never commits into an existing repo.
    const recoveredRoot = path.join(root, 'recovered-project');
    await fs.mkdir(recoveredRoot);
    const git = process.env.WHAM_TEST_GIT || 'git';
    const gitRun = (...args) => execFileSync(git, ['-C', recoveredRoot, ...args], { encoding: 'utf8', stdio: 'pipe' });
    mock.window.showOpenDialog = async options => [Uri.file(options.filters ? twoOutput : recoveredRoot)];
    mock.window.showQuickPick = async choices => {
      if (choices[0]?.label === 'Write reconstructed tree') return choices[0];
      throw new Error('Recovery file picker should only show files');
    };
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (!options?.modal) return;
      const titles = choices.map(choice => (typeof choice === 'string' ? choice : choice.title));
      if (titles.includes('Recover files')) return 'Recover files';
      if (titles.includes('Use this folder')) return 'Use this folder';
      if (titles.includes('Customize…')) return choices[titles.indexOf('Customize…')];
      if (titles.includes('Indentation only')) {
        gitRun('config', 'user.name', 'WHAM Test');
        gitRun('config', 'user.email', 'wham-test@example.invalid');
        gitRun('config', 'commit.gpgsign', 'false');
        gitRun('config', 'core.hooksPath', path.join(recoveredRoot, 'empty-hooks'));
        return choices[titles.indexOf('Indentation only')];
      }
      return choices[titles.indexOf('2 spaces')];
    };
    await receive({
      action: 'initialize',
      mode: 'Recover one or more .wh.cpp files',
      openProject: false,
      initialCommit: true
    });
    const recoveredHead = gitRun('rev-parse', 'HEAD');
    assert.ok(gitRun('ls-tree', '-r', '--name-only', 'HEAD').includes('src/shared.h'));
    assert.equal(gitRun('status', '--porcelain').trim(), '');
    assert.equal(globalStored.recentProjects[0], recoveredRoot);
    assert.ok(
      stored.additionalRoots.includes(recoveredRoot),
      'A recovered project kept outside the workspace reloads next session'
    );
    await fs.writeFile(path.join(recoveredRoot, 'user.txt'), 'user staged changes');
    gitRun('add', 'user.txt');
    mock.window.showQuickPick = async choices =>
      choices[0]?.label === 'Write reconstructed tree' ? choices[0] : undefined;
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (!options?.modal) return;
      return choices.find(choice =>
        ['Use this folder', 'Recover files', 'Skip'].includes(typeof choice === 'string' ? choice : choice.title)
      );
    };
    await receive({
      action: 'initialize',
      mode: 'Recover one or more .wh.cpp files',
      openProject: false,
      initialCommit: true
    });
    assert.equal(gitRun('rev-parse', 'HEAD'), recoveredHead);
    assert.equal(gitRun('diff', '--cached', '--name-only').trim(), 'user.txt');
    await fs.writeFile(path.join(recoveredRoot, 'src/shared.h'), 'user edit before recovery');
    let replaceConfirmations = 0,
      reviewNotifications = 0,
      recoveryDiffs = 0;
    mock.window.showQuickPick = async (choices, options) => {
      assert.equal(options.title, 'Review recovered files');
      return choices.find(choice => choice.file === 'src/shared.h');
    };
    const executeBeforeRecovery = mock.commands.executeCommand;
    mock.commands.executeCommand = async (command, ...args) => {
      if (command === 'vscode.diff') recoveryDiffs++;
      else await executeBeforeRecovery(command, ...args);
    };
    mock.window.showWarningMessage = async (message, options, ...choices) => {
      assert.ok(options.detail.includes('src/shared.h'));
      assert.ok(choices.includes('Recover and replace'));
      if (options.modal) {
        assert.equal(message, 'Recover source files');
        replaceConfirmations++;
        return 'Review files…';
      }
      reviewNotifications++;
      assert.equal(recoveryDiffs, 1);
      assert.equal(await fs.readFile(path.join(recoveredRoot, 'src/shared.h'), 'utf8'), 'user edit before recovery');
      return 'Recover and replace';
    };
    await receive({ action: 'initialize', mode: 'Recover one or more .wh.cpp files', openProject: false });
    assert.equal(replaceConfirmations, 1);
    assert.equal(reviewNotifications, 1);
    assert.ok((await fs.readFile(path.join(recoveredRoot, 'src/shared.h'), 'utf8')).includes('shared'));
    await fs.writeFile(path.join(recoveredRoot, 'src/shared.h'), 'before external change');
    mock.window.showWarningMessage = async () => {
      await fs.writeFile(path.join(recoveredRoot, 'src/shared.h'), 'external change during confirmation');
      return 'Recover and replace';
    };
    await receive({ action: 'initialize', mode: 'Recover one or more .wh.cpp files', openProject: false });
    assert.match(messages.at(-1).message, /Recovery destination changed/);
    assert.equal(
      await fs.readFile(path.join(recoveredRoot, 'src/shared.h'), 'utf8'),
      'external change during confirmation'
    );
    // A failed initial commit still opens a fully configured new project.
    const failedRoot = path.join(root, 'failed-commit');
    await fs.mkdir(failedRoot);
    const warnings = [];
    mock.window.showWarningMessage = async message => {
      warnings.push(message);
    };
    mock.window.showOpenDialog = async () => [Uri.file(failedRoot)];
    mock.window.showQuickPick = async () => {
      throw new Error('Fixed setup choices must use buttons');
    };
    mock.window.showInformationMessage = async (message, options, ...choices) => {
      if (!options?.modal) return;
      const titles = choices.map(choice => (typeof choice === 'string' ? choice : choice.title));
      if (titles.includes('Use empty folder')) return 'Use empty folder';
      if (titles.includes('Customize…')) return choices[titles.indexOf('Customize…')];
      if (titles.includes('Indentation only')) {
        for (const key of ['user.name', 'user.email'])
          execFileSync(git, ['-C', failedRoot, 'config', key, ''], { stdio: 'pipe' });
        return choices[titles.indexOf('Indentation only')];
      }
      return choices[titles.indexOf('2 spaces')];
    };
    await receive({ action: 'initialize', mode: 'Create a new project', openProject: true, initialCommit: true });
    assert.equal(opened.at(-1)[1].fsPath, failedRoot);
    assert.match(warnings.at(-1), /initial commit failed/);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(failedRoot, '.vscode/settings.json'), 'utf8'))['[cpp]']['editor.tabSize'],
      2
    );
    // Browsing a plain source project adds WHAM config, without editor prompts.
    const plainRoot = path.join(root, 'plain-project');
    await fs.mkdir(plainRoot);
    mock.window.showQuickPick = async choices =>
      choices.find(choice => choice.label === 'Browse for a project folder…');
    mock.window.showOpenDialog = async () => [Uri.file(plainRoot)];
    mock.window.showQuickPick = async () => {
      throw new Error('Browse must open the folder dialog directly');
    };
    await receive({ action: 'openProject', browse: true });
    assert.ok((await fs.stat(path.join(plainRoot, 'windhawk-amalgamation.json'))).isFile());
    await assert.rejects(fs.stat(path.join(plainRoot, '.vscode/settings.json')), /ENOENT/);
    assert.equal(opened.at(-1)[1].fsPath, plainRoot);
    assert.equal(globalStored.recentProjects[0], plainRoot);
    // A disposed sidebar view is never written to; the next resolved view takes over.
    let disposeView,
      staleWrites = 0;
    const staleWebview = {
      cspSource: 'test-resource:',
      asWebviewUri: uri => uri.toString(),
      postMessage: async () => {
        staleWrites++;
      },
      onDidReceiveMessage() {
        return disposable();
      }
    };
    provider.resolveWebviewView({
      webview: staleWebview,
      onDidDispose(fn) {
        disposeView = fn;
        return disposable();
      }
    });
    disposeView();
    staleWrites = 0;
    Object.defineProperty(staleWebview, 'html', {
      set() {
        throw new Error('Webview is disposed');
      }
    });
    onFolders({ added: [], removed: [] });
    assert.equal(staleWrites, 0);
    // Retiring a project must cancel both debounces and queued work. Reopening
    // creates a new watcher and resumes generation without resurrecting old work.
    provider.resolveWebviewView({
      webview: {
        cspSource: 'test-resource:',
        asWebviewUri: uri => uri.toString(),
        postMessage: async message => {
          messages.push(message);
        },
        onDidReceiveMessage(fn) {
          receive = fn;
          return disposable();
        }
      }
    });
    const closingRoot = plainRoot,
      closingEntry = path.join(closingRoot, 'src/closing.cpp');
    await fs.writeFile(closingEntry, 'int closing = 1;\n');
    const closingWatcher = watchers.findLast(watcher => watcher.root === closingRoot);
    closingWatcher.create(Uri.file(closingEntry));
    const closingProject = () =>
      messages
        .filter(message => message.type === 'state')
        .at(-1)
        ?.projects.find(project => project.root === closingRoot);
    await settle(() => closingProject()?.entries[0]?.status === 'current');
    await receive({ action: 'config', root: closingRoot, config: { ...closingProject().config, debounceMs: 250 } });
    const closingOutput = path.join(closingRoot, 'output/closing.wh.cpp');
    const previousOutput = await fs.readFile(closingOutput),
      beforeClose = generations.get(closingEntry);
    await fs.writeFile(closingEntry, 'int closing = 2;\n');
    onSave({ uri: Uri.file(closingEntry) });
    onFolders({ added: [], removed: [{ uri: Uri.file(closingRoot) }] });
    assert.equal(closingWatcher.disposed, true);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(await fs.readFile(closingOutput), previousOutput);
    assert.equal(generations.get(closingEntry), beforeClose);
    onFolders({ added: [{ uri: Uri.file(closingRoot) }], removed: [] });
    await settle(() => closingProject()?.entries[0]?.status === 'current');
    assert.notEqual(
      watchers.findLast(watcher => watcher.root === closingRoot),
      closingWatcher
    );
    assert.match(await fs.readFile(closingOutput, 'utf8'), /int closing = 2;/);
    const reopenedOutput = await fs.readFile(closingOutput);
    holdGenerationFor = closingEntry;
    releaseGeneration = undefined;
    await fs.writeFile(closingEntry, 'int closing = 3;\n');
    onSave({ uri: Uri.file(closingEntry) });
    await settle(() => releaseGeneration);
    onFolders({ added: [], removed: [{ uri: Uri.file(closingRoot) }] });
    holdGenerationFor = undefined;
    releaseGeneration();
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.deepEqual(
      await fs.readFile(closingOutput),
      reopenedOutput,
      'An in-flight generation cannot commit after project removal'
    );
    // With no recent history, opening goes straight to a folder picker.
    for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
    globalStored.recentProjects = [];
    delete stored.additionalRoots;
    mock.window.showQuickPick = async () => {
      throw new Error('Unexpected setup/recent picker');
    };
    await extension.activate(context);
    await commands.get('windhawk.openProject')();
    assert.equal(globalStored.recentProjects[0], plainRoot);
    assert.equal(localPreferenceWrites, 0);
    assert.deepEqual(globalStored.localPreferences, legacyPreferences);
  } finally {
    for (const subscription of context.subscriptions) subscription.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
