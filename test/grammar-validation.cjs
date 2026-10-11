// Run with VS Code's Electron Node runtime; app path and extension root are arguments.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { parse } = require('jsonc-parser');
(async () => {
  const app = process.argv[2], extensionRoot = path.resolve(process.argv[3] || '.');
  const textmate = require(path.join(app, 'node_modules.asar/vscode-textmate'));
  const oniguruma = require(path.join(app, 'node_modules.asar/vscode-oniguruma'));
  await oniguruma.loadWASM(await fs.readFile(path.join(app, 'node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm')));
  const packageJson = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json')));
  const contribution = packageJson.contributes.grammars[0];
  const grammarFiles = new Map([[contribution.scopeName, path.join(extensionRoot, contribution.path)]]);
  for (const folder of await fs.readdir(path.join(app, 'extensions'))) {
    try {
      const directory = path.join(app, 'extensions', folder);
      const bundled = parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      for (const grammar of bundled.contributes?.grammars || []) grammarFiles.set(grammar.scopeName, path.join(directory, grammar.path));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const themeDirectory = path.join(app, 'extensions/theme-defaults/themes');
  const readTheme = async file => {
    const theme = parse(await fs.readFile(path.join(themeDirectory, file), 'utf8'));
    const inherited = theme.include ? await readTheme(theme.include) : {};
    return { ...inherited, ...theme, colors: { ...inherited.colors, ...theme.colors }, tokenColors: [...(inherited.tokenColors || []), ...(theme.tokenColors || [])] };
  };
  const theme = await readTheme('dark_modern.json');
  const registry = new textmate.Registry({
    theme: { settings: [{ settings: { foreground: theme.colors['editor.foreground'], background: theme.colors['editor.background'] } }, ...theme.tokenColors] },
    onigLib: Promise.resolve({ createOnigScanner: patterns => new oniguruma.OnigScanner(patterns), createOnigString: text => new oniguruma.OnigString(text) }),
    loadGrammar: async scope => {
      const file = grammarFiles.get(scope);
      return file ? textmate.parseRawGrammar(await fs.readFile(file, 'utf8'), file) : null;
    },
    getInjections: scope => contribution.injectTo.includes(scope) ? [contribution.scopeName] : []
  });
  try {
    const grammar = await registry.loadGrammarWithConfiguration('source.cpp', 1, {
      embeddedLanguages: Object.fromEntries(Object.entries(contribution.embeddedLanguages).map(([scope, language]) => [scope, language === 'yaml' ? 2 : 3]))
    });
    const source = `// ==WindhawkMod==
// @id highlight-demo
// @name Highlight demo
// @description Theme-aware metadata
// @name:fr Exemple
// @version 1.0
// ==/WindhawkMod==

// ==WindhawkModReadme==
/*
# Highlight demo
README text with **bold**, *italic* and [a link](https://windhawk.net).
- Markdown list
*/
// ==/WindhawkModReadme==

// ==WindhawkModSettings==
/*
- enabled: true
  count: 3
  $name: Enable logging
  #! $description: Highlight this annotation
*/
// ==/WindhawkModSettings==

// An ordinary C++ comment with @name stays a comment.
const char* text = R"raw(
// ==WindhawkMod==
// @name This is string content
// ==/WindhawkMod==
)raw";
/*
// ==WindhawkMod==
// @name This is ordinary comment content
// ==/WindhawkMod==
*/
int answer = 42;
`;
    let stack = textmate.INITIAL;
    const lines = source.split('\n'), tokenized = [];
    for (const line of lines) {
      const result = grammar.tokenizeLine(line, stack);
      const styled = grammar.tokenizeLine2(line, stack);
      tokenized.push({ line, scopes: result.tokens, styles: [...styled.tokens] });
      stack = result.ruleStack;
    }
    const tokenAt = (line, text) => {
      const row = tokenized.find(row => row.line === line); assert.ok(row, line);
      const index = line.indexOf(text); assert.ok(index >= 0, text);
      return row.scopes.find(token => token.startIndex <= index && token.endIndex > index).scopes;
    };
    assert.ok(tokenAt('// @id highlight-demo', '@id').includes('storage.type.class.doxygen.cpp'));
    assert.ok(tokenAt('// @name:fr Exemple', '@name:fr').includes('storage.type.class.doxygen.cpp'));
    assert.ok(tokenAt('// @name Highlight demo', 'Highlight').includes('comment.line.double-slash.cpp'));
    assert.ok(tokenAt('# Highlight demo', 'Highlight').some(scope => scope.startsWith('markup.heading')));
    assert.ok(tokenAt(lines[11], 'bold').some(scope => scope.startsWith('markup.bold')));
    assert.ok(tokenAt('- enabled: true', 'enabled').some(scope => scope.includes('yaml')));
    assert.ok(tokenAt('- enabled: true', 'true').some(scope => scope.startsWith('constant.language')));
    assert.ok(tokenAt(lines[21], '#!').includes('keyword.other.windhawk-settings-marker'));
    for (const line of ['// @name This is string content', '// @name This is ordinary comment content', '// An ordinary C++ comment with @name stays a comment.']) {
      assert.ok(!tokenAt(line, '@name').includes('storage.type.class.doxygen.cpp'), line);
    }
    assert.ok(!tokenAt('int answer = 42;', 'int').some(scope => /windhawk|wham|markdown|yaml/.test(scope)));
    // Export the actual theme-colored tokens for visual review, without changing source bytes.
    const colorMap = registry.getColorMap();
    for (const [line, text, expectedColor] of [
      ['// @name Highlight demo', '@name', '#569CD6'],
      ['// @name Highlight demo', 'Highlight', '#6A9955'],
      ['# Highlight demo', 'Highlight', '#569CD6']
    ]) {
      const row = tokenized.find(row => row.line === line), position = line.indexOf(text);
      const styleIndex = row.styles.findIndex((start, index) => index % 2 === 0 && start <= position && (row.styles[index + 2] ?? line.length) > position);
      assert.equal(colorMap[(row.styles[styleIndex + 1] >>> 15) & 511], expectedColor, text);
    }
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const preview = tokenized.slice(0, 24).map(({ line, styles }, lineIndex) => {
      let body = '';
      for (let index = 0; index < styles.length; index += 2) {
        const metadata = styles[index + 1], fontStyle = (metadata >>> 11) & 15;
        body += `<span style="color:${colorMap[(metadata >>> 15) & 511]};font-style:${fontStyle & 1 ? 'italic' : 'normal'};font-weight:${fontStyle & 2 ? 'bold' : 'normal'};text-decoration:${fontStyle & 4 ? 'underline' : 'none'}">${escape(line.slice(styles[index], styles[index + 2] ?? line.length))}</span>`;
      }
      return `<div><span class="number">${lineIndex + 1}</span>${body}</div>`;
    }).join('\n');
    await fs.mkdir('work', { recursive: true });
    await fs.writeFile('work/syntax-preview.html', `<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:20px;background:${theme.colors['editor.background']};color:${theme.colors['editor.foreground']};font:14px/1.65 Consolas,monospace}div{white-space:pre}.number{display:inline-block;width:35px;color:#6e7681;user-select:none}</style>${preview}`);
    console.log('Grammar checks passed: metadata and localized fields, Markdown, YAML and #! annotations, strings/comments excluded, C++ resumes; native Dark Modern token preview generated.');
  } finally { registry.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
