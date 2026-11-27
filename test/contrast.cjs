// Optional real-browser audit. Build first, then pass Playwright, Chromium, and before or after.
/* global createImageBitmap, document, getComputedStyle, OffscreenCanvas, window */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const work = path.resolve('work/contrast');
const fileUrl = file => pathToFileURL(path.resolve(file)).href;

async function loadFixtures() {
  const { parseMetadata } = require('../dist/metadata');
  const source = await fs.readFile('examples/demo/src/demo.cpp', 'utf8');
  const metadata = parseMetadata(source, 'demo.cpp');
  metadata.diagnostics.push({ line: 4, message: 'Duplicate metadata field.' });
  metadata.readme ??= '# Draft readme';
  metadata.settingsText ??= '- enabled: true';
  const root = 'C:\\Projects\\Windhawk';
  const project = {
    root,
    name: 'Windhawk',
    opened: false,
    retained: ['Existing output edits were preserved.'],
    git: { branch: 'main', changes: 2 },
    editorNeedsApply: false,
    editor: { integration: 'cpp', indentStyle: 'spaces', indentSize: 4 },
    config: {
      sourceDirectory: 'src',
      outputDirectory: 'output',
      entries: ['**/*.cpp'],
      exclude: ['scratch/**'],
      includeDirectories: ['include'],
      externalIncludes: ['windows.h'],
      generate: 'onSave',
      debounceMs: 250,
      inlineAngleIncludes: false
    },
    entries: ['current', 'blocked', 'stale', 'pending', 'generating'].map((status, index) => ({
      path: `${root}\\src\\${status}.cpp`,
      label: `${status}.cpp`,
      status,
      dependencies: 3,
      metadata: index === 1 ? metadata : undefined,
      message: index === 1 ? 'Output was edited. Compare or restore its edits.' : '3 source file(s)',
      runtime: [
        { installed: true, enabled: true, changesPending: true },
        { installed: true, enabled: false, compileStatus: 'unknown', error: 'Fixture runtime warning.' },
        { installed: false, enabled: false },
        { installed: true, enabled: true, busy: true, operation: 'compile' },
        { installed: true, enabled: false, busy: true, operation: 'test', stopping: true }
      ][index]
    }))
  };
  const state = {
    type: 'state',
    selected: root,
    projects: [project],
    projectChoices: [
      { label: project.name, detail: root, root },
      { label: 'Recent mod', detail: 'C:/Recent', root: 'C:/Recent' },
      { label: 'Browse for a project folder…', detail: '', root: '' }
    ],
    computer: { installationPath: '', integration: 'cpp', elevation: 'gsudo', gsudoPath: '' }
  };
  const sidebar = (await fs.readFile('media/sidebar.html', 'utf8'))
    .replaceAll('{{cspSource}}', 'file:')
    .replaceAll('{{nonce}}', 'contrast')
    .replaceAll('{{iconFont}}', fileUrl('media/windhawk-renderer/codicon.b5576db5d289588c1912.ttf'))
    .replaceAll('{{sidebarStyles}}', await fs.readFile('media/sidebar.css', 'utf8'))
    .replaceAll('{{script}}', fileUrl('media/sidebar.js'));

  // Render the real header through the extension entry point, without asking the host to load the renderer.
  const Uri = {
    file: fsPath => ({ fsPath }),
    joinPath: (root, ...parts) => Uri.file(path.join(root.fsPath, ...parts))
  };
  const webview = {
    cspSource: 'file:',
    asWebviewUri: uri => fileUrl(uri.fsPath),
    onDidReceiveMessage: () => ({ dispose() {} })
  };
  const load = Module._load;
  Module._load = function (name, ...args) {
    return name === 'vscode' ? { Uri, env: { language: 'en' } } : load.call(this, name, ...args);
  };
  try {
    require('../dist/details').createDetailsView(
      Uri.file(path.resolve('.')),
      webview,
      { modId: 'local@demo', entry: 'src/demo.cpp', source, parsed: metadata },
      { onAction: async () => {}, onNavigate: async () => {} }
    );
  } finally {
    Module._load = load;
  }
  return { sidebar, details: webview.html, state };
}

