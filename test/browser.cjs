// Optional real-browser test; supply a Playwright module and Chromium executable.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { parseMetadata } = require('../dist/metadata');
const { parse } = require('jsonc-parser');
(async () => {
  const version = require('../package.json').version;
  // Resolve actual bundled theme inheritance; registry defaults cover omitted tokens.
  const themeDirectory = process.argv[4];
  if (!themeDirectory) throw new Error('Pass the VS Code theme-defaults/themes directory as the fourth argument.');
  const readTheme = async file => {
    const theme = parse(await fs.readFile(path.join(themeDirectory, file), 'utf8'));
    return { ...(theme.include ? await readTheme(theme.include) : {}), ...theme.colors };
  };
  const darkModern = await readTheme('dark_modern.json');
  assert.equal(darkModern['button.secondaryBackground'], '#00000000');
  const defaultColors = { foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'button.secondaryBorder': '#cccccc26', 'testing.iconPassed': '#73c991', 'editorWarning.foreground': '#cca700', 'textCodeBlock.background': '#202020' };
  const themes = [
    ['Dark Modern', { ...defaultColors, ...darkModern }],
    ['2026 Dark', { ...defaultColors, ...await readTheme('2026-dark.json') }],
    ['2026 Light', { ...defaultColors, ...await readTheme('2026-light.json') }],
    ['High contrast fixture', { ...defaultColors, 'sideBar.background': '#000000', foreground: '#ffffff', 'input.background': '#000000', 'input.foreground': '#ffffff', 'button.background': '#000000', 'button.foreground': '#ffffff', 'button.secondaryBackground': '#00000000', 'button.secondaryForeground': '#ffffff', 'button.secondaryBorder': '#6fc3df', contrastBorder: '#6fc3df', focusBorder: '#f38518', 'textLink.foreground': '#3794ff', 'panel.border': '#6fc3df' }],
    ['Missing optional tokens', { foreground: '#cccccc', descriptionForeground: '#9d9d9d', 'sideBar.background': '#181818', 'input.background': '#313131', 'input.foreground': '#cccccc', 'button.background': '#0078d4', 'button.foreground': '#ffffff', focusBorder: '#0078d4', 'textLink.foreground': '#3794ff' }]
  ];
  const playwright = require(process.argv[2]);
  const browser = await playwright.chromium.launch({ executablePath: process.argv[3], headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const code = await fs.readFile('src/extension.ts', 'utf8');
    const template = /view\.webview\.html = `([\s\S]*?)`;/m.exec(code)[1];
    const html = template.replaceAll('${view.webview.cspSource}', 'file:').replaceAll('${nonce}', 'testnonce')
      // VS Code injects these scrollbar dimensions into every webview.
      .replace('</head>', `<link rel="stylesheet" href="${pathToFileURL(path.resolve('work/webview-scrollbars.css')).href}"></head>`)
      .replaceAll('${css}', pathToFileURL(path.resolve('media/sidebar.css')).href).replaceAll('${script}', pathToFileURL(path.resolve('media/sidebar.js')).href);
    const root = 'C:\\Projects\\Windhawk';
    const config = { formatVersion: 1, sourceDirectory: 'src', outputDirectory: 'output', entries: ['**/*.cpp'], exclude: [], includeDirectories: ['src'], externalIncludes: [], generate: 'onSave', debounceMs: 250, inlineAngleIncludes: false };
    const metadata = parseMetadata(await fs.readFile('examples/demo/src/demo.cpp', 'utf8'), 'demo.cpp');
    metadata.readme += '\n<script>window.hacked = true</script>';
    const state = { type: 'state', openAfterSetup: true, selected: root, projects: [{ root, name: 'Windhawk', opened: true, config,
      editor: { installationPath: 'C:/Windhawk', integration: 'cpp', indentStyle: 'spaces', indentSize: 4 }, git: { branch: 'main', changes: 2 }, retained: [], entries: [
        { path: root + '\\src\\demo.cpp', label: 'demo.cpp', status: 'current', message: '3 source file(s)', metadata },
        { path: root + '\\src\\tools\\second.cpp', label: 'tools/second.cpp', status: 'blocked', message: 'Output was edited. Compare or restore its edits.', metadata: parseMetadata(await fs.readFile('examples/demo/src/tools/second.cpp', 'utf8'), 'second.cpp') }
      ] }] };
    await page.addInitScript(() => { let stored; window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message), getState: () => stored, setState: value => { stored = value; } }); });
    await fs.mkdir('work/screenshots', { recursive: true });
    await fs.writeFile('work/webview-scrollbars.css', '::-webkit-scrollbar { width: 10px; height: 10px; }');
    await fs.writeFile('work/sidebar.html', html);
    await page.goto(pathToFileURL(path.resolve('work/sidebar.html')).href);
    const applyTheme = async colors => {
      await page.evaluate(colors => {
        const root = document.documentElement;
        root.removeAttribute('style');
        root.style.setProperty('--vscode-font-family', 'Segoe UI, sans-serif');
        root.style.setProperty('--vscode-editor-font-family', 'Consolas, monospace');
        for (const [name, value] of Object.entries(colors)) if (typeof value === 'string') root.style.setProperty('--vscode-' + name.replaceAll('.', '-'), value);
        document.body.style.backgroundColor = colors['sideBar.background'];
      }, colors);
    };
    await applyTheme(themes[0][1]);
    assert.ok(await page.locator('#page-setup').isVisible()); assert.ok(await page.locator('#page-project').isHidden()); assert.ok(await page.locator('#page-settings').isHidden());
    assert.ok(await page.locator('[data-page="settings"]').isDisabled());
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-setup-${version}.png`), fullPage: true });
    await page.locator('#open-after-setup').uncheck(); await page.locator('[data-mode="Create a new project"]').click();
    const setupMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(setupMessage.mode, 'Create a new project'); assert.equal(setupMessage.openProject, false);
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.ok(await page.locator('#page-project').isVisible()); assert.equal(await page.locator('article').count(), 2);
    assert.equal(await page.locator('article .link').first().textContent(), metadata.fields.name[0]);
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-project-${version}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Generate all', exact: true }).click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'generateAll');
    await page.locator('article .link').first().click(); assert.ok(await page.locator('#page-mod').isVisible());
    assert.ok((await page.locator('#metadata-fields').textContent()).includes(metadata.fields.id[0]));
    assert.ok((await page.locator('#readme').textContent()).includes('<script>')); assert.equal(await page.evaluate(() => window.hacked), undefined);
    await page.getByRole('button', { name: 'Edit metadata in source', exact: true }).click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).line, 0);
    await page.locator('#page-mod').getByRole('button', { name: 'Restore', exact: true }).click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'restore');
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-metadata-${version}.png`), fullPage: true });
    await page.locator('nav[aria-label="Main navigation"] [data-page="project"]').click(); await page.locator('article .link').nth(1).click();
    await page.getByRole('button', { name: 'Discard output edits…', exact: true }).click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'discard');
    await page.locator('[data-page="settings"]').click();
    // Generation is taller: a classic scrollbar must not change either tab row.
    for (const width of [240, 380]) {
      await page.setViewportSize({ width, height: 700 });
      const measurements = [];
      for (const settingsPage of ['editor', 'generation', 'git']) {
        await page.locator(`[data-settings="${settingsPage}"]`).click();
        if (settingsPage === 'generation') {
          assert.ok(await page.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight), 'Generation must scroll in this regression');
          assert.equal(await page.evaluate(() => innerWidth - document.documentElement.clientWidth), 10, 'Use VS Code scrollbar dimensions');
        }
        measurements.push(await page.evaluate(() => [...document.querySelectorAll('nav button')].map(button => {
          const bounds = button.getBoundingClientRect();
          return { x: bounds.x, width: bounds.width };
        })));
      }
      assert.deepEqual(measurements[1], measurements[0], `Generation tab layout at ${width}px`);
      assert.deepEqual(measurements[2], measurements[0], `Git tab layout at ${width}px`);
    }
    await page.setViewportSize({ width: 380, height: 900 });
    await page.locator('[data-settings="generation"]').click();
    await page.locator('[name="outputDirectory"]').fill('generated');
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.equal(await page.locator('[name="outputDirectory"]').inputValue(), 'generated');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    const message = await page.evaluate(() => window.sent.at(-1)); assert.equal(message.action, 'config'); assert.equal(message.config.outputDirectory, 'generated');
    await page.locator('[data-settings="editor"]').click(); await page.locator('[name="indentStyle"]').selectOption('tabs'); await page.locator('[name="indentSize"]').fill('3');
    await page.locator('[data-settings="git"]').click(); assert.ok(await page.locator('#git-settings').isVisible()); assert.ok(await page.locator('#config').isHidden());
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-git-${version}.png`), fullPage: true });
    for (const [name, colors] of themes) {
      await applyTheme(colors);
      const styles = await page.evaluate(() => {
        const secondary = getComputedStyle(document.querySelector('#git-settings button'));
        const selectedTabs = [...document.querySelectorAll('nav button[aria-current="page"]')].map(button => {
          const style = getComputedStyle(button);
          return { radius: style.borderRadius, topWidth: style.borderTopWidth, topColor: style.borderTopColor, shadow: style.boxShadow };
        });
        return { border: secondary.borderTopWidth, borderStyle: secondary.borderTopStyle, borderColor: secondary.borderTopColor, selectedTabs };
      });
      assert.equal(styles.border, '1px', name); assert.equal(styles.borderStyle, 'solid', name);
      assert.notEqual(styles.borderColor, 'rgba(0, 0, 0, 0)', name);
      assert.equal(styles.selectedTabs.length, 2, name);
      for (const tab of styles.selectedTabs) {
        assert.equal(tab.radius, '0px', name); assert.equal(tab.topWidth, '2px', name);
        assert.notEqual(tab.topColor, 'rgba(0, 0, 0, 0)', name); assert.equal(tab.shadow, 'none', name);
      }
      const action = page.locator('#git-settings button').first();
      await page.keyboard.press('Tab');
      await action.focus();
      assert.equal(await action.evaluate(button => getComputedStyle(button).outlineStyle), 'solid', name);
      await page.setViewportSize({ width: 240, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), name);
      await page.setViewportSize({ width: 380, height: 900 });
    }
    await applyTheme(themes[0][1]);
    await page.locator('[data-settings="editor"]').click(); assert.equal(await page.locator('[name="indentSize"]').inputValue(), '3');
    await page.getByRole('button', { name: 'Apply editor settings', exact: true }).click();
    const editorMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(editorMessage.action, 'editor'); assert.equal(editorMessage.settings.indentStyle, 'tabs'); assert.equal(editorMessage.settings.indentSize, 3);
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-settings-${version}.png`), fullPage: true });
    await page.setViewportSize({ width: 240, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const restoredPage = await browser.newPage();
    await restoredPage.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({ page: 'settings', settings: 'generation' }), setState() {} }); });
    await restoredPage.goto(pathToFileURL(path.resolve('work/sidebar.html')).href);
    await restoredPage.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.ok(await restoredPage.locator('#page-settings').isVisible()); assert.ok(await restoredPage.locator('#config').isVisible());
    await restoredPage.close();
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: stable tab widths with visible scrollbars; existing sidebar workflows; visible action borders, square tabs, focus and narrow layout in ' + themes.map(([name]) => name).join(', ') + '.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
