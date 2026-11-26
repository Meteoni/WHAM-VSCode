const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateConfig } = require('../dist/config');
const { generateEntry } = require('../dist/engine');
const { installedModKey, sourceHash } = require('../dist/projects');
const { createRuntimeOperations, mapCompilerDiagnostics, parseCompilerArguments } = require('../dist/runtime');
const { WindhawkError } = require('../dist/windhawk');

const root = path.resolve('work', 'runtime-fixture');
const installation = path.resolve('work', 'no-windhawk-here');
const metadata = '// ==WindhawkMod==\n// @id demo-mod\n// @name Demo\n// @version 1.0\n// ==/WindhawkMod==\n';
const files = {
  'src/mod.cpp': metadata + '#include "shared.h"\nint mod;\n',
  'src/shared.h': '#pragma once\nint first;\nint broken;\n'
};

async function generated() {
  const buffers = new Map(Object.entries(files).map(([file, text]) => [path.join(root, file), Buffer.from(text)]));
  const missing = () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  const access = {
    read: async file => buffers.get(file) ?? missing(),
    identity: async file => (file === path.join(root, 'src') || buffers.has(file) ? file : missing()),
    list: async () => [...buffers.keys()]
  };
  const result = await generateEntry({ root, config: validateConfig({}) }, path.join(root, 'src/mod.cpp'), access);
  assert.ok(result.bytes, JSON.stringify(result.diagnostics));
  return result;
}

function projectState(name = 'project') {
  const entryPath = path.join(root, name, 'src/mod.cpp');
  const installationPreferences = { elevation: 'none', gsudoPath: '' };
  const entry = {
    path: entryPath,
    output: '',
    status: 'current',
    runtime: { id: 'local@demo-mod', installed: false, enabled: false, changesPending: false, busy: false }
  };
  return {
    entry,
    state: {
      project: { root: path.join(root, name), config: validateConfig({}) },
      entries: new Map([[entryPath, entry]]),
      queue: Promise.resolve(),
      pending: new Set(),
      draftPending: new Set(),
      retained: [],
      editor: {
        installationPath: installation,
        installationPreferences,
        integration: 'cpp',
        indentStyle: 'spaces',
        indentSize: 4
      },
      windhawk: { root: installation, parser: false, cli: true, installationPreferences }
    }
  };
}

/** Runtime operations over `projects`, with fake Windhawk tools that record every call. */
function harness(projects, tools = {}) {
  const events = { informed: [], errors: [], logs: [], cli: [], snapshots: {} };
  let generation;
  const runtime = createRuntimeOperations({
    isDisposed: () => false,
    projects: () => projects,
    log: { append: text => events.logs.push(text), appendLine: line => events.logs.push(line), show: () => {} },
    publish: () => {},
    inform: message => events.informed.push(message),
    showError: message => events.errors.push(message),
    promptCompiler: async () => undefined,
    saveRelevant: async () => true,
    // Generation itself is the pipeline's job; here it just provides the saved snapshot.
    enqueue: async state => {
      for (const entry of state.entries.values()) {
        entry.result = generation ??= await generated();
        entry.status = 'current';
      }
    },
    refreshDraft: async () => {},
    refreshEditorConfiguration: async () => {},
    installationPreferences: state => state.windhawk.installationPreferences,
    compiledSnapshots: () => events.snapshots,
    saveCompiledSnapshots: async builds => (events.snapshots = builds),
    tools: {
      inspectWindhawk: async rootPath => ({ root: rootPath, parser: false, cli: true }),
      readInstalledMod: async () => ({ config: null }),
      runWindhawkCli: async (rootPath, args) => {
        events.cli.push(args);
        return args[1] === 'install'
          ? { id: 'local@demo-mod', config: { libraryFileName: 'demo_1.dll' } }
          : { id: args[2], enabled: args[1] === 'enable' };
      },
      runWindhawkProcess: async () => ({ code: 0, stdout: '', stderr: '' }),
      checkModBuild: async () => ({ warnings: false }),
      ...tools
    }
  });
  return { runtime, events };
}

