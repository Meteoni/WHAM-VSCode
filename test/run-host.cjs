const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { defaults } = require('../dist/config');
(async () => {
  const executable = process.argv[2]; if (!executable) throw new Error('Pass the VS Code executable path.');
  const work = path.resolve('work', 'host-' + Date.now()), root = path.join(work, 'project');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify({ ...defaults, debounceMs: 25 }));
  await fs.writeFile(path.join(root, 'src/main.cpp'), '#include "shared.h"\n');
  await fs.writeFile(path.join(root, 'src/shared.h'), '#pragma once\nint value = 1;\n');
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [root, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-extensions',
    '--user-data-dir=' + path.join(work, 'user-data'), '--extensions-dir=' + path.join(work, 'extensions'),
    '--extensionDevelopmentPath=' + path.resolve(process.argv[3] ?? '.'), '--extensionTestsPath=' + path.resolve('test/vscode-host.cjs')], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => { child.kill(); console.error('Host test exceeded 90 seconds'); }, 90000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timeout);
  console.log('VS Code exit:', code);
  try { const result = JSON.parse(await fs.readFile(path.join(work, 'host-result.json'))); console.log(JSON.stringify(result, null, 2)); if (!result.passed) process.exitCode = 1; }
  catch { console.error(output.slice(-5000)); process.exitCode = 1; }
})().catch(error => { console.error(error); process.exitCode = 1; });
