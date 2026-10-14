import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type { InstallationPreferences } from './preferences';

const elevationSessions = new Map<string, Promise<void>>();

/** Check availability without elevating or changing sudo/gsudo configuration. */
export async function inspectElevation(preferences: InstallationPreferences): Promise<{ executable?: string; notice: string }> {
  if (preferences.elevation === 'none') return { notice: 'Uses VS Code’s current permissions.' };
  if (process.platform !== 'win32') throw new Error('Windhawk elevation requires Windows.');
  let executable: string;
  if (preferences.elevation === 'sudo') {
    executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'sudo.exe');
    try {
      await promisify(execFile)(executable, ['--version'], { windowsHide: true, timeout: 5000 });
      const registry = await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Sudo', '/v', 'Enabled', '/reg:64'], { windowsHide: true, timeout: 5000 });
      if (!/REG_DWORD\s+0x3\b/i.test(registry.stdout)) throw new Error('Inline mode is not enabled.');
    } catch { throw new Error('Windows sudo needs Windows 11 24H2 or newer and Inline mode enabled in Windows Settings. WHAM does not change this setting.'); }
    return { executable, notice: 'Windows sudo is ready. Each operation may request administrator approval.' };
  }
  executable = preferences.gsudoPath;
  if (!executable) {
    const candidates = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory.replace(/^"|"$/g, ''), 'gsudo.exe'));
    for (const candidate of candidates) {
      try { if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* Continue searching PATH. */ }
    }
  }
  if (!executable || !path.isAbsolute(executable)) throw new Error('Install gsudo or select its gsudo.exe path in Settings → Extension settings.');
  try {
    const version = await promisify(execFile)(executable, ['--version'], { windowsHide: true, timeout: 5000 });
    if (!/^gsudo\s+v?\d/im.test(version.stdout)) throw new Error('Not gsudo.');
  } catch { throw new Error('The selected executable is not a working gsudo installation.'); }
  return { executable, notice: preferences.reuseSession ? 'gsudo is ready. Approval is reused until this VS Code session ends.' : 'gsudo is ready. Each operation requests administrator approval.' };
}

/** Close only the cache WHAM explicitly opened for its extension-host process. */
export async function closeElevationSessions(): Promise<void> {
  const sessions = [...elevationSessions]; elevationSessions.clear();
  await Promise.all(sessions.map(async ([executable, opening]) => {
    try { await opening; await promisify(execFile)(executable, ['cache', 'off', '--pid', String(process.pid)], { windowsHide: true, timeout: 5000 }); }
    catch { /* gsudo also closes the cache when its allowed process exits. */ }
  }));
}

export interface WindhawkInstallation {
  root: string; version?: string; parser: boolean; cli: boolean;
  compileFlags?: string[]; notice?: string;
}
export interface ParsedModSource {
  metadata: Record<string, string | string[]> | null; readme: string | null;
  initialSettings: InitialSetting[] | null;
  errors: { metadata?: string; readme?: string; initialSettings?: string };
}
export interface InitialSetting {
  key: string; value: string | number | boolean | InitialSetting[] | unknown[];
  name?: string; description?: string; [annotation: string]: unknown;
}
export interface InstalledMod {
  config: { disabled: boolean; libraryFileName?: string; nuked?: string; [key: string]: unknown } | null;
}
export class WindhawkError extends Error {
  constructor(message: string, public code = 'INTERNAL', public details?: Record<string, unknown>, public stderr = '') { super(message); }
}