const luminance = color =>
  color.slice(0, 3).reduce((total, channel, index) => {
    const srgb = channel / 255;
    const linear = srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
const contrast = (foreground, background) => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
};
const hex = color =>
  '#' +
  color
    .slice(0, 3)
    .map(channel => Math.round(channel).toString(16).padStart(2, '0'))
    .join('');

// Runs inside Chromium. Composite each background and CSS opacity group in paint order.
function measure(element) {
  const style = getComputedStyle(element);
  const ancestry = [];
  for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) ancestry.push(getComputedStyle(ancestor));
  const canvas = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const color = value => {
    // Preserve fractional sRGB alpha in computed colors, including color(srgb) from color-mix().
    const rgb = value.match(/^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)$/);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)];
    const srgb = value.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
    if (srgb) return [255 * srgb[1], 255 * srgb[2], 255 * srgb[3], Number(srgb[4] ?? 1)];
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = value;
    canvas.fillRect(0, 0, 1, 1);
    const pixel = [...canvas.getImageData(0, 0, 1, 1).data];
    return [...pixel.slice(0, 3), pixel[3] / 255];
  };
  const over = (front, back) => {
    const alpha = front[3] + back[3] * (1 - front[3]);
    return [
      ...front
        .slice(0, 3)
        .map((channel, index) => (alpha ? (channel * front[3] + back[index] * back[3] * (1 - front[3])) / alpha : 0)),
      alpha
    ];
  };
  const paint = (pixel, outside = false) => {
    for (const [index, layer] of ancestry.entries()) {
      if (outside && index === 0) continue;
      pixel = over(pixel, color(layer.backgroundColor));
      pixel[3] *= Number(layer.opacity);
    }
    return over(pixel, [255, 255, 255, 1]).slice(0, 3);
  };
  const transparent = [0, 0, 0, 0];
  const inside = paint(transparent);
  const outside = paint(transparent, true);
  const rows = [];
  const add = (feature, foreground, background, required = 3, visible = true) =>
    rows.push({ feature, foreground, background, required, visible });
  const ink = (feature, value, required = 3) => add(feature, paint(color(value)), inside, required);
  const text = (feature, textStyle = style) => {
    const size = parseFloat(textStyle.fontSize);
    ink(feature, textStyle.color, size >= 24 || (size >= 18.66 && Number(textStyle.fontWeight) >= 700) ? 3 : 4.5);
  };
  const nativeCheckbox = element.matches('input[type="checkbox"]') && style.appearance !== 'none';
  const native = nativeCheckbox ? 'checkbox' : element.matches('select') ? 'select' : '';
  const icon = element.querySelector(':scope > svg :is(path, circle, rect)');
  if (icon) {
    const glyph = getComputedStyle(icon);
    ink('Icon', glyph.stroke === 'none' ? glyph.fill : glyph.stroke);
  }
  if (element.matches('.build-indicator')) ink('Status icon', style.color);
  else if (element.matches('.compile-spinner')) ink('Busy spinner', style.borderTopColor);
  else if (element.matches('input:not([type="checkbox"]), textarea') && element.value) text('Value');
  else if (element.matches('input:placeholder-shown, textarea:placeholder-shown'))
    text('Placeholder', getComputedStyle(element, '::placeholder'));
  else if (element.matches('select')) text('Selected value');
  else if (element.matches('option')) add('Option text', paint(color(style.color)), inside, 4.5);
  else if ([...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()))
    element.matches('.more-menu > summary') ? ink('Menu glyph', style.color) : text('Text');

  // Fields, switches and popups need a visible edge. Text buttons are identified by their label,
  // and icon-only controls by their glyph, so their edges are not required (WCAG 1.4.11).
  if (!nativeCheckbox && element.matches('input, select, textarea, .more-actions')) {
    // Either the fill or a solid edge can identify the control against the surrounding surface.
    add('Boundary fill', inside, outside);
    add('Boundary border', paint(color(style.borderTopColor)), outside, 3, style.borderTopWidth !== '0px');
  }
  if (element.matches('nav button[aria-current="page"]')) {
    const indicator = paint(color(style.borderTopColor));
    add('Selected tab (inside)', indicator, inside);
    add('Selected tab (above)', indicator, outside);
  }
  if (element.matches('.compile-menu > summary')) {
    const divider = paint(color(style.borderLeftColor));
    add('Split divider', divider, inside);
  }
  if (element.matches('.runtime-toggle input'))
    ink('Switch thumb', getComputedStyle(element, '::before').backgroundColor);
  if (element.matches('summary:not(.more-menu > summary)'))
    ink('Disclosure marker', getComputedStyle(element, '::marker').color);
  if (element.matches('.refresh-pending')) {
    const dot = getComputedStyle(element, '::after');
    const halo = dot.boxShadow.match(/^(rgba?\([^)]+\))/)?.[1];
    add('Refresh status dot', paint(color(dot.backgroundColor)), halo ? paint(color(halo)) : inside);
  }
  if (element.matches(':focus-visible')) {
    const insideOutline = parseFloat(style.outlineOffset) < 0;
    const outline = paint(color(style.outlineColor), !insideOutline);
    const visible = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    add('Focus indicator', outline, insideOutline ? inside : outside, 3, visible);
  }
  const busy = element.closest('[aria-busy="true"]');
  const disabled = element.closest(':disabled');
  const states = [
    element.matches(':checked') ? 'checked' : element.matches('input[type="checkbox"]') ? 'unchecked' : '',
    element.matches('[aria-current="page"]') ? 'selected' : '',
    element.matches('details[open] > summary') ? 'expanded' : '',
    busy ? 'busy' : '',
    disabled ? 'disabled' : ''
  ].filter(Boolean);
  return {
    rows,
    inside,
    outside,
    native,
    states,
    exempt: !!disabled && !(busy && element.matches('.compile-spinner, .compile-stopping'))
  };
}

