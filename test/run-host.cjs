const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
(async () => {
  const repo = path.resolve(__dirname, '..');
  const executable = path.resolve(process.argv[2] ?? path.join(repo, 'work/vscode-portable/Code.exe'));
  const executableDirectory = await fs.readdir(path.dirname(executable)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return [];
  });
  if (!executableDirectory.some(name => name.toLowerCase() === path.basename(executable).toLowerCase())) {
    throw new Error(
      `VS Code executable missing: ${executable}\nExtract the Windows x64 ZIP to work/vscode-portable/:\n` +
        'https://update.code.visualstudio.com/latest/win32-x64-archive/stable'
    );
  }
  // An adjacent portable data directory overrides the isolated profile flags.
  if (executableDirectory.some(name => name.toLowerCase() === 'data')) {
    throw new Error('Use a fresh VS Code ZIP extraction without an adjacent data folder.');
  }
  const extension = path.resolve(process.argv[3] ?? repo);
  const { defaults } = require(path.join(extension, 'dist/config'));
  const work = path.join(repo, 'work', 'host-' + Date.now());
  const temp = path.join(work, 'temp');
  const userSettings = path.join(work, 'user-data/User');
  await fs.mkdir(temp, { recursive: true });
  await fs.mkdir(userSettings, { recursive: true });
  await fs.writeFile(
    path.join(userSettings, 'settings.json'),
    JSON.stringify({
      'extensions.autoCheckUpdates': false,
      'extensions.autoUpdate': 'off',
      'git.enabled': false,
      'chat.disableAIFeatures': true,
      'wham.languageService': 'both'
    })
  );
  for (const [folder, generate] of [
    ['project', 'onSave'],
    ['legacy', 'manual']
  ]) {
    const root = path.join(work, folder);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, generate }));
    await fs.writeFile(path.join(root, 'src/main.cpp'), '#include "shared.h"\n');
    await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint value = 1;\n');
  }
  await fs.mkdir(path.join(work, 'legacy/.vscode'));
  await fs.writeFile(
    path.join(work, 'legacy/.vscode/settings.json'),
    JSON.stringify({
      'clangd.path': path.join(work, 'toolchain/clangd.exe'),
      'clangd.arguments': ['--background-index']
    })
  );
  const workspace = path.join(work, 'projects.code-workspace');
  await fs.writeFile(
    workspace,
    JSON.stringify({ folders: [{ path: 'project' }, { path: 'legacy' }], settings: { 'wham.debounceMs': 750 } })
  );
  const environment = { ...process.env, TEMP: temp, TMP: temp };
  delete environment.ELECTRON_RUN_AS_NODE;
  // An integrated terminal can inherit the regular VS Code installation's caches and IPC paths.
  for (const name of Object.keys(environment)) if (/^VSCODE_/i.test(name)) delete environment[name];
  console.log('Host artifacts:', work);
  // VS Code registers itself as the vscode:// link handler at startup. Restore the user's afterwards.
  const protocolKey = 'HKCU\\Software\\Classes\\vscode',
    protocolBackup = path.join(work, 'vscode-protocol.reg');
  const reg = args => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
  const hadProtocol = reg(['export', protocolKey, protocolBackup, '/y']).status === 0;
  const restoreProtocol = () => {
    reg(['delete', protocolKey, '/f']);
    if (hadProtocol && reg(['import', protocolBackup]).status !== 0)
      console.error(`Could not restore the vscode:// handler. Import ${protocolBackup} to restore it.`);
  };
  const child = spawn(
    executable,
    [
      workspace,
      '--new-window',
      '--hidden-window',
      '--skip-welcome',
      '--skip-release-notes',
      '--skip-add-to-recently-opened',
      '--disable-workspace-trust',
      '--disable-extensions',
      '--disable-updates',
      '--disable-telemetry',
      '--disable-crash-reporter',
      '--disable-experiments',
      '--disable-gpu',
      // Allow the disposable copy to run inside a process sandbox that blocks nested Chromium sandboxes.
      ...(process.env.WHAM_HOST_DISABLE_CHROMIUM_SANDBOX === '1' ? ['--disable-chromium-sandbox'] : []),
      '--user-data-dir=' + path.join(work, 'user-data'),
      '--extensions-dir=' + path.join(work, 'extensions'),
      '--shared-data-dir=' + path.join(work, 'shared-data'),
      '--extensionDevelopmentPath=' + extension,
      '--extensionTestsPath=' + path.join(__dirname, 'vscode-host.cjs')
    ],
    { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', data => {
      output += data;
    });
  const timeout = setTimeout(() => {
    child.kill();
    console.error('VS Code host test exceeded 90 seconds');
  }, 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    console.log('VS Code exit:', code);
    await fs.writeFile(path.join(work, 'host.log'), output);
    const result = JSON.parse(await fs.readFile(path.join(work, 'host-result.json'), 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (code !== 0 || !result.passed) process.exitCode = 1;
  } catch (error) {
    console.error(output.slice(-5000));
    throw error;
  } finally {
    clearTimeout(timeout);
    restoreProtocol();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