test('compiler errors map from generated lines back to their source file and line', async () => {
  const result = await generated();
  const lines = result.bytes.toString().split('\n');
  const generatedLine = lines.findIndex(line => line === 'int broken;') + 1;
  const footerLine = lines.findIndex(line => line.includes('recovery-begin')) + 1;
  const output = [
    `<stdin>:${generatedLine}:5: error: unknown type name 'broken'`,
    `C:\\Temp\\mod.wh.cpp:${generatedLine}:1: warning: unused`,
    `<stdin>:${footerLine}:1: error: inside the recovery footer`,
    'clang: error: linker command failed'
  ].join('\n');
  assert.deepEqual(mapCompilerDiagnostics(output, result), [
    { path: path.join(root, 'src/shared.h'), line: 2, severity: 'error', message: "unknown type name 'broken'" },
    { path: path.join(root, 'src/shared.h'), line: 2, severity: 'warning', message: 'unused' }
  ]);
  assert.deepEqual(mapCompilerDiagnostics(output, { ...result, bytes: undefined }), []);
});

test('Verify compiler arguments substitute {file} or append it', () => {
  assert.deepEqual(parseCompilerArguments('["-fsyntax-only","-include","{file}.h"]', 'out.wh.cpp'), [
    '-fsyntax-only',
    '-include',
    'out.wh.cpp.h'
  ]);
  assert.deepEqual(parseCompilerArguments('["-std=c++23"]', 'out.wh.cpp'), ['-std=c++23', 'out.wh.cpp']);
  assert.throws(() => parseCompilerArguments('["-a", 1]', 'x'), /JSON string array/);
  assert.throws(() => parseCompilerArguments('not json', 'x'), SyntaxError);
});

test('a first compile installs disabled and records which source produced the build', async () => {
  const { state, entry } = projectState();
  const { runtime, events } = harness([state]);
  await runtime.compileMod(state, entry);
  assert.deepEqual(events.cli, [['mod', 'install', '--file', '-', '--disabled']]);
  const key = installedModKey(installation, 'local@demo-mod');
  assert.deepEqual(events.snapshots[key], {
    sourceHash: sourceHash(entry.result.bytes.toString()),
    libraryFileName: 'demo_1.dll'
  });
  assert.equal(entry.busy, undefined);
  assert.equal(entry.runtime.busy, false);
  assert.equal(runtime.installedOperations.size, 0, 'The mod is released after the operation');
  assert.equal(entry.buildError, undefined);
});

test('an installed, enabled mod stays enabled when recompiled', async () => {
  const { state, entry } = projectState();
  const { runtime, events } = harness([state], {
    readInstalledMod: async () => ({ config: { disabled: false, libraryFileName: 'demo_0.dll' } })
  });
  await runtime.compileMod(state, entry);
  assert.deepEqual(events.cli, [['mod', 'install', '--file', '-']]);
});

test('compile keeps its starting installation and elevation when settings change', async () => {
  const { state, entry } = projectState();
  const startingPreferences = { elevation: 'gsudo', gsudoPath: path.join(installation, 'gsudo.exe') };
  state.editor.installationPreferences = state.windhawk.installationPreferences = startingPreferences;
  let installedRead, finishInstalledRead;
  const readingInstalled = new Promise(resolve => (installedRead = resolve));
  const installed = new Promise(resolve => (finishInstalledRead = resolve));
  const installs = [];
  const { runtime, events } = harness([state], {
    readInstalledMod: async () => {
      installedRead();
      return installed;
    },
    runWindhawkCli: async (rootPath, args, input, onOutput, signal, elevation) => {
      installs.push({ rootPath, elevation });
      return { id: 'local@demo-mod', config: { libraryFileName: 'demo_1.dll' } };
    }
  });
  const compiling = runtime.compileMod(state, entry);
  await readingInstalled;
  const newInstallation = path.resolve('work', 'other-windhawk');
  const installationPreferences = { elevation: 'sudo', gsudoPath: '' };
  state.editor = { ...state.editor, installationPath: newInstallation, installationPreferences };
  state.windhawk = { ...state.windhawk, root: newInstallation, installationPreferences };
  finishInstalledRead({ config: null });
  await compiling;
  assert.deepEqual(events.errors, []);
  assert.deepEqual(installs, [{ rootPath: installation, elevation: startingPreferences }]);
  assert.deepEqual(Object.keys(events.snapshots), [installedModKey(installation, 'local@demo-mod')]);
});

