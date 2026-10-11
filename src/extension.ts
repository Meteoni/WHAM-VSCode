import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { contained, defaults, discoverEntries, outputPath, validateConfig } from './config';
import { checksum, generateEntry, restoreSource } from './engine';
import { assertSafeDestination, commitRestore, initializeProject, inputsUnchanged, loadProject, nodeFiles, writeOutput } from './io';
import { GenerationResult, Project } from './types';
import { ModMetadata, parseMetadata } from './metadata';
import { appendIgnoreRules, createInitialCommit, editorConfiguration, editorDefaults, EditorSettings, findWindhawk, gitStatus, mergeRecoveries, readEditorSettings, setupProject } from './setup';

interface EntryState {
  path: string; output: string; status: string; result?: GenerationResult; ownedHash?: string; message?: string; metadata?: ModMetadata;
}
interface ProjectState {
  project: Project; entries: Map<string, EntryState>; queue: Promise<void>;
  pending: Set<string>; timer?: NodeJS.Timeout; error?: string; retained: string[];
  editor: EditorSettings; git?: Awaited<ReturnType<typeof gitStatus>>;
}

/** Bind the shared engine to workspace lifecycle, project queues, and the sidebar. */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('WHAM');
  const diagnostics = vscode.languages.createDiagnosticCollection('wham');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  status.command = 'workbench.view.extension.windhawk'; status.show();
  const projects = new Map<string, ProjectState>();
  const previews = new Map<string, string>();
  let view: vscode.WebviewView | undefined, selectedRoot: string | undefined, previewId = 0, disposed = false;
  const storedHashes = context.workspaceState.get<Record<string, string>>('outputHashes', {});
  const storedEditors = { ...context.workspaceState.get<Record<string, EditorSettings>>('editorSettings', {}), ...context.globalState.get<Record<string, EditorSettings>>('editorSettings', {}) };
  let recentProjects = context.globalState.get<string[]>('recentProjects', []).filter(root => typeof root === 'string' && path.isAbsolute(root));
  const initialCommitEnabled = () => vscode.workspace.getConfiguration('wham').get<boolean>('createInitialCommit', false);
  const openAfterSetup = () => vscode.workspace.getConfiguration('wham').get<boolean>('openProjectAfterSetup', true);
  const gitExecutable = () => vscode.workspace.getConfiguration('git').get<string>('path') || 'git';
  const sameFile = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  const dependsOn = (entry: EntryState, file: string) => [...(entry.result?.dependencies.keys() ?? [])].some(dependency => sameFile(dependency, file));
  const virtual = (label: string, bytes: Buffer | string): vscode.Uri => {
    const uri = vscode.Uri.from({ scheme: 'wham-preview', path: `/${++previewId}/${path.basename(label)}` });
    previews.set(uri.toString(), bytes.toString()); return uri;
  };
  context.subscriptions.push(log, diagnostics, status,
    vscode.workspace.registerTextDocumentContentProvider('wham-preview', { provideTextDocumentContent: uri => previews.get(uri.toString()) ?? '' }));
  const active = (): ProjectState | undefined => {
    const editorRoot = vscode.window.activeTextEditor?.document.uri.fsPath;
    return projects.get(selectedRoot ?? '') ?? [...projects.values()].find(state => editorRoot && contained(state.project.root, editorRoot)) ?? projects.values().next().value;
  };
  const projectChoices = () => [
    ...[...new Set([...recentProjects, ...projects.keys()])].map(root => ({ label: path.basename(root), description: 'Recent project', detail: root, root })),
    { label: 'Browse for a project folder…', description: '', detail: '', root: '' }
  ];
  const publish = () => {
    if (disposed) return;
    const state = active();
    const statuses = state ? [...state.entries.values()].map(entry => entry.status) : [];
    status.text = '$(file-code) WHAM: ' + (state?.error ? 'configuration error' : statuses.includes('generating') ? 'generating' : statuses.includes('blocked') ? 'output edits' : statuses.some(value => value !== 'current') ? 'stale' : 'current');
    status.tooltip = state?.project.root ?? 'Initialize a Windhawk project';
    void view?.webview.postMessage({ type: 'state', selected: state?.project.root,
      openAfterSetup: openAfterSetup(), createInitialCommit: initialCommitEnabled(), projectChoices: projectChoices(), projects: [...projects.values()].map(item => ({ root: item.project.root, name: path.basename(item.project.root), config: item.project.config, editor: item.editor, git: item.git,
        opened: !!vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, item.project.root)),
        error: item.error, retained: item.retained, entries: [...item.entries.values()].map(entry => ({ path: entry.path, label: path.relative(path.join(item.project.root, item.project.config.sourceDirectory), entry.path),
          status: entry.status, message: entry.message, metadata: entry.metadata, output: outputPath(item.project, entry.path), dependencies: entry.result?.dependencies.size ?? 0 })) })) });
  };
  const presentDiagnostics = () => {
    diagnostics.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();
    for (const state of projects.values()) for (const entry of state.entries.values()) {
      for (const item of [...(entry.result?.diagnostics ?? []), ...(entry.metadata?.diagnostics ?? [])]) {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(item.line, 0, item.line, 100), item.message,
          item.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
        const list = grouped.get(item.path) ?? []; list.push(diagnostic); grouped.set(item.path, list);
      }
    }
    for (const [file, list] of grouped) diagnostics.set(vscode.Uri.file(file), list);
  };
  const ownedOutput = (existing: Buffer, entry: EntryState, state: ProjectState, expected?: Buffer): boolean => {
    if (expected?.equals(existing) || entry.ownedHash === checksum(existing)) return true;
    try {
      const restored = restoreSource(existing);
      return restored.manifest.root === path.relative(state.project.root, entry.path).split(path.sep).join('/') &&
        restored.conflicts.length === 0 && [...restored.files.values()].every(candidates => candidates.every(candidate => !candidate.changed));
    } catch { return false; }
  };
  const relevantDirty = (state: ProjectState, entry?: EntryState) => vscode.workspace.textDocuments.filter(document => document.isDirty && document.uri.scheme === 'file' &&
    (sameFile(document.uri.fsPath, path.join(state.project.root, 'windhawk-amalgamation.json')) ||
      (entry ? sameFile(document.uri.fsPath, entry.path) || dependsOn(entry, document.uri.fsPath) || !entry.result && contained(path.join(state.project.root, state.project.config.sourceDirectory), document.uri.fsPath)
        : contained(path.join(state.project.root, state.project.config.sourceDirectory), document.uri.fsPath))));
  const saveRelevant = async (state: ProjectState): Promise<boolean> => {
    const dirty = relevantDirty(state);
    if (!dirty.length) return true;
    const choice = await vscode.window.showWarningMessage(`${dirty.length} relevant document(s) have unsaved changes. Generation reads saved files.`, { modal: true }, 'Save Relevant Files');
    if (choice !== 'Save Relevant Files') return false;
    for (const document of dirty) if (!await document.save()) return false;
    return true;
  };
  const refresh = async (state: ProjectState) => {
    state.project = await loadProject(state.project.root);
    const entries = await discoverEntries(state.project, nodeFiles);
    for (const previous of [...state.entries.values()]) {
      const stillExists = entries.includes(previous.path);
      const nextOutput = stillExists ? outputPath(state.project, previous.path) : undefined;
      if (stillExists && nextOutput === previous.output) continue;
      const output = previous.output;
      try {
        const existing = await fs.readFile(output);
        if (previous.ownedHash === checksum(existing) && !vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, output) && document.isDirty)) {
          await assertSafeDestination(state.project.root, path.relative(state.project.root, output).split(path.sep).join('/'));
          await fs.rm(output); delete storedHashes[output];
        } else state.retained.push(`Preserved orphan output: ${output}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.appendLine(String(error)); }
      state.entries.delete(previous.path);
    }
    for (const entry of entries) if (!state.entries.has(entry)) state.entries.set(entry, { path: entry, output: outputPath(state.project, entry), status: 'stale', ownedHash: storedHashes[outputPath(state.project, entry)] });
    for (const entry of state.entries.values()) {
      const document = vscode.workspace.textDocuments.find(document => sameFile(document.uri.fsPath, entry.path) && document.isDirty);
      entry.metadata = parseMetadata(document ? document.getText() : await fs.readFile(entry.path, 'utf8'), entry.path);
    }
    state.error = undefined;
    state.git = await gitStatus(state.project.root, gitExecutable());
    presentDiagnostics();
  };
  const generate = async (state: ProjectState, entry: EntryState, force: boolean) => {
    const output = outputPath(state.project, entry.path);
    const dirtyOutput = vscode.workspace.textDocuments.find(document => sameFile(document.uri.fsPath, output) && document.isDirty);
    if (dirtyOutput) { entry.status = 'blocked'; entry.message = 'Output has unsaved edits. Save or revert it before regenerating.'; publish(); return; }
    if (relevantDirty(state, entry).length) { entry.status = 'pending'; entry.message = 'Waiting for source buffers to be saved.'; publish(); return; }
    entry.status = 'generating'; entry.message = undefined; publish();
    const result = await generateEntry(state.project, entry.path, nodeFiles);
    entry.result = result;
    for (const diagnostic of result.diagnostics) log.appendLine(`${diagnostic.path}:${diagnostic.line + 1}: ${diagnostic.message}`);
    if (!result.bytes) { entry.status = 'stale'; entry.message = result.diagnostics.find(item => item.severity === 'error')?.message; return; }
    let existing: Buffer | undefined;
    try { existing = await fs.readFile(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing && !force && !ownedOutput(existing, entry, state, result.bytes)) {
      entry.status = 'blocked'; entry.message = 'Output was edited. Compare, restore edits, or explicitly discard them.'; return;
    }
    if (!await inputsUnchanged(result.dependencies) || relevantDirty(state, entry).length) {
      entry.status = 'pending'; entry.message = 'Source changed during generation; queued another pass.'; schedule(state, [entry.path]); return;
    }
    // Recheck output immediately before commit, including documents dirtied during generation.
    let now: Buffer | undefined;
    try { now = await fs.readFile(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if ((now ? !existing || !now.equals(existing) : !!existing) || vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, output) && document.isDirty)) {
      entry.status = 'blocked'; entry.message = 'Output changed during generation; no write performed.'; return;
    }
    if (!existing?.equals(result.bytes)) await writeOutput(state.project, output, result.bytes);
    entry.ownedHash = checksum(result.bytes); storedHashes[output] = entry.ownedHash;
    entry.status = 'current'; entry.message = `${result.dependencies.size} source file(s)`;
  };
  const enqueue = (state: ProjectState, targets?: string[], force = false): Promise<void> => {
    state.queue = state.queue.then(async () => {
      if (disposed) return;
      try {
        await refresh(state);
        for (const entry of state.entries.values()) {
          if (targets && !targets.includes(entry.path)) continue;
          try { await generate(state, entry, force); }
          catch (error) { entry.status = 'stale'; entry.message = String(error); log.appendLine(String(error)); }
        }
        await context.workspaceState.update('outputHashes', storedHashes);
      } catch (error) { state.error = (error as Error).message; log.appendLine(String(error)); }
      presentDiagnostics(); publish();
    });
    return state.queue;
  };
  const schedule = (state: ProjectState, targets: string[]) => {
    for (const target of targets) state.pending.add(target);
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const targets = [...state.pending]; state.pending.clear();
      void enqueue(state, targets);
    }, state.project.config.debounceMs);
  };
  const changed = (file: string) => {
    for (const state of projects.values()) {
      if (!contained(state.project.root, file)) continue;
      const source = path.join(state.project.root, state.project.config.sourceDirectory), output = path.join(state.project.root, state.project.config.outputDirectory);
      if (['.vscode/settings.json', '.vscode/c_cpp_properties.json', '.clang-format', '.clangd'].some(local => sameFile(file, path.join(state.project.root, local)))) {
        state.queue = state.queue.then(async () => {
          try { state.editor = await readEditorSettings(state.project.root, state.editor); publish(); }
          catch (error) { log.appendLine(String(error)); }
        });
        continue;
      }
      if (contained(output, file)) {
        for (const entry of state.entries.values()) if (sameFile(outputPath(state.project, entry.path), file)) {
          void fs.readFile(file).then(bytes => {
            if (entry.ownedHash !== checksum(bytes)) { entry.status = 'blocked'; entry.message = 'Generated output changed on disk.'; publish(); }
          }).catch(() => { entry.status = 'stale'; publish(); });
        }
        continue;
      }
      if (sameFile(file, path.join(state.project.root, 'windhawk-amalgamation.json')) || /\.cpp$/i.test(file) && contained(source, file)) {
        for (const entry of state.entries.values()) if (entry.status !== 'blocked') { entry.status = 'stale'; entry.message = 'Saved sources or project configuration changed.'; }
        state.queue = state.queue.then(async () => {
          try { await refresh(state); if (state.project.config.generate === 'onSave') schedule(state, [...state.entries.keys()]); }
          catch (error) { state.error = String(error); }
          publish();
        });
      } else if (contained(source, file)) {
        const targets = [...state.entries.values()].filter(entry => !entry.result || dependsOn(entry, file) || entry.result.attempts.some(attempt => sameFile(attempt, file)));
        for (const entry of targets) entry.status = 'stale';
        if (state.project.config.generate === 'onSave') schedule(state, targets.map(entry => entry.path));
        publish();
      }
    }
  };
  const rememberProject = async (root: string) => {
    recentProjects = [root, ...recentProjects.filter(previous => !sameFile(previous, root))].slice(0, 15);
    await context.globalState.update('recentProjects', recentProjects);
  };
  const addProject = async (root: string) => {
    root = path.resolve(root);
    const loadedRoot = [...projects.keys()].find(previous => sameFile(previous, root));
    if (loadedRoot) { selectedRoot = loadedRoot; await rememberProject(loadedRoot); publish(); return; }
    const savedEditor = Object.entries(storedEditors).reverse().find(([key]) => sameFile(key, root))?.[1];
    const state: ProjectState = { project: { root, config: { ...defaults } }, entries: new Map(), queue: Promise.resolve(), pending: new Set(), retained: [], editor: await readEditorSettings(root, savedEditor ?? editorDefaults) };
    projects.set(root, state);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
    context.subscriptions.push(watcher, watcher.onDidChange(uri => changed(uri.fsPath)), watcher.onDidCreate(uri => changed(uri.fsPath)), watcher.onDidDelete(uri => changed(uri.fsPath)));
    try { await refresh(state); await rememberProject(root); if (state.project.config.generate === 'onSave') void enqueue(state); }
    catch (error) { state.error = String(error); }
    publish();
  };
  const compare = async (state: ProjectState, entry: EntryState) => {
    const result = await generateEntry(state.project, entry.path, nodeFiles);
    if (!result.bytes) throw new Error(result.diagnostics.map(item => item.message).join('\n'));
    const output = outputPath(state.project, entry.path);
    let actual = vscode.Uri.file(output);
    try { await fs.stat(output); } catch { actual = virtual('missing.wh.cpp', ''); }
    await vscode.commands.executeCommand('vscode.diff', actual, virtual(path.basename(output), result.bytes), 'Existing output ↔ Expected from saved source');
  };
  const finishInitialCommit = async (state: ProjectState, sourceFiles: string[]) => {
    try {
      await createInitialCommit(state.project, sourceFiles, gitExecutable());
      log.appendLine('Created initial commit: ' + state.project.root);
    } catch (error) {
      log.appendLine(String(error));
      void vscode.window.showWarningMessage('Project is ready, but the initial commit failed. Check your Git name/email and the WHAM log. Setup files may remain staged.', 'Show log').then(choice => { if (choice === 'Show log') log.show(); });
    }
    state.git = await gitStatus(state.project.root, gitExecutable()); publish();
  };
  const restore = async (container?: string, openProject = openAfterSetup(), initialCommit = initialCommitEnabled()) => {
    const containers = container ? [container] : (await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'Windhawk source': ['cpp'] }, openLabel: 'Recover selected mods' }))?.map(uri => uri.fsPath);
    if (!containers?.length) return;
    for (const file of containers) if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, file) && document.isDirty)) throw new Error('Save generated outputs before restoring their edits.');
    const result = mergeRecoveries(await Promise.all(containers.map(async file => restoreSource(await fs.readFile(file)))));
    const selections = new Map<string, number>();
    for (const file of result.conflicts) {
      const candidates = result.files.get(file)!;
      for (;;) {
        const options = candidates.map((candidate, index) => ({ label: `Use copy ${index + 1}`, description: candidate.changed ? 'Edited copy' : 'Original copy', detail: `${file}; occurrences ${candidate.occurrences.join(', ')}`, index, compare: false }));
        const selection = await vscode.window.showQuickPick([...options, { label: 'Compare copies', description: '', detail: file, index: -1, compare: true }], { title: `Resolve conflicting occurrences: ${file}` });
        if (!selection) return;
        if (selection.compare) {
          const first = await vscode.window.showQuickPick(options, { title: 'Left copy' }), second = await vscode.window.showQuickPick(options, { title: 'Right copy' });
          if (first && second) await vscode.commands.executeCommand('vscode.diff', virtual(file, candidates[first.index].bytes), virtual(file, candidates[second.index].bytes), `Recovery copies: ${file}`);
        } else { selections.set(file, selection.index); break; }
      }
    }
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select recovery parent or existing project' });
    if (!picked?.[0]) return;
    const mode = await vscode.window.showQuickPick(['Create new recovered project here', 'Use this existing directory'], { title: 'Recovery destination' });
    if (!mode) return;
    let destination = picked[0].fsPath;
    if (mode.startsWith('Create')) {
      const name = await vscode.window.showInputBox({ title: 'New recovery directory', value: path.basename(containers[0]).replace(/\.wh\.cpp$/i, '') + '-recovered', validateInput: value => !value || /[\\/:*?"<>|]/.test(value) || ['.', '..'].includes(value) ? 'Enter one directory name.' : undefined });
      if (!name) return; destination = path.join(destination, name);
    }
    const contents = new Map([...result.files].map(([file, candidates]) => [file, candidates[selections.get(file) ?? 0].bytes]));
    contents.set('windhawk-amalgamation.json', Buffer.from(JSON.stringify(result.manifest.config, null, 2) + '\n'));
    const differences: string[] = [];
    for (const [file, bytes] of contents) {
      const target = await assertSafeDestination(destination, file);
      if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, target) && document.isDirty)) throw new Error(`Destination has unsaved edits: ${file}`);
      try { if (!(await fs.readFile(target)).equals(bytes)) differences.push(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    for (;;) {
      const picked = await vscode.window.showQuickPick([
        { label: 'Write reconstructed tree', description: `${contents.size} files; ${differences.length} existing files differ`, file: '' },
        ...[...contents.keys()].map(file => ({ label: file, description: differences.includes(file) ? 'Compare with existing file' : 'Preview recovered file', file }))
      ], { title: `Preview recovery → ${destination}` });
      if (!picked) return;
      if (!picked.file) break;
      const uri = virtual(picked.file, contents.get(picked.file)!);
      if (differences.includes(picked.file)) await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path.join(destination, picked.file)), uri, `Recovery preview: ${picked.file}`);
      else await vscode.window.showTextDocument(uri, { preview: true });
    }
    if (differences.length && await vscode.window.showWarningMessage(`Overwrite ${differences.length} differing file(s) in ${destination}?\n${differences.join('\n')}`, { modal: true }, 'Overwrite Reviewed Files') !== 'Overwrite Reviewed Files') return;
    for (const file of contents.keys()) if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, path.join(destination, file)) && document.isDirty)) throw new Error(`Destination became dirty: ${file}`);
    await commitRestore(result, destination, selections, differences.length > 0);
    const setup = await setupProject(destination, { git: gitExecutable() });
    await addProject(destination); selectedRoot = destination; publish();
    await configureEditor(projects.get(destination)!);
    if (initialCommit && setup.gitInitialized) await finishInitialCommit(projects.get(destination)!, [...result.files.keys()]);
    if (openProject && !vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, destination))) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), false);
    else void vscode.window.showInformationMessage(`Recovered ${result.files.size} source files in ${destination}`);
    return true;
  };
  const refreshRecentProjects = async () => {
    const available: string[] = [];
    for (const root of recentProjects) {
      try { if ((await fs.stat(path.join(root, 'windhawk-amalgamation.json'))).isFile()) available.push(root); }
      catch { /* The folder or its project configuration may have been removed. */ }
    }
    recentProjects = available; await context.globalState.update('recentProjects', recentProjects);
  };
  const openExistingProject = async (requestedRoot?: string, browse = false): Promise<boolean> => {
    await refreshRecentProjects(); publish();
    const choices = projectChoices();
    let root = requestedRoot;
    if (root && !choices.some(choice => sameFile(choice.root, root!))) throw new Error('This project is no longer available. Browse to its new location.');
    if (!root && !browse && choices.some(choice => choice.root)) {
      const choice = await vscode.window.showQuickPick(choices, { title: 'Open WHAM project', matchOnDetail: true });
      if (!choice) return false;
      root = choice.root;
    }
    if (!root) root = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select your source project' }))?.[0].fsPath;
    if (!root) return false;
    root = path.resolve(root);
    let configured = false;
    try { configured = (await fs.stat(path.join(root, 'windhawk-amalgamation.json'))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Opening an existing WHAM project never rewrites its editor or Git configuration.
    if (configured) await loadProject(root);
    else {
      await setupProject(root, { git: gitExecutable() });
      void vscode.window.showInformationMessage('WHAM project created. Configure the compiler and indentation in Settings → Editor when needed.');
    }
    await addProject(root); selectedRoot = root; publish();
    if (!vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, root))) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    return true;
  };
  const initialize = async (requestedMode?: string, openProject = openAfterSetup(), initialCommit = initialCommitEnabled()) => {
    const modes = ['Create a new project', 'Open an existing project', 'Recover one or more .wh.cpp files'];
    if (requestedMode === 'Use an existing project') requestedMode = 'Open an existing project';
    const mode = modes.includes(requestedMode ?? '') ? requestedMode : await vscode.window.showQuickPick(modes, { title: 'Set up WHAM' });
    if (!mode) return;
    if (mode.startsWith('Open')) return openExistingProject();
    if (mode.startsWith('Recover')) return restore(undefined, openProject, initialCommit);
    const folders = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Select an empty folder or parent directory' });
    if (!folders?.[0]) return;
    let root = folders[0].fsPath;
    if (mode.startsWith('Create')) {
      const choice = await vscode.window.showQuickPick(['Create a named folder here', 'Use this empty folder'], { title: 'New project location' });
      if (!choice) return;
      if (choice.startsWith('Create')) {
        const name = await vscode.window.showInputBox({ title: 'New project folder', value: 'windhawk-mods', validateInput: value => !value || /[\\/:*?"<>|]/.test(value) || ['.', '..'].includes(value) ? 'Enter one directory name.' : undefined });
        if (!name) return; root = path.join(root, name);
        try { await fs.stat(root); throw new Error('That directory already exists. Choose Open project.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await fs.mkdir(root);
      } else if ((await fs.readdir(root)).length) throw new Error('This folder is not empty. Choose Open project.');
    }
    const setup = await setupProject(root, { git: gitExecutable() }); await addProject(root); selectedRoot = root;
    await context.workspaceState.update('additionalRoots', [...projects.keys()].filter(root => !vscode.workspace.workspaceFolders?.some(folder => folder.uri.fsPath === root))); publish();
    await configureEditor(projects.get(root)!);
    if (initialCommit && setup.gitInitialized) await finishInitialCommit(projects.get(root)!, []);
    if (openProject && !vscode.workspace.workspaceFolders?.some(folder => sameFile(folder.uri.fsPath, root))) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(root), false);
    else void vscode.window.showInformationMessage(`Project ready: ${root}`);
    return true;
  };
  const applyEditor = async (state: ProjectState, settings: EditorSettings) => {
    const files = await editorConfiguration(state.project, settings);
    for (const file of files.keys()) if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, path.join(state.project.root, file)) && document.isDirty)) throw new Error(`Save or revert ${file} before applying editor configuration.`);
    const differs: string[] = [], previous = new Map<string, Buffer | undefined>();
    for (const [file, bytes] of files) {
      try { const old = await fs.readFile(path.join(state.project.root, file)); previous.set(file, old); if (!old.equals(bytes)) differs.push(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; previous.set(file, undefined); }
    }
    if (differs.length) {
      for (;;) {
        const selection = await vscode.window.showQuickPick(['Apply reviewed editor settings', ...differs], { title: 'Review changes to existing editor configuration' });
        if (!selection) return false;
        if (selection === 'Apply reviewed editor settings') break;
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(path.join(state.project.root, selection)), virtual(selection, files.get(selection)!), `Editor configuration: ${selection}`);
      }
    }
    for (const [file, bytes] of files) {
      if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, path.join(state.project.root, file)) && document.isDirty)) throw new Error(`Editor settings became dirty: ${file}`);
      let now: Buffer | undefined; try { now = await fs.readFile(path.join(state.project.root, file)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const before = previous.get(file);
      if (now ? !before || !now.equals(before) : !!before) throw new Error(`Editor configuration changed during review: ${file}`);
      if (!now?.equals(bytes)) await writeOutput(state.project, path.join(state.project.root, file), bytes);
    }
    // Editor preferences and toolchain paths are local; formatting and recommendations are shared.
    await appendIgnoreRules(state.project, ['/.vscode/settings.json', '/.vscode/c_cpp_properties.json', '/.clangd']);
    state.editor = settings; storedEditors[state.project.root] = settings;
    await context.globalState.update('editorSettings', storedEditors);
    state.git = await gitStatus(state.project.root, gitExecutable()); publish();
    if (settings.integration !== 'clangd' && vscode.extensions.getExtension('ms-vscode.cpptools')) {
      try { await vscode.commands.executeCommand('C_Cpp.ConfigurationSelect', 'Windhawk (WHAM)'); } catch { /* User can select it via the C++ status bar. */ }
    }
    return true;
  };
  const configureEditor = async (state: ProjectState) => {
    const choice = await vscode.window.showQuickPick(['Configure Windhawk compiler and indentation', 'Configure indentation only', 'Skip editor setup for now'], { title: 'Project editor setup' });
    if (!choice || choice.startsWith('Skip')) return;
    let installationPath = state.editor.installationPath;
    if (choice.startsWith('Configure Windhawk')) {
      const found = await findWindhawk();
      const selected = await vscode.window.showQuickPick([...found, 'Browse for Windhawk installation…'], { title: 'Select Windhawk installation (must contain Compiler)' });
      if (!selected) return;
      if (selected.startsWith('Browse')) {
        const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Choose Windhawk installation' });
        if (!folder?.[0]) return; installationPath = folder[0].fsPath;
      } else installationPath = selected;
    } else installationPath = '';
    const style = await vscode.window.showQuickPick(['4 spaces', '2 spaces', 'Tabs', 'Custom width…'], { title: 'Choose indentation (change anytime in the sidebar)' });
    if (!style) return;
    let indentSize = style === '2 spaces' ? 2 : 4;
    if (style.startsWith('Custom')) {
      const width = await vscode.window.showInputBox({ title: 'Indentation width', value: String(state.editor.indentSize), validateInput: value => /^([1-9]|1[0-6])$/.test(value) ? undefined : 'Enter 1–16.' });
      if (!width) return; indentSize = Number(width);
    }
    await applyEditor(state, { ...state.editor, installationPath, indentStyle: style === 'Tabs' ? 'tabs' : 'spaces', indentSize });
  };
  const chooseEntry = async (state: ProjectState, onlyCurrent = false): Promise<EntryState | undefined> => {
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (onlyCurrent && file) { const current = [...state.entries.values()].find(entry => sameFile(entry.path, file)); if (current) return current; }
    const entries = [...state.entries.values()].filter(entry => !onlyCurrent || !file || dependsOn(entry, file) || sameFile(outputPath(state.project, entry.path), file));
    const picked = await vscode.window.showQuickPick(entries.map(entry => ({ label: path.relative(state.project.root, entry.path), entry })), { title: 'Select independent mod' });
    return picked?.entry;
  };
  const updateConfig = async (state: ProjectState, input: unknown) => {
    const config = validateConfig(input);
    if (vscode.workspace.textDocuments.some(document => sameFile(document.uri.fsPath, path.join(state.project.root, 'windhawk-amalgamation.json')) && document.isDirty)) throw new Error('Save or revert the configuration editor before updating sidebar settings.');
    const update = state.queue.then(async () => {
      // Validate filesystem containment before persisting new settings.
      const temporaryProject: Project = { root: state.project.root, config };
      await assertSafeDestination(state.project.root, config.sourceDirectory + '/.wham-probe');
      await assertSafeDestination(state.project.root, config.outputDirectory + '/.wham-probe');
      await discoverEntries(temporaryProject, nodeFiles);
      await writeOutput(state.project, path.join(state.project.root, 'windhawk-amalgamation.json'), Buffer.from(JSON.stringify(config, null, 2) + '\n'));
      state.project = temporaryProject;
      // Directory changes need fresh entry ownership and dependency state.
      if (state.timer) clearTimeout(state.timer);
      state.pending.clear();
      for (const entry of state.entries.values()) { entry.result = undefined; entry.status = 'stale'; }
      await refresh(state); publish();
    });
    state.queue = update.then(() => undefined, () => undefined);
    await update;
    if (state.project.config.generate === 'onSave') await enqueue(state);
  };
  const verify = async (state: ProjectState, entry: EntryState) => {
    const executable = state.editor.installationPath ? path.join(state.editor.installationPath, 'Compiler', 'bin', 'clang++.exe') :
      await vscode.window.showInputBox({ title: 'Compiler executable', prompt: 'Full executable path; the command runs only when you invoke Verify.' });
    if (!executable) return;
    const defaultArguments = ['-std=c++23', '-fsyntax-only', '--target=x86_64-w64-mingw32', '-DWH_MOD', '-DWH_EDITING', '-DUNICODE', '-D_UNICODE', '-DWINVER=0x0A00', '-D_WIN32_WINNT=0x0A00', '-D_WIN32_IE=0x0A00', '-DNTDDI_VERSION=0x0A000008', '-D__USE_MINGW_ANSI_STDIO=0', '-include', 'windhawk_api.h'];
    const argumentsJson = state.editor.installationPath ? JSON.stringify(defaultArguments) : await vscode.window.showInputBox({ title: 'Compiler arguments (JSON array)', value: JSON.stringify(defaultArguments), prompt: 'Use {file} where the generated file belongs, or it will be appended.' });
    if (!argumentsJson) return;
    const argumentsList: unknown = JSON.parse(argumentsJson);
    if (!Array.isArray(argumentsList) || argumentsList.some(argument => typeof argument !== 'string')) throw new Error('Compiler arguments must be a JSON string array.');
    const file = outputPath(state.project, entry.path);
    const args = (argumentsList as string[]).map(argument => argument.replaceAll('{file}', file));
    if (!(argumentsList as string[]).some(argument => argument.includes('{file}'))) args.push(file);
    log.show(true); log.appendLine(`Verify ${file}`);
    const child = spawn(executable, args, { cwd: state.project.root, shell: false, windowsHide: true });
    child.stdout.on('data', data => log.append(data.toString())); child.stderr.on('data', data => log.append(data.toString()));
    const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    log.appendLine(`Compiler exit code: ${code}`);
    void vscode.window.showInformationMessage(`Compiler verification ${code === 0 ? 'passed' : 'failed'} (exit ${code}).`);
  };
  const safe = (operation: () => Promise<unknown>) => async () => { try { await operation(); } catch (error) { log.appendLine(String(error)); void vscode.window.showErrorMessage((error as Error).message); } };
  const register = (name: string, operation: () => Promise<unknown>) => context.subscriptions.push(vscode.commands.registerCommand('windhawk.' + name, safe(operation)));
  register('initialize', initialize); register('openProject', openExistingProject); register('restore', () => restore()); register('logs', async () => log.show());
  register('configureEditor', async () => { const state = active(); if (state) await configureEditor(state); });
  register('generateAll', async () => { const state = active(); if (state && await saveRelevant(state)) await enqueue(state); });
  register('generateCurrent', async () => { const state = active(); if (!state) return; const entry = await chooseEntry(state, true); if (entry && await saveRelevant(state)) await enqueue(state, [entry.path]); });
  register('compare', async () => { const state = active(); if (!state) return; const entry = await chooseEntry(state); if (entry) await compare(state, entry); });
  register('verify', async () => { const state = active(); if (!state) return; const entry = await chooseEntry(state); if (entry) await verify(state, entry); });
  register('toggleOnSave', async () => { const state = active(); if (state) await updateConfig(state, { ...state.project.config, generate: state.project.config.generate === 'onSave' ? 'manual' : 'onSave' }); });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('windhawk.projects', {
    resolveWebviewView(webviewView) {
      view = webviewView;
      const nonce = randomBytes(16).toString('hex');
      view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
      const css = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'sidebar.css'));
      const script = view.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'sidebar.js'));
      view.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${css}"></head><body>
        <nav aria-label="Main navigation"><button data-page="project">Project</button><button data-page="settings">Settings</button><button data-page="setup">Setup</button></nav>
        <div id="error" role="alert"></div>
        <section id="page-setup" hidden>
          <h1>Set up your project</h1><p class="muted">Work in separate source files. Generate standalone mods with recoverable source.</p>
          <div class="setup-options">
            <button data-mode="Create a new project"><strong>New project</strong><span>Choose an empty folder or create a named folder. WHAM sets up src, output, and Git.</span></button>
            <button data-mode="Open an existing project"><strong>Existing project</strong><span>Select your source project or reopen one from the recent projects list.</span></button>
            <button data-mode="Recover one or more .wh.cpp files"><strong>Recover mods</strong><span>Reconstruct a project from one or more WHAM outputs, including shared headers.</span></button>
          </div>
          <label class="checkbox"><input id="open-after-setup" type="checkbox" checked> Open project after setup</label>
          <p class="muted">Opening the folder activates its C++ configuration in this window. VS Code handles any unsaved files.</p>
          <label class="checkbox"><input id="initial-commit" type="checkbox"> Create initial Git commit</label>
          <p class="muted">For new and recovered projects when WHAM creates the repository. Uses your existing Git name and email.</p>
          <p id="setup-status" role="status"></p>
        </section>
        <section id="page-project" hidden>
          <label for="project">Active project</label><select id="project"></select>
          <details class="project-location"><summary>Project folder</summary><p id="root" class="muted"></p><button data-action="openFolder">Open folder in VS Code</button></details>
          <p id="folder-status" class="muted"></p><p id="git-status" class="muted"></p>
          <div id="notice" role="status"></div>
          <div class="toolbar"><button data-action="generateAll" class="primary">Generate all</button><button data-action="logs">Show log</button></div>
          <h2>Mods <span id="count"></span></h2><div id="entries"></div>
        </section>
        <section id="page-mod" hidden>
          <button data-page="project" class="link">← All mods</button>
          <h1 id="mod-name"></h1><p id="mod-file" class="muted"></p><div id="mod-actions" class="toolbar"></div>
          <div id="metadata-issues" role="status"></div>
          <h2>Metadata</h2><dl id="metadata-fields"></dl><button id="edit-metadata">Edit metadata in source</button>
          <section id="readme-section"><h2>Readme</h2><pre id="readme"></pre><button id="edit-readme">Edit readme in source</button></section>
          <section id="mod-settings-section"><h2 id="mod-settings-title">Mod settings</h2><pre id="mod-settings"></pre><button id="edit-mod-settings">Edit settings in source</button></section>
        </section>
        <section id="page-settings" hidden>
          <h1>Project settings</h1><p id="settings-project" class="muted"></p>
          <nav aria-label="Settings navigation"><button data-settings="editor">Editor</button><button data-settings="generation">Generation</button><button data-settings="git">Git</button></nav>
          <form id="config" hidden>
            <label>Source directory<input name="sourceDirectory" required></label><label>Output directory<input name="outputDirectory" required></label>
            <label>Entry globs <small>One per line, relative to source</small><textarea name="entries" rows="2"></textarea></label>
            <label>Excluded globs<textarea name="exclude" rows="2"></textarea></label>
            <label>Include directories <small>One per line, relative to project</small><textarea name="includeDirectories" rows="2"></textarea></label>
            <label>External includes <small>Exact header name or macro expression per line</small><textarea name="externalIncludes" rows="2"></textarea></label>
            <label>Generation<select name="generate"><option value="onSave">After save</option><option value="manual">Manual</option></select></label>
            <label>Debounce (ms)<input name="debounceMs" type="number" min="0" max="10000" step="1"></label>
            <label class="checkbox"><input name="inlineAngleIncludes" type="checkbox"> Expand local angle includes</label>
            <button type="submit" class="primary">Save configuration</button><p id="settings-status" role="status"></p>
          </form>
          <form id="editor-config">
            <label>Windhawk installation<input name="installationPath" placeholder="Folder containing Compiler"></label>
            <div class="toolbar"><button type="button" data-action="browseInstallation">Browse / detect</button></div>
            <label>C++ language service<select name="integration"><option value="cpp">Microsoft C/C++</option><option value="clangd">clangd</option><option value="both">Configure both</option></select></label>
            <label>Indentation<select name="indentStyle"><option value="spaces">Spaces</option><option value="tabs">Tabs</option></select></label>
            <label>Indent / tab width<input name="indentSize" type="number" min="1" max="16" value="4"></label>
            <button type="submit" class="primary">Apply editor settings</button><p id="editor-status" role="status"></p>
            <p class="muted">Uses Windhawk headers and compiler to resolve Wh_* APIs. Requires the selected C++ language extension.</p>
          </form>
          <section id="git-settings" hidden>
            <p id="settings-git-status"></p><div class="toolbar"><button data-action="sourceControl">Source control</button><button data-action="refreshGit">Refresh Git</button></div>
            <h2>Ignored by default</h2><p>Generated output, .vscode/settings.json, .vscode/c_cpp_properties.json, and .clangd. Editor preferences and installed compiler paths belong to this machine.</p>
            <h2>Shared with your project</h2><p>Source, windhawk-amalgamation.json, .clang-format, .vscode/extensions.json, and .gitignore. These preserve how the project builds and formats.</p>
            <button data-action="gitSetup">Initialize Git / update ignore rules</button><p class="muted">Existing ignore rules are preserved. Files already tracked by Git stay tracked.</p>
          </section>
        </section>
        <script nonce="${nonce}" src="${script}"></script></body></html>`;
      context.subscriptions.push(view.webview.onDidReceiveMessage(async message => {
        try {
          if (!message || typeof message.action !== 'string') return;
          if (message.action === 'ready') { await refreshRecentProjects(); publish(); return; }
          if (message.action === 'openProject') { await openExistingProject(typeof message.projectRoot === 'string' ? message.projectRoot : undefined, message.browse === true); return; }
          if (message.action === 'initialize') {
            const completed = await initialize(message.mode, typeof message.openProject === 'boolean' ? message.openProject : openAfterSetup(),
              typeof message.initialCommit === 'boolean' ? message.initialCommit : initialCommitEnabled());
            await view?.webview.postMessage({ type: 'setupFinished', completed }); return;
          }
          if (message.action === 'logs') { log.show(); return; }
          const state = projects.get(message.root);
          if (message.action === 'restore' && !message.entry) { await restore(); return; }
          if (!state) throw new Error('Select a project first.');
          selectedRoot = state.project.root;
          const entry = state.entries.get(message.entry);
          if (message.action === 'openFolder') { await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(state.project.root), false); return; }
          if (message.action === 'refreshGit') { state.git = await gitStatus(state.project.root, gitExecutable()); publish(); return; }
          if (message.action === 'sourceControl') { await vscode.commands.executeCommand('workbench.view.scm'); return; }
          if (message.action === 'gitSetup') { await setupProject(state.project.root, { git: gitExecutable() }); state.git = await gitStatus(state.project.root, gitExecutable()); publish(); return; }
          if (message.action === 'editor') {
            if (await applyEditor(state, message.settings)) await view?.webview.postMessage({ type: 'editorSaved' });
            return;
          }
          if (message.action === 'browseInstallation') {
            const found = await findWindhawk();
            const selected = await vscode.window.showQuickPick([...found, 'Browse…'], { title: 'Windhawk installation' });
            if (!selected) return;
            const install = selected === 'Browse…' ? (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false }))?.[0].fsPath : selected;
            if (install) await view?.webview.postMessage({ type: 'installation', value: install }); return;
          }
          if (message.action === 'select') { await rememberProject(state.project.root); publish(); return; }
          if (message.action === 'config') { await updateConfig(state, message.config); await view?.webview.postMessage({ type: 'saved' }); return; }
          if (message.action === 'generateAll') { if (await saveRelevant(state)) await enqueue(state); return; }
          if (!entry) throw new Error('Select a valid mod entry.');
          switch (message.action) {
            case 'generate': if (await saveRelevant(state)) await enqueue(state, [entry.path]); break;
            case 'compare': await compare(state, entry); break;
            case 'restore': await restore(outputPath(state.project, entry.path)); break;
            case 'discard':
              if (await vscode.window.showWarningMessage(`Discard saved output edits for ${path.basename(entry.path)}?`, { modal: true }, 'Regenerate and Discard') === 'Regenerate and Discard' && await saveRelevant(state)) await enqueue(state, [entry.path], true);
              break;
            case 'open': await vscode.window.showTextDocument(vscode.Uri.file(entry.path), Number.isInteger(message.line) && message.line >= 0 ? { selection: new vscode.Range(message.line, 0, message.line, 0) } : undefined); break;
            case 'output': await vscode.window.showTextDocument(vscode.Uri.file(outputPath(state.project, entry.path))); break;
            case 'verify': await verify(state, entry); break;
          }
        } catch (error) { log.appendLine(String(error)); await view?.webview.postMessage({ type: 'error', message: (error as Error).message }); }
      }));
      publish();
    }
  }));
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(document => changed(document.uri.fsPath)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.document.isDirty) return;
      for (const state of projects.values()) for (const entry of state.entries.values()) {
        if (sameFile(event.document.uri.fsPath, outputPath(state.project, entry.path))) { entry.status = 'blocked'; entry.message = 'Output has unsaved edits.'; }
        else if (sameFile(event.document.uri.fsPath, entry.path) || dependsOn(entry, event.document.uri.fsPath)) {
          entry.status = 'pending';
          if (sameFile(event.document.uri.fsPath, entry.path)) entry.metadata = parseMetadata(event.document.getText(), entry.path);
        }
      }
      presentDiagnostics(); publish();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      for (const folder of event.added) if (folder.uri.scheme === 'file') void fs.stat(path.join(folder.uri.fsPath, 'windhawk-amalgamation.json')).then(() => addProject(folder.uri.fsPath)).catch(error => log.appendLine(String(error)));
      for (const folder of event.removed) projects.delete(folder.uri.fsPath);
      publish();
    }),
    { dispose() { disposed = true; for (const state of projects.values()) if (state.timer) clearTimeout(state.timer); } }
  );
  for (const folder of vscode.workspace.workspaceFolders ?? []) if (folder.uri.scheme === 'file') {
    try { await fs.stat(path.join(folder.uri.fsPath, 'windhawk-amalgamation.json')); await addProject(folder.uri.fsPath); } catch { /* Initialize explicitly if no config exists. */ }
  }
  for (const root of context.workspaceState.get<string[]>('additionalRoots', [])) {
    try { await fs.stat(path.join(root, 'windhawk-amalgamation.json')); await addProject(root); } catch { /* A detached project may have moved. */ }
  }
  publish();
}
