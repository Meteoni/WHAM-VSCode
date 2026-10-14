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
      .replace('<head>', '<head><style nonce="testnonce">@layer vscode-default { body { padding: 0 20px; } }</style>')
      // VS Code injects these scrollbar dimensions into every webview.
      .replace('</head>', `<link rel="stylesheet" href="${pathToFileURL(path.resolve('work/webview-scrollbars.css')).href}"></head>`)
      .replaceAll('${iconFont}', pathToFileURL(path.resolve('media/windhawk-renderer/codicon.edde7c4363c6d735a416.ttf')).href)
      .replaceAll('${sidebarStyles}', await fs.readFile('media/sidebar.css', 'utf8')).replaceAll('${script}', pathToFileURL(path.resolve('media/sidebar.js')).href);
    const root = 'C:\\Projects\\Windhawk';
    const config = { formatVersion: 1, sourceDirectory: 'src', outputDirectory: 'output', entries: ['**/*.cpp'], exclude: [], includeDirectories: ['src'], externalIncludes: [], generate: 'onSave', debounceMs: 250, inlineAngleIncludes: false };
    const metadata = parseMetadata(await fs.readFile('examples/demo/src/demo.cpp', 'utf8'), 'demo.cpp');
    metadata.readme += '\n<script>window.hacked = true</script>';
    const choices = [
      { label: 'Windhawk', detail: root, root },
      { label: 'Recent mod', detail: 'C:/Recent', root: 'C:/Recent' },
      { label: 'Browse for a project folder…', detail: '', root: '' }
    ];
    const state = { type: 'state', computer: { installationPath: 'C:/Windhawk', integration: 'cpp', installations: {} }, openAfterSetup: true, selected: root, projectChoices: choices, projects: [{ root, name: 'Windhawk', opened: true, config, editorNeedsApply: false, local: { integration: 'cpp' },
      editor: { installationPath: 'C:/Windhawk', integration: 'cpp', indentStyle: 'spaces', indentSize: 4 }, git: { branch: 'main', changes: 2 }, retained: [], entries: [
        { path: root + '\\src\\demo.cpp', label: 'demo.cpp', status: 'current', dependencies: 3, runtime: { installed: false, enabled: false, busy: false, changesPending: false }, message: '3 source file(s)', metadata },
        { path: root + '\\src\\tools\\second.cpp', label: 'tools/second.cpp', status: 'blocked', dependencies: 1, runtime: { installed: true, enabled: true, busy: false, changesPending: true }, message: 'Output was edited. Compare or restore its edits.', metadata: parseMetadata(await fs.readFile('examples/demo/src/tools/second.cpp', 'utf8'), 'second.cpp') }
      ] }] };
    await page.addInitScript(() => { let stored; window.sent = []; window.acquireVsCodeApi = () => ({ postMessage: message => window.sent.push(message), getState: () => stored, setState: value => { stored = value; } }); });
    await fs.mkdir('work/screenshots', { recursive: true });
    await fs.writeFile('work/webview-scrollbars.css', '::-webkit-scrollbar { width: 10px; height: 10px; }');
    await fs.writeFile('work/sidebar.html', html);
    await page.goto(pathToFileURL(path.resolve('work/sidebar.html')).href);
    assert.equal(await page.evaluate(()=>getComputedStyle(document.body).padding),'0px');
    const navigationBounds=await page.locator('.main-navigation').boundingBox();
    assert.equal(navigationBounds.x,12);assert.equal(navigationBounds.width,356,'Main navigation has the same inset as details at 380px');
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
    assert.ok(await page.locator('[data-page="settings"]').isEnabled());
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-setup-${version}.png`), fullPage: true });
    const wideCards = await page.locator('.setup-options button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    await page.setViewportSize({ width: 240, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const narrowCards = await page.locator('.setup-options button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    assert.ok(narrowCards.every((height, index) => height > wideCards[index]), 'Setup cards adapt to wrapped descriptions');
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-setup-narrow-${version}.png`), fullPage: true });
    await page.setViewportSize({ width: 380, height: 900 });
    await page.locator('#open-after-setup').uncheck(); await page.locator('#initial-commit').check(); await page.locator('[data-mode="Create a new project"]').click();
    const setupMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(setupMessage.mode, 'Create a new project'); assert.equal(setupMessage.openProject, false); assert.equal(setupMessage.initialCommit, true);
    await page.locator('[data-mode="Open an existing project"]').click();
    assert.equal((await page.evaluate(() => window.sent.at(-1))).mode, 'Open an existing project');
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.ok(await page.locator('#page-project').isVisible());
    assert.ok(await page.locator('#project').isVisible()); assert.equal(await page.locator('#project option:checked').textContent(), 'Windhawk');
    assert.equal(await page.locator('[data-action="openProject"]').count(), 0);
    assert.deepEqual(await page.locator('#project option').allTextContents(), choices.map(choice => choice.label));
    await page.locator('#project').selectOption('C:/Recent');
    const recentMessage = await page.evaluate(() => window.sent.at(-1));
    assert.equal(recentMessage.action, 'openProject'); assert.equal(recentMessage.projectRoot, 'C:/Recent');
    assert.equal(await page.locator('#project').inputValue(), root);
    await page.locator('#project').selectOption('');
    const browseMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(browseMessage.action, 'openProject'); assert.equal(browseMessage.browse, true);
    assert.equal(await page.locator('#project').inputValue(), root);
    const multiple = { ...state, projectChoices: [...choices.slice(0, -1), { label: 'Other', detail: 'C:/Other', root: 'C:/Other' }, choices.at(-1)], projects: [...state.projects, { ...state.projects[0], root: 'C:/Other', name: 'Other' }] };
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), multiple);
    assert.ok(await page.locator('#project').isVisible()); assert.equal(await page.locator('#project option').count(), 4);
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.equal(await page.locator('article').count(), 2);
    assert.equal(await page.locator('article .link').first().textContent(), metadata.fields.name[0]);
    assert.deepEqual(await page.locator('article .entry-actions').first().locator('button:visible').allTextContents(), ['Generate', 'Source', 'Compile']);
    assert.deepEqual(await page.locator('article .entry-actions').nth(1).locator('button:visible').allTextContents(), ['Generate', 'Source', 'Compile']);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('article .compile-needed').textContent(), '\ueb6d');
    assert.equal(await page.locator('article .compile-needed').evaluate(icon=>getComputedStyle(icon).borderWidth),'0px');
    assert.ok(await page.evaluate(()=>document.fonts.check('16px wham-codicon')), 'Bundled Codicon font loads');
    assert.equal(await page.getByRole('img', {name:'Needs compilation'}).count(), 1);
    assert.match(await page.locator('article .compile-needed').getAttribute('title'), /need compilation/);
    assert.match(await page.locator('article .badge.current').getAttribute('title'), /matches.*saved source/);
    assert.match(await page.locator('article .badge.blocked').getAttribute('title'), /preserve/);
    const unknownState={...state,projects:[{...state.projects[0],entries:state.projects[0].entries.map((entry,index)=>index===1?{...entry,runtime:{...entry.runtime,changesPending:false,compileStatus:'unknown'}}:entry)}]};
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),unknownState);
    const unknownIcon=page.getByRole('img',{name:'Build unknown'});
    assert.equal(await unknownIcon.textContent(),'\ueb32');assert.match(await unknownIcon.getAttribute('title'),/cannot confirm which source/);
    assert.equal(await unknownIcon.evaluate(icon=>getComputedStyle(icon).borderWidth),'0px');
    assert.equal(await unknownIcon.evaluate(icon=>getComputedStyle(icon).color),await page.locator('article .muted').first().evaluate(text=>getComputedStyle(text).color));
    await unknownIcon.waitFor({state:'visible'});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:path.resolve('work/screenshots/sidebar-build-unknown-'+version+'.png'),fullPage:true});
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),state);
    const folderButton = page.locator('.project-heading [data-action="openFolder"]');
    assert.equal(await folderButton.getAttribute('title'), 'Open project folder in VS Code.');
    assert.equal(await folderButton.textContent(), 'Open');
    await folderButton.click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'openFolder');
    assert.ok(await page.locator('article .entry-source-info').first().getByRole('switch').isVisible());
    assert.equal(await page.locator('article .entry-actions').first().getByRole('button', { name: 'Generate', exact: true }).getAttribute('class'), null);
    assert.equal(await page.locator('article .entry-actions').first().getByRole('button', { name: 'Compile', exact: true }).getAttribute('class'), 'primary');
    const split = page.locator('article .compile-split').first();
    const splitStyles = await split.evaluate(element => { const main = getComputedStyle(element.firstElementChild), arrow = getComputedStyle(element.querySelector('summary')); return {mainHeight:element.firstElementChild.offsetHeight, arrowHeight:element.querySelector('summary').offsetHeight, width:element.querySelector('summary').offsetWidth, mainCorner:main.borderTopRightRadius, arrowCorner:arrow.borderTopLeftRadius, mainBackground:main.backgroundColor, arrowBackground:arrow.backgroundColor}; });
    assert.equal(splitStyles.mainHeight,splitStyles.arrowHeight);assert.equal(splitStyles.width,22);
    assert.equal(splitStyles.mainCorner,'0px');assert.equal(splitStyles.arrowCorner,'0px');assert.equal(splitStyles.mainBackground,splitStyles.arrowBackground);
    const expander=split.getByRole('button',{name:/Compile options/});
    await expander.click();assert.ok(await split.getByRole('menuitem',{name:'Test build',exact:true}).isVisible());
    assert.ok(await split.getByRole('menuitem',{name:'Stop compilation',exact:true}).isHidden());
    await split.getByRole('menuitem',{name:'Test build',exact:true}).click();assert.equal((await page.evaluate(()=>window.sent.at(-1))).action,'testCompile');
    await expander.click();await split.getByRole('menuitem',{name:'Verify syntax',exact:true}).click();assert.equal((await page.evaluate(()=>window.sent.at(-1))).action,'verify');
    await expander.click();await page.locator('.mods-heading h2').click();assert.equal(await split.locator('details').getAttribute('open'),null,'Outside click closes menu');
    await expander.click();await page.keyboard.press('Escape');assert.equal(await split.locator('details').getAttribute('open'),null);
    await page.screenshot({ path: path.resolve('work/screenshots/sidebar-project-'+version+'.png'), fullPage: true });
    await page.locator('article .entry-actions').nth(1).screenshot({path:path.resolve('work/screenshots/compile-ready.png')});
    await page.locator('article').first().getByRole('button', { name: 'Compile', exact: true }).click();
    assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'compile');
    assert.ok(await page.locator('article').first().getByRole('switch').isDisabled());
    assert.equal(await page.locator('article .runtime-toggle').first().textContent(),'Disabled');
    assert.ok(await page.locator('article .runtime-toggle').first().evaluate(label => label.lastChild.matches('input')), 'Toggle follows its text');
    assert.equal(await page.locator('article .runtime-toggle').nth(1).textContent(),'Enabled');
    const installedSwitch = page.locator('article').nth(1).getByRole('switch'); assert.ok(await installedSwitch.isChecked());
    await installedSwitch.click(); const enableMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(enableMessage.action, 'enable'); assert.equal(enableMessage.enabled, false);
    assert.ok(await installedSwitch.isChecked(), 'Wait for confirmed Windhawk state before changing the displayed switch');
    for(const [operation,label,enabled]of [['enable','Enabling…',false],['disable','Disabling…',true]]) {
      const pending={...state,projects:[{...state.projects[0],entries:state.projects[0].entries.map((entry,index)=>index===1?{...entry,runtime:{...entry.runtime,enabled,busy:true,operation}}:entry)}]};
      await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),pending);
      assert.equal(await page.locator('article .runtime-toggle').nth(1).textContent(),label);
      assert.ok(await page.locator('article').nth(1).getByRole('button',{name:'Compile',exact:true}).isDisabled());
      assert.equal(await page.getByRole('button',{name:'Compiling…',exact:true}).count(),0);
    }
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),state);
    const normalCompile=await page.locator('article .compile-split > button').nth(1).boundingBox();
    const compilingState={...state,projects:[{...state.projects[0],entries:state.projects[0].entries.map((entry,index)=>index===1?{...entry,runtime:{...entry.runtime,busy:true,operation:'compile'}}:entry)}]};
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),compilingState);
    const compilingButton=page.locator('article').nth(1).getByRole('button',{name:'Compiling…',exact:true});
    assert.ok(await compilingButton.isDisabled());assert.equal(await compilingButton.getAttribute('aria-busy'),'true');
    assert.equal(await page.locator('.compile-spinner').count(),1);
    const busyCompile=await compilingButton.boundingBox();assert.equal(busyCompile.width,normalCompile.width);assert.equal(busyCompile.height,normalCompile.height);
    assert.equal(await compilingButton.locator('.compile-caption').evaluate(element=>getComputedStyle(element).visibility),'hidden');
    const spinnerBox=await compilingButton.locator('.compile-spinner').boundingBox();
    assert.ok(Math.abs(spinnerBox.x+spinnerBox.width/2-busyCompile.x-busyCompile.width/2)<1,'Spinner is centered');
    const compilingMenu=page.locator('article .compile-menu').nth(1);
    await compilingMenu.locator('summary').click();
    assert.ok(await compilingMenu.getByRole('menuitem',{name:'Test build',exact:true}).isDisabled());
    assert.ok(await compilingMenu.getByRole('menuitem',{name:'Stop compilation',exact:true}).isVisible());
    await compilingMenu.getByRole('menuitem',{name:'Stop compilation',exact:true}).click();assert.equal((await page.evaluate(()=>window.sent.at(-1))).action,'stopCompile');
    await page.screenshot({path:path.resolve('work/screenshots/sidebar-compiling-'+version+'.png'),fullPage:true});
    await page.locator('article .entry-actions').nth(1).screenshot({path:path.resolve('work/screenshots/compile-building.png')});
    const stoppingState={...compilingState,projects:[{...compilingState.projects[0],entries:compilingState.projects[0].entries.map((entry,index)=>index===1?{...entry,runtime:{...entry.runtime,stopping:true}}:entry)}]};
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),stoppingState);
    const stoppingButton=page.locator('article').nth(1).getByRole('button',{name:'Stopping…',exact:true});
    assert.equal((await stoppingButton.boundingBox()).width,normalCompile.width);assert.equal(await page.locator('.compile-spinner').count(),0);assert.equal(await stoppingButton.locator('.compile-stopping').textContent(),'Stopping');
    await page.screenshot({path:path.resolve('work/screenshots/sidebar-stopping-'+version+'.png'),fullPage:true});
    await page.locator('article .entry-actions').nth(1).screenshot({path:path.resolve('work/screenshots/compile-stopping.png')});
    const disabledState={...state,projects:[{...state.projects[0],entries:state.projects[0].entries.map((entry,index)=>index===1?{...entry,runtime:{...entry.runtime,enabled:false}}:entry)}]};
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),disabledState);
    assert.equal(await page.locator('article .runtime-toggle').nth(1).textContent(),'Disabled');
    await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:state})),state);
    await page.locator('article .link').first().click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'details'); assert.ok(await page.locator('#page-project').isVisible());
    await page.getByRole('button', { name: 'Generate all', exact: true }).click(); assert.equal((await page.evaluate(() => window.sent.at(-1))).action, 'generateAll');
    await page.locator('[data-page="settings"]').click();
    await page.locator('[data-settings-scope="extension"]').click();
    assert.ok(await page.getByRole('button',{name:'Save preferences',exact:true}).isDisabled());
    assert.ok(await page.locator('#project-settings-navigation').isHidden());
    assert.ok(await page.locator('#settings-project').isHidden());
    assert.equal(await page.locator('#page-settings > h1').count(), 0, 'There is no redundant Settings heading');
    assert.equal(await page.locator('#computer-config h2, [name="useAsDefault"], [name="useDefaultInstallation"], #editor-config [name="installationPath"]').count(),0,'Installation is global, with no redundant heading or default controls');
    await page.locator('#computer-config [name="elevation"]').selectOption('sudo');
    assert.equal(await page.locator('#computer-config [name="elevation"] option:checked').textContent(),'Windows sudo');
    assert.ok(await page.locator('#elevation-help').isVisible());assert.equal(await page.locator('#elevation-help').textContent(),'May require more approval prompts than gsudo.');
    await page.screenshot({path:path.resolve('work/screenshots/sidebar-windows-sudo-'+version+'.png'),fullPage:true});
    assert.ok(await page.getByRole('button',{name:'Save preferences',exact:true}).isEnabled());
    await page.locator('#computer-config [name="elevation"]').selectOption('none');
    assert.ok(await page.getByRole('button',{name:'Save preferences',exact:true}).isDisabled(),'Reverting extension settings disables Save');
    await page.locator('#computer-config [name="elevation"]').selectOption('gsudo');
    assert.ok(await page.locator('#gsudo-path').isVisible());
    assert.ok(await page.locator('#elevation-help').isHidden(), 'The dropdown already explains gsudo session reuse');
    await page.locator('#gsudo-path summary').click();
    assert.ok(!(await page.locator('#gsudo-path').textContent()).includes('gsudo executable'),'The custom path label is not repeated');
    await page.locator('#computer-config [name="installationPath"]').fill('"C:/Windhawk"');
    await page.locator('#computer-config [name="gsudoPath"]').fill('"C:/Tools/gsudo.exe"');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    const computerMessage=await page.evaluate(()=>window.sent.at(-1));assert.equal(computerMessage.action,'computerPreferences');assert.equal(computerMessage.settings.elevation,'gsudo');assert.equal(computerMessage.settings.installationPath,'C:/Windhawk');assert.equal(computerMessage.settings.gsudoPath,'C:/Tools/gsudo.exe');
    assert.ok(await page.getByRole('button',{name:'Save preferences',exact:true}).isDisabled(),'Save stays disabled while saving');
    await page.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'error',action:'computerPreferences',message:'Fixture save failure'}})));
    assert.ok(await page.getByRole('button',{name:'Save preferences',exact:true}).isEnabled(),'Failed saves can be retried');
    await page.screenshot({path:path.resolve('work/screenshots/sidebar-computer-'+version+'.png'),fullPage:true});
    await page.locator('[data-settings-scope="project"]').click();
    assert.equal(await page.locator('#settings-project').textContent(), 'These settings apply to Windhawk.');
    assert.ok(await page.locator('#project-settings-navigation').isVisible());
    await page.locator('[data-settings="editor"]').click();
    assert.ok(await page.locator('#apply-editor').isDisabled());assert.ok(await page.getByRole('button',{name:'Review…',exact:true}).isDisabled());
    const missingEditorState={...state,projects:[{...state.projects[0],editorNeedsApply:true}]};
    await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),missingEditorState);
    assert.ok(await page.locator('#apply-editor').isEnabled(),'Missing/outdated files enable Apply without field edits');
    await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),state);
    await page.locator('#editor-config [name="integration"]').selectOption('clangd');
    assert.ok(await page.locator('#apply-editor').isEnabled());
    assert.equal(await page.locator('#editor-pending').count(),0,'Pending dots are removed');
    assert.match(await page.locator('#apply-editor').getAttribute('title'),/pending editor changes/);
    const pendingApplyBounds=await page.locator('#apply-editor').boundingBox();
    await page.locator('#editor-config [name="integration"]').selectOption('cpp');
    assert.ok(await page.locator('#apply-editor').isDisabled(),'Reverting editor settings disables Apply');
    assert.ok(await page.getByRole('button',{name:'Review…',exact:true}).isDisabled());
    assert.equal((await page.locator('#apply-editor').boundingBox()).width,pendingApplyBounds.width,'Indicator does not shift the buttons');
    await page.locator('#editor-config [name="integration"]').selectOption('clangd');
    assert.equal(await page.getByRole('button',{name:'Save local preferences',exact:true}).count(),0);
    // Generation is taller: a classic scrollbar must not change either tab row.
    for (const width of [240, 380]) {
      await page.setViewportSize({ width, height: 700 });
      const measurements = [];
      for (const settingsPage of ['editor', 'generation', 'git']) {
        await page.locator(`[data-settings="${settingsPage}"]`).click();
        if (settingsPage === 'generation') {
          assert.ok(await page.evaluate(() => document.getElementById('wham-pages').scrollHeight > document.getElementById('wham-pages').clientHeight), 'Generation must scroll in this regression');
          assert.equal(await page.evaluate(() => document.getElementById('wham-pages').offsetWidth - document.getElementById('wham-pages').clientWidth), 10, 'Use VS Code scrollbar dimensions');
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
    assert.ok(await page.getByRole('button',{name:'Save configuration',exact:true}).isDisabled());
    await page.locator('[name="outputDirectory"]').fill('generated');
    assert.ok(await page.getByRole('button',{name:'Save configuration',exact:true}).isEnabled());
    await page.locator('[name="outputDirectory"]').fill('output');
    assert.ok(await page.getByRole('button',{name:'Save configuration',exact:true}).isDisabled());
    await page.locator('[name="outputDirectory"]').fill('generated');
    await page.evaluate(state => window.dispatchEvent(new MessageEvent('message', { data: state })), state);
    assert.equal(await page.locator('[name="outputDirectory"]').inputValue(), 'generated');
    await page.getByRole('button', { name: 'Save configuration', exact: true }).click();
    const message = await page.evaluate(() => window.sent.at(-1)); assert.equal(message.action, 'config'); assert.equal(message.config.outputDirectory, 'generated');
    assert.ok(await page.getByRole('button',{name:'Save configuration',exact:true}).isDisabled());
    await page.locator('[name="debounceMs"]').fill('400');
    const savedConfigState={...state,projects:[{...state.projects[0],config:message.config}]};
    await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),savedConfigState);
    await page.evaluate(root=>window.dispatchEvent(new MessageEvent('message',{data:{type:'saved',root}})),root);
    assert.equal(await page.locator('[name="debounceMs"]').inputValue(),'400','Saving does not discard edits made during the request');
    assert.ok(await page.getByRole('button',{name:'Save configuration',exact:true}).isEnabled());
    await page.locator('[data-settings="editor"]').click(); await page.locator('[name="indentStyle"]').selectOption('tabs'); await page.locator('[name="indentSize"]').fill('3');
    await page.locator('[data-settings="git"]').click(); assert.ok(await page.locator('#git-settings').isVisible()); assert.ok(await page.locator('#config').isHidden());
    assert.deepEqual(await page.locator('#git-settings .git-files').first().locator('li').allTextContents(),['Generated output','.vscode/settings.json','.vscode/c_cpp_properties.json','.clangd']);
    assert.deepEqual(await page.locator('#git-settings .git-files').nth(1).locator('li').allTextContents(),['Source files','windhawk-amalgamation.json','.clang-format','.vscode/extensions.json','.gitignore']);
    await page.screenshot({ path: path.resolve('work/screenshots/sidebar-git-'+version+'.png'), fullPage: true });
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
      assert.equal(styles.selectedTabs.length, 3, name);
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
    await page.getByRole('button', { name: 'Review…', exact: true }).click();
    const reviewed=await page.evaluate(()=>window.sent.at(-1));assert.equal(reviewed.action,'reviewEditor');assert.equal(reviewed.settings.indentSize,3);
    await page.evaluate(root=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorReviewed',root}})),root);
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    const editorMessage = await page.evaluate(() => window.sent.at(-1)); assert.equal(editorMessage.action, 'editor'); assert.equal(editorMessage.settings.indentStyle, 'tabs'); assert.equal(editorMessage.settings.indentSize, 3);
    assert.equal(editorMessage.settings.integration,'clangd');
    await page.evaluate(root=>window.dispatchEvent(new MessageEvent('message',{data:{type:'error',action:'editor',root,message:'Fixture apply failure'}})),root);
    assert.ok(await page.locator('#apply-editor').isEnabled());
    assert.equal(await page.locator('#editor-status').textContent(),'Fixture apply failure');
    const appliedState={...state,projects:[{...state.projects[0],local:{integration:'clangd'},editor:{...state.projects[0].editor,integration:'clangd',indentStyle:'tabs',indentSize:3}}]};
    await page.evaluate(data=>window.dispatchEvent(new MessageEvent('message',{data})),appliedState);
    await page.evaluate(root=>window.dispatchEvent(new MessageEvent('message',{data:{type:'editorSaved',root}})),root);
    assert.ok(await page.locator('#apply-editor').isDisabled(),'Successful Apply disables the action');
    assert.ok(await page.getByRole('button',{name:'Review…',exact:true}).isDisabled());
    await page.screenshot({ path: path.resolve(`work/screenshots/sidebar-settings-${version}.png`), fullPage: true });
    await page.setViewportSize({ width: 240, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    const restoredPage = await browser.newPage();
    await restoredPage.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => ({ page: 'settings', settings: 'generation' }), setState() {} }); });
    for (const destination of ['settings', 'project']) {
      const restoredHtml = html.replace('/* initial sidebar state */', 'window.whamSidebarState = ' + JSON.stringify({ ...state, page: destination }).replace(/</g, '\\u003c') + ';');
      await fs.writeFile('work/sidebar-restored.html', restoredHtml);
      await restoredPage.goto(pathToFileURL(path.resolve('work/sidebar-restored.html')).href, { waitUntil: 'domcontentloaded' });
      assert.ok(await restoredPage.locator('#page-' + destination).isVisible(), 'Restore destination before any host reply');
      assert.ok(await restoredPage.locator('#page-setup').isHidden());
      assert.equal(await restoredPage.locator('article .link').count(), 2, 'Cached project cards are ready immediately');
      if (destination === 'settings') assert.ok(await restoredPage.locator('#config').isVisible());
      assert.equal(await restoredPage.evaluate(() => window.hacked), undefined);
    }
    await restoredPage.close();
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: stable tab widths with visible scrollbars; existing sidebar workflows; visible action borders, square tabs, focus and narrow layout in ' + themes.map(([name]) => name).join(', ') + '.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
