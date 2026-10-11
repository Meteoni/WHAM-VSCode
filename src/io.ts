import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { contained, defaults, portablePath, validateConfig } from './config';
import { checksum } from './engine';
import { FileAccess, Project, RestoreResult } from './types';

/** Local filesystem adapter; canonical identities prevent source symlink escapes. */
export const nodeFiles: FileAccess = {
  read: file => fs.readFile(file),
  identity: file => fs.realpath(file),
  async list(directory) {
    const result: string[] = [];
    const walk = async (current: string) => {
      let entries;
      try { entries = await fs.readdir(current, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(target);
        else if (entry.isFile() || entry.isSymbolicLink() && (await fs.stat(target)).isFile()) result.push(target);
      }
    };
    await walk(directory); return result;
  }
};

export async function loadProject(root: string): Promise<Project> {
  let config = defaults;
  try { config = validateConfig(JSON.parse(await fs.readFile(path.join(root, 'windhawk-amalgamation.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const canonical = await fs.realpath(root);
  for (const directory of [config.sourceDirectory, config.outputDirectory]) {
    const target = path.resolve(root, directory);
    let current = target;
    while (contained(root, current)) {
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Project directory uses a symlink: ${current}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current === path.resolve(root)) break;
      current = path.dirname(current);
    }
    // Check existing aliases in addition to lexical overlap.
    try { if (!contained(canonical, await fs.realpath(target))) throw new Error('Project directory escapes its root.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return { root: path.resolve(root), config: { ...config } };
}

export async function initializeProject(root: string): Promise<Project> {
  const project = await loadProject(root);
  await fs.mkdir(path.join(root, project.config.sourceDirectory), { recursive: true });
  await fs.mkdir(path.join(root, project.config.outputDirectory), { recursive: true });
  try { await fs.writeFile(path.join(root, 'windhawk-amalgamation.json'), JSON.stringify(project.config, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return project;
}

export async function inputsUnchanged(dependencies: Map<string, string>): Promise<boolean> {
  for (const [file, hash] of dependencies) {
    try { if (checksum(await fs.readFile(file)) !== hash) return false; }
    catch { return false; }
  }
  return true;
}

/** Commit only to ordinary files beneath a trusted root. */
export async function assertSafeDestination(root: string, relative: string): Promise<string> {
  portablePath(relative);
  const resolvedRoot = path.resolve(root), target = path.resolve(root, relative);
  if (!contained(resolvedRoot, target)) throw new Error('Destination escapes selected directory.');
  let current = resolvedRoot;
  for (const component of ['', ...relative.split('/')]) {
    if (component) current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Destination uses a symlink: ${current}`);
      if (current !== target && !stat.isDirectory()) throw new Error(`Destination parent is not a directory: ${current}`);
      if (current === target && !stat.isFile()) throw new Error(`Destination is not a regular file: ${current}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}

export async function writeOutput(project: Project, output: string, bytes: Buffer): Promise<void> {
  await assertSafeDestination(project.root, path.relative(project.root, output).split(path.sep).join('/'));
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporary = output + '.' + randomUUID() + '.tmp';
  let previous: Buffer | undefined;
  try { previous = await fs.readFile(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, output); break; }
      catch (error) {
        // Windows readers and indexers can briefly prevent an atomic replacement.
        if (process.platform !== 'win32' || attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
        await assertSafeDestination(project.root, path.relative(project.root, output).split(path.sep).join('/'));
        let current: Buffer | undefined;
        try { current = await fs.readFile(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (current ? !previous || !current.equals(previous) : !!previous) throw new Error(`Destination changed while waiting for a file lock: ${output}`);
      }
    }
  }
  finally { await fs.rm(temporary, { force: true }); }
}

/** Stage an entire recovery and roll back file changes on a failed commit. */
export async function commitRestore(result: RestoreResult, destination: string, selections = new Map<string, number>(), overwrite = false): Promise<void> {
  const contents = new Map<string, Buffer>();
  for (const [file, candidates] of result.files) {
    const selected = selections.get(file) ?? (candidates.length === 1 ? 0 : undefined);
    if (selected === undefined || !candidates[selected]) throw new Error(`Unresolved recovery conflict: ${file}`);
    contents.set(file, candidates[selected].bytes);
  }
  contents.set('windhawk-amalgamation.json', Buffer.from(JSON.stringify(result.manifest.config, null, 2) + '\n'));
  const existing = new Map<string, Buffer | undefined>();
  for (const [relative, bytes] of contents) {
    const target = await assertSafeDestination(destination, relative);
    let previous: Buffer | undefined;
    try { previous = await fs.readFile(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous && !previous.equals(bytes) && !overwrite) throw new Error(`Existing destination differs: ${relative}. Preview and approve overwrite, or use a new directory.`);
    existing.set(relative, previous);
  }
  // Validate the output directory as a parent before staging anything.
  await assertSafeDestination(destination, result.manifest.config.outputDirectory + '/.wham-probe');
  await fs.mkdir(destination, { recursive: true });
  const stage = path.join(destination, '.wham-stage-' + randomUUID());
  const committed: string[] = [];
  try {
    await fs.mkdir(stage);
    for (const [relative, bytes] of contents) {
      const target = path.join(stage, relative);
      await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' });
    }
    for (const [relative, bytes] of contents) {
      const target = await assertSafeDestination(destination, relative), before = existing.get(relative);
      let current: Buffer | undefined;
      try { current = await fs.readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (current ? !before || !current.equals(before) : !!before) throw new Error(`Destination changed during recovery: ${relative}`);
      if (current?.equals(bytes)) continue;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(path.join(stage, relative), target); committed.push(relative);
    }
    await fs.mkdir(path.join(destination, result.manifest.config.outputDirectory), { recursive: true });
  } catch (error) {
    for (const relative of committed.reverse()) {
      const before = existing.get(relative), target = path.join(destination, relative);
      if (before) await fs.writeFile(target, before); else await fs.rm(target, { force: true });
    }
    throw error;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
