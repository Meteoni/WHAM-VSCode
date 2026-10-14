import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyEdits, modify, parse, ParseError } from 'jsonc-parser';
import { isMap, parseAllDocuments } from 'yaml';
import { assertSafeDestination, initializeProject, writeOutput } from './io';
import { Project, RestoreResult } from './types';
import { readWindhawkPaths } from './windhawk';

const run = promisify(execFile);
export interface EditorSettings {
  installationPath: string;
  integration: 'cpp' | 'clangd' | 'both';
  indentStyle: 'spaces' | 'tabs';
  indentSize: number;
}
export const editorDefaults: EditorSettings = { installationPath: '', integration: 'cpp', indentStyle: 'spaces', indentSize: 4 };

/** Recover applied preferences when opening a project in a different VS Code workspace. */
export async function readEditorSettings(root: string, saved: EditorSettings = editorDefaults): Promise<EditorSettings> {
  const contents = await Promise.all(['.vscode/settings.json', '.vscode/c_cpp_properties.json', '.clang-format'].map(async file => {
    try { return await fs.readFile(path.join(root, file), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return ''; }
  }));
  const settingsErrors: ParseError[] = [], propertiesErrors: ParseError[] = [];
  const parsedSettings = parse(contents[0], settingsErrors, { allowTrailingComma: true }), parsedProperties = parse(contents[1], propertiesErrors, { allowTrailingComma: true });
  const settings = !settingsErrors.length && parsedSettings && typeof parsedSettings === 'object' ? parsedSettings : {};
  const properties = !propertiesErrors.length && parsedProperties && typeof parsedProperties === 'object' ? parsedProperties : {};
  const cpp = Array.isArray(properties.configurations) ? properties.configurations.find((item: { name?: string }) => item && ['Windhawk (WHAM)', 'Windhawk'].includes(item.name ?? '')) : undefined;
  const cppCompiler = typeof cpp?.compilerPath === 'string' ? cpp.compilerPath : '';
  const clangdCompiler = typeof settings['clangd.path'] === 'string' ? settings['clangd.path'] : '';
  const compiler = [cppCompiler, clangdCompiler].find(file => path.isAbsolute(file) && /[\\/]Compiler[\\/]bin[\\/]clang(?:\+\+|d)\.exe$/i.test(file));
  const result = { ...saved };
  if (compiler) result.installationPath = path.resolve(path.dirname(path.dirname(path.dirname(compiler))));
  else for (const executable of [cppCompiler, clangdCompiler]) {
    if (!path.isAbsolute(executable) || !/[\\/]bin[\\/]clang(?:\+\+|d)\.exe$/i.test(executable)) continue;
    const candidate = path.resolve(path.dirname(path.dirname(path.dirname(executable))));
    try {
      await fs.access(path.join(candidate, 'windhawk.ini'));
      const { compilerRoot } = await readWindhawkPaths(candidate);
      if (path.resolve(path.dirname(executable)).toLowerCase() === path.join(compilerRoot, 'bin').toLowerCase()) { result.installationPath = candidate; break; }
    } catch { /* A copied toolchain path may no longer exist. */ }
  }
  const clangdEnabled = !!clangdCompiler && settings['clangd.enable'] !== false;
  if (cpp && clangdEnabled) result.integration = settings['C_Cpp.intelliSenseEngine'] === 'disabled' ? 'clangd' : 'both';
  else if (cpp) result.integration = 'cpp';
  else if (clangdEnabled) result.integration = 'clangd';
  const cppSettings = settings['[cpp]'] && typeof settings['[cpp]'] === 'object' ? settings['[cpp]'] : {};
  const width = cppSettings['editor.tabSize'] ?? settings['editor.tabSize'];
  const insertSpaces = cppSettings['editor.insertSpaces'] ?? settings['editor.insertSpaces'];
  const formatDocument = parseAllDocuments(contents[2])[0];
  const format = formatDocument && !formatDocument.errors.length && isMap(formatDocument.contents) ? formatDocument.toJS() : {};
  const indentSize = format.IndentWidth ?? width;
  if (Number.isInteger(indentSize) && indentSize >= 1 && indentSize <= 16) result.indentSize = indentSize;
  if (format.UseTab === 'Never') result.indentStyle = 'spaces';
  else if (['Always', 'ForIndentation', 'ForContinuationAndIndentation', 'AlignWithSpaces'].includes(format.UseTab)) result.indentStyle = 'tabs';
  else if (typeof insertSpaces === 'boolean') result.indentStyle = insertSpaces ? 'spaces' : 'tabs';
  return result;
}

export async function gitStatus(root: string, git = 'git'): Promise<{ branch: string; changes: number; root: string } | undefined> {
  try {
    const location = (await run(git, ['-C', root, 'rev-parse', '--show-toplevel'], { windowsHide: true })).stdout.trim();
    let branch = 'detached HEAD';
    try { branch = (await run(git, ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true })).stdout.trim(); } catch { /* A detached repository is still usable. */ }
    const porcelain = (await run(git, ['-C', root, 'status', '--porcelain=v1', '-z'], { windowsHide: true })).stdout.split('\0');
    let changes = 0;
    for (let index = 0; index < porcelain.length; index++) if (porcelain[index]) { changes++; if (/[RC]/.test(porcelain[index].slice(0, 2))) index++; }
    return { branch: branch || 'detached HEAD', changes, root: location };
  } catch { return undefined; }
}