async function nativeColors(page, target, sample) {
  // Chromium does not expose native check and select glyphs in computed styles.
  const png = await target.screenshot();
  const pixels = await page.evaluate(
    async bytes => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(image.width, image.height).getContext('2d');
      canvas.drawImage(image, 0, 0);
      return [...Array(image.height)].map((_, y) => {
        const row = canvas.getImageData(0, y, image.width, 1).data;
        return [...Array(image.width)].map((_, x) => [...row.slice(x * 4, x * 4 + 3)]);
      });
    },
    [...png]
  );
  const width = pixels[0].length;
  const height = pixels.length;
  const strongest = (region, background) =>
    region.reduce(
      (best, color) => (contrast(color, background) > contrast(best, background) ? color : best),
      background
    );
  if (sample.native === 'select') {
    const arrow = pixels.slice(3, -3).flatMap(row => row.slice(-17, -2));
    return [
      {
        feature: 'Select arrow',
        foreground: strongest(arrow, sample.inside),
        background: sample.inside,
        required: 3,
        visible: true
      }
    ];
  }
  const center = Math.floor(width / 2);
  const edge = pixels[Math.floor(height / 2)].slice(0, 3);
  const fill = pixels[2][center];
  const rows = [
    {
      feature: 'Native checkbox edge',
      foreground: strongest([...edge, fill], sample.outside),
      background: sample.outside,
      required: 3,
      visible: true
    }
  ];
  if (sample.states.includes('checked')) {
    const glyph = pixels.slice(3, -3).flatMap(row => row.slice(3, -3));
    rows.push({
      feature: 'Native check mark',
      foreground: strongest(glyph, fill),
      background: fill,
      required: 3,
      visible: true
    });
  }
  return rows;
}