/** Own the CLI/compiler process tree; cancellation and deadlines share its job. */
export async function runWindhawkProcess(executable: string, args: string[], input?: string, options: { signal?: AbortSignal; timeoutMs?: number; onOutput?: (text: string, channel: 'stdout' | 'stderr') => void; cwd?: string; elevation?: InstallationPreferences } = {}) {
  if (options.signal?.aborted) throw new WindhawkError('Compilation stopped.', 'CANCELED');
  const helper = path.join(__dirname, `windhawk-bridge-${process.arch}.exe`);
  const event = 'Local\\WHAM-' + randomBytes(16).toString('hex');
  const elevated = options.elevation && options.elevation.elevation !== 'none' ? await inspectElevation(options.elevation) : undefined;
  if (elevated && options.elevation?.elevation === 'gsudo' && options.elevation.reuseSession) {
    let opening = elevationSessions.get(elevated.executable!);
    if (!opening) {
      // The cache intentionally outlives this command; an owned process job
      // would close it as soon as the cache-start command returned.
      opening = promisify(execFile)(elevated.executable!, ['cache', 'on', '--pid', String(process.pid), '--duration', '-1'], { windowsHide: true, signal: options.signal, timeout: 120000 })
        .then(() => {}).catch(async error => {
          elevationSessions.delete(elevated.executable!);
          await promisify(execFile)(elevated.executable!, ['cache', 'off', '--pid', String(process.pid)], { windowsHide: true, timeout: 5000 }).catch(() => {});
          const canceled = error.code === 999 || error.code === 'ABORT_ERR';
          throw new WindhawkError(canceled ? 'Operation canceled.' : error.stderr || 'gsudo could not start an elevation session.', canceled ? 'CANCELED' : 'ELEVATION_FAILED');
        });
      elevationSessions.set(elevated.executable!, opening);
    }
    await opening;
  }
  if (options.signal?.aborted) throw new WindhawkError('Operation canceled.', 'CANCELED');
  // gsudo's cache is bound to its direct caller. Launch it from the extension
  // host, not from a short-lived runner with a different parent PID.
  const control = elevated ? spawn(helper, ['control', event], { windowsHide: true, shell: false }) : undefined;
  if (control) {
    control.stdin.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject); control.once('close', () => reject(new Error('Cannot create the elevation cancellation event.')));
        control.stdout.once('data', () => resolve());
      });
    } catch (error) { control.stdin.end(); throw error; }
  }
  if (options.signal?.aborted) { control?.stdin.end(); throw new WindhawkError('Operation canceled.', 'CANCELED'); }
  const launch = elevated ? [...(options.elevation!.elevation === 'gsudo' ? ['--direct', '--loglevel', 'Error'] : ['--inline']), helper, 'worker', event, String(process.pid), executable, ...args] : ['run', event, executable, ...args];
  const child = spawn(elevated?.executable ?? helper, launch, { windowsHide: true, shell: false, cwd: options.cwd });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '', finished = false, cancellation: WindhawkError | undefined;
  let cancellationDeadline: NodeJS.Timeout | undefined;
  const cancel = (reason: WindhawkError) => {
    if (finished || cancellation) return;
    cancellation = reason;
    void promisify(execFile)(helper, ['cancel', event], { windowsHide: true, timeout: 5000 }).catch(() => { if (!finished) child.kill(); });
    if (elevated) cancellationDeadline = setTimeout(() => { if (!finished) child.kill(); }, 15000);
  };
  const abort = () => cancel(new WindhawkError('Compilation stopped.', 'CANCELED'));
  options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => cancel(new WindhawkError('Windhawk operation timed out.', 'TIMED_OUT')), options.timeoutMs ?? 15000);
  for (const [stream, channel] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', chunk => {
    const remaining = 32 * 1024 * 1024 - stdout.length - stderr.length;
    if (remaining <= 0) { cancel(new WindhawkError('Windhawk returned too much output.', 'OUTPUT_LIMIT')); return; }
    const text = String(chunk).slice(0, remaining);
    if (channel === 'stdout') stdout += text; else stderr += text;
    options.onOutput?.(text, channel);
    if (text.length < String(chunk).length) cancel(new WindhawkError('Windhawk returned too much output.', 'OUTPUT_LIMIT'));
  });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    // A completed install can win a late cancellation: report its actual result.
    if (code !== 0 && cancellation) throw cancellation;
    return { code, stdout, stderr };
  } finally {
    finished = true; clearTimeout(timeout); clearTimeout(cancellationDeadline); options.signal?.removeEventListener('abort', abort);
    control?.stdin.end();
  }
}

