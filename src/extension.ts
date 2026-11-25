import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { contained, defaults, discoverEntries, outputPath, portableRelative, validateConfig } from './config';
import { checksum, generateEntry, restoreSource } from './engine';
import {
  assertSafeDestination,
  changedSince,
  commitRestore,
  inputsUnchanged,
  loadProject,
  nodeFiles,
  readIfExists,
  writeOutput
} from './io';
import { GenerationResult, Project } from './types';
import { parseMetadata, parseDraftSource } from './metadata';
import {
  inspectWindhawk,
  inspectElevation,
  closeElevationSessions,
  invokeWindhawkCore,
  runWindhawkCli,
  runWindhawkProcess,
  readInstalledMod,
  WindhawkError,
  previewLanguage
} from './windhawk';
import { ComputerPreferencesInput, createSidebarRouter, ProjectMessage } from './sidebar';
import {
  compileStatus,
  CompiledSnapshot,
  dependsOn,
  EntryState,
  installedModKey,
  localModId,
  ownedOutput,
  pathKey,
  projectSummary,
  ProjectState,
  sameFile,
  setBusy,
  sourceHash
} from './projects';
import { createDetailsView, DetailsData } from './details';
import { checkModBuild } from './compiler';
import { InstallationPreferences, loadLocalPreferences } from './preferences';
import {
  appendIgnoreRules,
  createInitialCommit,
  editorConfiguration,
  EditorSettings,
  findWindhawk,
  gitStatus,
  mergeRecoveries,
  readEditorSettings,
  setupProject
} from './setup';

/** Fill {{name}} placeholders in a webview template; inserted values are not rescanned. */
function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\r\n/g, '\n').replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!(name in values)) throw new Error(`Missing webview template value: ${name}`);
    return values[name];
  });
}

