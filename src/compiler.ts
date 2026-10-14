import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseMetadata } from './metadata';
import { runWindhawkProcess, WindhawkError } from './windhawk';

/** Compile or syntax-check a snapshot in scratch storage; never install or load it. */
export async function checkModBuild(root: string, source: string, signal: AbortSignal, onOutput: (text: string) => void, windhawkVersion?: string, syntaxOnly = false) {
  if (!root) throw new Error('Select your Windhawk installation in Settings → Extension settings to check a build.');
  const iniBytes = await fs.readFile(path.join(root, 'windhawk.ini'));
  const ini = iniBytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ? iniBytes.subarray(2).toString('utf16le') : iniBytes.toString('utf8');
  const storage = /\[Storage\]([\s\S]*?)(?:\r?\n\[|$)/i.exec(ini)?.[1] ?? '';
  const compilerRoot = path.resolve(root, /^CompilerPath\s*=\s*(.+)$/im.exec(storage)?.[1].trim() ?? 'Compiler');
  const engineRoot = path.resolve(root, /^EnginePath\s*=\s*(.+)$/im.exec(storage)?.[1].trim() ?? 'Engine');
  const metadata = parseMetadata(source, 'mod.wh.cpp').fields;
  const options: string[] = [];
  let argument = '', quote = '', active = false;
  const declaredOptions = metadata.compilerOptions?.[0] ?? '';
  for (let index = 0; index < declaredOptions.length; index++) {
    const character = declaredOptions[index];
    if (character === '\\' && ['"', "'"].includes(declaredOptions[index + 1])) { argument += declaredOptions[++index]; active = true; }
    else if (quote) { if (character === quote) quote = ''; else argument += character; }
    else if (character === '"' || character === "'") { quote = character; active = true; }
    else if (/\s/.test(character)) { if (active) options.push(argument); argument = ''; active = false; }
    else { argument += character; active = true; }
  }
  if (quote) throw new Error('Unclosed quote in @compilerOptions.');
  if (active) options.push(argument);
  if (options.some(option => /^-o|^--output(?:=|$)/.test(option) || option.startsWith('-Wl,') && option.split(',').some(part => /^-o|^--output(?:=|$)/.test(part)) || /^--for-linker=(?:-o|--output)/.test(option)))
    throw new Error('Remove output redirects from @compilerOptions to check a build in temporary storage.');
  const architectures = metadata.architecture ?? [];
  const targets = [
    { names: ['x86'], folder: '32', triple: 'i686-w64-mingw32' },
    { names: ['x86-64', 'amd64'], folder: '64', triple: 'x86_64-w64-mingw32' },
    { names: ['arm64'], folder: 'arm64', triple: 'aarch64-w64-mingw32' }
  ].filter(target => architectures.length ? target.names.some(name => architectures.includes(name)) : target.folder !== 'arm64' || process.arch === 'arm64');
  if (!targets.length) throw new Error('Unsupported @architecture for compiler checks.');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wham-build-'));
  const relativeTemporary = path.relative(os.tmpdir(), temporary);
  if (relativeTemporary.includes(path.sep) || !relativeTemporary.startsWith('wham-build-')) throw new Error('Invalid temporary build folder.');
  try {
    const escapeDefine = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const version = /^(\d+)\.(\d+)\.(\d+)/.exec(windhawkVersion ?? '');
    const versionHex = version ? '0x' + version.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('') + '00' : '0x00000000';
    for (const target of targets) {
      const output = path.join(temporary, target.folder + '.dll');
      const args = ['-std=c++23', '-ffp-exception-behavior=maytrap', '-DUNICODE', '-D_UNICODE',
        '-DWINVER=0x0A00', '-D_WIN32_WINNT=0x0A00', '-D_WIN32_IE=0x0A00', '-DNTDDI_VERSION=0x0A000008',
        '-D__USE_MINGW_ANSI_STDIO=0', '-DWH_MOD', `-DWH_MOD_ID=L"${escapeDefine(metadata.id?.[0] ?? '')}"`,
        `-DWH_MOD_VERSION=L"${escapeDefine(metadata.version?.[0] ?? '')}"`, '-DWH_WINDHAWK_VERSION=' + versionHex,
        '-include', path.join(compilerRoot, 'include', 'windhawk_api.h'), '-target', target.triple,
        '-O2', '-mguard=cf-nochecks',
        ...(syntaxOnly ? [] : ['-shared', '-Wl,--export-all-symbols', path.join(engineRoot, target.folder, 'windhawk.lib')]),
        '-x', 'c++', '-', ...options,
        ...(syntaxOnly ? ['-fsyntax-only', '-Qunused-arguments'] : ['-o', output])];
      onOutput((syntaxOnly ? 'Verify syntax ' : 'Test build ') + target.triple + '\n');
      const result = await runWindhawkProcess(path.join(compilerRoot, 'bin', 'clang++.exe'), args, source, { signal, timeoutMs: 600000, onOutput, cwd: temporary });
      if (result.code !== 0) throw new WindhawkError(syntaxOnly ? 'Syntax verification failed.' : 'Test build failed.', 'COMPILER_FAILED', { output: result.stderr + result.stdout }, result.stderr);
      if (!syntaxOnly && !(await fs.stat(output).catch(() => undefined))?.isFile()) throw new Error('Compiler produced no test DLL.');
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