/** Optional, session-free parsing and compiler flags. All installed-state access uses the CLI. */
export async function invokeWindhawkCore(root: string, command: string, params: Record<string, unknown> = {}): Promise<any> {
  if (!['parseModSource', 'getCompileFlags'].includes(command)) throw new Error('Unsupported Windhawk parsing command.');
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Windhawk integration requires Windows x64 or ARM64.');
  const helper = path.join(__dirname, `windhawk-bridge-${process.arch}.exe`);
  const request = JSON.stringify({ command, params });
  const child = spawn(helper, [path.join(root, 'windhawk-core.dll'), 'stateless'], { windowsHide: true, shell: false });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let stdout = '', stderr = '';
  const timeout = setTimeout(() => child.kill(), 15000);
  child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 32 * 1024 * 1024) child.kill(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.stdin.on('error', () => { /* A loader error is reported through stderr/exit. */ });
  child.stdin.end(request);
  let code: number | null;
  try { code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); }
  let reply;
  try { reply = JSON.parse(stdout); } catch { throw new WindhawkError(stderr || 'Windhawk parser is unavailable. Rebuild the WHAM native bridge or update Windhawk.'); }
  if (code !== 0 || !reply.ok) throw new WindhawkError(reply.error?.message || stderr || 'Windhawk core read failed.', reply.error?.code, reply.error?.details, stderr);
  return reply.result;
}

/** Installed-state reads and runtime actions share the CLI's JSON envelope. */
export async function runWindhawkCli(root: string, args: string[], input?: string, onOutput?: (text: string) => void, signal?: AbortSignal, elevation?: InstallationPreferences): Promise<any> {
  const { code, stdout, stderr } = await runWindhawkProcess(path.join(root, 'windhawk-cli.exe'), ['--app-root', root, '--json', ...args], input,
    { signal, elevation, timeoutMs: args[1] === 'install' ? 600000 : elevation?.elevation && elevation.elevation !== 'none' ? 120000 : 15000, onOutput: (text, channel) => { if (channel === 'stderr') onOutput?.(text); } });
  let reply;
  try { reply = JSON.parse(stdout); } catch {
    if (code === 999 || code === 1223 || /cancell?ed by (?:the )?user|user declined|operation was canceled/i.test(stderr)) throw new WindhawkError('Operation canceled.', 'CANCELED');
    throw new WindhawkError(stderr || 'Windhawk CLI returned an invalid response.');
  }
  if (code !== 0 || reply.schemaVersion !== 1 || reply.success !== true) {
    let message = reply.error?.message || 'Windhawk command failed.';
    if ((!elevation || elevation.elevation === 'none') && (reply.error?.details?.osError === 5 || /ACCESS_DENIED/.test(reply.error?.code ?? '') || /permission denied|access is denied|RegCreateKeyEx/i.test(message + stderr + String(reply.error?.details?.output ?? ''))))
      message += ' Choose an elevation method for this Windhawk installation in Settings → Extension settings.';
    throw new WindhawkError(message, reply.error?.code, reply.error?.details, stderr);
  }
  return reply.data;
}

/** A missing installation is distinct from a permission/protocol failure. */
export async function readInstalledMod(root: string, modId: string): Promise<InstalledMod> {
  try {
    const result = await runWindhawkCli(root, ['mod', 'config', 'get', modId]);
    if (result?.id !== modId || typeof result?.config?.disabled !== 'boolean') throw new Error('Windhawk returned an unsupported mod configuration.');
    return { config: result.config };
  } catch (error) {
    if (error instanceof WindhawkError && error.code === 'MOD_NOT_INSTALLED') return { config: null };
    throw error;
  }
}