async function auditPage(page, fixtures, results, theme, surface) {
  const click = selector => page.locator(selector).click();
  const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
  const { state } = fixtures;
  const project = state.projects[0];
  const root = project.root;
  const audit = async (scenario, scope = 'body') => {
    const initialCount = results.length;
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement.blur());
    const elements = await page.evaluate(scope => {
      for (const element of document.querySelectorAll('[data-contrast]')) delete element.dataset.contrast;
      const elements = [...document.querySelectorAll(scope)].flatMap(root => [root, ...root.querySelectorAll('*')]);
      return [...new Set(elements)]
        .filter(
          element =>
            !element.matches('script, style, svg, svg *, br') &&
            (element.matches('option') ? element.parentElement : element).checkVisibility({ visibilityProperty: true })
        )
        .map((element, index) => {
          const control = element.matches('button, summary, input, select, textarea, a[href], [tabindex]');
          if (
            !control &&
            !element.matches('option, .more-actions, .compile-spinner, .build-indicator') &&
            ![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())
          )
            return null;
          element.dataset.contrast = index;
          const card = element.closest('article')?.querySelector('.badge')?.textContent;
          const text = element.getAttribute('aria-label') || element.innerText?.trim().replace(/\s+/g, ' ') || '';
          const id = element.id || element.getAttribute('name') || element.getAttribute('data-action') || '';
          return {
            index,
            element: `${element.localName}${id ? ' (' + id + ')' : ''}${text && !element.matches('.more-actions') ? ' ' + text : ''}${card ? ' [' + card + ' mod]' : ''}`,
            control,
            disabled: element.matches(':disabled'),
            pressable: element.matches('button, summary, input[type="checkbox"]'),
            nested: !!element.querySelector(
              ':scope > strong, :scope > span:not(.compile-spinner, .compile-stopping):not([hidden])'
            )
          };
        })
        .filter(Boolean);
    }, scope);
    const capture = async (entry, target, interaction, includeNative = false) => {
      const sample = await target.evaluate(measure);
      if (includeNative && sample.native) sample.rows.push(...(await nativeColors(page, target, sample)));
      const boundary = sample.rows.filter(row => row.feature.startsWith('Boundary '));
      if (boundary.length) {
        const [best] = boundary.sort(
          (a, b) =>
            (b.visible ? contrast(b.foreground, b.background) : 0) -
            (a.visible ? contrast(a.foreground, a.background) : 0)
        );
        best.feature = `Boundary (${best.feature.split(' ')[1]})`;
        sample.rows = sample.rows.filter(row => row === best || !row.feature.startsWith('Boundary '));
      }
      for (const row of sample.rows) {
        const ratio = row.visible ? contrast(row.foreground, row.background) : 1;
        results.push({
          theme,
          surface,
          scenario,
          element: entry.element,
          state: [...sample.states, interaction].filter(Boolean).join(', ') || 'default',
          feature: row.feature,
          foreground: hex(row.foreground),
          background: hex(row.background),
          ratio,
          required: row.required,
          result: sample.exempt ? 'exempt (disabled)' : ratio >= row.required ? 'pass' : 'fail'
        });
      }
    };
    for (const entry of elements) {
      const target = page.locator(`[data-contrast="${entry.index}"]`);
      await capture(entry, target, '', true);
      if (!entry.control || entry.disabled) continue;
      await page.keyboard.press('Tab');
      await target.focus();
      assert.ok(await target.evaluate(element => element.matches(':focus-visible')), entry.element);
      await capture(entry, target, 'keyboard focus', true);
      await target.hover();
      await capture(entry, target, 'keyboard focus + hover', true);
      await target.evaluate(element => element.blur());
      await capture(entry, target, 'hover', true);
      const children = entry.nested
        ? elements.filter(child => child.index > entry.index && child.index <= entry.index + 2)
        : [];
      for (const child of children) {
        const nested = page.locator(`[data-contrast="${child.index}"]`);
        if (await nested.evaluate(element => element.parentElement.matches('button')))
          await capture(child, nested, 'parent hover');
      }
      if (entry.pressable) {
        // Keep the real pressed style while suppressing the action triggered by mouseup.
        await page.mouse.down();
        assert.ok(await target.evaluate(element => element.matches(':active')), entry.element);
        await capture(entry, target, 'pressed', true);
        for (const child of children) {
          const nested = page.locator(`[data-contrast="${child.index}"]`);
          if (await nested.evaluate(element => element.parentElement.matches('button')))
            await capture(child, nested, 'parent pressed');
        }
        await page.evaluate(() =>
          window.addEventListener(
            'click',
            event => {
              event.preventDefault();
              event.stopImmediatePropagation();
            },
            { capture: true, once: true }
          )
        );
        await page.mouse.up();
      }
      await page.mouse.move(0, 0);
      await target.evaluate(element => element.blur());
    }
    assert.ok(results.length > initialCount, `${surface} / ${scenario} has no visible contrast measurements`);
  };

  if (surface === 'details') {
    await audit('Preview loading');
    await post({ type: 'context', modId: 'local@demo', draftRevision: 'new revision', outputBlocked: true });
    await post({ type: 'error', message: 'Could not load mod details. Try Refresh.' });
    await audit('Preview changed / error', '#refresh, #wham-error');
    await click('.more-menu > summary');
    await audit('Preview menu open', '.more-menu > summary, .more-actions');
    return;
  }
  await click('[data-mode] >> nth=0');
  await audit('Setup without a project');
  await click('#open-after-setup');
  await click('#initial-commit');
  await audit('Setup checkbox alternatives', '.checkbox input');
  await post({ ...state, page: 'project' });
  await click('.project-location summary');
  await audit('Project and mod cards');
  for (const status of ['current', 'pending', 'generating']) {
    const card = `article:has(.badge.${status})`;
    await click(`${card} .compile-menu > summary`);
    await audit(`Compile menu open (${status})`, `${card} .compile-menu > summary, ${card} .more-actions`);
    await page.keyboard.press('Escape');
    await page.locator(`${card} .compile-menu`).evaluate(menu => {
      menu.open = false;
    });
  }
  const entries = project.entries.map((entry, index) =>
    index < 2
      ? { ...entry, runtime: { ...entry.runtime, busy: true, operation: index === 0 ? 'disable' : 'enable' } }
      : entry
  );
  await post({ ...state, projects: [{ ...project, entries }] });
  await audit('Changing installed mod state', 'article:has(.badge.current, .badge.blocked) .runtime-toggle');
  await post(state);
  await post({ type: 'detailsFallback', entry: project.entries[1].path });
  await audit('Mod metadata, README and settings');
  await click('#mod-actions summary');
  await audit('Mod menu open', '#mod-actions summary, #mod-actions .more-actions');
  await post({
    ...state,
    page: 'project',
    projects: [{ ...project, error: 'Project configuration error.', entries: [] }]
  });
  await audit('Project error / empty', '#error, #page-project');
  await post({ ...state, page: 'settings' });
  await audit('Settings / Editor');
  await page.locator('#editor-config [name="integration"]').selectOption('clangd');
  await audit('Editor settings changed', '#editor-config .toolbar');
  await click('#apply-editor');
  await audit('Applying editor settings', '#editor-config .toolbar');
  await post({ type: 'error', action: 'editor', root, message: 'Editor setup failed.' });
  await audit('Editor error', '#editor-status');
  await post({ type: 'editorSaved', root });
  await audit('Editor saved', '#editor-status');
  await click('[data-settings="generation"]');
  await audit('Settings / Generation');
  await page.locator('[name="outputDirectory"]').fill('generated');
  await click('[name="inlineAngleIncludes"]');
  await audit('Generation settings changed', '#config button, [name="inlineAngleIncludes"]');
  await click('#config button');
  await audit('Saving generation settings', '#config button');
  await post({ type: 'error', action: 'config', root, message: 'Could not save configuration.' });
  await audit('Generation error', '#settings-status');
  await post({ type: 'saved', root });
  await audit('Generation saved', '#settings-status');
  await click('[data-settings="git"]');
  await audit('Settings / Git');
  await click('[data-settings-scope="extension"]');
  await click('#gsudo-path summary');
  await audit('Settings / Extension');
  await page.locator('[name="elevation"]').selectOption('sudo');
  await audit('Extension settings changed', '#elevation-help, #computer-config [type="submit"]');
  await click('#computer-config [type="submit"]');
  await audit('Saving extension settings', '#computer-config [type="submit"]');
  await post({ type: 'error', action: 'computerPreferences', message: 'Could not save preferences.' });
  await audit('Extension settings error', '#computer-status');
  await post({ type: 'computerSaved' });
  await audit('Extension settings saved', '#computer-status');
  await post({ type: 'state', page: 'settings', projects: [], projectChoices: [], computer: state.computer });
  await audit('Settings without a project', 'nav.main-navigation, nav.settings-scope');
}

