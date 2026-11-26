// Loaded by VS Code's --extensionTestsPath, not by node --test.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parse } = require('jsonc-parser');

exports.run = async function () {
  const [project, legacy] = vscode.workspace.workspaceFolders;
  const root = project.uri.fsPath;
  const work = path.dirname(root);
  const previewMessages = [];
  const checks = [];
  const check = async (name, run) => {
    try {
      await run();
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, error: error.stack });
    }
  };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (description, predicate) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await predicate()) return;
      await delay(25);
    }
    throw new Error('Timed out waiting for ' + description);
  };
  const readIfPresent = file =>
    fs.readFile(file, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  const waitForValue = (file, value) =>
    until(`value = ${value} in ${file}`, async () => (await readIfPresent(file))?.includes(`value = ${value};`));
  const header = folder => vscode.Uri.joinPath(folder.uri, 'src/shared.h');
  const saveHeader = async (folder, value) => {
    const uri = header(folder);
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
      `#pragma once\nint value = ${value};\n`
    );
    assert.ok(await vscode.workspace.applyEdit(edit), 'Source edit applied');
    let savedAt;
    const listener = vscode.workspace.onDidSaveTextDocument(saved => {
      if (saved === document) savedAt = performance.now();
    });
    try {
      assert.ok(await document.save(), 'Source document saved');
      await until(`save event for ${uri.fsPath}`, () => savedAt !== undefined);
      return savedAt;
    } finally {
      listener.dispose();
    }
  };
  const configuration = folder => vscode.workspace.getConfiguration('wham', folder?.uri);
  const target = vscode.ConfigurationTarget;
  const setMode = async (folder, mode) => {
    let changed = false;
    const listener = vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('wham.generate')) changed = true;
    });
    try {
      await configuration(folder).update('generate', mode, target.WorkspaceFolder);
      // An explicit setting can match the VS Code default while overriding WHAM's legacy mode.
      await until(
        `configuration event for ${folder.name} → ${mode}`,
        () => changed && configuration(folder).inspect('generate').workspaceFolderValue === mode
      );
    } finally {
      listener.dispose();
    }
  };
  const artifact = path.join(work, 'host-result.json');
  try {
    const extension = vscode.extensions.getExtension(
      require('../package.json').publisher + '.' + require('../package.json').name
    );
    assert.ok(extension, 'Extension registered');
    await extension.activate();
    const all = await vscode.commands.getCommands();
    assert.ok(all.includes('windhawk.generateAll'));
    await vscode.commands.executeCommand('workbench.view.extension.windhawk');
    await vscode.commands.executeCommand('windhawk.generateAll');
    const output = path.join(root, 'output/main.wh.cpp');
    await waitForValue(output, 1);
    checks.push({ name: 'activation, command and sidebar registration, generate command', passed: true });
    const debounceMs = configuration().get('debounceMs');
    const settle = () => delay(debounceMs * 2);
    const outputState = async file => ({ text: await fs.readFile(file, 'utf8'), mtime: (await fs.stat(file)).mtimeMs });
    const legacyOutput = path.join(legacy.uri.fsPath, 'output/main.wh.cpp');
    const userSettingsPath = path.join(work, 'user-data/User/settings.json');
    const userSettings = async () => parse(await fs.readFile(userSettingsPath, 'utf8'));
    await check('machine settings use Global and refuse Workspace and WorkspaceFolder', async () => {
      const machineSettings = {
        windhawkPath: path.join(work, 'Windhawk'),
        elevation: 'gsudo',
        gsudoPath: path.join(work, 'gsudo.exe')
      };
      for (const [key, value] of Object.entries(machineSettings)) {
        await configuration(project).update(key, value, target.Global);
        assert.equal((await userSettings())['wham.' + key], value, `${key} is in user settings`);
        const replacement = key === 'elevation' ? 'sudo' : path.join(work, 'workspace-only', key);
        for (const level of [target.Workspace, target.WorkspaceFolder]) {
          await assert.rejects(
            async () => configuration(project).update(key, replacement, level),
            /workspace|machine|scope/i,
            `${key} must reject ${target[level]}`
          );
        }
      }
    });
    await check('real document save regenerates in after-save mode', async () => {
      await saveHeader(project, 2);
      await waitForValue(output, 2);
    });
    await check('legacy project generate: manual applies until overridden by a folder setting', async () => {
      const { globalValue, workspaceValue, workspaceFolderValue } = configuration(legacy).inspect('generate');
      assert.deepEqual([globalValue, workspaceValue, workspaceFolderValue], [undefined, undefined, undefined]);
      await saveHeader(legacy, 2);
      await settle();
      assert.equal(await readIfPresent(legacyOutput), undefined, 'Legacy Manual left no generated output');
      await setMode(legacy, 'onSave');
      await waitForValue(legacyOutput, 2);
    });
    await check('Toggle Generate on Save writes only the active project folder setting', async () => {
      await vscode.window.showTextDocument(header(legacy));
      await vscode.commands.executeCommand('windhawk.toggleOnSave');
      await until(
        'Toggle to write Manual in the active folder',
        () => configuration(legacy).inspect('generate').workspaceFolderValue === 'manual'
      );
      const settings = parse(await fs.readFile(path.join(legacy.uri.fsPath, '.vscode/settings.json'), 'utf8'));
      assert.equal(settings['wham.generate'], 'manual');
      const { globalValue, workspaceValue, workspaceFolderValue } = configuration(project).inspect('generate');
      assert.deepEqual([globalValue, workspaceValue, workspaceFolderValue], [undefined, undefined, undefined]);
      const before = await outputState(legacyOutput);
      await saveHeader(legacy, 3);
      await saveHeader(project, 3);
      await waitForValue(output, 3);
      await settle();
      assert.deepEqual(await outputState(legacyOutput), before, 'Only the Manual folder skipped regeneration');
    });
    await check(
      'switching to Manual cancels a queued save and blocks later saves until after-save resumes',
      async () => {
        const before = await outputState(output);
        const savedAt = await saveHeader(project, 4);
        await setMode(project, 'manual');
        assert.ok(
          performance.now() - savedAt < debounceMs,
          'Manual event reached WHAM before the save debounce expired'
        );
        await settle();
        assert.deepEqual(await outputState(output), before, 'No write from the save just before switching to Manual');
        await saveHeader(project, 5);
        await settle();
        assert.deepEqual(await outputState(output), before, 'No write from a save in Manual');
        await setMode(project, 'onSave');
        await waitForValue(output, 5);
      }
    );
    await check('changing the language-service default leaves clangd project files intact', async () => {
      const folder = legacy.uri.fsPath;
      const settingsFile = path.join(folder, '.vscode/settings.json');
      const before = await outputState(settingsFile);
      assert.equal(path.relative(work, parse(before.text)['clangd.path']), path.join('toolchain', 'clangd.exe'));
      const rootEntries = (await fs.readdir(folder)).sort();
      const vscodeEntries = (await fs.readdir(path.dirname(settingsFile))).sort();
      await configuration().update('languageService', 'cpp', target.Global);
      await until('language-service default to change', () => configuration().get('languageService') === 'cpp');
      assert.equal((await userSettings())['wham.languageService'], 'cpp');
      await settle();
      assert.deepEqual(await outputState(settingsFile), before);
      assert.deepEqual((await fs.readdir(folder)).sort(), rootEntries);
      assert.deepEqual((await fs.readdir(path.dirname(settingsFile))).sort(), vscodeEntries);
    });
    await check('manual output edits are preserved', async () => {
      await vscode.window.showTextDocument(header(project));
      const original = await fs.readFile(output, 'utf8');
      const manuallyEdited = original.replace(/value = \d+;/, 'value = 99;');
      assert.notEqual(manuallyEdited, original);
      await fs.writeFile(output, manuallyEdited);
      await fs.writeFile(header(project).fsPath, '#pragma once\nint value = 6;\n');
      await vscode.commands.executeCommand('windhawk.generateAll');
      assert.equal(await fs.readFile(output, 'utf8'), manuallyEdited);
    });
    if (process.env.WHAM_TEST_WINDHAWK) {
      const windhawk = require(path.join(extension.extensionPath, 'dist/windhawk'));
      const { createDetailsPanel } = require(path.join(extension.extensionPath, 'dist/details'));
      const installation = await windhawk.inspectWindhawk(process.env.WHAM_TEST_WINDHAWK);
      assert.ok((await fs.stat(path.join(extension.extensionPath, 'media/windhawk-renderer/index.html'))).isFile());
      const source =
        '// ==WindhawkMod==\n// @id wham-host-preview-test\n// @name Host preview\n// ==/WindhawkMod==\n// ==WindhawkModReadme==\n/*\n# Native host preview\n*/\n// ==/WindhawkModReadme==\n';
      const parsed = await windhawk.invokeWindhawkCore(installation.root, 'parseModSource', { source, language: 'en' });
      const details = await createDetailsPanel(
        vscode.Uri.file(extension.extensionPath),
        {
          installation,
          modId: 'local@wham-host-preview-test',
          entry: path.join(root, 'src/main.cpp'),
          source,
          parsed,
          changesPending: false
        },
        async () => {}
      );
      const messages = previewMessages;
      details.panel.webview.onDidReceiveMessage(message => messages.push(message));
      await until('Windhawk webview messages', () =>
        messages.some(message => message.command === 'getRepositoryModSourceData')
      );
      assert.ok(messages.some(message => message.command === 'getInitialAppSettings'));
      assert.ok(messages.some(message => message.command === 'getRepositoryMods'));
      assert.ok(!messages.some(message => message.command === 'setModSettings'));
      details.dispose();
      checks.push({ name: 'native Windhawk parser and embedded Discover renderer', passed: true });
    }
    const passed = checks.every(check => check.passed);
    await fs.writeFile(artifact, JSON.stringify({ passed, checks }, null, 2));
    assert.ok(passed, 'One or more VS Code host checks failed');
  } catch (error) {
    await fs.writeFile(
      artifact,
      JSON.stringify({ passed: false, checks, error: error.stack, previewMessages }, null, 2)
    );
    throw error;
  }
};
