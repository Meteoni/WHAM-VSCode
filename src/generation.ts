import fs from 'node:fs/promises';
import path from 'node:path';
import { contained, discoverEntries, outputPath, portableRelative } from './config';
import { checksum, generateEntry } from './engine';
import {
  assertSafeDestination,
  changedSince,
  inputsUnchanged,
  loadProject,
  nodeFiles,
  readIfExists,
  writeOutput
} from './io';
import { parseMetadata } from './metadata';
import { dependsOn, EntryState, ownedOutput, ProjectState, sameFile } from './projects';
import { GenerationTiming } from './types';

/**
 * What the generation pipeline needs from its environment. The extension implements it
 * with VS Code; tests use fakes. Paths are absolute.
 */
export interface GenerationHost {
  isDisposed(): boolean;
  /** Whether any open editor has unsaved changes for this file. */
  isDirty(file: string): boolean;
  /** Unsaved text of an open editor for this file, if any. */
  dirtyText(file: string): string | undefined;
  /** Every local file with unsaved changes in an open editor. */
  dirtyFiles(): string[];
  log(line: string): void;
  /** Push the current state to the status bar and sidebar. */
  publish(): void;
  /** Rebuild the Problems view from entry diagnostics. */
  presentDiagnostics(): void;
  /** Persist which outputs WHAM owns, keyed by output path. */
  saveHashes(hashes: Record<string, string>): PromiseLike<unknown>;
  gitStatus(root: string): Promise<ProjectState['git']>;
  /** Rebuild previews, metadata and runtime views for these entries (includes their output status). */
  refreshDraft(state: ProjectState, entries?: EntryState[]): Promise<void>;
  /** Re-read installed mod state from Windhawk. */
  refreshRuntime(state: ProjectState): Promise<void>;
  /** Re-check whether generated editor configuration needs applying. */
  refreshEditorConfiguration(state: ProjectState): Promise<void>;
  /** An editor configuration file in the project changed on disk. */
  editorFilesChanged(state: ProjectState): Promise<void>;
  /** When this project generates: after saves or manually, and the debounce. */
  timing(state: ProjectState): GenerationTiming;
}

/** Editor configuration files WHAM generates; changes to them refresh editor state only. */
const editorFiles = [
  '.vscode/settings.json',
  '.vscode/c_cpp_properties.json',
  '.vscode/extensions.json',
  '.clang-format',
  '.clangd'
];

/**
 * Save → debounce → generate → protected write, per project. All work for a project runs on
 * its `queue`, so generations, refreshes and configuration changes never interleave.
 */
