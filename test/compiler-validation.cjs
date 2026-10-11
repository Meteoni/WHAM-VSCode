const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { loadProject, nodeFiles, writeOutput } = require('../dist/io');
const { generateEntry, restoreSource } = require('../dist/engine');
const { editorConfiguration } = require('../dist/setup');
const { parse } = require('jsonc-parser');
(async () => {
  const installation = process.argv[2]; if (!installation) throw new Error('Pass a Windhawk installation path.');
  const compiler = path.join(installation, 'Compiler/bin/clang++.exe');
  const project = await loadProject(path.resolve('examples/demo'));
  const settings = await editorConfiguration(project, { installationPath: installation, integration: 'both', indentStyle: 'spaces', indentSize: 2 });
  const config = parse(settings.get('.vscode/c_cpp_properties.json').toString()).configurations[0];
  const common = ['-std=c++23', '-fsyntax-only', ...config.compilerArgs, ...config.defines.map(define => '-D' + define), '-include', config.forcedInclude[0], '-I' + path.join(project.root, 'src')];
  for (const relative of ['src/demo.cpp', 'src/tools/second.cpp']) {
    const entry = path.join(project.root, relative);
    const generated = await generateEntry(project, entry, nodeFiles); assert.ok(generated.bytes, JSON.stringify(generated.diagnostics));
    const target = path.join(project.root, relative.replace('src/', 'output/').replace('.cpp', '.wh.cpp')); await writeOutput(project, target, generated.bytes);
    for (const value of ['0', '1']) {
      execFileSync(compiler, [...common, '-DWHAM_EXTRA=' + value, entry], { stdio: 'pipe', windowsHide: true });
      execFileSync(compiler, [...common, '-DWHAM_EXTRA=' + value, target], { stdio: 'pipe', windowsHide: true });
    }
    const recovered = restoreSource(generated.bytes); for (const [file, candidates] of recovered.files) assert.deepEqual(candidates[0].bytes, await fs.readFile(path.join(project.root, file)));
  }
  // Validate the actual generated clangd configuration against the installed language server.
  const work = path.resolve('work', 'clangd-validation'); await fs.mkdir(work, { recursive: true });
  const source = path.join(work, 'editor.cpp'); await fs.copyFile(path.join(project.root, 'src/demo.cpp'), source);
  await fs.writeFile(path.join(work, '.clangd'), settings.get('.clangd'));
  execFileSync(path.join(installation, 'Compiler/bin/clangd.exe'), ['--check=' + source, '--query-driver=' + compiler], { stdio: 'pipe', windowsHide: true });
  console.log('Windhawk Clang: both demo entries and generated outputs pass with both conditional values. Generated clangd settings resolve Windhawk APIs. Exact source recovery passes.');
})().catch(error => { console.error(error.stderr?.toString() || error); process.exitCode = 1; });