(async () => {
  const [playwrightPath, chromium, name] = process.argv.slice(2);
  if (!playwrightPath || !chromium || !['before', 'after'].includes(name))
    throw new Error('Usage: node test/contrast.cjs <Playwright module> <Chromium executable> <before|after>');
  const themes = JSON.parse(
    await fs.readFile(path.join(work, 'themes.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT')
        throw new Error(
          'Missing work/contrast/themes.json. Supply captured VS Code webview variables and body classes.'
        );
      throw error;
    })
  );
  const fixtures = await loadFixtures();
  const browser = await require(path.resolve(playwrightPath)).chromium.launch({
    executablePath: chromium,
    headless: true
  });
  const results = [];
  try {
    for (const [theme, { bodyClass, variables }] of Object.entries(themes)) {
      for (const surface of ['sidebar', 'details']) {
        const page = await browser.newPage({ viewport: { width: 420, height: 1500 }, reducedMotion: 'reduce' });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
          window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
        });
        // Reproduce the VS Code webview defaults that affect WHAM. The host paints behind the sidebar.
        const injected = `<style nonce="contrast">:root { ${Object.entries(variables)
          .map(([key, value]) => `${key}: ${value};`)
          .join('\n')} }
          @layer vscode-default {
            body { background-color: transparent; font-weight: var(--vscode-font-weight); padding: 0 20px; }
            code { color: var(--vscode-textPreformat-foreground); background-color: var(--vscode-textPreformat-background); padding: 1px 3px; }
            input:focus, select:focus, textarea:focus { outline: 1px solid -webkit-focus-ring-color; outline-offset: -1px; }
            ::-webkit-scrollbar { width: 10px; height: 10px; }
          }
          ${surface === 'sidebar' ? 'html { background-color: var(--vscode-sideBar-background); }' : ''}</style>`;
        const html = fixtures[surface]
          .replace('<body', `<body class="${bodyClass}" data-vscode-theme-kind="${bodyClass.split(' ')[0]}"`)
          .replace('</head>', `${injected}</head>`);
        const file = path.join(work, `${surface}.html`);
        await fs.writeFile(file, html);
        await page.goto(fileUrl(file));
        await page.evaluate(() => document.fonts.ready);
        await auditPage(page, fixtures, results, theme, surface);
        assert.deepEqual(errors, [], `${theme} ${surface}`);
        await page.close();
      }
      console.log(`${theme} audited`);
    }
  } finally {
    await browser.close();
  }
  await fs.writeFile(path.join(work, `${name}.json`), JSON.stringify(results, null, 2) + '\n');
  const report = [
    `# WHAM contrast audit (${name})`,
    '',
    'WCAG 2.2 AA. Ratios are checked before rounding. Foreground and background are shown after compositing. A control boundary passes when either its fill or border contrasts with the surrounding surface. Link, icon and menu-row controls are identified by their content. Badge outlines are decorative. Native checkbox and select glyphs are sampled in Chromium. Open native select pickers are platform UI. Disabled controls are recorded as exempt. Read the JSON for each measurement, including passing and exempt rows.',
    ''
  ];
  for (const theme of Object.keys(themes)) {
    const rows = results.filter(row => row.theme === theme);
    const failures = rows.filter(row => row.result === 'fail');
    const exempt = rows.filter(row => row.result.startsWith('exempt')).length;
    report.push(
      `## ${theme}`,
      '',
      `${rows.length - failures.length - exempt} passed, ${failures.length} failed, ${exempt} exempt.`,
      ''
    );
    if (!failures.length) continue;
    report.push(
      '| Surface / scenario | Element | State | Feature | Foreground | Background | Ratio | Required |',
      '| --- | --- | --- | --- | --- | --- | ---: | ---: |'
    );
    for (const row of failures)
      report.push(
        `| ${row.surface} / ${row.scenario} | ${row.element.replaceAll('|', '\\|')} | ${row.state} | ${row.feature} | ${row.foreground} | ${row.background} | ${row.ratio.toFixed(2)} | ${row.required} |`
      );
    report.push('');
  }
  await fs.writeFile(path.join(work, `${name}.md`), report.join('\n'));
  const failures = results.filter(row => row.result === 'fail').length;
  console.log(`${results.length} measurements, ${failures} failures. Reports in work/contrast/${name}.{json,md}.`);
  if (name === 'after' && failures) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
