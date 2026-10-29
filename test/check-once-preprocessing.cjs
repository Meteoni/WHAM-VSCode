const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateEntry, restoreSource } = require('../dist/engine');
const { defaults } = require('../dist/config');
const { nodeFiles } = require('../dist/io');

// Run explicitly with a Clang executable; this checks real preprocessing on both targets.
// node test/check-once-preprocessing.cjs <path-to-clang++.exe>
const compiler = process.argv[2];
if (!compiler) throw Error('Pass a Clang compiler executable.');
const once = '#pragma once\nstruct Shared { int value; };\n';
const cases = [
  { name: 'guarded-macro-header', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\nstatic_assert(VALUE == 42);\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-type-explicit-proof', files: { 'mod.cpp': '#include "a.h"\n#define A_H\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\nstruct Shared {};\n#endif\n' } },
  { name: 'guarded-type-unknown-macro-effects', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\nstruct Shared {};\n#endif\n' } },
  { name: 'guarded-partial-repeatable', files: { 'mod.cpp': '#include "a.h"\n#define FAST\n#include "a.h"\nstatic_assert(MODE == 2);\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n#undef MODE\n#ifdef FAST\n#define MODE 2\n#else\n#define MODE 1\n#endif\n' } },
  { name: 'guarded-partial-active-code', files: { 'mod.cpp': '#include "a.h"\n#define A_H\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\nstruct Shared {};\n#endif\nstatic_assert(sizeof(Shared) > 0);\n' } },
  { name: 'guarded-partial-prefix-undef', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': '#undef A_H\n#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-partial-nested', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#include "values.h"\n#endif\n#undef MODE\n#define MODE 1\n', 'values.h': '#define VALUE 42\n' } },
  { name: 'guarded-conditional-first', files: { 'mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-branch-merge', files: { 'mod.cpp': '#if FLAG\n#include "a.h"\n#else\n#include "a.h"\n#endif\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-branch-undef', files: { 'mod.cpp': '#include "a.h"\n#if FLAG\n#undef A_H\n#endif\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-target-definedness', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#if defined(__x86_64__)\n#define ARCH 64\n#else\n#define ARCH 32\n#endif\n#endif\n' } },
  { name: 'guarded-external-invalidation', externals: { 'external.h': '#undef A_H\n' }, config: { externalIncludes: ['external.h'] }, files: { 'mod.cpp': '#include "a.h"\n#include "external.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-macro-hidden-pop', externals: { 'external.h': '#define RESTORE _Pragma("pop_macro(\\"A_H\\")")\n' }, config: { externalIncludes: ['external.h'] }, files: { 'mod.cpp': '#include "external.h"\n#undef A_H\n#pragma push_macro("A_H")\n#include "a.h"\nRESTORE\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-flag-hidden-pop', options: ['-DRESTORE=_Pragma("pop_macro(\\"A_H\\")")'], files: { 'mod.cpp': '#undef A_H\n#pragma push_macro("A_H")\n#include "a.h"\nRESTORE\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-hidden-pop-within-header', options: ['-DRESTORE=_Pragma("pop_macro(\\"A_H\\")")'], files: { 'mod.cpp': '#undef A_H\n#pragma push_macro("A_H")\n#pragma push_macro("A_H")\n#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\nRESTORE\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-outer-else-active', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\nstatic_assert(SECOND == 1);\n', 'a.h': '#ifndef A_H\n#define A_H\n#else\n#define SECOND 1\n#endif\n' } },
  { name: 'guarded-once-conditional-mutation', files: { 'mod.cpp': '#if FLAG\n#include "once.h"\n#endif\n#undef A_H\n#if 0\n#include "a.h"\n#endif\n#include "once.h"\n#include "a.h"\n', 'once.h': '#pragma once\n#define A_H\n', 'a.h': '#ifndef A_H\n#define A_H\n#define VALUE 42\n#endif\n' } },
  { name: 'guarded-known-inactive-code', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': '#ifndef A_H\n#define A_H\n#if 0\nDO_NOT_EXPAND\n#endif\n#define VALUE 42\n#endif\n' } },
  { name: 'unconditional', files: { 'mod.cpp': '#include "a.h"\n#include "a.h"\n', 'a.h': once } },
  { name: 'conditional-first', files: { 'mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#include "a.h"\n#include "a.h"\n', 'a.h': once } },
  { name: 'conditional-only', files: { 'mod.cpp': '#if FLAG\n#include "a.h"\n#else\n#include "a.h"\n#endif\n', 'a.h': once } },
  { name: 'nested-conditional', files: { 'mod.cpp': '#if FLAG\n#include "parent.h"\n#endif\n#include "a.h"\n', 'parent.h': '#include "a.h"\n', 'a.h': once } },
  { name: 'nested-unconditional', files: { 'mod.cpp': '#include "parent.h"\n#include "parent.h"\n#include "a.h"\n', 'parent.h': '#include "a.h"\n', 'a.h': once } },
  { name: 'once-parent', files: { 'mod.cpp': '#include "parent.h"\n#include "parent.h"\n#include "a.h"\n', 'parent.h': '#pragma once\n#include "a.h"\n', 'a.h': once } },
  { name: 'conditional-once-parent', files: { 'mod.cpp': '#if FLAG\n#include "parent.h"\n#endif\n#include "parent.h"\n#include "a.h"\n', 'parent.h': '#pragma once\n#include "a.h"\n', 'a.h': once } },
  { name: 'ordinary-parent-guard', files: { 'mod.cpp': '#define PARENT_H\n#include "parent.h"\n#include "a.h"\n', 'parent.h': '#ifndef PARENT_H\n#define PARENT_H\n#include "a.h"\n#endif\n', 'a.h': once } },
  { name: 'macro-context', files: { 'mod.cpp': '#if FLAG\n#include "a.h"\n#endif\n#define CHOICE 1\n#include "a.h"\n#include "a.h"\nconstexpr int result = VALUE;\n', 'a.h': '#pragma once\n#if CHOICE\n#define VALUE 42\n#else\n#define VALUE 7\n#endif\n' } },
  { name: 'guard-undef-and-architecture', files: { 'mod.cpp': '#include "a.h"\nconstexpr int first = VALUE;\n#undef A_H\n#undef VALUE\n#define ARM64 1\n#include "a.h"\nconstexpr int second = VALUE;\n', 'a.h': '#ifndef A_H\n#define A_H\n#ifdef ARM64\n#define VALUE 64\n#else\n#define VALUE 32\n#endif\n#endif\n' } },
  { name: 'repeatable-header', files: { 'mod.cpp': '#define ITEM(x) static_assert(true);\n#include "a.inc"\n#include "a.inc"\n', 'a.inc': 'ITEM(value)\n' } },
  { name: 'distinct-identical-files', files: { 'mod.cpp': '#include "a.h"\n#include "b.h"\n#include "a.h"\n#include "b.h"\n', 'a.h': '#pragma once\nstatic_assert(true);\n', 'b.h': '#pragma once\nstatic_assert(true);\n' } }
];

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wham-once-preprocess-'));
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('wham-once-preprocess-')) throw Error('Invalid temporary directory.');
  let comparisons = 0;
  try {
    for (const fixture of cases) {
      const root = path.join(temporary, fixture.name);
      await fs.mkdir(path.join(root, 'src'), { recursive: true });
      for (const [file, source] of Object.entries({ ...fixture.files, ...fixture.externals })) await fs.writeFile(path.join(root, 'src', file), source);
      const input = path.join(root, 'src/mod.cpp');
      const generated = await generateEntry({ root, config: { ...defaults, ...fixture.config } }, input, nodeFiles);
      assert.ok(generated.bytes, JSON.stringify(generated.diagnostics));
      const output = path.join(root, 'generated.cpp');
      await fs.writeFile(output, generated.bytes);
      const recovered = restoreSource(generated.bytes);
      assert.deepEqual(recovered.conflicts, []);
      for (const [file, source] of Object.entries(fixture.files)) assert.equal(recovered.files.get('src/' + file)[0].bytes.toString(), source);
      for (const target of ['x86_64-w64-mingw32', 'aarch64-w64-mingw32']) {
        for (const flag of [0, 1]) {
          const options = ['-std=c++17', '-target', target, '-DFLAG=' + flag, '-I', path.join(root, 'src'), ...(fixture.options ?? [])];
          const original = execFileSync(compiler, [...options, '-E', '-P', input], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
          const expanded = execFileSync(compiler, [...options, '-E', '-P', output], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
          assert.equal(expanded.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n'),
            original.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n'), `${fixture.name}, ${target}, FLAG=${flag}`);
          const originalMacros = execFileSync(compiler, [...options, '-E', '-dM', input], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
          const expandedMacros = execFileSync(compiler, [...options, '-E', '-dM', output], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
          const macroLines = text => text.split(/\r?\n/).filter(line => line && !line.startsWith('#define WHAM_ONCE_')).sort();
          assert.deepEqual(macroLines(expandedMacros), macroLines(originalMacros), `${fixture.name} macro state, ${target}, FLAG=${flag}`);
          execFileSync(compiler, [...options, '-fsyntax-only', output], { windowsHide: true, timeout: 30000 });
          comparisons++;
        }
      }
      console.log('Passed: ' + fixture.name);
    }
    console.log(`${comparisons} original/generated preprocessing, final macro-state comparisons, and syntax checks passed.`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
