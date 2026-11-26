import fs from 'node:fs/promises';
import path from 'node:path';
import { outputPath } from './config';
import { generateEntry } from './engine';
import { nodeFiles } from './io';
import { parseMetadata } from './metadata';
import type { InstallationPreferences } from './preferences';
import {
  compileStatus,
  CompiledSnapshot,
  EntryState,
  installedModKey,
  localModId,
  ProjectState,
  sameFile,
  setBusy,
  sourceHash
} from './projects';
import type { Diagnostic, GenerationResult } from './types';
import { WindhawkError } from './windhawk';
import type * as windhawk from './windhawk';
import type { checkModBuild } from './compiler';

/** The Windhawk CLI and compiler calls runtime operations make; injected so tests can fake them. */
export interface RuntimeTools {
  inspectWindhawk: typeof windhawk.inspectWindhawk;
  readInstalledMod: typeof windhawk.readInstalledMod;
  runWindhawkCli: typeof windhawk.runWindhawkCli;
  runWindhawkProcess: typeof windhawk.runWindhawkProcess;
  checkModBuild: typeof checkModBuild;
}

/** What runtime operations need from the extension. */
export interface RuntimeHost {
  isDisposed(): boolean;
  projects(): Iterable<ProjectState>;
  log: { append(text: string): void; appendLine(line: string): void; show(preserveFocus?: boolean): void };
  publish(): void;
  inform(message: string): void;
  showError(message: string): void;
  /** Ask for a compiler and its JSON arguments when no Windhawk installation is selected. */
  promptCompiler(): Promise<{ executable: string; argumentsJson: string } | undefined>;
  /** Offer to save unsaved relevant files; false when the user declines. */
  saveRelevant(state: ProjectState): Promise<boolean>;
  enqueue(state: ProjectState, targets: string[]): Promise<void>;
  refreshDraft(state: ProjectState, entries?: EntryState[]): Promise<void>;
  refreshEditorConfiguration(state: ProjectState): Promise<void>;
  /** How to elevate Windhawk CLI calls; one choice for the selected installation. */
  installationPreferences(): InstallationPreferences;
  compiledSnapshots(): Record<string, CompiledSnapshot>;
  saveCompiledSnapshots(builds: Record<string, CompiledSnapshot>): PromiseLike<unknown>;
  tools: RuntimeTools;
}

const compilerLocation = /(?:^|\n)([^\n]+\.(?:wh\.)?cpp|<stdin>):(\d+):(\d+):\s*(error|warning):\s*([^\n]+)/g;

/**
 * Map `file:line:column: error: message` lines in compiler output, whose lines refer to the
 * generated file, back to the source file and line each came from. Unmappable lines are skipped.
 */
export function mapCompilerDiagnostics(output: string, snapshot: GenerationResult): Diagnostic[] {
  if (!snapshot.bytes) return [];
  const text = snapshot.bytes.toString();
  const diagnostics: Diagnostic[] = [];
  for (const match of output.matchAll(compilerLocation)) {
    const line = Number(match[2]) - 1;
    let offset = 0;
    for (let index = 0; index < line; index++) {
      const next = text.indexOf('\n', offset);
      if (next < 0) break;
      offset = next + 1;
    }
    const span = snapshot.spans.find(span => span.outputStart <= offset && offset < span.outputEnd);
    if (span)
      diagnostics.push({
        path: span.path,
        line: span.sourceLine + text.slice(span.outputStart, offset).split('\n').length - 1,
        severity: match[4] as 'error' | 'warning',
        message: match[5].trim()
      });
  }
  return diagnostics;
}

/** Parse Verify's custom compiler arguments: a JSON string array; `{file}` marks the output. */
export function parseCompilerArguments(argumentsJson: string, file: string): string[] {
  const argumentsList: unknown = JSON.parse(argumentsJson);
  if (!Array.isArray(argumentsList) || argumentsList.some(argument => typeof argument !== 'string'))
    throw new Error('Compiler arguments must be a JSON string array.');
  const args = (argumentsList as string[]).map(argument => argument.replaceAll('{file}', file));
  if (!(argumentsList as string[]).some(argument => argument.includes('{file}'))) args.push(file);
  return args;
}