/** Match the pinned renderer's shipped translations; use the same locale for parsing. */
export function previewLanguage(language: string): string {
  const supported = ['ar','az','bn','cs','da','de','el','en','es','fa','fr','hi','hr','ht','hu','id','it','ja','ko','nb','nl','or','pl','pt-BR','pt-PT','ro','ru','sv','ta','th','tr','uk','uz','vi','zh-CN','zh-TW'];
  const requested = language.toLowerCase();
  return supported.find(locale => locale.toLowerCase() === requested) ?? supported.find(locale => locale.toLowerCase() === requested.split('-')[0]) ?? supported.find(locale => locale.toLowerCase().startsWith(requested.split('-')[0] + '-')) ?? 'en';
}

/** Open the selected installation, including older versions without the CLI. */
export async function openWindhawk(root: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Opening Windhawk requires Windows.');
  let executable: string | undefined;
  for (const name of ['windhawk-ui.exe', 'windhawk.exe']) {
    const candidate = path.join(root, name);
    try { if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (!executable) throw new Error('Windhawk could not be found. Select its installation in Settings → Extension settings.');
  try {
    const child = spawn(executable, [], { cwd: root, windowsHide: true, shell: false, detached: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve); });
    child.unref();
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new Error('Windhawk could not be opened. Check its installation path or open it manually.', { cause: error });
    // ShellExecute handles executable manifests/UAC, unlike direct CreateProcess.
    // Paths are passed as data, without embedding them in a PowerShell command.
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:WHAM_LAUNCH_EXE -WorkingDirectory $env:WHAM_LAUNCH_ROOT -ErrorAction Stop'], {
        windowsHide: true, env: { ...process.env, WHAM_LAUNCH_EXE: executable, WHAM_LAUNCH_ROOT: root }
      });
    } catch (launchError) { throw new Error('Windhawk could not be opened. Allow its Windows prompt or open it manually.', { cause: launchError }); }
  }
}

export async function inspectWindhawk(root: string): Promise<WindhawkInstallation> {
  const result: WindhawkInstallation = { root, parser: false, cli: false };
  if (!root) { result.notice = 'Select your Windhawk installation in Settings → Extension settings.'; return result; }
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    result.notice = 'Compile and installed-mod controls require Windows x64 or ARM64. Source previews remain available.'; return result;
  }
  try {
    const version = await promisify(execFile)(path.join(root, 'windhawk-cli.exe'), ['--version'], { windowsHide: true, timeout: 5000 });
    result.version = /windhawk-cli\s+(\S+)/.exec(version.stdout)?.[1];
    // Probe the commands we use, rather than rejecting beta/RC or future version names.
    await Promise.all([['mod', 'install'], ['mod', 'enable'], ['mod', 'disable'], ['mod', 'config', 'get']].map(command => promisify(execFile)(path.join(root, 'windhawk-cli.exe'), [...command, '--help'], { windowsHide: true, timeout: 5000 })));
    result.cli = true;
  } catch { /* Older Windhawk installations have no compatible CLI. */ }
  try {
    result.compileFlags = await invokeWindhawkCore(root, 'getCompileFlags');
    if (!Array.isArray(result.compileFlags) || !result.compileFlags.every(flag => typeof flag === 'string')) result.compileFlags = undefined;
  } catch { /* The bundled Draft preview uses WHAM's local parser instead. */ }
  try {
    const parsed = await invokeWindhawkCore(root, 'parseModSource', { source: '// ==WindhawkMod==\n// @id wham-parser-probe\n// @name Parser probe\n// @version 1\n// ==/WindhawkMod==\n', language: 'en' });
    result.parser = parsed?.metadata?.id === 'wham-parser-probe' && parsed.errors && typeof parsed.errors === 'object' &&
      (parsed.initialSettings === null || Array.isArray(parsed.initialSettings));
  } catch { /* Compiler flags and source parsing are independent capabilities. */ }
  if (!result.cli) result.notice = 'Compile and installed-mod controls need a compatible Windhawk 2.0 CLI. Update Windhawk to use them. Source previews remain available.';
  return result;
}
