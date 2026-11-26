import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { contained, defaults, discoverEntries, layoutConfig, outputPath, validateConfig } from './config';
import { checksum, generateEntry, restoreSource } from './engine';
import {
  assertSafeDestination,
  changedSince,
  commitRestore,
  loadProject,
  nodeFiles,
  readIfExists,
  writeOutput
} from './io';
import { Configuration, GenerationTiming, Project } from './types';
import { parseMetadata, parseDraftSource } from './metadata';
import {
  inspectWindhawk,
  inspectElevation,
  closeElevationSessions,
  invokeWindhawkCore,
  runWindhawkCli,
  runWindhawkProcess,
  readInstalledMod,
  previewLanguage
} from './windhawk';
import { ComputerPreferencesInput, createSidebarRouter, ProjectMessage } from './sidebar';
import { createGenerationPipeline } from './generation';
import { createRuntimeOperations } from './runtime';
import {
  CompiledSnapshot,
  dependsOn,
  EntryState,
  localModId,
  projectSummary,
  ProjectState,
  sameFile
} from './projects';
import { createDetailsView, DetailsData } from './details';
import { checkModBuild } from './compiler';
import {
  ComputerPreferences,
  computerSettings,
  InstallationPreferences,
  loadLocalPreferences,
  migrateComputerPreferences,
  readComputerPreferences
} from './preferences';
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
  await migrateComputerPreferences(context.globalState, localPreferences, {
    isSet: setting => vscode.workspace.getConfiguration('wham').inspect(setting)?.globalValue !== undefined,
    set: (setting, value) =>
      vscode.workspace.getConfiguration('wham').update(setting, value, vscode.ConfigurationTarget.Global)
  }).catch(error => {
    // User settings may be temporarily unwritable. Retry on the next activation.
    log.appendLine('Could not migrate WHAM computer settings: ' + String(error));
  });
  /** Computer-wide preferences, from VS Code settings. */
  const computer = () => readComputerPreferences(setting => vscode.workspace.getConfiguration('wham').get(setting));
  /** Nonzero while WHAM writes computer settings; the caller applies them once afterwards. */
  let savingComputer = 0;
  /** Write the preferences that differ to user settings; `machine` scope keeps paths off Settings Sync. */
  const saveComputer = async (next: Partial<ComputerPreferences>) => {
    const current = computer();
    savingComputer++;
    try {
      for (const key of Object.keys(next) as (keyof ComputerPreferences)[])
        if (next[key] !== undefined && next[key] !== current[key])
          await vscode.workspace
            .getConfiguration('wham')
            .update(computerSettings[key], next[key], vscode.ConfigurationTarget.Global);
    } finally {
      savingComputer--;
      // Successful writes and Settings editor events still count when a later write fails.
      if (!savingComputer) await applyComputerPreferences();
    }
  };
  const installationPreferences = (): InstallationPreferences => {
    const { elevation, gsudoPath } = computer();
    return { elevation, gsudoPath };
  };
  const resolveEditor = (applied: Awaited<ReturnType<typeof readEditorSettings>>): EditorSettings => {
    const { installationPath, integration } = computer();
    return {
      ...applied,
      installationPath,
      integration: applied.integration ?? integration
    };
  };
  /** A timing value set in user, workspace or folder settings, with the level that holds it. */
  const explicitTiming = <K extends keyof GenerationTiming>(root: string, key: K) => {
    const inspected = vscode.workspace.getConfiguration('wham', vscode.Uri.file(root)).inspect<unknown>(key);
    const levels = [
      // A single-folder window can expose its workspace settings at both levels.
      [key === 'generate' ? inspected?.workspaceFolderValue : undefined, vscode.ConfigurationTarget.WorkspaceFolder],
      [inspected?.workspaceValue, vscode.ConfigurationTarget.Workspace],
      [inspected?.globalValue, vscode.ConfigurationTarget.Global]
    ] as const;
    const valid = (value: unknown): value is GenerationTiming[K] =>
      key === 'generate'
        ? value === 'onSave' || value === 'manual'
        : Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 10000;
    const found = levels.find(([value]) => valid(value));
    return found && { value: found[0] as GenerationTiming[K], target: found[1] };
  };
  /** Settings win; older project files that still hold `generate`/`debounceMs` are the fallback. */
  const timing = (state: ProjectState): GenerationTiming => ({
    generate: explicitTiming(state.project.root, 'generate')?.value ?? state.project.config.generate,
    debounceMs: explicitTiming(state.project.root, 'debounceMs')?.value ?? state.project.config.debounceMs
  });
  const lastGenerateSetting = new WeakMap<ProjectState, GenerationTiming['generate']>();
  /**
   * Store changed timing in VS Code settings. After save / Manual belongs to this project: its
   * folder settings when it is a workspace folder. Otherwise, and for the debounce, the level
   * that already holds a value, or user settings.
   */
  const saveTiming = async (state: ProjectState, next: GenerationTiming, fallback = state.project.config) => {
    const folder = vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, state.project.root));
    for (const key of ['generate', 'debounceMs'] as const) {
      const explicit = explicitTiming(state.project.root, key);
      if (next[key] === (explicit?.value ?? fallback[key])) continue;
      const target =
        key === 'generate' && folder
          ? vscode.ConfigurationTarget.WorkspaceFolder
          : (explicit?.target ?? vscode.ConfigurationTarget.Global);
      await vscode.workspace
        .getConfiguration('wham', vscode.Uri.file(state.project.root))
        .update(key, next[key], target);
    }
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
  // Compile, install, enable, verify and installed-state polling live in runtime.ts. Hooks
  // defined further down (saveRelevant, enqueue, refreshDraft) are called lazily.
  const runtime = createRuntimeOperations({
    isDisposed: () => disposed,
    projects: () => projects.values(),
    log,
    publish: () => publish(),
    inform: message => void vscode.window.showInformationMessage(message),
    showError: message => void vscode.window.showErrorMessage(message),
    promptCompiler: async () => {
      const executable = await vscode.window.showInputBox({
        title: 'Compiler executable',
        prompt: 'Full executable path; the command runs only when you invoke Verify.'
      });
      if (!executable) return undefined;
      const argumentsJson = await vscode.window.showInputBox({
        title: 'Compiler arguments (JSON array)',
        value: JSON.stringify(['-std=c++23', '-fsyntax-only']),
        prompt: 'Use {file} where the generated file belongs, or it will be appended.'
      });
      return argumentsJson ? { executable, argumentsJson } : undefined;
    },
    saveRelevant: state => saveRelevant(state),
    enqueue: (state, targets) => enqueue(state, targets),
    refreshDraft: (state, entries) => refreshDraft(state, entries),
    refreshEditorConfiguration: state => refreshEditorConfiguration(state),
    installationPreferences,
    compiledSnapshots: () => context.globalState.get<Record<string, CompiledSnapshot>>('compiledSnapshots', {}),
    saveCompiledSnapshots: builds => context.globalState.update('compiledSnapshots', builds),
    tools: { inspectWindhawk, readInstalledMod, runWindhawkCli, runWindhawkProcess, checkModBuild }
  });
  const { updateCompileStatus, refreshRuntime, compileMod, enableMod, verify, stopOperation } = runtime;
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
      computer: computer(),
      openAfterSetup: openAfterSetup(),
      createInitialCommit: initialCommitEnabled(),
      projectChoices: projectChoices(),
      projects: [...projects.values()].map(item => ({
        root: item.project.root,
        name: path.basename(item.project.root),
        // Settings → Generation shows the timing in effect, wherever it is stored.
        config: { ...item.project.config, ...timing(item) },
        editor: item.editor,
        editorNeedsApply: item.editorNeedsApply,
        elevation: computer().elevation,
        git: item.git,
        windhawk: item.windhawk,
        opened: !!vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, item.project.root)),
        error: item.error,
        retained: item.retained,
        entries: [...item.entries.values()].map(entry => {
          const owner = runtime.operationOwner(item, entry);
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
  // Save → debounce → generate → protected write lives in generation.ts; this binds it to VS Code.
  // The hooks are called lazily, so the Draft and runtime refreshes can be defined below.
  const pipeline = createGenerationPipeline(
    {
      isDisposed: () => disposed,
      isDirty,
      dirtyText: file =>
        vscode.workspace.textDocuments
          .find(document => sameFile(document.uri.fsPath, file) && document.isDirty)
          ?.getText(),
      dirtyFiles: () =>
        vscode.workspace.textDocuments
          .filter(document => document.isDirty && document.uri.scheme === 'file')
          .map(document => document.uri.fsPath),
      log: line => log.appendLine(line),
      publish: () => publish(),
      presentDiagnostics: () => presentDiagnostics(),
      saveHashes: hashes => context.workspaceState.update('outputHashes', hashes),
      gitStatus: root => gitStatus(root, gitExecutable()),
      refreshDraft: (state, entries) => refreshDraft(state, entries),
      refreshRuntime: state => refreshRuntime(state),
      refreshEditorConfiguration: state => refreshEditorConfiguration(state),
      editorFilesChanged: async state => {
        state.editor = resolveEditor(await readEditorSettings(state.project.root));
        await refreshEditorConfiguration(state);
        publish();
      },
      timing
    },
    storedHashes
  );
  const { relevantDirty, reconcileOutput, scheduleRefresh, refresh, enqueue } = pipeline;
  const changed = (file: string, discovery = false) => pipeline.changed(projects.values(), file, discovery);
  let appliedComputer = computer(),
    computerQueue: Promise<void> = Promise.resolve();
  /**
   * Bring every project up to date with the computer preferences, wherever they were changed:
   * the sidebar, editor setup, or the Settings editor. Runs one change at a time.
   */
  const applyComputerPreferences = () => {
    const run = computerQueue.then(async () => {
      const previous = appliedComputer,
        next = computer();
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      appliedComputer = next;
      if (
        !sameFile(previous.installationPath, next.installationPath) ||
        previous.elevation !== next.elevation ||
        previous.gsudoPath !== next.gsudoPath
      )
        await closeElevationSessions();
      for (const project of projects.values()) {
        // An earlier runtime poll must finish before replacing its installation state.
        const update = project.queue.then(async () => {
          if (disposed || project.removed) return;
          project.editor = resolveEditor(await readEditorSettings(project.project.root));
          await refreshRuntime(project);
          await refreshDraft(project);
        });
        project.queue = update.catch(() => {});
        await update;
      }
      publish();
    });
    computerQueue = run.catch(() => {});
    return run;
  };
  /** After loading, or switching to After save, catch up on what manual mode left stale. */
  const generateStale = (state: ProjectState) => {
    if (timing(state).generate !== 'onSave') return;
    const stale = [...state.entries.values()].filter(entry => entry.status === 'stale').map(entry => entry.path);
    if (stale.length) void enqueue(state, stale, { automatic: true });
  };
  const saveRelevant = async (state: ProjectState): Promise<boolean> => {
    const files = relevantDirty(state);
    const dirty = vscode.workspace.textDocuments.filter(
      document => document.isDirty && document.uri.scheme === 'file' && files.includes(document.uri.fsPath)
    );
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
        await reconcileOutput(state, entry);
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
    const applied = await readEditorSettings(root);
    if (applied.installationPath && !computer().installationPath) {
      let usable = false;
      try {
        await fs.access(path.join(applied.installationPath, 'windhawk.ini'));
        usable = true;
      } catch {
        /* A copied project's path may not exist on this computer. */
      }
      if (
        usable &&
        vscode.workspace.getConfiguration('wham').inspect(computerSettings.installationPath)?.globalValue === undefined
      )
        await saveComputer({ installationPath: applied.installationPath }).catch(error => {
          log.appendLine('Could not adopt the project’s Windhawk installation: ' + String(error));
        });
    }
    const state: ProjectState = {
      project: { root, config: { ...defaults } },
      entries: new Map(),
      queue: Promise.resolve(),
      pending: new Set(),
      draftPending: new Set(),
      retained: [],
      editor: resolveEditor(applied)
    };
    projects.set(root, state);
    const mode = explicitTiming(root, 'generate')?.value;
    if (mode) lastGenerateSetting.set(state, mode);
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
      generateStale(state);
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
    contents.set(
      'windhawk-amalgamation.json',
      Buffer.from(JSON.stringify(layoutConfig(result.manifest.config), null, 2) + '\n')
    );
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
    state.editor = resolveEditor(await readEditorSettings(state.project.root));
    state.windhawk = windhawk;
    await refreshRuntime(state);
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
    if (settings.installationPath && settings.installationPath !== computer().installationPath) {
      if ([...projects.values()].some(project => [...project.entries.values()].some(entry => entry.busy)))
        throw new Error('Wait for the current Windhawk operation before changing preferences.');
      // Validate before saving a newly selected installation as a computer preference.
      await editorConfiguration(
        state.project,
        settings,
        (await inspectWindhawk(settings.installationPath)).compileFlags
      );
      await saveComputer({ installationPath: settings.installationPath });
    }
    await applyEditor(state, settings);
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
  /** Layout goes to the project file; when to generate goes to VS Code settings. */
  const updateConfig = async (state: ProjectState, input: unknown) => {
    const config = validateConfig(input);
    const layoutChanged = JSON.stringify(layoutConfig(config)) !== JSON.stringify(layoutConfig(state.project.config));
    if (layoutChanged) await updateLayout(state, config);
    else await saveTiming(state, config);
    if (layoutChanged && timing(state).generate === 'onSave') await enqueue(state, undefined, { automatic: true });
  };
  const updateLayout = async (state: ProjectState, config: Configuration) => {
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
      // A failed ignore update must leave the old layout in place. Brackets are literal in paths.
      if (config.outputDirectory !== state.project.config.outputDirectory)
        await appendIgnoreRules(temporaryProject, [`/${config.outputDirectory.replace(/[[\]]/g, '\\$&')}/`]);
      // Keep legacy timing until VS Code has accepted the settings needed by the rewritten file.
      await saveTiming(state, config, defaults);
      await writeOutput(
        state.project,
        path.join(state.project.root, 'windhawk-amalgamation.json'),
        Buffer.from(JSON.stringify(layoutConfig(config), null, 2) + '\n')
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
    if (!state) return;
    const current = timing(state);
    await saveTiming(state, { ...current, generate: current.generate === 'onSave' ? 'manual' : 'onSave' });
  });
  // Sidebar protocol: parsing and dispatch live in sidebar.ts; these are the operations.
  const postToSidebar = (message: unknown) => view?.webview.postMessage(message);
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  const readComputerForm = (settings: ComputerPreferencesInput) => {
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
  /** The sidebar checks the choices before they reach settings; the Settings editor cannot. */
  const saveComputerPreferences = async (settings: ComputerPreferencesInput) => {
    const { root, preferences } = readComputerForm(settings);
    await inspectElevation(preferences);
    if (anyBusy(projects.values()))
      throw new Error('Wait for the current Windhawk operation before changing preferences.');
    if (root) await fs.access(path.join(root, 'windhawk.ini'));
    await saveComputer({ installationPath: root, ...preferences, integration: settings.integration });
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
    const settings = {
      ...state.editor,
      integration: message.integration ?? state.editor.integration,
      indentStyle: message.indentStyle as EditorSettings['indentStyle'],
      indentSize: message.indentSize as number
    };
    if (await applyEditor(state, settings, message.action === 'reviewEditor'))
      await postToSidebar({ type: 'editorSaved', root: state.project.root });
    else if (message.action === 'reviewEditor')
      await postToSidebar({ type: 'editorReviewed', root: state.project.root });
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
        const availability = await inspectElevation(readComputerForm(message.settings).preferences);
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
    vscode.workspace.onDidChangeConfiguration(event => {
      // Edits in the Settings editor; WHAM's own writes apply once they are all written.
      if (
        !savingComputer &&
        Object.values(computerSettings).some(setting => event.affectsConfiguration('wham.' + setting))
      )
        applyComputerPreferences().catch(error => log.appendLine(String(error)));
      // Only a change in this project's mode should bypass its normal save debounce.
      if (event.affectsConfiguration('wham.generate')) {
        for (const state of projects.values()) {
          const previous = lastGenerateSetting.get(state) ?? state.project.config.generate;
          const explicit = explicitTiming(state.project.root, 'generate')?.value;
          if (explicit) lastGenerateSetting.set(state, explicit);
          else lastGenerateSetting.delete(state);
          const mode = explicit ?? state.project.config.generate;
          if (mode === previous) continue;
          if (mode === 'onSave') generateStale(state);
          else {
            if (state.timer) clearTimeout(state.timer);
            // Saves still update Draft and metadata in Manual mode.
            const pending = [...state.entries.values()].filter(entry => state.pending.has(entry.path));
            state.pending.clear();
            if (pending.length) scheduleRefresh(state, false, pending);
          }
        }
        publish();
      } else if (event.affectsConfiguration('wham.debounceMs')) publish();
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
