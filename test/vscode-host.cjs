// Loaded by VS Code's --extensionTestsPath, not by node --test.
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
exports.run = async function() {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const artifact = path.join(root, '..', 'host-result.json');
  const previewMessages = [];
  const until = async predicate => {
    for (let attempt = 0; attempt < 600; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Extension host condition timed out.');
  };
  try {
    const extension = vscode.extensions.getExtension(require('../package.json').publisher + '.' + require('../package.json').name);
    assert.ok(extension, 'Extension registered'); await extension.activate();
    const all = await vscode.commands.getCommands(); assert.ok(all.includes('windhawk.generateAll'));
    await vscode.commands.executeCommand('workbench.view.extension.windhawk');
    await vscode.commands.executeCommand('windhawk.generateAll');
    const output = path.join(root, 'output/main.wh.cpp');
    await until(async () => { try { return (await fs.readFile(output, 'utf8')).includes('value = 1'); } catch { return false; } });
    const headerUri = vscode.Uri.file(path.join(root, 'src/shared.h'));
    const document = await vscode.workspace.openTextDocument(headerUri);
    const edit = new vscode.WorkspaceEdit(); edit.replace(headerUri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), '#pragma once\nint value = 2;\n');
    await vscode.workspace.applyEdit(edit); await document.save();
    await until(async () => (await fs.readFile(output, 'utf8')).includes('value = 2'));
    const manuallyEdited = (await fs.readFile(output, 'utf8')).replace('value = 2', 'value = 99'); await fs.writeFile(output, manuallyEdited);
    await fs.writeFile(headerUri.fsPath, '#pragma once\nint value = 3;\n');
    await vscode.commands.executeCommand('windhawk.generateAll');
    assert.equal(await fs.readFile(output, 'utf8'), manuallyEdited, 'Manual output edits preserved by real extension host');
    const checks = ['activation', 'commands', 'sidebar view registration', 'generate command', 'document save regeneration', 'manual output protection'];
    if (process.env.WHAM_TEST_WINDHAWK) {
      const windhawk = require(path.join(extension.extensionPath, 'dist/windhawk'));
      const { createDetailsPanel } = require(path.join(extension.extensionPath, 'dist/details'));
      const installation = await windhawk.inspectWindhawk(process.env.WHAM_TEST_WINDHAWK);
      assert.ok((await fs.stat(path.join(extension.extensionPath,'media/windhawk-renderer/index.html'))).isFile());
      const source = '// ==WindhawkMod==\n// @id wham-host-preview-test\n// @name Host preview\n// ==/WindhawkMod==\n// ==WindhawkModReadme==\n/*\n# Native host preview\n*/\n// ==/WindhawkModReadme==\n';
      const parsed = await windhawk.invokeWindhawkCore(installation.root, 'parseModSource', { source, language: 'en' });
      const details = await createDetailsPanel(vscode.Uri.file(extension.extensionPath), { installation, modId: 'local@wham-host-preview-test', entry: path.join(root, 'src/main.cpp'), source, parsed, changesPending: false }, async () => {});
      const messages = previewMessages;
      details.panel.webview.onDidReceiveMessage(message => messages.push(message));
      await until(() => messages.some(message => message.command === 'getRepositoryModSourceData'));
      assert.ok(messages.some(message => message.command === 'getInitialAppSettings'));
      assert.ok(messages.some(message => message.command === 'getRepositoryMods'));
      assert.ok(!messages.some(message => message.command === 'setModSettings'));
      details.dispose();
      checks.push('native Windhawk parser', 'embedded Discover renderer in real VS Code webview');
    }
    await fs.writeFile(artifact, JSON.stringify({ passed: true, checks }, null, 2));
  } catch (error) {
    await fs.writeFile(artifact, JSON.stringify({ passed: false, error: error.stack, previewMessages }, null, 2)); throw error;
  }
};