/**
 * Operations against an installed Windhawk: test builds, compile-and-install, enable and
 * disable, syntax verification, cancellation, and polling installed state. An installed mod
 * can be shared by several projects, so one operation per mod runs at a time.
 */
export function createRuntimeOperations(host: RuntimeHost) {
  /** The entry running an operation on each installed mod, keyed by installedModKey. */
  const installedOperations = new Map<string, EntryState>();
  const stopped = (state: ProjectState) => host.isDisposed() || !!state.removed;
  const { tools, log } = host;

  // Saved Windhawk source is editable without compilation. Only a successful build
  // links our submitted snapshot to the compiler-owned library identity.
  const updateCompileStatus = (state: ProjectState, entry: EntryState) => {
    if (!entry.runtime) return;
    const key = installedModKey(state.editor.installationPath, entry.runtime.id);
    entry.runtime.compileStatus = compileStatus(entry, host.compiledSnapshots()[key]);
    entry.runtime.changesPending = entry.runtime.compileStatus === 'uncompiled';
  };

  /** Re-inspect the installation when its CLI or core changed, then read each mod's installed state. */
  const refreshRuntime = async (state: ProjectState) => {
    if (stopped(state)) return;
    const root = state.editor.installationPath;
    const stamp = root
      ? (
          await Promise.all(
            ['windhawk-cli.exe', 'windhawk-core.dll'].map(async file => {
              try {
                const stat = await fs.stat(path.join(root, file));
                return file + ':' + stat.size + ':' + stat.mtimeMs;
              } catch {
                return file + ':missing';
              }
            })
          )
        ).join('|')
      : '';
    if (!state.windhawk || state.windhawk.root !== root || state.windhawkStamp !== stamp) {
      state.windhawk = await tools.inspectWindhawk(root);
      state.windhawkStamp = stamp;
      await host.refreshDraft(state);
    }
    const installation = state.windhawk;
    const entries = [...state.entries.values()];
    await Promise.all(
      entries.map(async entry => {
        if (!entry.runtime) return;
        if (!installation.cli || !entry.runtime.id) {
          entry.installed = undefined;
          return;
        }
        try {
          entry.installed = await tools.readInstalledMod(root, entry.runtime.id);
          entry.runtime.error = entry.buildError;
        } catch (error) {
          entry.installed = undefined;
          entry.runtime.error = (error as Error).message;
        }
      })
    );
    for (const entry of entries) {
      if (!entry.runtime) continue;
      entry.runtime.installed = !!entry.installed?.config;
      entry.runtime.enabled = !!entry.installed?.config && !entry.installed.config.disabled;
      updateCompileStatus(state, entry);
      entry.runtime.busy = !!entry.busy;
      entry.runtime.operation = entry.busy;
      entry.runtime.stopping = entry.stopping;
    }
    await host.refreshEditorConfiguration(state);
    host.publish();
  };

  /**
   * Test build (`testOnly`): compile a fresh snapshot into temporary DLLs, installing nothing.
   * Otherwise generate, then install with Windhawk, keeping Enabled as it was (first builds
   * start disabled), and record which source produced the build.
   */
  const compileMod = async (state: ProjectState, entry: EntryState, testOnly = false) => {
    if (entry.busy || stopped(state)) return;
    const installation = state.windhawk;
    const root = testOnly ? state.editor.installationPath : (installation?.root ?? state.editor.installationPath);
    if (!testOnly && entry.runtime?.id && installedOperations.has(installedModKey(root, entry.runtime.id))) {
      host.inform('This mod already has an operation running.');
      return;
    }
    if (!testOnly && !installation?.cli) {
      host.inform(installation?.notice ?? 'Select your Windhawk installation in Settings → Extension settings.');
      return;
    }
    // Settings can change while saving or generating the source.
    const elevation = testOnly ? undefined : host.installationPreferences();
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, testOnly ? 'test' : 'compile');
    entry.buildError = undefined;
    host.publish();
    let snapshot: GenerationResult | undefined;
    let operationKey: string | undefined;
    try {
      if (!(await host.saveRelevant(state))) return;
      if (abort.signal.aborted) throw new WindhawkError('Compilation stopped.', 'CANCELED');
      if (testOnly) {
        snapshot = await generateEntry(state.project, entry.path, nodeFiles);
        if (!snapshot.bytes || snapshot.diagnostics.some(issue => issue.severity === 'error'))
          throw new Error(snapshot.diagnostics.map(issue => issue.message).join('\n'));
        const result = await tools.checkModBuild(
          root,
          snapshot.bytes.toString(),
          abort.signal,
          text => log.append(text),
          installation?.version
        );
        if (result?.warnings) log.show(true);
        entry.compilerDiagnostics = [];
        log.appendLine('Test build passed. No mod was installed.');
        host.inform('Test build passed.');
        return;
      }
      await host.enqueue(state, [entry.path]);
      if (abort.signal.aborted) throw new WindhawkError('Compilation stopped.', 'CANCELED');
      if (entry.status !== 'current' || !entry.result?.bytes || !entry.runtime?.id)
        throw new Error(entry.message || entry.runtime?.error || 'Generate a valid output before compiling.');
      snapshot = entry.result;
      const source = entry.result.bytes.toString();
      const modId = localModId(parseMetadata(source, entry.path).fields.id?.[0]);
      if (!modId) throw new Error('Add a valid @id before compiling.');
      const key = installedModKey(root, modId);
      if (installedOperations.has(key)) {
        host.inform('This mod already has an operation running.');
        return;
      }
      operationKey = key;
      installedOperations.set(key, entry);
      host.publish();
      const installed = await tools.readInstalledMod(root, modId);
      const installDisabled = !installed.config || installed.config.disabled;
      log.appendLine(`Compile ${modId} from ${entry.path}`);
      const result = await tools.runWindhawkCli(
        root,
        ['mod', 'install', '--file', '-', ...(installDisabled ? ['--disabled'] : [])],
        source,
        text => log.append(text),
        abort.signal,
        elevation
      );
      if (result.id !== modId) throw new Error('Windhawk returned an unexpected compiled mod ID.');
      const library = result.config?.libraryFileName;
      const builds = { ...host.compiledSnapshots() };
      if (typeof library === 'string' && library)
        builds[key] = { sourceHash: sourceHash(source), libraryFileName: library };
      else delete builds[key]; // An unsupported reply cannot retain a previous build's proof.
      await host.saveCompiledSnapshots(builds);
      entry.compilerDiagnostics = [];
      if (result.warnings) {
        log.appendLine(String(result.warnings));
        log.show(true);
      }
      log.appendLine('Compilation succeeded.');
      // Refresh once in finally, including edits made while this snapshot compiled.
    } catch (error) {
      if (error instanceof WindhawkError && error.code === 'CANCELED') {
        log.appendLine('Compilation stopped.');
        return;
      }
      entry.buildError = (error as Error).message;
      log.appendLine(String(error));
      const output = error instanceof WindhawkError ? String(error.details?.output ?? error.stderr) : '';
      if (error instanceof WindhawkError && error.details?.output) log.appendLine(String(error.details.output));
      log.show(true);
      entry.compilerDiagnostics = snapshot ? mapCompilerDiagnostics(output, snapshot) : [];
      host.showError(entry.buildError);
    } finally {
      try {
        await host.refreshDraft(state, [entry]);
        if (!testOnly)
          for (const project of host.projects()) {
            if (
              project === state ||
              (operationKey &&
                [...project.entries.values()].some(
                  peer =>
                    peer.runtime?.id &&
                    installedModKey(project.editor.installationPath, peer.runtime.id) === operationKey
                ))
            )
              await refreshRuntime(project);
          }
      } finally {
        if (operationKey && installedOperations.get(operationKey) === entry) installedOperations.delete(operationKey);
        entry.abort = undefined;
        setBusy(entry, undefined);
        host.publish();
      }
    }
  };

  /** Enable or disable the installed build, updating every project's card for that mod. */
  const enableMod = async (state: ProjectState, entry: EntryState, enabled: boolean) => {
    if (entry.busy || stopped(state)) return;
    if (!state.windhawk?.cli || !entry.runtime?.id || !entry.installed?.config) {
      host.inform(state.windhawk?.notice ?? 'Compile this mod before enabling it.');
      return;
    }
    const root = state.windhawk.root,
      modId = entry.runtime.id,
      key = installedModKey(root, modId);
    if (installedOperations.has(key)) {
      host.inform('This mod already has an operation running.');
      return;
    }
    installedOperations.set(key, entry);
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, enabled ? 'enable' : 'disable');
    host.publish();
    try {
      const result = await tools.runWindhawkCli(
        root,
        ['mod', enabled ? 'enable' : 'disable', modId],
        undefined,
        undefined,
        abort.signal,
        host.installationPreferences()
      );
      if (result?.id !== modId || result.enabled !== enabled)
        throw new Error('Windhawk returned an unsupported enable/disable response. Update Windhawk.');
      // The CLI confirms the change. Keep the installed source and Draft untouched.
      for (const project of host.projects())
        if (sameFile(project.editor.installationPath, root))
          for (const peer of project.entries.values()) {
            if (peer.runtime?.id !== modId || !peer.installed?.config) continue;
            peer.installed.config.disabled = !result.enabled;
            peer.runtime.enabled = result.enabled;
            peer.runtime.error = peer.buildError;
          }
    } catch (error) {
      if (error instanceof WindhawkError && error.code === 'CANCELED') {
        log.appendLine('Operation canceled.');
        return;
      }
      entry.runtime.error = (error as Error).message;
      throw error;
    } finally {
      if (installedOperations.get(key) === entry) installedOperations.delete(key);
      entry.abort = undefined;
      setBusy(entry, undefined);
      host.publish();
    }
  };

  /** Syntax-check the saved output with Windhawk's compiler, or a compiler the user names. */
  const verify = async (state: ProjectState, entry: EntryState) => {
    if (entry.busy || stopped(state)) return;
    const root = state.editor.installationPath;
    const windhawkVersion = state.windhawk?.version;
    let executable: string | undefined,
      args: string[] = [];
    const file = outputPath(state.project, entry.path);
    if (!root) {
      const compiler = await host.promptCompiler();
      if (!compiler) return;
      executable = compiler.executable;
      args = parseCompilerArguments(compiler.argumentsJson, file);
    }
    if (stopped(state)) return;
    log.appendLine('Verify ' + file);
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, 'verify');
    host.publish();
    try {
      if (root) {
        const source = await fs.readFile(file, 'utf8');
        const result = await tools.checkModBuild(
          root,
          source,
          abort.signal,
          text => log.append(text),
          windhawkVersion,
          true
        );
        if (result?.warnings) log.show(true);
      } else {
        const result = await tools.runWindhawkProcess(executable!, args, undefined, {
          signal: abort.signal,
          timeoutMs: 600000,
          onOutput: text => log.append(text),
          cwd: state.project.root
        });
        if (result.code !== 0) throw new Error('Syntax verification failed (exit ' + result.code + ').');
        if (/\bwarning:/i.test(result.stderr + '\n' + result.stdout)) log.show(true);
      }
      log.appendLine('Syntax verification passed.');
      host.inform('Syntax verification passed.');
    } catch (error) {
      if (error instanceof WindhawkError && error.code === 'CANCELED') log.appendLine('Verification stopped.');
      else {
        log.show(true);
        throw error;
      }
    } finally {
      entry.abort = undefined;
      setBusy(entry, undefined);
      host.publish();
    }
  };

  /** The entry whose operation holds this entry's installed mod, if it is another card's. */
  const operationOwner = (state: ProjectState, entry: EntryState) =>
    entry.runtime?.id
      ? installedOperations.get(installedModKey(state.editor.installationPath, entry.runtime.id))
      : undefined;

  /** Stop this entry's operation, or the one another project's card started for the same mod. */
  const stopOperation = (state: ProjectState, entry: EntryState) => {
    const owner = entry.abort ? entry : operationOwner(state, entry);
    if (owner?.abort && !owner.abort.signal.aborted) {
      owner.stopping = true;
      if (owner.runtime) owner.runtime.stopping = true;
      owner.abort.abort();
      host.publish();
    }
  };

  return {
    updateCompileStatus,
    refreshRuntime,
    compileMod,
    enableMod,
    verify,
    stopOperation,
    operationOwner,
    installedOperations
  };
}
