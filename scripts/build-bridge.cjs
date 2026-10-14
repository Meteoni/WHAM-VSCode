const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const compilerArgument = process.argv[2];
(async () => {
const installation = compilerArgument ? undefined : (await require('../dist/setup').findWindhawk())[0];
const compiler = compilerArgument || (installation && path.join(installation, 'Compiler', 'bin', 'clang++.exe'));
if (!compiler) throw new Error('Pass a Windhawk Compiler/bin/clang++.exe path to npm run build:bridge, or set WINDHAWK_HOME.');
fs.mkdirSync('dist', { recursive: true });
for (const [architecture, target] of [['x64', 'x86_64-w64-mingw32'], ['arm64', 'aarch64-w64-mingw32']]) {
  const result = spawnSync(compiler, ['native/windhawk-bridge.cpp', '-std=c++17', '-O2', '-municode', '--target=' + target,
    '-static-libgcc', '-static-libstdc++', '-ladvapi32', '-o', path.join('dist', 'windhawk-bridge-' + architecture + '.exe')], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status) process.exit(result.status);
}

})().catch(error => { console.error(error.message); process.exitCode = 1; });