/** Initialize Git only when no enclosing repository exists, then append managed ignore rules. */
export async function setupProject(root: string, options: { initializeGit?: boolean; ignoreOutput?: boolean; git?: string } = {}): Promise<Project & { gitInitialized: boolean }> {
  const project = await initializeProject(root), git = options.git ?? 'git';
  let gitInitialized = false;
  if (options.initializeGit !== false) {
    let inside = false;
    try { inside = (await run(git, ['-C', root, 'rev-parse', '--is-inside-work-tree'], { windowsHide: true })).stdout.trim() === 'true'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Git executable not found. Install Git or configure git.path, then retry setup.'); }
    if (!inside) { await run(git, ['init', root], { windowsHide: true }); gitInitialized = true; }
  }
  await appendIgnoreRules(project, [
    ...(options.ignoreOutput !== false ? [`/${project.config.outputDirectory}/`] : []),
    '/.vscode/settings.json', '/.vscode/c_cpp_properties.json', '/.clangd'
  ]);
  return { ...project, gitInitialized };
}

/** Called only after setup creates a repository; commit the explicit setup/source files. */
export async function createInitialCommit(project: Project, sourceFiles: string[] = [], git = 'git'): Promise<void> {
  const repository = (await run(git, ['-C', project.root, 'rev-parse', '--show-toplevel'], { windowsHide: true })).stdout.trim();
  const normalize = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (normalize(repository) !== normalize(project.root)) throw new Error('Initial commits are limited to the new project repository.');
  let hasCommit = false;
  try { await run(git, ['-C', project.root, 'rev-parse', '--verify', 'HEAD'], { windowsHide: true }); hasCommit = true; } catch { /* An unborn branch has no HEAD. */ }
  if (hasCommit) throw new Error('This repository already has a commit.');
  const staged = (await run(git, ['-C', project.root, 'diff', '--cached', '--name-only', '-z'], { windowsHide: true })).stdout;
  if (staged) throw new Error('This repository already has staged changes. Commit them through Source Control.');
  const files: string[] = [];
  for (const relative of new Set(['windhawk-amalgamation.json', '.gitignore', '.clang-format', '.vscode/extensions.json', ...sourceFiles])) {
    const file = await assertSafeDestination(project.root, relative);
    try { if ((await fs.stat(file)).isFile()) files.push(':(literal)' + relative); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await run(git, ['-C', project.root, 'add', '--', ...files], { windowsHide: true });
  // --only keeps unrelated files staged during setup out of this commit.
  await run(git, ['-C', project.root, 'commit', '--only', '-m', 'Initialize WHAM project', '--', ...files], { windowsHide: true });
}

export async function appendIgnoreRules(project: Project, rules: string[]): Promise<void> {
  const file = await assertSafeDestination(project.root, '.gitignore');
  let previous = '';
  try { previous = await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const lines = new Set(previous.split(/\r?\n/)), missing = rules.filter(rule => !lines.has(rule));
  if (!missing.length) return;
  const newline = previous.includes('\r\n') ? '\r\n' : '\n';
  await writeOutput(project, file, Buffer.from(previous + (previous && !previous.endsWith('\n') ? newline : '') + '# WHAM' + newline + missing.join(newline) + newline));
}

/** Discover common installed/portable layouts without scanning arbitrary user files. */
export async function findWindhawk(): Promise<string[]> {
  const registryCandidates: string[] = [];
  if (process.platform === 'win32') {
    for (const [key, value] of [
      ['HKLM\\SOFTWARE\\Windhawk', 'install_dir'], ['HKLM\\SOFTWARE\\WOW6432Node\\Windhawk', 'install_dir'],
      ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Windhawk', 'InstallLocation'],
      ['HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Windhawk', 'InstallLocation']
    ]) {
      try {
        const query = await run('reg.exe', ['query', key, '/v', value], { windowsHide: true });
        const found = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(query.stdout)?.[1].trim();
        if (found) registryCandidates.push(found.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`));
      } catch { /* Missing registry keys are ordinary for portable installations. */ }
    }
  }
  const candidates = [...new Set([
    ...(process.env.WINDHAWK_HOME ? [process.env.WINDHAWK_HOME] : []), ...registryCandidates,
    path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Windhawk'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Windhawk'),
    path.join(os.homedir(), 'Portable Programs', 'Windhawk'),
    path.join(os.homedir(), 'scoop', 'apps', 'windhawk', 'current')
  ])];
  const matches: string[] = [];
  for (const candidate of candidates) {
    try { const { compilerRoot } = await readWindhawkPaths(candidate); await fs.stat(path.join(compilerRoot, 'bin', 'clang++.exe')); await fs.stat(path.join(compilerRoot, 'include', 'windhawk_api.h')); matches.push(candidate); }
    catch { /* Installed service-only folders do not contain the developer toolchain. */ }
  }
  return matches;
}

/** Produce reviewable configuration files; adapters approve replacements of existing owned keys. */
export async function editorConfiguration(project: Project, input: EditorSettings, baselineFlags?: string[]): Promise<Map<string, Buffer>> {
  if (!input || !['cpp', 'clangd', 'both'].includes(input.integration) || !['spaces', 'tabs'].includes(input.indentStyle) ||
    !Number.isInteger(input.indentSize) || input.indentSize < 1 || input.indentSize > 16 || typeof input.installationPath !== 'string') throw new Error('Invalid editor settings. Indentation size must be 1–16.');
  const result = new Map<string, Buffer>();
  const read = async (relative: string): Promise<string> => {
    const file = await assertSafeDestination(project.root, relative);
    try { return await fs.readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}\n'; throw error; }
  };
  const edit = (source: string, updates: [string[], unknown][]): string => {
    const errors: ParseError[] = [];
    const value = parse(source, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Existing VS Code configuration contains invalid JSON with comments. Fix it before applying settings.');
    for (const [keys, value] of updates) source = applyEdits(source, modify(source, keys, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    return source;
  };
  let settings = await read('.vscode/settings.json');
  const existingSettings = parse(settings);
  const cppSettings = { ...(existingSettings['[cpp]'] ?? {}), 'editor.insertSpaces': input.indentStyle === 'spaces', 'editor.tabSize': input.indentSize, 'editor.detectIndentation': false };
  settings = edit(settings, [[['[cpp]'], cppSettings]]);
  settings = edit(settings, [[['search.exclude'], { ...(existingSettings['search.exclude'] ?? {}), [project.config.outputDirectory]: true }],
    [['files.associations'], { ...(existingSettings['files.associations'] ?? {}), '*.wh.cpp': 'cpp', '*.h': 'cpp' }]]);
  const formatFile = await read('.clang-format');
  if (formatFile === '{}\n') {
    result.set('.clang-format', Buffer.from(`BasedOnStyle: Chromium\nIndentWidth: ${input.indentSize}\nTabWidth: ${input.indentSize}\nUseTab: ${input.indentStyle === 'tabs' ? 'Always' : 'Never'}\nCommentPragmas: '^[ \\t]+(@[a-zA-Z]+|WHAM@[0-9]+ )'\n`));
  } else {
    // Keep the existing YAML style and all unrelated formatting options.
    const documents = parseAllDocuments(formatFile);
    for (const document of documents) {
      if (document.errors.length || !isMap(document.contents)) throw new Error('Existing .clang-format is not a valid YAML mapping.');
      document.set('IndentWidth', input.indentSize); document.set('TabWidth', input.indentSize); document.set('UseTab', input.indentStyle === 'tabs' ? 'Always' : 'Never');
      if (!document.get('Language') || document.get('Language') === 'Cpp') {
        const prior = document.get('CommentPragmas');
        if (prior !== undefined && typeof prior !== 'string') throw new Error('CommentPragmas must be a string.');
        const protect = '^[ \\t]+(@[a-zA-Z]+|WHAM@[0-9]+ )';
        if (!prior || !prior.includes('WHAM@')) document.set('CommentPragmas', prior ? `(${prior})|(${protect})` : protect);
      }
    }
    result.set('.clang-format', Buffer.from(documents.map(document => document.toString()).join('---\n')));
  }
  if (input.installationPath) {
    const { compilerRoot } = await readWindhawkPaths(input.installationPath);
    const compiler = path.join(compilerRoot, 'bin', 'clang++.exe'), api = path.join(compilerRoot, 'include', 'windhawk_api.h');
    for (const file of [compiler, api]) if (!(await fs.stat(file)).isFile()) throw new Error(`Missing Windhawk toolchain file: ${file}`);
    const forward = (file: string) => file.split(path.sep).join('/');
    const includeDirectories = project.config.includeDirectories.map(directory => '${workspaceFolder}/' + directory);
    const defines = ['UNICODE', '_UNICODE', 'WINVER=0x0A00', '_WIN32_WINNT=0x0A00', '_WIN32_IE=0x0A00', 'NTDDI_VERSION=0x0A000008', '__USE_MINGW_ANSI_STDIO=0', 'WH_MOD', 'WH_EDITING'];
    if (input.integration !== 'clangd') {
      let properties = await read('.vscode/c_cpp_properties.json');
      const parsed = parse(properties), configurations = parsed.configurations ?? [];
      if (!Array.isArray(configurations)) throw new Error('c_cpp_properties.configurations must be an array.');
      const windhawk = {
        name: 'Windhawk (WHAM)', compilerPath: forward(compiler), intelliSenseMode: 'windows-clang-x64', cppStandard: 'c++23', cStandard: 'c17',
        defines, forcedInclude: [forward(api)], compilerArgs: baselineFlags ? baselineFlags.map(flag => flag === 'windhawk_api.h' ? forward(api) : flag) : ['-target', 'x86_64-w64-mingw32'],
        includePath: ['${workspaceFolder}/' + project.config.sourceDirectory + '/**', ...includeDirectories, forward(path.join(compilerRoot, 'include'))]
      };
      const index = configurations.findIndex((item: { name?: string }) => item.name === windhawk.name);
      if (index < 0) configurations.push(windhawk); else configurations[index] = { ...configurations[index], ...windhawk };
      properties = edit(properties, [[['configurations'], configurations], [['version'], 4]]);
      result.set('.vscode/c_cpp_properties.json', Buffer.from(properties));
    }
    if (input.integration !== 'cpp') {
      const clangd = path.join(compilerRoot, 'bin', 'clangd.exe'); await fs.stat(clangd);
      const argumentsList = existingSettings['clangd.arguments'] ?? [];
      if (!Array.isArray(argumentsList) || argumentsList.some(item => typeof item !== 'string')) throw new Error('clangd.arguments must be an array of strings.');
      settings = edit(settings, [[['clangd.path'], forward(clangd)], [['clangd.arguments'], [...argumentsList.filter((item: string) => !item.startsWith('--query-driver=')), '--query-driver=' + forward(compiler)]]]);
      const flags = [...(baselineFlags ? baselineFlags.map(flag => flag === 'windhawk_api.h' ? forward(api) : flag) : ['-xc++', '-std=c++23', '--target=x86_64-w64-mingw32', ...defines.map(define => '-D' + define), '-include', forward(api)]),
        ...project.config.includeDirectories.map(directory => '-I' + forward(path.resolve(project.root, directory))), '-I' + forward(path.join(compilerRoot, 'include'))];
      // A separate managed fragment keeps an existing .clangd file untouched.
      const existing = await read('.clangd');
      const begin = '# WHAM editor configuration begin', end = '# WHAM editor configuration end';
      const fragment = begin + '\n' + JSON.stringify({ CompileFlags: { Compiler: forward(compiler), Add: flags } }, null, 2) + '\n' + end;
      const first = existing.indexOf(begin), last = existing.indexOf(end);
      if ((first >= 0) !== (last >= 0) || first > last) throw new Error('Damaged WHAM section in .clangd.');
      const updated = first >= 0 ? existing.slice(0, first) + fragment + existing.slice(last + end.length) : (existing === '{}\n' ? '' : existing.trimEnd() + '\n---\n') + fragment + '\n';
      result.set('.clangd', Buffer.from(updated));
      const outputConfig = project.config.outputDirectory + '/.clangd';
      const existingOutputConfig = await read(outputConfig);
      const outputBegin = '# WHAM output index configuration begin', outputEnd = '# WHAM output index configuration end';
      const outputFragment = outputBegin + '\n' + JSON.stringify({ Index: { Background: 'Skip' } }, null, 2) + '\n' + outputEnd;
      const outputStart = existingOutputConfig.indexOf(outputBegin), outputStop = existingOutputConfig.indexOf(outputEnd);
      if ((outputStart >= 0) !== (outputStop >= 0) || outputStart > outputStop) throw new Error('Damaged WHAM output index section.');
      result.set(outputConfig, Buffer.from(outputStart >= 0 ? existingOutputConfig.slice(0, outputStart) + outputFragment + existingOutputConfig.slice(outputStop + outputEnd.length) :
        (existingOutputConfig === '{}\n' ? '' : existingOutputConfig.trimEnd() + '\n---\n') + outputFragment + '\n'));
    }
    settings = edit(settings, [[['C_Cpp.intelliSenseEngine'], input.integration === 'clangd' ? 'disabled' : 'default']]);
    settings = edit(settings, [[['clangd.enable'], input.integration !== 'cpp']]);
    const extensions = await read('.vscode/extensions.json'), recommendations = parse(extensions).recommendations ?? [];
    if (!Array.isArray(recommendations)) throw new Error('extensions.recommendations must be an array.');
    const needed = input.integration === 'cpp' ? ['ms-vscode.cpptools'] : input.integration === 'clangd' ? ['llvm-vs-code-extensions.vscode-clangd'] : ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'];
    result.set('.vscode/extensions.json', Buffer.from(edit(extensions, [[['recommendations'], [...new Set([...recommendations, ...needed])]]])));
  }
  result.set('.vscode/settings.json', Buffer.from(settings));
  return result;
}

/** Merge several recovered mods; shared-file differences remain explicit conflicts. */
export function mergeRecoveries(results: RestoreResult[]): RestoreResult {
  if (!results.length) throw new Error('Select at least one recovery container.');
  const first = results[0], files: RestoreResult['files'] = new Map(), records = new Map();
  const compatible = (result: RestoreResult) => JSON.stringify({ sourceDirectory: result.manifest.config.sourceDirectory, outputDirectory: result.manifest.config.outputDirectory,
    includeDirectories: result.manifest.config.includeDirectories, externalIncludes: result.manifest.config.externalIncludes, inlineAngleIncludes: result.manifest.config.inlineAngleIncludes });
  const entries = new Set<string>();
  let offset = 0;
  for (const result of results) {
    if (compatible(result) !== compatible(first)) throw new Error('Selected containers have different include/source layouts. Recover them into separate projects.');
    for (const entry of result.manifest.config.entries) entries.add(entry);
    for (const record of result.manifest.files) if (!records.has(record.path)) records.set(record.path, record);
    for (const [file, candidates] of result.files) {
      const combined = files.get(file) ?? [];
      for (const candidate of candidates) {
        const occurrences = candidate.occurrences.map(id => id + offset);
        const identical = combined.find(item => item.bytes.equals(candidate.bytes));
        if (identical) { identical.occurrences.push(...occurrences); identical.changed ||= candidate.changed; }
        else combined.push({ ...candidate, occurrences });
      }
      files.set(file, combined);
    }
    offset += 100000;
  }
  const paths = new Set<string>();
  for (const file of files.keys()) { if (paths.has(file.toLowerCase())) throw new Error(`Case collision across containers: ${file}`); paths.add(file.toLowerCase()); }
  const config = { ...first.manifest.config, entries: [...entries].sort(), exclude: [] };
  return { manifest: { ...first.manifest, config, files: [...records.values()] }, files, conflicts: [...files].filter(([, candidates]) => candidates.length > 1).map(([file]) => file) };
}