test('one operation per installed mod, even across projects', async () => {
  const first = projectState('first'),
    second = projectState('second');
  const { runtime, events } = harness([first.state, second.state]);
  runtime.installedOperations.set(installedModKey(installation, 'local@demo-mod'), first.entry);
  await runtime.compileMod(second.state, second.entry);
  second.entry.installed = { config: { disabled: true } };
  await runtime.enableMod(second.state, second.entry, true);
  assert.deepEqual(events.informed, [
    'This mod already has an operation running.',
    'This mod already has an operation running.'
  ]);
  assert.deepEqual(events.cli, []);
});

test('compile failures map compiler output to sources; cancellation is not a failure', async () => {
  const result = await generated();
  const generatedLine = result.bytes.toString().split('\n').indexOf('int broken;') + 1;
  const failing = projectState();
  const failed = harness([failing.state], {
    runWindhawkCli: async () => {
      throw new WindhawkError('Compilation failed.', 'COMPILER_FAILED', {
        output: `<stdin>:${generatedLine}:5: error: bad`
      });
    }
  });
  await failed.runtime.compileMod(failing.state, failing.entry);
  assert.equal(failing.entry.buildError, 'Compilation failed.');
  assert.deepEqual(failed.events.errors, ['Compilation failed.']);
  assert.deepEqual(
    failing.entry.compilerDiagnostics.map(item => [path.basename(item.path), item.line, item.message]),
    [['shared.h', 2, 'bad']]
  );
  const canceling = projectState();
  const canceled = harness([canceling.state], {
    runWindhawkCli: async () => {
      throw new WindhawkError('Operation canceled.', 'CANCELED');
    }
  });
  await canceled.runtime.compileMod(canceling.state, canceling.entry);
  assert.equal(canceling.entry.buildError, undefined);
  assert.deepEqual(canceled.events.errors, []);
  assert.ok(canceled.events.logs.includes('Compilation stopped.'));
});

test('stopping from another project card cancels the operation that holds the mod', async () => {
  const owner = projectState('owner'),
    peer = projectState('peer');
  let started;
  const running = new Promise(resolve => (started = resolve));
  const { runtime, events } = harness([owner.state, peer.state], {
    runWindhawkCli: async (rootPath, args, input, onOutput, signal) => {
      started();
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(new WindhawkError('Compilation stopped.', 'CANCELED')))
      );
    }
  });
  const compiling = runtime.compileMod(owner.state, owner.entry);
  await running;
  assert.equal(runtime.operationOwner(peer.state, peer.entry), owner.entry);
  runtime.stopOperation(peer.state, peer.entry);
  assert.equal(owner.entry.runtime.stopping, true);
  await compiling;
  assert.ok(events.logs.includes('Compilation stopped.'));
  assert.equal(runtime.installedOperations.size, 0);
  assert.equal(owner.entry.busy, undefined);
});

test('enabling updates every project card for the same installed mod', async () => {
  const first = projectState('first'),
    second = projectState('second');
  for (const { entry } of [first, second]) entry.installed = { config: { disabled: true } };
  const { runtime, events } = harness([first.state, second.state]);
  await runtime.enableMod(first.state, first.entry, true);
  assert.deepEqual(events.cli, [['mod', 'enable', 'local@demo-mod']]);
  for (const { entry } of [first, second]) {
    assert.equal(entry.installed.config.disabled, false);
    assert.equal(entry.runtime.enabled, true);
  }
});

test('refreshRuntime reads installed state for each entry and reports read errors', async () => {
  const { state, entry } = projectState();
  const reads = [];
  const { runtime } = harness([state], {
    readInstalledMod: async (rootPath, id) => {
      reads.push(id);
      if (reads.length > 1) throw new Error('Windhawk is busy.');
      return { config: { disabled: false, libraryFileName: 'demo_1.dll' } };
    }
  });
  await runtime.refreshRuntime(state);
  assert.deepEqual(
    [entry.runtime.installed, entry.runtime.enabled, entry.runtime.compileStatus],
    [true, true, 'unknown']
  );
  await runtime.refreshRuntime(state);
  assert.deepEqual(
    [entry.installed, entry.runtime.installed, entry.runtime.error],
    [undefined, false, 'Windhawk is busy.']
  );
  assert.deepEqual(reads, ['local@demo-mod', 'local@demo-mod']);
});