/** Bind the shared engine to workspace lifecycle, project queues, and the sidebar. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('WHAM');
  const diagnostics = vscode.languages.createDiagnosticCollection('wham');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = 'workbench.view.extension.windhawk';
  status.show();
  const projects = new Map<string, ProjectState>();
  const installedOperations = new Map<string, EntryState>();
  let sidebarDetails: { entry: string; controller: ReturnType<typeof createDetailsView> } | undefined;
  let sidebarReceiver: vscode.Disposable | undefined;
  let sidebarHtml = '';
  let sidebarStateJson = '';
  // Keep layout styles in the initial document when moving between list and details.
  const sidebarStyles = await fs.readFile(path.join(context.extensionUri.fsPath, 'media', 'sidebar.css'), 'utf8');
  const sidebarTemplate = await fs.readFile(path.join(context.extensionUri.fsPath, 'media', 'sidebar.html'), 'utf8');
  let pendingSidebarPage: string | undefined;
  const previews = new Map<string, string>();
  let view: vscode.WebviewView | undefined,
    selectedRoot: string | undefined,
    previewId = 0,
    disposed = false;
  const storedHashes = context.workspaceState.get<Record<string, string>>('outputHashes', {});
  const localPreferences = await loadLocalPreferences(context.globalState, context.workspaceState);
  let recentProjects = context.globalState
    .get<string[]>('recentProjects', [])
    .filter(root => typeof root === 'string' && path.isAbsolute(root));
  const initialCommitEnabled = () =>
    vscode.workspace.getConfiguration('wham').get<boolean>('createInitialCommit', false);
  const openAfterSetup = () => vscode.workspace.getConfiguration('wham').get<boolean>('openProjectAfterSetup', true);
  const gitExecutable = () => vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
  /** Whether any open editor holds unsaved changes for this file. Generation reads only saved files. */
  const isDirty = (file: string) =>
    vscode.workspace.textDocuments.some(document => document.isDirty && sameFile(document.uri.fsPath, file));
  const projectPreferences = (root: string) =>
    localPreferences.projects[Object.keys(localPreferences.projects).find(key => sameFile(key, root)) ?? root] ?? {};
  const installationPreferences = (root: string): InstallationPreferences =>
    localPreferences.computer.installations[pathKey(root)] ?? { elevation: 'none', gsudoPath: '' };
  /** Replace a project's local preference entry, whatever casing it was stored under. */
  const setProjectPreference = async (root: string, preference: { integration?: EditorSettings['integration'] }) => {
    const previousKey = Object.keys(localPreferences.projects).find(key => sameFile(key, root));
    if (previousKey) delete localPreferences.projects[previousKey];
    localPreferences.projects[root] = preference;
    await context.globalState.update('localPreferences', localPreferences);
  };
  const resolveEditor = async (root: string) => {
    const formatting = await readEditorSettings(root);
    const overrides = projectPreferences(root);
    return {
      ...formatting,
      installationPath: localPreferences.computer.installationPath,
      integration: overrides.integration ?? localPreferences.computer.integration
    };
  };
  const refreshEditorConfiguration = async (state: ProjectState) => {
    state.editorNeedsApply = true;
    try {
      const files = await editorConfiguration(state.project, state.editor, state.windhawk?.compileFlags);
      for (const [file, expected] of files) {
        const actual = await fs.readFile(path.join(state.project.root, file));
        if (!actual.equals(expected)) return;
      }
      state.editorNeedsApply = false;
    } catch {
      /* Missing files or invalid configuration still need Apply/Review. */
    }
  };
  // Saved Windhawk source is editable without compilation. Only a successful build
  // links our submitted snapshot to the compiler-owned library identity.
  const updateCompileStatus = (state: ProjectState, entry: EntryState) => {
    if (!entry.runtime) return;
    const key = installedModKey(state.editor.installationPath, entry.runtime.id);
    const builds = context.globalState.get<Record<string, CompiledSnapshot>>('compiledSnapshots', {});
    entry.runtime.compileStatus = compileStatus(entry, builds[key]);
    entry.runtime.changesPending = entry.runtime.compileStatus === 'uncompiled';
  };
  const virtual = (label: string, bytes: Buffer | string): vscode.Uri => {
    const uri = vscode.Uri.from({ scheme: 'wham-preview', path: `/${++previewId}/${path.basename(label)}` });
    previews.set(uri.toString(), bytes.toString());
    return uri;
  };
  context.subscriptions.push(
    log,
    diagnostics,
    status,
    vscode.workspace.registerTextDocumentContentProvider('wham-preview', {
      provideTextDocumentContent: uri => previews.get(uri.toString()) ?? ''
    })
  );
  // Each diff/preview gets a fresh URI; keep its text only while the document is open.
  if (vscode.workspace.onDidCloseTextDocument)
    context.subscriptions.push(
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === 'wham-preview') previews.delete(document.uri.toString());
      })
    );
  const active = (): ProjectState | undefined => {
    const editorRoot = vscode.window.activeTextEditor?.document.uri.fsPath;
    return (
      projects.get(selectedRoot ?? '') ??
      [...projects.values()].find(state => editorRoot && contained(state.project.root, editorRoot)) ??
      projects.values().next().value
    );
  };
  const projectChoices = () => [
    ...[...new Set([...recentProjects, ...projects.keys()])].map(root => ({
      label: path.basename(root),
      description: 'Recent project',
      detail: root,
      root
    })),
    { label: 'Browse for a project folder…', description: '', detail: '', root: '' }
  ];
  const publish = () => {
    if (disposed) return;
    const state = active();
    status.text = '$(file-code) WHAM: ' + projectSummary(state);
    status.tooltip = state?.project.root ?? 'Initialize a Windhawk project';
    const sidebarState = {
      type: 'state',
      selected: state?.project.root,
      page: pendingSidebarPage,
      computer: localPreferences.computer,
      openAfterSetup: openAfterSetup(),
      createInitialCommit: initialCommitEnabled(),
      projectChoices: projectChoices(),
      projects: [...projects.values()].map(item => ({
        root: item.project.root,
        name: path.basename(item.project.root),
        config: item.project.config,
        editor: item.editor,
        editorNeedsApply: item.editorNeedsApply,
        local: projectPreferences(item.project.root),
        elevation: installationPreferences(item.editor.installationPath).elevation,
        git: item.git,
        windhawk: item.windhawk,
        opened: !!vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, item.project.root)),
        error: item.error,
        retained: item.retained,
        entries: [...item.entries.values()].map(entry => {
          const owner =
            entry.runtime?.id &&
            installedOperations.get(installedModKey(item.editor.installationPath, entry.runtime.id));
          return {
            path: entry.path,
            label: path.relative(path.join(item.project.root, item.project.config.sourceDirectory), entry.path),
            status: entry.status,
            message: entry.message,
            metadata: entry.metadata,
            runtime:
              owner && owner !== entry
                ? { ...entry.runtime, busy: true, operation: owner.busy, stopping: owner.stopping }
                : entry.runtime,
            output: outputPath(item.project, entry.path),
            dependencies: entry.draft?.dependencies.size ?? entry.result?.dependencies.size ?? 0
          };
        })
      }))
    };
    sidebarStateJson = JSON.stringify(sidebarState).replace(/</g, '\\u003c');
    void view?.webview.postMessage(sidebarState);
  };
  const presentDiagnostics = () => {
    diagnostics.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const state of projects.values())
      for (const entry of state.entries.values()) {
        for (const item of [
          ...(entry.result?.diagnostics ?? []),
          ...(entry.metadata?.diagnostics ?? []),
          ...(entry.compilerDiagnostics ?? [])
        ]) {
          const diagnostic = new vscode.Diagnostic(
            new vscode.Range(item.line, 0, item.line, 100),
            item.message,
            item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
          );
          const list = grouped.get(item.path) ?? [];
          list.push(diagnostic);
          grouped.set(item.path, list);
        }
      }
    for (const [file, list] of grouped) diagnostics.set(vscode.Uri.file(file), list);
  };
  const relevantDirty = (state: ProjectState, entry?: EntryState) =>
    vscode.workspace.textDocuments.filter(
      document =>
        document.isDirty &&
        document.uri.scheme === 'file' &&
        (sameFile(document.uri.fsPath, path.join(state.project.root, 'windhawk-amalgamation.json')) ||
          (entry
            ? sameFile(document.uri.fsPath, entry.path) ||
              dependsOn(entry, document.uri.fsPath) ||
              (!entry.draft &&
                !entry.result &&
                contained(path.join(state.project.root, state.project.config.sourceDirectory), document.uri.fsPath))
            : contained(path.join(state.project.root, state.project.config.sourceDirectory), document.uri.fsPath)))
    );
  const saveRelevant = async (state: ProjectState): Promise<boolean> => {
    const dirty = relevantDirty(state);
    if (!dirty.length) return true;
    const choice = await vscode.window.showWarningMessage(
      `${dirty.length} relevant document(s) have unsaved changes. Generation reads saved files.`,
      { modal: true },
      'Save Relevant Files'
    );
    if (choice !== 'Save Relevant Files') return false;
    for (const document of dirty) if (!(await document.save())) return false;
    return true;
  };
  // Draft preparation reads project source; it never queries installed mod state.
  const refreshDraft = async (state: ProjectState, entries = [...state.entries.values()]) => {
    if (disposed || state.removed) return;
    const root = state.editor.installationPath;
    // Draft dependencies are keyed by canonical path (symlinks, junctions, subst drives and
    // 8.3 names resolved), but editors use the workspace path. Match unsaved buffers by both.
    const canonicalKey = (file: string) => (process.platform === 'win32' ? file.toLowerCase() : file);
    const dirtyByCanonical = new Map<string, vscode.TextDocument>();
    for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      try {
        dirtyByCanonical.set(canonicalKey(await fs.realpath(document.uri.fsPath)), document);
      } catch {
        /* A buffer for a file that does not exist on disk is matched by its path only. */
      }
    }
    const overlay = {
      ...nodeFiles,
      read: async (file: string) => {
        const document =
          vscode.workspace.textDocuments.find(
            document => document.isDirty && document.uri.scheme === 'file' && sameFile(document.uri.fsPath, file)
          ) ?? dirtyByCanonical.get(canonicalKey(file));
        return document?.isDirty ? Buffer.from(document.getText()) : nodeFiles.read(file);
      }
    };
    for (const entry of entries) {
      if (state.removed) return;
      try {
        const source = (await overlay.read(entry.path)).toString(),
          language = previewLanguage(vscode.env?.language ?? 'en').toLowerCase();
        const hash =
          root +
          ':' +
          state.windhawkStamp +
          ':' +
          state.windhawk?.parser +
          ':' +
          language +
          ':' +
          checksum(Buffer.from(source));
        if (entry.parsedHash !== hash) {
          entry.parsed = parseDraftSource(source, entry.path, language);
          if (state.windhawk?.parser) {
            try {
              const native = await invokeWindhawkCore(root, 'parseModSource', { source, language });
              if (
                !native ||
                typeof native.errors !== 'object' ||
                !native.errors ||
                !(native.metadata === null || typeof native.metadata === 'object') ||
                !(native.readme === null || typeof native.readme === 'string') ||
                !(native.initialSettings === null || Array.isArray(native.initialSettings))
              )
                throw new Error('Unsupported parser response.');
              entry.parsed = native;
            } catch (error) {
              log.appendLine('Using local source preview: ' + (error as Error).message);
            }
          }
          entry.parsedHash = hash;
        }
        const parsed = entry.parsed!;
        entry.metadata = parseMetadata(source, entry.path);
        if (entry.metadata) {
          entry.metadata.readme = parsed.readme ?? undefined;
          entry.metadata.settingsCount = parsed.initialSettings?.length;
          for (const [key, value] of Object.entries(parsed.metadata ?? {}))
            entry.metadata.fields[key] = Array.isArray(value) ? value : [value];
          for (const [section, message] of Object.entries(parsed.errors)) {
            const line =
              entry.metadata.lines[section === 'initialSettings' ? 'settings' : (section as 'metadata' | 'readme')] ??
              0;
            if (message && !entry.metadata.diagnostics.some(item => item.message === 'Windhawk: ' + message))
              entry.metadata.diagnostics.push({
                path: entry.path,
                line,
                severity: 'warning',
                message: 'Windhawk: ' + message
              });
          }
        }
        const id = parsed.metadata?.id;
        const modId = localModId(id);
        if (entry.runtime?.id !== modId) entry.installed = undefined;
        const config = JSON.stringify(state.project.config);
        let reuse = !!entry.draft?.bytes && entry.draftConfig === config && !entry.draftInvalidated;
        if (reuse)
          for (const [file, hash] of entry.draft!.dependencies) {
            try {
              if (checksum(await overlay.read(file)) !== hash) {
                reuse = false;
                break;
              }
            } catch {
              reuse = false;
              break;
            }
          }
        if (!reuse) entry.draft = await generateEntry(state.project, entry.path, overlay);
        entry.draftConfig = config;
        entry.draftInvalidated = false;
        entry.runtime = {
          id: modId,
          installed: !!entry.installed?.config,
          enabled: !!entry.installed?.config && !entry.installed.config.disabled,
          changesPending: false,
          busy: !!entry.busy,
          operation: entry.busy,
          stopping: entry.stopping,
          error: modId ? (entry.buildError ?? entry.runtime?.error) : 'Add a valid @id before compiling.'
        };
        updateCompileStatus(state, entry);
        const output = outputPath(state.project, entry.path);
        const dirtyOutput = isDirty(output);
        if (dirtyOutput) {
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
            entry.message = entry.draft!.dependencies.size + ' source file(s)';
          } else if (existing && !ownedOutput(existing, entry, state.project.root)) {
            entry.status = 'blocked';
            entry.message = 'Output was edited. Compare, restore edits, or explicitly discard them.';
          } else {
            entry.status = 'stale';
            entry.message = entry.draft?.diagnostics.find(item => item.severity === 'error')?.message;
          }
        }
        if (sidebarDetails?.entry === entry.path)
          await sidebarDetails.controller.update({
            installation: state.windhawk ?? { root, parser: false, cli: false },
            modId: modId ?? 'local@wham-draft',
            entry: entry.path,
            source: entry.draft?.bytes?.toString() ?? source,
            parsed,
            outputBlocked: entry.status === 'blocked'
          });
      } catch (error) {
        entry.runtime = {
          ...entry.runtime,
          installed: entry.runtime?.installed ?? false,
          enabled: entry.runtime?.enabled ?? false,
          changesPending: entry.runtime?.changesPending ?? false,
          busy: !!entry.busy,
          operation: entry.busy,
          stopping: entry.stopping,
          error: (error as Error).message
        };
      }
    }
    presentDiagnostics();
    publish();
  };
  // Poll after runtime actions/focus changes, independently of source edits or preview refresh.
  const refreshRuntime = async (state: ProjectState) => {
    if (disposed || state.removed) return;
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
      state.windhawk = await inspectWindhawk(root);
      state.windhawkStamp = stamp;
      await refreshDraft(state);
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
          entry.installed = await readInstalledMod(root, entry.runtime.id);
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
    await refreshEditorConfiguration(state);
    publish();
  };
  const scheduleRefresh = (state: ProjectState, pollInstalled = false, entries = [...state.entries.values()]) => {
    if (disposed || state.removed) return;
    for (const entry of entries) state.draftPending.add(entry.path);
    state.pollInstalled ||= pollInstalled;
    if (state.runtimeTimer) clearTimeout(state.runtimeTimer);
    state.runtimeTimer = setTimeout(() => {
      if (state.runtimePending || disposed || state.removed) return;
      state.runtimePending = true;
      state.queue = state.queue
        .then(async () => {
          if (disposed || state.removed) return;
          state.runtimePending = false;
          const poll = state.pollInstalled;
          state.pollInstalled = false;
          const entries = [...state.draftPending]
            .map(file => state.entries.get(file))
            .filter((entry): entry is EntryState => !!entry);
          state.draftPending.clear();
          if (entries.length) await refreshDraft(state, entries);
          if (poll) await refreshRuntime(state);
        })
        .catch(error => {
          state.runtimePending = false;
          log.appendLine(String(error));
        });
    }, 350);
  };
  const refresh = async (state: ProjectState) => {
    if (disposed || state.removed) return;
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
        if (previous.ownedHash === checksum(existing) && !isDirty(output)) {
          await assertSafeDestination(state.project.root, portableRelative(state.project.root, output));
          if (state.removed) return;
          await fs.rm(output);
          delete storedHashes[output];
        } else state.retained.push(`Preserved orphan output: ${output}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.appendLine(String(error));
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
    for (const entry of state.entries.values()) {
      const document = vscode.workspace.textDocuments.find(
        document => sameFile(document.uri.fsPath, entry.path) && document.isDirty
      );
      entry.metadata = parseMetadata(document ? document.getText() : await fs.readFile(entry.path, 'utf8'), entry.path);
    }
    state.error = undefined;
    state.git = await gitStatus(state.project.root, gitExecutable());
    presentDiagnostics();
  };
  const generate = async (state: ProjectState, entry: EntryState, force: boolean) => {
    if (disposed || state.removed) return;
    const output = outputPath(state.project, entry.path);
    const dirtyOutput = isDirty(output);
    if (dirtyOutput) {
      entry.status = 'blocked';
      entry.message = 'Output has unsaved edits. Save or revert it before regenerating.';
      publish();
      return;
    }
    if (relevantDirty(state, entry).length) {
      entry.status = 'pending';
      entry.message = 'Waiting for source buffers to be saved.';
      publish();
      return;
    }
    entry.status = 'generating';
    entry.message = undefined;
    publish();
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
      log.appendLine(`${diagnostic.path}:${diagnostic.line + 1}: ${diagnostic.message}`);
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
      entry.status = 'pending';
      entry.message = 'Source changed during generation; queued another pass.';
      schedule(state, [entry.path]);
      return;
    }
    // Recheck output immediately before commit, including documents dirtied during generation.
    if (changedSince(await readIfExists(output), existing) || isDirty(output)) {
      entry.status = 'blocked';
      entry.message = 'Output changed during generation; no write performed.';
      return;
    }
    if (disposed || state.removed) return;
    if (!existing?.equals(result.bytes)) await writeOutput(state.project, output, result.bytes);
    entry.ownedHash = checksum(result.bytes);
    storedHashes[output] = entry.ownedHash;
    entry.status = 'current';
    entry.message = `${result.dependencies.size} source file(s)`;
  };
  const enqueue = (
    state: ProjectState,
    targets?: string[],
    options: { force?: boolean; refreshProject?: boolean } = {}
  ): Promise<void> => {
    state.queue = state.queue.then(async () => {
      if (disposed || state.removed) return;
      try {
        // Save events already use the known dependency graph; structural/config
        // events refresh it separately. Explicit commands still discover entries.
        if (options.refreshProject !== false) await refresh(state);
        const entries = [...state.entries.values()].filter(entry => !targets || targets.includes(entry.path));
        for (const entry of entries) state.draftPending.delete(entry.path);
        for (const entry of entries) {
          try {
            await generate(state, entry, options.force ?? false);
          } catch (error) {
            entry.status = 'stale';
            entry.message = String(error);
            log.appendLine(String(error));
          }
        }
        await context.workspaceState.update('outputHashes', storedHashes);
        await refreshDraft(state, entries);
        if (options.refreshProject === false) state.git = await gitStatus(state.project.root, gitExecutable());
      } catch (error) {
        state.error = (error as Error).message;
        log.appendLine(String(error));
      }
      presentDiagnostics();
      publish();
    });
    return state.queue;
  };
  const schedule = (state: ProjectState, targets: string[]) => {
    if (disposed || state.removed) return;
    for (const target of targets) {
      state.pending.add(target);
      // Generation reconciles Draft too; retire the earlier typing/save refresh.
      state.draftPending.delete(target);
    }
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const targets = [...state.pending];
      state.pending.clear();
      void enqueue(state, targets, { refreshProject: false });
    }, state.project.config.debounceMs);
  };
  const changed = (file: string, discovery = false) => {
    for (const state of projects.values()) {
      if (!contained(state.project.root, file)) continue;
      const source = path.join(state.project.root, state.project.config.sourceDirectory),
        output = path.join(state.project.root, state.project.config.outputDirectory);
      if (
        [
          '.vscode/settings.json',
          '.vscode/c_cpp_properties.json',
          '.vscode/extensions.json',
          '.clang-format',
          '.clangd'
        ].some(local => sameFile(file, path.join(state.project.root, local)))
      ) {
        state.queue = state.queue.then(async () => {
          if (disposed || state.removed) return;
          try {
            state.editor = await resolveEditor(state.project.root);
            await refreshEditorConfiguration(state);
            publish();
          } catch (error) {
            log.appendLine(String(error));
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
                  publish();
                }
              })
              .catch(() => {
                entry.status = 'stale';
                publish();
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
          if (disposed || state.removed) return;
          try {
            await refresh(state);
            if (configurationChanged) await refreshEditorConfiguration(state);
            const affected = [...state.entries.values()].filter(
              entry => configurationChanged || !entry.draft || targets.includes(entry)
            );
            if (state.project.config.generate === 'onSave')
              schedule(
                state,
                affected.map(entry => entry.path)
              );
            else scheduleRefresh(state, false, affected);
          } catch (error) {
            state.error = String(error);
          }
          publish();
        });
      } else if (targets.length) {
        if (state.project.config.generate === 'onSave')
          schedule(
            state,
            targets.map(entry => entry.path)
          );
        else scheduleRefresh(state, false, targets);
        publish();
      }
    }
  };
  const rememberProject = async (root: string) => {
    recentProjects = [root, ...recentProjects.filter(previous => !sameFile(previous, root))].slice(0, 15);
    await context.globalState.update('recentProjects', recentProjects);
  };
  const retireProject = (state: ProjectState) => {
    state.removed = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.runtimeTimer) clearTimeout(state.runtimeTimer);
    state.pending.clear();
    state.draftPending.clear();
    state.pollInstalled = false;
    for (const entry of state.entries.values()) entry.abort?.abort();
    for (const subscription of state.subscriptions ?? []) subscription.dispose();
    state.subscriptions = [];
    projects.delete(state.project.root);
    if (sidebarDetails && state.entries.has(sidebarDetails.entry)) {
      sidebarDetails.controller.dispose();
      sidebarDetails = undefined;
      if (!disposed && view) view.webview.html = sidebarHtml;
    }
    if (!disposed) presentDiagnostics();
  };
  // Projects loaded outside the workspace folders are reloaded for this workspace on activation.
  const persistAdditionalRoots = () =>
    context.workspaceState.update(
      'additionalRoots',
      [...projects.keys()].filter(
        root => !vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, root))
      )
    );
  /** Returns the loaded state, which may be keyed by an existing root with different casing. */
  const addProject = async (root: string): Promise<ProjectState> => {
    root = path.resolve(root);
    const loadedRoot = [...projects.keys()].find(previous => sameFile(previous, root));
    if (loadedRoot) {
      selectedRoot = loadedRoot;
      await rememberProject(loadedRoot);
      publish();
      return projects.get(loadedRoot)!;
    }
    if (!Object.keys(localPreferences.projects).some(key => sameFile(key, root))) {
      // Adopt a usable old installation only if none is selected globally.
      const applied = await readEditorSettings(root);
      if (!localPreferences.computer.installationPath && applied.installationPath) {
        try {
          await fs.access(path.join(applied.installationPath, 'windhawk.ini'));
          localPreferences.computer.installationPath = applied.installationPath;
        } catch {
          /* A copied project's path may not exist on this computer. */
        }
        if (localPreferences.computer.installationPath)
          for (const project of projects.values()) {
            project.editor = await resolveEditor(project.project.root);
            await refreshRuntime(project);
            await refreshDraft(project);
          }
      }
      localPreferences.projects[root] = applied.installationPath ? { integration: applied.integration } : {};
      await context.globalState.update('localPreferences', localPreferences);
    }
    const state: ProjectState = {
      project: { root, config: { ...defaults } },
      entries: new Map(),
      queue: Promise.resolve(),
      pending: new Set(),
      draftPending: new Set(),
      retained: [],
      editor: await resolveEditor(root)
    };
    projects.set(root, state);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    state.subscriptions = [
      watcher,
      watcher.onDidChange(uri => changed(uri.fsPath)),
      watcher.onDidCreate(uri => changed(uri.fsPath, true)),
      watcher.onDidDelete(uri => changed(uri.fsPath, true))
    ];
    try {
      await refresh(state);
      await refreshDraft(state);
      await rememberProject(root);
      scheduleRefresh(state, true);
      if (state.project.config.generate === 'onSave') {
        const stale = [...state.entries.values()].filter(entry => entry.status === 'stale').map(entry => entry.path);
        if (stale.length) void enqueue(state, stale);
      }
    } catch (error) {
      state.error = String(error);
    }
    publish();
    return state;
  };
  const showDetails = async (state: ProjectState, entry: EntryState) => {
    const data: DetailsData = {
      installation: state.windhawk ?? { root: state.editor.installationPath, parser: false, cli: false },
      modId: entry.runtime?.id ?? 'local@wham-draft',
      entry: entry.path,
      source: entry.draft?.bytes?.toString() ?? '',
      parsed:
        entry.parsed ?? parseDraftSource('', entry.path, previewLanguage(vscode.env?.language ?? 'en').toLowerCase()),
      outputBlocked: entry.status === 'blocked'
    };
    if (view) {
      sidebarDetails?.controller.dispose();
      const controller = createDetailsView(context.extensionUri, view.webview, data, {
        onAction: action => runModAction(state, entry, action),
        onRefresh: async () => {
          state.queue = state.queue.then(() => refreshDraft(state, [entry]));
          await state.queue;
        },
        onNavigate: async page => {
          sidebarDetails?.controller.dispose();
          sidebarDetails = undefined;
          if (!view) return;
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
          };
          // Restore the current project and destination before the first render.
          pendingSidebarPage = page;
          view.webview.html = sidebarHtml.replace(
            '/* initial sidebar state */',
            () =>
              `window.whamSidebarState = ${sidebarStateJson}; window.whamSidebarState.page = ${JSON.stringify(page)};`
          );
        }
      });
      sidebarDetails = { entry: entry.path, controller };
    }
    scheduleRefresh(state, false, [entry]);
  };
  const compileMod = async (state: ProjectState, entry: EntryState, testOnly = false) => {
    if (entry.busy || disposed || state.removed) return;
    if (
      !testOnly &&
      entry.runtime?.id &&
      installedOperations.has(installedModKey(state.editor.installationPath, entry.runtime.id))
    ) {
      void vscode.window.showInformationMessage('This mod already has an operation running.');
      return;
    }
    if (!testOnly && !state.windhawk?.cli) {
      void vscode.window.showInformationMessage(
        state.windhawk?.notice ?? 'Select your Windhawk installation in Settings → Extension settings.'
      );
      return;
    }
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, testOnly ? 'test' : 'compile');
    entry.buildError = undefined;
    publish();
    let snapshot: GenerationResult | undefined;
    let operationKey: string | undefined;
    try {
      if (!(await saveRelevant(state))) return;
      if (abort.signal.aborted) throw new WindhawkError('Compilation stopped.', 'CANCELED');
      if (testOnly) {
        snapshot = await generateEntry(state.project, entry.path, nodeFiles);
        if (!snapshot.bytes || snapshot.diagnostics.some(issue => issue.severity === 'error'))
          throw new Error(snapshot.diagnostics.map(issue => issue.message).join('\n'));
        const result = await checkModBuild(
          state.editor.installationPath,
          snapshot.bytes.toString(),
          abort.signal,
          text => log.append(text),
          state.windhawk?.version
        );
        if (result?.warnings) log.show(true);
        entry.compilerDiagnostics = [];
        log.appendLine('Test build passed. No mod was installed.');
        void vscode.window.showInformationMessage('Test build passed.');
        return;
      }
      await enqueue(state, [entry.path]);
      if (abort.signal.aborted) throw new WindhawkError('Compilation stopped.', 'CANCELED');
      if (entry.status !== 'current' || !entry.result?.bytes || !entry.runtime?.id)
        throw new Error(entry.message || entry.runtime?.error || 'Generate a valid output before compiling.');
      snapshot = entry.result;
      const modId = localModId(parseMetadata(snapshot.bytes!.toString(), entry.path).fields.id?.[0]);
      if (!modId) throw new Error('Add a valid @id before compiling.');
      const root = state.windhawk!.root,
        key = installedModKey(root, modId);
      if (installedOperations.has(key)) {
        void vscode.window.showInformationMessage('This mod already has an operation running.');
        return;
      }
      operationKey = key;
      installedOperations.set(key, entry);
      publish();
      const installed = await readInstalledMod(root, modId);
      const installDisabled = !installed.config || installed.config.disabled;
      log.appendLine(`Compile ${modId} from ${entry.path}`);
      const result = await runWindhawkCli(
        root,
        ['mod', 'install', '--file', '-', ...(installDisabled ? ['--disabled'] : [])],
        snapshot.bytes!.toString(),
        text => log.append(text),
        abort.signal,
        installationPreferences(root)
      );
      if (result.id !== modId) throw new Error('Windhawk returned an unexpected compiled mod ID.');
      const library = result.config?.libraryFileName;
      const builds = {
        ...context.globalState.get<Record<string, CompiledSnapshot>>('compiledSnapshots', {})
      };
      if (typeof library === 'string' && library)
        builds[key] = { sourceHash: sourceHash(snapshot.bytes!.toString()), libraryFileName: library };
      else delete builds[key]; // An unsupported reply cannot retain a previous build's proof.
      await context.globalState.update('compiledSnapshots', builds);
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
      entry.compilerDiagnostics = [];
      if (snapshot?.bytes)
        for (const match of output.matchAll(
          /(?:^|\n)([^\n]+\.(?:wh\.)?cpp|<stdin>):(\d+):(\d+):\s*(error|warning):\s*([^\n]+)/g
        )) {
          const line = Number(match[2]) - 1,
            text = snapshot.bytes.toString();
          let offset = 0;
          for (let index = 0; index < line; index++) {
            const next = text.indexOf('\n', offset);
            if (next < 0) break;
            offset = next + 1;
          }
          const span = snapshot.spans.find(span => span.outputStart <= offset && offset < span.outputEnd);
          if (span)
            entry.compilerDiagnostics.push({
              path: span.path,
              line: span.sourceLine + text.slice(span.outputStart, offset).split('\n').length - 1,
              severity: match[4] as 'error' | 'warning',
              message: match[5].trim()
            });
        }
      void vscode.window.showErrorMessage(entry.buildError);
    } finally {
      try {
        await refreshDraft(state, [entry]);
        if (!testOnly)
          for (const project of projects.values()) {
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
        publish();
      }
    }
  };
  const enableMod = async (state: ProjectState, entry: EntryState, enabled: boolean) => {
    if (entry.busy || disposed || state.removed) return;
    if (!state.windhawk?.cli || !entry.runtime?.id || !entry.installed?.config) {
      void vscode.window.showInformationMessage(state.windhawk?.notice ?? 'Compile this mod before enabling it.');
      return;
    }
    const root = state.windhawk.root,
      modId = entry.runtime.id,
      key = installedModKey(root, modId);
    if (installedOperations.has(key)) {
      void vscode.window.showInformationMessage('This mod already has an operation running.');
      return;
    }
    installedOperations.set(key, entry);
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, enabled ? 'enable' : 'disable');
    publish();
    try {
      const result = await runWindhawkCli(
        root,
        ['mod', enabled ? 'enable' : 'disable', modId],
        undefined,
        undefined,
        abort.signal,
        installationPreferences(root)
      );
      if (result?.id !== modId || result.enabled !== enabled)
        throw new Error('Windhawk returned an unsupported enable/disable response. Update Windhawk.');
      // The CLI confirms the change. Keep the installed source and Draft untouched.
      for (const project of projects.values())
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
      publish();
    }
  };
  const compare = async (state: ProjectState, entry: EntryState) => {
    const result = await generateEntry(state.project, entry.path, nodeFiles);
    if (!result.bytes) throw new Error(result.diagnostics.map(item => item.message).join('\n'));
    const output = outputPath(state.project, entry.path);
    let actual = vscode.Uri.file(output);
    try {
      await fs.stat(output);
    } catch {
      actual = virtual('missing.wh.cpp', '');
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      actual,
      virtual(path.basename(output), result.bytes),
      'Existing output ↔ Expected from saved source'
    );
  };
  const finishInitialCommit = async (state: ProjectState, sourceFiles: string[]) => {
    try {
      await createInitialCommit(state.project, sourceFiles, gitExecutable());
      log.appendLine('Created initial commit: ' + state.project.root);
    } catch (error) {
      log.appendLine(String(error));
      void vscode.window
        .showWarningMessage(
          'Project is ready, but the initial commit failed. Check your Git name/email and the WHAM log. Setup files may remain staged.',
          'Show log'
        )
        .then(choice => {
          if (choice === 'Show log') log.show();
        });
    }
    state.git = await gitStatus(state.project.root, gitExecutable());
    publish();
  };
  const restore = async (
    container?: string,
    openProject = openAfterSetup(),
    initialCommit = initialCommitEnabled()
  ) => {
    const containers = container
      ? [container]
      : (
          await vscode.window.showOpenDialog({
            canSelectMany: true,
            filters: { 'Windhawk source': ['cpp'] },
            openLabel: 'Recover selected mods'
          })
        )?.map(uri => uri.fsPath);
    if (!containers?.length) return;
    for (const file of containers)
      if (isDirty(file)) throw new Error('Save generated outputs before restoring their edits.');
    const result = mergeRecoveries(
      await Promise.all(containers.map(async file => restoreSource(await fs.readFile(file))))
    );
    const selections = new Map<string, number>();
    for (const file of result.conflicts) {
      const candidates = result.files.get(file)!;
      for (;;) {
        const options = candidates.map((candidate, index) => ({
          label: `Use copy ${index + 1}`,
          description: candidate.changed ? 'Edited copy' : 'Original copy',
          detail: `${file}; occurrences ${candidate.occurrences.join(', ')}`,
          index,
          compare: false
        }));
        const selection = await vscode.window.showQuickPick(
          [...options, { label: 'Compare copies', description: '', detail: file, index: -1, compare: true }],
          { title: `Resolve conflicting occurrences: ${file}` }
        );
        if (!selection) return;
        if (selection.compare) {
          const first =
            options.length === 2 ? options[0] : await vscode.window.showQuickPick(options, { title: 'Left copy' });
          const second =
            options.length === 2
              ? options[1]
              : first &&
                (await vscode.window.showQuickPick(
                  options.filter(option => option.index !== first.index),
                  { title: 'Right copy' }
                ));
          if (first && second)
            await vscode.commands.executeCommand(
              'vscode.diff',
              virtual(file, candidates[first.index].bytes),
              virtual(file, candidates[second.index].bytes),
              `Recovery copies: ${file}`
            );
        } else {
          selections.set(file, selection.index);
          break;
        }
      }
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select recovery parent or existing project'
    });
    if (!picked?.[0]) return;
    const mode = await vscode.window.showInformationMessage(
      'Recovery destination',
      { modal: true, detail: picked[0].fsPath },
      'Create folder',
      'Use this folder'
    );
    if (!mode) return;
    let destination = picked[0].fsPath;
    if (mode.startsWith('Create')) {
      const name = await vscode.window.showInputBox({
        title: 'New recovery directory',
        value: path.basename(containers[0]).replace(/\.wh\.cpp$/i, '') + '-recovered',
        validateInput: value =>
          !value || /[\\/:*?"<>|]/.test(value) || ['.', '..'].includes(value) ? 'Enter one directory name.' : undefined
      });
      if (!name) return;
      destination = path.join(destination, name);
    }
    const contents = new Map(
      [...result.files].map(([file, candidates]) => [file, candidates[selections.get(file) ?? 0].bytes])
    );
    contents.set('windhawk-amalgamation.json', Buffer.from(JSON.stringify(result.manifest.config, null, 2) + '\n'));
    const differences: string[] = [],
      previous = new Map<string, Buffer | undefined>();
    for (const [file, bytes] of contents) {
      const target = await assertSafeDestination(destination, file);
      if (isDirty(target)) throw new Error(`Destination has unsaved edits: ${file}`);
      const old = await readIfExists(target);
      previous.set(file, old);
      if (old && !old.equals(bytes)) differences.push(file);
    }
    let reviewing = false;
    for (;;) {
      const action = differences.length ? 'Recover and replace' : 'Recover files';
      const detail =
        `${destination}\n${contents.size} source and configuration files.` +
        (differences.length
          ? `\nReplace ${differences.length} existing file(s):\n${differences.join('\n')}`
          : '\nNo existing files will be replaced.');
      const message = reviewing
        ? `Recover ${contents.size} files to ${destination}` +
          (differences.length ? `; replace ${differences.length} existing file(s).` : '.')
        : 'Recover source files';
      const choice = await (
        differences.length ? vscode.window.showWarningMessage : vscode.window.showInformationMessage
      )(message, { modal: !reviewing, detail }, action, 'Review files…');
      if (!choice) return;
      if (choice === action) break;
      const picked = await vscode.window.showQuickPick(
        [...contents.keys()].map(file => ({
          label: file,
          description: differences.includes(file) ? 'Compare with existing file' : 'Preview recovered file',
          file
        })),
        { title: 'Review recovered files' }
      );
      if (!picked) continue;
      const uri = virtual(picked.file, contents.get(picked.file)!);
      if (differences.includes(picked.file))
        await vscode.commands.executeCommand(
          'vscode.diff',
          vscode.Uri.file(path.join(destination, picked.file)),
          uri,
          `Recovery preview: ${picked.file}`
        );
      else await vscode.window.showTextDocument(uri, { preview: true });
      reviewing = true; // Keep the final action available without covering the diff.
    }
    for (const file of contents.keys()) {
      if (isDirty(path.join(destination, file))) throw new Error(`Destination became dirty: ${file}`);
      if (changedSince(await readIfExists(path.join(destination, file)), previous.get(file)))
        throw new Error(`Recovery destination changed: ${file}. Review it again before recovering.`);
    }
    await commitRestore(result, destination, selections, differences.length > 0);
    const setup = await setupProject(destination, { git: gitExecutable() });
    const recovered = await addProject(destination);
    selectedRoot = recovered.project.root;
    await persistAdditionalRoots();
    publish();
    await configureEditor(recovered);
    if (initialCommit && setup.gitInitialized) await finishInitialCommit(recovered, [...result.files.keys()]);
    if (openProject && !vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, destination)))
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), false);
    else void vscode.window.showInformationMessage(`Recovered ${result.files.size} source files in ${destination}`);
    return true;
  };
  const refreshRecentProjects = async () => {
    const available: string[] = [];
    for (const root of recentProjects) {
      try {
        if ((await fs.stat(path.join(root, 'windhawk-amalgamation.json'))).isFile()) available.push(root);
      } catch {
        /* The folder or its project configuration may have been removed. */
      }
    }
    recentProjects = available;
    await context.globalState.update('recentProjects', recentProjects);
  };
  const openExistingProject = async (requestedRoot?: string, browse = false): Promise<boolean> => {
    await refreshRecentProjects();
    publish();
    const choices = projectChoices();
    let root = requestedRoot;
    if (root && !choices.some(choice => sameFile(choice.root, root!)))
      throw new Error('This project is no longer available. Browse to its new location.');
    if (!root && !browse && choices.some(choice => choice.root)) {
      const choice = await vscode.window.showQuickPick(choices, { title: 'Open WHAM project', matchOnDetail: true });
      if (!choice) return false;
      root = choice.root;
    }
    if (!root)
      root = (
        await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select your source project'
        })
      )?.[0].fsPath;
    if (!root) return false;
    root = path.resolve(root);
    let configured = false;
    try {
      configured = (await fs.stat(path.join(root, 'windhawk-amalgamation.json'))).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Opening an existing WHAM project never rewrites its editor or Git configuration.
    if (configured) await loadProject(root);
    else {
      await setupProject(root, { git: gitExecutable() });
      void vscode.window.showInformationMessage(
        'WHAM project created. Configure the editor in Project settings → Editor when needed.'
      );
    }
    await addProject(root);
    selectedRoot = root;
    publish();
    if (!vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, root)))
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    return true;
  };
  const initialize = async (
    requestedMode?: string,
    openProject = openAfterSetup(),
    initialCommit = initialCommitEnabled()
  ) => {
    const modes = ['Create a new project', 'Open an existing project', 'Recover one or more .wh.cpp files'];
    if (requestedMode === 'Use an existing project') requestedMode = 'Open an existing project';
    const mode = modes.includes(requestedMode ?? '')
      ? requestedMode
      : (
          await vscode.window.showInformationMessage(
            'Set up WHAM',
            { modal: true },
            { title: 'New project', mode: modes[0] },
            { title: 'Existing project', mode: modes[1] },
            { title: 'Recover mods', mode: modes[2] }
          )
        )?.mode;
    if (!mode) return;
    if (mode.startsWith('Open')) return openExistingProject();
    if (mode.startsWith('Recover')) return restore(undefined, openProject, initialCommit);
    const folders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select an empty folder or parent directory'
    });
    if (!folders?.[0]) return;
    let root = folders[0].fsPath;
    if (mode.startsWith('Create')) {
      const choice = await vscode.window.showInformationMessage(
        'New project location',
        { modal: true, detail: root },
        'Create folder',
        'Use empty folder'
      );
      if (!choice) return;
      if (choice.startsWith('Create')) {
        const name = await vscode.window.showInputBox({
          title: 'New project folder',
          value: 'windhawk-mods',
          validateInput: value =>
            !value || /[\\/:*?"<>|]/.test(value) || ['.', '..'].includes(value)
              ? 'Enter one directory name.'
              : undefined
        });
        if (!name) return;
        root = path.join(root, name);
        try {
          await fs.stat(root);
          throw new Error('That directory already exists. Choose Open project.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await fs.mkdir(root);
      } else if ((await fs.readdir(root)).length) throw new Error('This folder is not empty. Choose Open project.');
    }
    const setup = await setupProject(root, { git: gitExecutable() });
    const created = await addProject(root);
    selectedRoot = created.project.root;
    await persistAdditionalRoots();
    publish();
    await configureEditor(created);
    if (initialCommit && setup.gitInitialized) await finishInitialCommit(created, []);
    if (openProject && !vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, root)))
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    else void vscode.window.showInformationMessage(`Project ready: ${root}`);
    return true;
  };
  const applyEditor = async (state: ProjectState, settings: EditorSettings, reviewOnly = false) => {
    if (disposed || state.removed) throw new Error('This project was closed.');
    const windhawk = await inspectWindhawk(settings.installationPath);
    const files = await editorConfiguration(state.project, settings, windhawk.compileFlags);
    for (const file of files.keys())
      if (isDirty(path.join(state.project.root, file)))
        throw new Error(`Save or revert ${file} before applying editor configuration.`);
    const differs: string[] = [],
      previous = new Map<string, Buffer | undefined>();
    for (const [file, bytes] of files) {
      const old = await readIfExists(path.join(state.project.root, file));
      previous.set(file, old);
      if (!old?.equals(bytes)) differs.push(file);
    }
    if (reviewOnly) {
      if (!differs.length) {
        void vscode.window.showInformationMessage('Editor settings already match.');
        return false;
      }
      const selection =
        differs.length === 1
          ? differs[0]
          : await vscode.window.showQuickPick(differs, { title: 'Review editor changes' });
      if (selection)
        await vscode.commands.executeCommand(
          'vscode.diff',
          virtual(selection, previous.get(selection) ?? Buffer.alloc(0)),
          virtual(selection, files.get(selection)!),
          `Editor configuration: ${selection}`
        );
      return false;
    }
    for (const [file, bytes] of files) {
      if (disposed || state.removed) throw new Error('This project was closed.');
      if (isDirty(path.join(state.project.root, file))) throw new Error(`Editor settings became dirty: ${file}`);
      const now = await readIfExists(path.join(state.project.root, file));
      if (changedSince(now, previous.get(file)))
        throw new Error(`Editor configuration changed before applying: ${file}`);
      if (!now?.equals(bytes)) await writeOutput(state.project, path.join(state.project.root, file), bytes);
    }
    // Editor preferences and toolchain paths are local; formatting and recommendations are shared.
    if (disposed || state.removed) throw new Error('This project was closed.');
    await appendIgnoreRules(state.project, ['/.vscode/settings.json', '/.vscode/c_cpp_properties.json', '/.clangd']);
    state.editor = await resolveEditor(state.project.root);
    state.windhawk = windhawk;
    await refreshRuntime(state);
    // Applying files does not change the independently saved local preferences.
    state.git = await gitStatus(state.project.root, gitExecutable());
    publish();
    if (settings.integration !== 'clangd' && vscode.extensions.getExtension('ms-vscode.cpptools')) {
      try {
        await vscode.commands.executeCommand('C_Cpp.ConfigurationSelect', 'Windhawk (WHAM)');
      } catch {
        /* User can select it via the C++ status bar. */
      }
    }
    return true;
  };
  const configureEditor = async (state: ProjectState) => {
    const settings = { ...state.editor };
    const installations = settings.installationPath ? [] : await findWindhawk();
    if (!settings.installationPath && installations.length === 1) settings.installationPath = installations[0];
    const languageService = { cpp: 'Microsoft C/C++', clangd: 'clangd', both: 'Microsoft C/C++ and clangd' }[
      settings.integration
    ];
    const indentation =
      settings.indentStyle === 'tabs'
        ? `Tabs (width ${settings.indentSize})`
        : `${settings.indentSize} ${settings.indentSize === 1 ? 'space' : 'spaces'}`;
    const choice = (
      await vscode.window.showInformationMessage(
        'Set up the editor?',
        {
          modal: true,
          detail: `Windhawk: ${settings.installationPath || 'Not selected (choose a folder on Apply)'}\nLanguage service: ${languageService}\nIndentation: ${indentation}`
        },
        { title: 'Apply' },
        { title: 'Customize…' },
        { title: 'Skip', isCloseAffordance: true }
      )
    )?.title;
    if (!choice || choice === 'Skip') return;
    let indentationOnly = false;
    if (choice === 'Customize…') {
      const service = (
        await vscode.window.showInformationMessage(
          'Choose language service',
          { modal: true },
          { title: 'Microsoft C/C++' },
          { title: 'clangd' },
          { title: 'Both' },
          { title: 'Indentation only' },
          { title: 'Skip', isCloseAffordance: true }
        )
      )?.title;
      if (!service || service === 'Skip') return;
      indentationOnly = service === 'Indentation only';
      if (!indentationOnly)
        settings.integration = service === 'Both' ? 'both' : service === 'clangd' ? 'clangd' : 'cpp';
    }
    if (indentationOnly) settings.installationPath = '';
    else if (!settings.installationPath || choice === 'Customize…') {
      const available = [
        ...new Set(
          [settings.installationPath, ...(settings.installationPath ? await findWindhawk() : installations)].filter(
            Boolean
          )
        )
      ];
      const selected = available.length
        ? await vscode.window.showQuickPick([...available, 'Browse for Windhawk installation…'], {
            title: 'Select Windhawk installation (must contain Compiler)'
          })
        : 'Browse for Windhawk installation…';
      if (!selected) return;
      if (selected === 'Browse for Windhawk installation…') {
        const folder = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Choose Windhawk installation'
        });
        if (!folder?.[0]) return;
        settings.installationPath = folder[0].fsPath;
      } else settings.installationPath = selected;
    }
    if (choice === 'Customize…') {
      const style = (
        await vscode.window.showInformationMessage(
          'Choose indentation',
          { modal: true },
          { title: '4 spaces' },
          { title: '2 spaces' },
          { title: 'Tabs' },
          { title: 'Custom width…' },
          { title: 'Skip editor setup', isCloseAffordance: true }
        )
      )?.title;
      if (!style || style === 'Skip editor setup') return;
      settings.indentStyle = style === 'Tabs' ? 'tabs' : 'spaces';
      settings.indentSize = style === '2 spaces' ? 2 : style === 'Tabs' ? settings.indentSize : 4;
      if (style === 'Custom width…') {
        const width = await vscode.window.showInputBox({
          title: 'Indentation width',
          value: String(state.editor.indentSize),
          validateInput: value => (/^([1-9]|1[0-6])$/.test(value) ? undefined : 'Enter 1–16.')
        });
        if (!width) return;
        settings.indentSize = Number(width);
      }
    }
    if (settings.installationPath && settings.installationPath !== localPreferences.computer.installationPath) {
      if ([...projects.values()].some(project => [...project.entries.values()].some(entry => entry.busy)))
        throw new Error('Wait for the current Windhawk operation before changing preferences.');
      // Validate before saving a newly selected installation as a computer preference.
      await editorConfiguration(
        state.project,
        settings,
        (await inspectWindhawk(settings.installationPath)).compileFlags
      );
      localPreferences.computer.installationPath = settings.installationPath;
      await context.globalState.update('localPreferences', localPreferences);
      for (const project of projects.values()) {
        project.editor = await resolveEditor(project.project.root);
        await refreshRuntime(project);
        await refreshDraft(project);
      }
    }
    if ((await applyEditor(state, settings)) && !indentationOnly && settings.integration !== state.editor.integration) {
      await setProjectPreference(state.project.root, { integration: settings.integration });
      state.editor = await resolveEditor(state.project.root);
      await refreshEditorConfiguration(state);
      publish();
    }
  };
  const chooseEntry = async (state: ProjectState, onlyCurrent = false): Promise<EntryState | undefined> => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (onlyCurrent && file) {
      const current = [...state.entries.values()].find(entry => sameFile(entry.path, file));
      if (current) return current;
    }
    const entries = [...state.entries.values()].filter(
      entry => !onlyCurrent || !file || dependsOn(entry, file) || sameFile(outputPath(state.project, entry.path), file)
    );
    if (entries.length < 2) return entries[0];
    const picked = await vscode.window.showQuickPick(
      entries.map(entry => ({ label: path.relative(state.project.root, entry.path), entry })),
      { title: 'Select independent mod' }
    );
    return picked?.entry;
  };
  const updateConfig = async (state: ProjectState, input: unknown) => {
    const config = validateConfig(input);
    if (isDirty(path.join(state.project.root, 'windhawk-amalgamation.json')))
      throw new Error('Save or revert the configuration editor before updating sidebar settings.');
    const update = state.queue.then(async () => {
      if (disposed || state.removed) throw new Error('This project was closed.');
      // Validate filesystem containment before persisting new settings.
      const temporaryProject: Project = { root: state.project.root, config };
      await assertSafeDestination(state.project.root, config.sourceDirectory + '/.wham-probe');
      await assertSafeDestination(state.project.root, config.outputDirectory + '/.wham-probe');
      await discoverEntries(temporaryProject, nodeFiles);
      if (disposed || state.removed) throw new Error('This project was closed.');
      await writeOutput(
        state.project,
        path.join(state.project.root, 'windhawk-amalgamation.json'),
        Buffer.from(JSON.stringify(config, null, 2) + '\n')
      );
      state.project = temporaryProject;
      // Directory changes need fresh entry ownership and dependency state.
      if (state.timer) clearTimeout(state.timer);
      state.pending.clear();
      for (const entry of state.entries.values()) {
        entry.result = undefined;
        entry.status = 'stale';
      }
      await refresh(state);
      await refreshDraft(state);
      await refreshEditorConfiguration(state);
      publish();
    });
    state.queue = update.then(
      () => undefined,
      () => undefined
    );
    await update;
    if (state.project.config.generate === 'onSave') await enqueue(state);
  };
  const verify = async (state: ProjectState, entry: EntryState) => {
    if (entry.busy || disposed || state.removed) return;
    let executable: string | undefined,
      args: string[] = [];
    const file = outputPath(state.project, entry.path);
    if (!state.editor.installationPath) {
      executable = await vscode.window.showInputBox({
        title: 'Compiler executable',
        prompt: 'Full executable path; the command runs only when you invoke Verify.'
      });
      if (!executable) return;
      const argumentsJson = await vscode.window.showInputBox({
        title: 'Compiler arguments (JSON array)',
        value: JSON.stringify(['-std=c++23', '-fsyntax-only']),
        prompt: 'Use {file} where the generated file belongs, or it will be appended.'
      });
      if (!argumentsJson) return;
      const argumentsList: unknown = JSON.parse(argumentsJson);
      if (!Array.isArray(argumentsList) || argumentsList.some(argument => typeof argument !== 'string'))
        throw new Error('Compiler arguments must be a JSON string array.');
      args = (argumentsList as string[]).map(argument => argument.replaceAll('{file}', file));
      if (!(argumentsList as string[]).some(argument => argument.includes('{file}'))) args.push(file);
    }
    if (disposed || state.removed) return;
    log.appendLine('Verify ' + file);
    const abort = new AbortController();
    entry.abort = abort;
    setBusy(entry, 'verify');
    publish();
    try {
      if (state.editor.installationPath) {
        const source = await fs.readFile(file, 'utf8');
        const result = await checkModBuild(
          state.editor.installationPath,
          source,
          abort.signal,
          text => log.append(text),
          state.windhawk?.version,
          true
        );
        if (result?.warnings) log.show(true);
      } else {
        const result = await runWindhawkProcess(executable!, args, undefined, {
          signal: abort.signal,
          timeoutMs: 600000,
          onOutput: text => log.append(text),
          cwd: state.project.root
        });
        if (result.code !== 0) throw new Error('Syntax verification failed (exit ' + result.code + ').');
        if (/\bwarning:/i.test(result.stderr + '\n' + result.stdout)) log.show(true);
      }
      log.appendLine('Syntax verification passed.');
      void vscode.window.showInformationMessage('Syntax verification passed.');
    } catch (error) {
      if (error instanceof WindhawkError && error.code === 'CANCELED') log.appendLine('Verification stopped.');
      else {
        log.show(true);
        throw error;
      }
    } finally {
      entry.abort = undefined;
      setBusy(entry, undefined);
      publish();
    }
  };
  const runModAction = async (state: ProjectState, entry: EntryState, action: string, line?: number) => {
    if (state.removed || !state.entries.has(entry.path)) throw new Error('This mod is no longer in the project.');
    switch (action) {
      case 'generate':
        if (await saveRelevant(state)) await enqueue(state, [entry.path]);
        break;
      case 'compare':
        await compare(state, entry);
        break;
      case 'restore':
        await restore(outputPath(state.project, entry.path));
        break;
      case 'discard':
        if (
          (await vscode.window.showWarningMessage(
            `Discard saved output edits for ${path.basename(entry.path)}?`,
            { modal: true },
            'Regenerate and Discard'
          )) === 'Regenerate and Discard' &&
          (await saveRelevant(state))
        )
          await enqueue(state, [entry.path], { force: true });
        break;
      case 'open':
        await vscode.window.showTextDocument(
          vscode.Uri.file(entry.path),
          typeof line === 'number' && Number.isInteger(line) && line >= 0
            ? { selection: new vscode.Range(line, 0, line, 0) }
            : undefined
        );
        break;
      case 'output':
        await vscode.window.showTextDocument(vscode.Uri.file(outputPath(state.project, entry.path)));
        break;
      case 'verify':
        await verify(state, entry);
        break;
    }
  };
  const safe = (operation: () => Promise<unknown>) => async () => {
    try {
      await operation();
    } catch (error) {
      log.appendLine(String(error));
      void vscode.window.showErrorMessage((error as Error).message);
    }
  };
  const register = (name: string, operation: () => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand('windhawk.' + name, safe(operation)));
  register('initialize', initialize);
  register('openProject', openExistingProject);
  register('restore', () => restore());
  register('logs', async () => log.show());
  register('configureEditor', async () => {
    const state = active();
    if (state) await configureEditor(state);
  });
  register('generateAll', async () => {
    const state = active();
    if (state && (await saveRelevant(state))) await enqueue(state);
  });
  register('generateCurrent', async () => {
    const state = active();
    if (!state) return;
    const entry = await chooseEntry(state, true);
    if (entry && (await saveRelevant(state))) await enqueue(state, [entry.path]);
  });
  register('compare', async () => {
    const state = active();
    if (!state) return;
    const entry = await chooseEntry(state);
    if (entry) await compare(state, entry);
  });
  register('verify', async () => {
    const state = active();
    if (!state) return;
    const entry = await chooseEntry(state);
    if (entry) await verify(state, entry);
  });
  register('compile', async () => {
    const state = active();
    if (!state) return;
    const entry = await chooseEntry(state);
    if (!entry) return;
    const document = vscode.window.activeTextEditor?.document;
    const sourceDocument =
      document &&
      (['c', 'cpp'].includes(document.languageId) ||
        /\.(?:c|cc|cpp|cxx|c\+\+|h|hh|hpp|hxx|h\+\+|inl|inc|ipp|tpp|ixx|cppm)$/i.test(document.uri.fsPath));
    if (document && sourceDocument) {
      const file = document.uri.fsPath;
      const related =
        document.uri.scheme === 'file' &&
        (dependsOn(entry, file) || sameFile(outputPath(state.project, entry.path), file));
      if (!related) {
        const editorProject =
          document.uri.scheme === 'file'
            ? [...projects.values()]
                .filter(project => contained(project.project.root, file))
                .sort((left, right) => right.project.root.length - left.project.root.length)[0]
            : undefined;
        const otherMod =
          editorProject &&
          [...editorProject.entries.values()].some(
            candidate =>
              candidate !== entry &&
              (dependsOn(candidate, file) || sameFile(outputPath(editorProject.project, candidate.path), file))
          );
        const name = entry.metadata?.fields.name?.[0] || path.basename(entry.path),
          confirm = 'Compile ' + name;
        const message =
          editorProject && (editorProject !== state || otherMod)
            ? `The editor is showing "${path.basename(file)}" in "${path.basename(editorProject.project.root)}", but WHAM will compile and install "${name}" from "${path.basename(state.project.root)}".`
            : `WHAM couldn't associate "${path.basename(file)}" with the selected mod. Compile and install "${name}" from "${path.basename(state.project.root)}"?`;
        if (
          (await vscode.window.showWarningMessage(
            message,
            { modal: true, detail: `Source: ${entry.path}` },
            confirm
          )) !== confirm
        )
          return;
      }
    }
    if (!state.windhawk || !sameFile(state.windhawk.root, state.editor.installationPath)) {
      const ready = state.queue.then(() => refreshRuntime(state));
      // A failed probe must not leave subsequent project work on a rejected queue.
      state.queue = ready.catch(() => {});
      await ready;
    }
    await compileMod(state, entry);
  });
  register('toggleOnSave', async () => {
    const state = active();
    if (state)
      await updateConfig(state, {
        ...state.project.config,
        generate: state.project.config.generate === 'onSave' ? 'manual' : 'onSave'
      });
  });
  // Sidebar protocol: parsing and dispatch live in sidebar.ts; these are the operations.
  const postToSidebar = (message: unknown) => view?.webview.postMessage(message);
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const readComputerPreferences = (settings: ComputerPreferencesInput) => {
    const root = unquote(settings.installationPath);
    if (root && !path.isAbsolute(root)) throw new Error('Choose an absolute Windhawk installation path.');
    const preferences: InstallationPreferences = {
      elevation: settings.elevation,
      gsudoPath: unquote(settings.gsudoPath)
    };
    return { root, preferences };
  };
  const anyBusy = (states: Iterable<ProjectState>) =>
    [...states].some(project => [...project.entries.values()].some(entry => entry.busy));
  const saveComputerPreferences = async (settings: ComputerPreferencesInput) => {
    const { root, preferences } = readComputerPreferences(settings);
    await inspectElevation(preferences);
    if (anyBusy(projects.values()))
      throw new Error('Wait for the current Windhawk operation before changing preferences.');
    if (root) await fs.access(path.join(root, 'windhawk.ini'));
    const previous = installationPreferences(localPreferences.computer.installationPath);
    if (
      !sameFile(root, localPreferences.computer.installationPath) ||
      previous.elevation !== preferences.elevation ||
      previous.gsudoPath !== preferences.gsudoPath
    )
      await closeElevationSessions();
    if (root) localPreferences.computer.installations[pathKey(root)] = preferences;
    localPreferences.computer.installationPath = root;
    localPreferences.computer.integration = settings.integration;
    await context.globalState.update('localPreferences', localPreferences);
    for (const project of projects.values()) {
      project.editor = await resolveEditor(project.project.root);
      await refreshRuntime(project);
      await refreshDraft(project);
    }
    publish();
    await postToSidebar({ type: 'computerSaved' });
  };
  const browseComputerInstallation = async () => {
    const found = await findWindhawk();
    const selected = found.length
      ? await vscode.window.showQuickPick([...found, 'Browse…'], { title: 'Windhawk installation' })
      : 'Browse…';
    if (!selected) return;
    const installation =
      selected === 'Browse…'
        ? (
            await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false })
          )?.[0].fsPath
        : selected;
    if (installation) await postToSidebar({ type: 'computerInstallation', value: installation });
  };
  const applyEditorFromSidebar = async (
    state: ProjectState,
    message: Extract<ProjectMessage, { action: 'editor' | 'reviewEditor' }>
  ) => {
    const integration = message.integration ?? projectPreferences(state.project.root).integration ?? 'default';
    const settings = {
      ...state.editor,
      integration: integration === 'default' ? localPreferences.computer.integration : integration,
      indentStyle: message.indentStyle as EditorSettings['indentStyle'],
      indentSize: message.indentSize as number
    };
    if (await applyEditor(state, settings, message.action === 'reviewEditor')) {
      await setProjectPreference(state.project.root, integration === 'default' ? {} : { integration });
      state.editor = await resolveEditor(state.project.root);
      await refreshEditorConfiguration(state);
      publish();
      await postToSidebar({ type: 'editorSaved', root: state.project.root });
    } else if (message.action === 'reviewEditor')
      await postToSidebar({ type: 'editorReviewed', root: state.project.root });
  };
  const stopOperation = (state: ProjectState, entry: EntryState) => {
    // A peer card can stop the build that another project's card started for the same mod.
    const owner = entry.abort
      ? entry
      : entry.runtime?.id
        ? installedOperations.get(installedModKey(state.editor.installationPath, entry.runtime.id))
        : undefined;
    if (owner?.abort && !owner.abort.signal.aborted) {
      owner.stopping = true;
      if (owner.runtime) owner.runtime.stopping = true;
      owner.abort.abort();
      publish();
    }
  };
  const refreshGit = async (state: ProjectState) => {
    state.git = await gitStatus(state.project.root, gitExecutable());
    publish();
  };
  const routeSidebarMessage = createSidebarRouter<ProjectState, EntryState>({
    findProject: root => (typeof root === 'string' ? projects.get(root) : undefined),
    findEntry: (state, entry) => (typeof entry === 'string' ? state.entries.get(entry) : undefined),
    selectProject: state => {
      selectedRoot = state.project.root;
    },
    global: {
      ready: async () => {
        await refreshRecentProjects();
        publish();
        pendingSidebarPage = undefined;
      },
      logs: async () => log.show(),
      openProject: message => openExistingProject(message.projectRoot, message.browse),
      initialize: async message => {
        const completed = await initialize(
          message.mode,
          message.openProject ?? openAfterSetup(),
          message.initialCommit ?? initialCommitEnabled()
        );
        await postToSidebar({ type: 'setupFinished', completed });
      },
      browseGsudo: async () => {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { Executable: ['exe'] },
          openLabel: 'Choose gsudo.exe'
        });
        if (selected?.[0]) await postToSidebar({ type: 'gsudoPath', value: selected[0].fsPath });
      },
      browseComputerInstallation,
      checkElevation: async message => {
        const availability = await inspectElevation(readComputerPreferences(message.settings).preferences);
        await postToSidebar({ type: 'elevationChecked', message: availability.notice });
      },
      computerPreferences: message => saveComputerPreferences(message.settings),
      restore: () => restore()
    },
    project: {
      openFolder: state =>
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(state.project.root), false),
      refreshGit,
      sourceControl: () => vscode.commands.executeCommand('workbench.view.scm'),
      gitSetup: async state => {
        await setupProject(state.project.root, { git: gitExecutable() });
        await refreshGit(state);
      },
      projectPreferences: async (state, message) => {
        if (anyBusy([state])) throw new Error('Wait for the current Windhawk operation before changing preferences.');
        await setProjectPreference(
          state.project.root,
          message.integration !== 'default' ? { integration: message.integration } : {}
        );
        state.editor = await resolveEditor(state.project.root);
        await refreshRuntime(state);
        await refreshDraft(state);
        publish();
        await postToSidebar({ type: 'projectPreferencesSaved' });
      },
      editor: applyEditorFromSidebar,
      reviewEditor: applyEditorFromSidebar,
      select: async state => {
        await rememberProject(state.project.root);
        publish();
      },
      config: async (state, message) => {
        await updateConfig(state, message.config);
        await postToSidebar({ type: 'saved', root: state.project.root });
      },
      generateAll: async state => {
        if (await saveRelevant(state)) await enqueue(state);
      }
    },
    entry: {
      details: (state, entry) => showDetails(state, entry),
      compile: (state, entry) => compileMod(state, entry),
      testCompile: (state, entry) => compileMod(state, entry, true),
      stopCompile: async (state, entry) => stopOperation(state, entry),
      enable: (state, entry, message) => enableMod(state, entry, message.enabled),
      open: (state, entry, message) => runModAction(state, entry, 'open', message.line),
      generate: (state, entry) => runModAction(state, entry, 'generate'),
      compare: (state, entry) => runModAction(state, entry, 'compare'),
      restore: (state, entry) => runModAction(state, entry, 'restore'),
      discard: (state, entry) => runModAction(state, entry, 'discard'),
      output: (state, entry) => runModAction(state, entry, 'output'),
      verify: (state, entry) => runModAction(state, entry, 'verify')
    }
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'windhawk.projects',
      {
        resolveWebviewView(webviewView) {
          sidebarDetails?.controller.dispose();
          sidebarDetails = undefined;
          view = webviewView;
          const nonce = randomBytes(16).toString('hex');
          view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
          };
          const script = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'sidebar.js'));
          const iconFont = view.webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'media', 'windhawk-renderer', 'codicon.edde7c4363c6d735a416.ttf')
          );
          view.webview.html = fillTemplate(sidebarTemplate, {
            cspSource: view.webview.cspSource,
            nonce,
            iconFont: String(iconFont),
            sidebarStyles,
            script: String(script)
          });
          sidebarHtml = view.webview.html;
          // VS Code resolves a new view after the old one is disposed; route messages to one listener only.
          sidebarReceiver?.dispose();
          webviewView.onDidDispose?.(() => {
            if (view !== webviewView) return;
            sidebarReceiver?.dispose();
            sidebarReceiver = undefined;
            sidebarDetails?.controller.dispose();
            sidebarDetails = undefined;
            view = undefined;
          });
          sidebarReceiver = view.webview.onDidReceiveMessage(async message => {
            // While mod details occupy the sidebar, its own controller handles messages.
            if (sidebarDetails) return;
            try {
              await routeSidebarMessage(message);
            } catch (error) {
              log.appendLine(String(error));
              await postToSidebar({
                type: 'error',
                action: message?.action,
                root: message?.root,
                message: (error as Error).message
              });
            }
          });
          publish();
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => changed(document.uri.fsPath)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== 'file') return;
      // This fires per keystroke in every open file: only republish for project inputs/outputs.
      let affected = false;
      for (const state of projects.values())
        for (const entry of state.entries.values()) {
          if (sameFile(event.document.uri.fsPath, outputPath(state.project, entry.path))) {
            affected = true;
            if (event.document.isDirty) {
              entry.status = 'blocked';
              entry.message = 'Output has unsaved edits.';
            } else scheduleRefresh(state, false, [entry]);
          } else if (sameFile(event.document.uri.fsPath, entry.path) || dependsOn(entry, event.document.uri.fsPath)) {
            affected = true;
            if (event.document.isDirty) entry.status = 'pending';
            entry.compilerDiagnostics = [];
            scheduleRefresh(state, false, [entry]);
            if (sameFile(event.document.uri.fsPath, entry.path))
              entry.metadata = parseMetadata(event.document.getText(), entry.path);
          }
        }
      if (affected) {
        presentDiagnostics();
        publish();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const folder of event.added)
        if (folder.uri.scheme === 'file')
          void fs
            .stat(path.join(folder.uri.fsPath, 'windhawk-amalgamation.json'))
            .then(() => addProject(folder.uri.fsPath))
            .catch(error => log.appendLine(String(error)));
      for (const folder of event.removed) {
        const state = [...projects.values()].find(state => sameFile(state.project.root, folder.uri.fsPath));
        if (state) retireProject(state);
      }
      publish();
    }),
    {
      dispose() {
        disposed = true;
        void closeElevationSessions();
        sidebarDetails?.controller.dispose();
        sidebarReceiver?.dispose();
        for (const state of projects.values()) retireProject(state);
      }
    }
  );
  if (vscode.window.onDidChangeWindowState)
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState(event => {
        if (event.focused) for (const state of projects.values()) scheduleRefresh(state, true);
      })
    );
  for (const folder of vscode.workspace.workspaceFolders ?? [])
    if (folder.uri.scheme === 'file') {
      try {
        await fs.stat(path.join(folder.uri.fsPath, 'windhawk-amalgamation.json'));
        await addProject(folder.uri.fsPath);
      } catch {
        /* Initialize explicitly if no config exists. */
      }
    }
  for (const root of context.workspaceState.get<string[]>('additionalRoots', [])) {
    try {
      await fs.stat(path.join(root, 'windhawk-amalgamation.json'));
      await addProject(root);
    } catch {
      /* A detached project may have moved. */
    }
  }
  publish();
}
