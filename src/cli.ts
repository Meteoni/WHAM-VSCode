#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { discoverEntries, outputPath } from './config';
import { checksum, generateEntry, restoreSource } from './engine';
import { commitRestore, initializeProject, inputsUnchanged, loadProject, nodeFiles, writeOutput } from './io';
import { mergeRecoveries, setupProject } from './setup';

/** CLI uses the same engine and explicit output ownership rules as the editor. */
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log('wham init <project> [--no-git]\nwham generate <project> [--force]\nwham check <project>\nwham restore <file.wh.cpp> [additional.wh.cpp...] <destination> [--overwrite] [--no-git]\nwham verify <file.wh.cpp> <compiler> [compiler arguments...]\nMacro externalIncludes entries match the complete include expression.'); return;
  }
  if (command === 'init') { const root = path.resolve(args[0] ?? '.'); await fs.mkdir(root, { recursive: true }); await setupProject(root, { initializeGit: !args.includes('--no-git') }); return; }
  if (command === 'restore') {
    if (!args[0] || !args[1]) throw new Error('restore requires a container and destination.');
    const positional = args.filter(argument => !argument.startsWith('--')), destination = positional.pop();
    if (!destination || !positional.length) throw new Error('restore requires containers and destination.');
    const result = mergeRecoveries(await Promise.all(positional.map(async file => restoreSource(await fs.readFile(file)))));
    if (result.conflicts.length) throw new Error(`Conflicting repeated files: ${result.conflicts.join(', ')}. Resolve in the VS Code sidebar.`);
    await commitRestore(result, path.resolve(destination), undefined, args.includes('--overwrite'));
    await setupProject(path.resolve(destination), { initializeGit: !args.includes('--no-git') });
    console.log(`Restored ${result.files.size} source files to ${path.resolve(destination)}`); return;
  }
  if (command === 'verify') {
    if (!args[0] || !args[1]) throw new Error('verify requires a generated file and compiler executable.');
    const child = spawn(args[1], [...args.slice(2), path.resolve(args[0])], { stdio: 'inherit', shell: false });
    process.exitCode = await new Promise<number>((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); }); return;
  }
  if (!['generate', 'check'].includes(command)) throw new Error(`Unknown command: ${command}`);
  const project = await loadProject(path.resolve(args[0] ?? '.'));
  const entries = await discoverEntries(project, nodeFiles);
  if (!entries.length) console.log('No matching .cpp entries found.');
  for (const entry of entries) {
    const generated = await generateEntry(project, entry, nodeFiles);
    for (const diagnostic of generated.diagnostics) console.error(`${diagnostic.path}:${diagnostic.line + 1}: ${diagnostic.severity}: ${diagnostic.message}`);
    if (!generated.bytes) { process.exitCode = 1; continue; }
    const output = outputPath(project, entry);
    let existing: Buffer | undefined;
    try { existing = await fs.readFile(output); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (command === 'check') {
      if (!existing?.equals(generated.bytes)) { console.error(`Stale or missing: ${output}`); process.exitCode = 1; }
      continue;
    }
    let owned = !existing || existing.equals(generated.bytes);
    if (existing && !owned) {
      try {
        const restored = restoreSource(existing);
        owned = !restored.conflicts.length && restored.manifest.root === path.relative(project.root, entry).split(path.sep).join('/') &&
          [...restored.files.values()].every(candidates => candidates.every(candidate => !candidate.changed));
      } catch { owned = false; }
    }
    if (!owned && !args.includes('--force')) { console.error(`Output edits block overwrite: ${output}. Restore edits or use --force.`); process.exitCode = 1; continue; }
    if (!await inputsUnchanged(generated.dependencies)) { console.error(`Inputs changed: ${entry}. Retry generation.`); process.exitCode = 1; continue; }
    if (!existing?.equals(generated.bytes)) await writeOutput(project, output, generated.bytes);
    console.log(`${path.relative(project.root, entry)} -> ${path.relative(project.root, output)} (${checksum(generated.bytes).slice(0, 12)})`);
  }
}
main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