export function createGenerationPipeline(host: GenerationHost, storedHashes: Record<string, string>) {
  const stopped = (state: ProjectState) => host.isDisposed() || !!state.removed;

  /**
   * Unsaved files that generation would miss: the project configuration plus, for an entry,
   * its own inputs (or any source file before its first generation), else any source file.
   */
  const relevantDirty = (state: ProjectState, entry?: EntryState): string[] => {
    const source = path.join(state.project.root, state.project.config.sourceDirectory);
    return host
      .dirtyFiles()
      .filter(
        file =>
          sameFile(file, path.join(state.project.root, 'windhawk-amalgamation.json')) ||
          (entry
            ? sameFile(file, entry.path) ||
              dependsOn(entry, file) ||
              (!entry.draft && !entry.result && contained(source, file))
            : contained(source, file))
      );
  };

  /** Set an entry's output status from the Draft and what is on disk. Used by Draft refreshes. */
  const reconcileOutput = async (state: ProjectState, entry: EntryState) => {
    const output = outputPath(state.project, entry.path);
    if (host.isDirty(output)) {
      entry.status = 'blocked';
      entry.message = 'Output has unsaved edits.';
    } else if (relevantDirty(state, entry).length) {
      entry.status = 'pending';
      entry.message = 'Waiting for source buffers to be saved.';
    } else {
      const existing = await readIfExists(output);
      if (existing && entry.draft?.bytes?.equals(existing)) {
        entry.status = 'current';
        entry.ownedHash = checksum(existing);
        storedHashes[output] = entry.ownedHash;
        entry.message = entry.draft.dependencies.size + ' source file(s)';
      } else if (existing && !ownedOutput(existing, entry, state.project.root)) {
        entry.status = 'blocked';
        entry.message = 'Output was edited. Compare, restore edits, or explicitly discard them.';
      } else {
        entry.status = 'stale';
        entry.message = entry.draft?.diagnostics.find(item => item.severity === 'error')?.message;
      }
    }
  };

  /** Debounce Draft refreshes (and optionally an installed-state poll) for these entries. */
  const scheduleRefresh = (state: ProjectState, pollInstalled = false, entries = [...state.entries.values()]) => {
    if (stopped(state)) return;
    for (const entry of entries) state.draftPending.add(entry.path);
    state.pollInstalled ||= pollInstalled;
    if (state.runtimeTimer) clearTimeout(state.runtimeTimer);
    state.runtimeTimer = setTimeout(() => {
      if (state.runtimePending || stopped(state)) return;
      state.runtimePending = true;
      state.queue = state.queue
        .then(async () => {
          if (stopped(state)) return;
          state.runtimePending = false;
          const poll = state.pollInstalled;
          state.pollInstalled = false;
          const entries = [...state.draftPending]
            .map(file => state.entries.get(file))
            .filter((entry): entry is EntryState => !!entry);
          state.draftPending.clear();
          if (entries.length) await host.refreshDraft(state, entries);
          if (poll) await host.refreshRuntime(state);
        })
        .catch(error => {
          state.runtimePending = false;
          host.log(String(error));
        });
    }, 350);
  };

  /**
   * Reload configuration and entries. Outputs of removed or moved entries are deleted only
   * when WHAM wrote them and they are not open with edits; others are kept with a notice.
   */
  const refresh = async (state: ProjectState) => {
    if (stopped(state)) return;
    state.project = await loadProject(state.project.root);
    const entries = await discoverEntries(state.project, nodeFiles);
    if (state.removed) return;
    for (const previous of [...state.entries.values()]) {
      const stillExists = entries.includes(previous.path);
      const nextOutput = stillExists ? outputPath(state.project, previous.path) : undefined;
      if (stillExists && nextOutput === previous.output) continue;
      const output = previous.output;
      try {
        const existing = await fs.readFile(output);
        if (ownedOutput(existing, previous, state.project.root) && !host.isDirty(output)) {
          await assertSafeDestination(state.project.root, portableRelative(state.project.root, output));
          if (state.removed) return;
          await fs.rm(output);
          delete storedHashes[output];
        } else state.retained.push(`Preserved orphan output: ${output}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') host.log(String(error));
      }
      state.entries.delete(previous.path);
    }
    for (const entry of entries)
      if (!state.entries.has(entry))
        state.entries.set(entry, {
          path: entry,
          output: outputPath(state.project, entry),
          status: 'stale',
          ownedHash: storedHashes[outputPath(state.project, entry)]
        });
    for (const entry of state.entries.values())
      entry.metadata = parseMetadata(host.dirtyText(entry.path) ?? (await fs.readFile(entry.path, 'utf8')), entry.path);
    state.error = undefined;
    state.git = await host.gitStatus(state.project.root);
    host.presentDiagnostics();
  };

  /** Generate one entry from saved files and write it unless that would lose output edits. */
  const generate = async (state: ProjectState, entry: EntryState, force: boolean, automatic = false) => {
    // The mode can change while work is queued or while it reads the saved files.
    const canGenerate = () => !stopped(state) && (!automatic || host.timing(state).generate === 'onSave');
    if (!canGenerate()) return;
    const output = outputPath(state.project, entry.path);
    if (host.isDirty(output)) {
      entry.status = 'blocked';
      entry.message = 'Output has unsaved edits. Save or revert it before regenerating.';
      host.publish();
      return;
    }
    if (relevantDirty(state, entry).length) {
      entry.status = 'pending';
      entry.message = 'Waiting for source buffers to be saved.';
      host.publish();
      return;
    }
    entry.status = 'generating';
    entry.message = undefined;
    host.publish();
    // Reuse the Draft when it was built from exactly the saved inputs.
    const result =
      entry.draft?.bytes &&
      !entry.draftInvalidated &&
      entry.draftConfig === JSON.stringify(state.project.config) &&
      (await inputsUnchanged(entry.draft.dependencies))
        ? entry.draft
        : await generateEntry(state.project, entry.path, nodeFiles);
    entry.result = result;
    entry.draft = result;
    entry.draftConfig = JSON.stringify(state.project.config);
    entry.draftInvalidated = false;
    for (const diagnostic of result.diagnostics)
      host.log(`${diagnostic.path}:${diagnostic.line + 1}: ${diagnostic.message}`);
    if (!result.bytes) {
      entry.status = 'stale';
      entry.message = result.diagnostics.find(item => item.severity === 'error')?.message;
      return;
    }
    const existing = await readIfExists(output);
    if (existing && !force && !ownedOutput(existing, entry, state.project.root, result.bytes)) {
      entry.status = 'blocked';
      entry.message = 'Output was edited. Compare, restore edits, or explicitly discard them.';
      return;
    }
    if (!(await inputsUnchanged(result.dependencies)) || relevantDirty(state, entry).length) {
      if (!canGenerate()) return;
      entry.status = 'pending';
      entry.message = 'Source changed during generation; queued another pass.';
      schedule(state, [entry.path]);
      return;
    }
    // Recheck output immediately before commit, including documents dirtied during generation.
    if (changedSince(await readIfExists(output), existing) || host.isDirty(output)) {
      entry.status = 'blocked';
      entry.message = 'Output changed during generation; no write performed.';
      return;
    }
    if (!canGenerate()) return;
    // Manual mode may be selected while the replacement is staged or waiting on a file lock.
    if (!existing?.equals(result.bytes) && !(await writeOutput(state.project, output, result.bytes, canGenerate)))
      return;
    entry.ownedHash = checksum(result.bytes);
    storedHashes[output] = entry.ownedHash;
    entry.status = 'current';
    entry.message = `${result.dependencies.size} source file(s)`;
  };

  /**
   * Queue generation of `targets` (default: every entry). Explicit commands rediscover
   * entries first; debounced saves use the known dependency graph (`refreshProject: false`).
   */
  const enqueue = (
    state: ProjectState,
    targets?: string[],
    options: { force?: boolean; refreshProject?: boolean; automatic?: boolean } = {}
  ): Promise<void> => {
    state.queue = state.queue.then(async () => {
      if (stopped(state)) return;
      try {
        if (options.refreshProject !== false) await refresh(state);
        const entries = [...state.entries.values()].filter(entry => !targets || targets.includes(entry.path));
        for (const entry of entries) state.draftPending.delete(entry.path);
        for (const entry of entries) {
          try {
            await generate(state, entry, options.force ?? false, options.automatic);
          } catch (error) {
            entry.status = 'stale';
            entry.message = String(error);
            host.log(String(error));
          }
        }
        await host.saveHashes(storedHashes);
        await host.refreshDraft(state, entries);
        if (options.refreshProject === false) state.git = await host.gitStatus(state.project.root);
      } catch (error) {
        state.error = (error as Error).message;
        host.log(String(error));
      }
      host.presentDiagnostics();
      host.publish();
    });
    return state.queue;
  };

  /** Debounce generation of `targets` by the project's debounce. */
  const schedule = (state: ProjectState, targets: string[]) => {
    if (stopped(state)) return;
    for (const target of targets) {
      state.pending.add(target);
      // Generation reconciles Draft too; retire the earlier typing/save refresh.
      state.draftPending.delete(target);
    }
    if (state.timer) clearTimeout(state.timer);
    const { generate: mode, debounceMs } = host.timing(state);
    state.timer = setTimeout(() => {
      const targets = [...state.pending];
      state.pending.clear();
      void enqueue(state, targets, { refreshProject: false, automatic: mode === 'onSave' });
    }, debounceMs);
  };

  /**
   * A file was saved, created (`discovery`), changed or deleted on disk. Routes it to editor
   * refreshes, output-edit detection, or the affected entries' generation or Draft refresh.
   */
  const changed = (projects: Iterable<ProjectState>, file: string, discovery = false) => {
    for (const state of projects) {
      if (!contained(state.project.root, file)) continue;
      const source = path.join(state.project.root, state.project.config.sourceDirectory),
        output = path.join(state.project.root, state.project.config.outputDirectory);
      if (editorFiles.some(local => sameFile(file, path.join(state.project.root, local)))) {
        state.queue = state.queue.then(async () => {
          if (stopped(state)) return;
          try {
            await host.editorFilesChanged(state);
          } catch (error) {
            host.log(String(error));
          }
        });
        continue;
      }
      if (contained(output, file)) {
        for (const entry of state.entries.values())
          if (sameFile(outputPath(state.project, entry.path), file)) {
            void fs
              .readFile(file)
              .then(bytes => {
                if (entry.ownedHash !== checksum(bytes)) {
                  entry.status = 'blocked';
                  entry.message = 'Generated output changed on disk.';
                  host.publish();
                }
              })
              .catch(() => {
                entry.status = 'stale';
                host.publish();
              });
          }
        continue;
      }
      const configurationChanged = sameFile(file, path.join(state.project.root, 'windhawk-amalgamation.json'));
      const targets = [...state.entries.values()].filter(entry => configurationChanged || dependsOn(entry, file));
      for (const entry of targets) {
        entry.draftInvalidated ||= discovery;
        if (entry.status !== 'blocked') {
          entry.status = 'stale';
          entry.message = 'Saved sources or project configuration changed.';
        }
      }
      // New/deleted .cpp files change the entry list, not every existing mod's inputs.
      if (configurationChanged || (discovery && /\.cpp$/i.test(file) && contained(source, file))) {
        state.queue = state.queue.then(async () => {
          if (stopped(state)) return;
          try {
            await refresh(state);
            if (configurationChanged) await host.refreshEditorConfiguration(state);
            const affected = [...state.entries.values()].filter(
              entry => configurationChanged || !entry.draft || targets.includes(entry)
            );
            if (host.timing(state).generate === 'onSave')
              schedule(
                state,
                affected.map(entry => entry.path)
              );
            else scheduleRefresh(state, false, affected);
          } catch (error) {
            state.error = String(error);
          }
          host.publish();
        });
      } else if (targets.length) {
        if (host.timing(state).generate === 'onSave')
          schedule(
            state,
            targets.map(entry => entry.path)
          );
        else scheduleRefresh(state, false, targets);
        host.publish();
      }
    }
  };

  return { relevantDirty, reconcileOutput, scheduleRefresh, refresh, generate, enqueue, schedule, changed };
}
