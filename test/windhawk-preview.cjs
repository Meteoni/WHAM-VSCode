// Render the bundled Discover view without using an installed Windhawk UI/core.
const fs = require('node:fs/promises'), path = require('node:path'), Module = require('node:module');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { parseDraftSource } = require('../dist/metadata');
const windhawk = require('../dist/windhawk');
(async () => {
  const [playwrightPath, chromium] = process.argv.slice(2);
  const source = '// ==WindhawkMod==\n// @id wham-preview-test\n// @name WHAM Preview Test\n// @version 1.0\n// ==/WindhawkMod==\n// ==WindhawkModReadme==\n/*\n# Preview heading\n\n**Formatted text** in the pinned Windhawk renderer.\n<script>window.hacked = true</script>\n*/\n// ==/WindhawkModReadme==\n// ==WindhawkModSettings==\n/*\n- enabled: true\n  $name: Enabled setting\n- amount: 3\n  $name: Amount\n*/\n// ==/WindhawkModSettings==\n';
  const parsed = parseDraftSource(source, 'src/mod.cpp', 'en');
  const renderer = path.resolve('media/windhawk-renderer');
  const browser = await require(playwrightPath).chromium.launch({ executablePath: chromium, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    const messages = [], errors = [], actions = [], launches = [], navigations = [];
    page.on('pageerror', error => errors.push(error.message));
    let receive, panelHtml, live = false, htmlSequence = 0, navigation = Promise.resolve();
    const Uri = { file: fsPath => ({ fsPath }), joinPath: (root, ...parts) => Uri.file(path.join(root.fsPath, ...parts)) };
    const webview = {
      cspSource: 'https://wham.test', asWebviewUri: uri => {
        const vendor = uri.fsPath.startsWith(renderer);
        const prefix = vendor ? renderer : path.resolve('media');
        return { toString: () => 'https://wham.test' + (vendor ? '/windhawk/' : '/media/') + path.relative(prefix, uri.fsPath).split(path.sep).join('/') };
      },
      set html(value) {
        // VS Code injects this default before WHAM's own styles.
        value = value.replace('<head>', '<head><style>@layer vscode-default { body { padding: 0 20px; } }</style>');
        panelHtml = value;
        if (live) navigation = navigation.then(async () => {
          const file = path.resolve('work/details-preview-' + (++htmlSequence) + '.html');
          await fs.writeFile(file, value); await page.goto(pathToFileURL(file).href);
        });
      },
      onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; },
      postMessage: async message => page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), message)
    };
    const mock = { Uri, env: { language:'en' }, window: {
      showErrorMessage: async message => errors.push(message), showInformationMessage: async () => {}
    } };
    const load = Module._load;
    Module._load = function(name, parent, ...rest) {
      if (parent?.filename === require.resolve('../dist/details')) {
        if (name === 'vscode') return mock;
        if (name === './windhawk') return { ...windhawk, openWindhawk: async root => { launches.push(root); } };
      }
      return load.call(this, name, parent, ...rest);
    };
    let create; try { delete require.cache[require.resolve('../dist/details')]; create = require('../dist/details').createDetailsView; } finally { Module._load = load; }
    const data = { installation: { root:'C:/Old Windhawk', parser:false, cli:false }, modId:'local@wham-preview-test', entry:'src/mod.cpp', source, parsed };
    const details = create(Uri.file(path.resolve('.')), webview, data, { onAction: async action => { actions.push(action); }, onNavigate: async page => { navigations.push(page); } });
    let releaseAssets;
    const assetsReady = new Promise(resolve => { releaseAssets = resolve; });
    await page.route('https://wham.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/windhawk/')) await assetsReady;
      const root = url.pathname.startsWith('/windhawk/') ? renderer : path.resolve('media');
      const relative = decodeURIComponent(url.pathname.replace(/^\/(?:windhawk|media)\//, ''));
      const file = path.resolve(root, relative); assert.ok(file.startsWith(root + path.sep));
      const types = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.woff2':'font/woff2', '.svg':'image/svg+xml' };
      try { await route.fulfill({ body:await fs.readFile(file), contentType:types[path.extname(file)] || 'application/octet-stream', headers:{ 'Access-Control-Allow-Origin':'*' } }); }
      catch { await route.fulfill({ status:404, body:'' }); }
    });
    await page.exposeFunction('sendToHost', async message => { messages.push(message); await receive(message); });
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.classList.add('vscode-dark');
        for (const [key,value] of Object.entries({ foreground:'#cccccc', 'descriptionForeground':'#9d9d9d', 'editor-background':'#1f1f1f', 'panel-border':'#2b2b2b', 'button-secondaryBackground':'#333333', 'button-secondaryForeground':'#cccccc', focusBorder:'#0078d4', 'tab-activeBackground':'#1f1f1f', 'font-family':'Segoe UI, sans-serif' })) document.documentElement.style.setProperty('--vscode-'+key,value);
      });
      window.acquireVsCodeApi = () => ({ postMessage:message => window.sendToHost(message), getState:() => ({}), setState() {} });
    });
    await fs.mkdir('work/screenshots', { recursive:true }); await fs.writeFile('work/details-preview.html',panelHtml);
    await page.goto(pathToFileURL(path.resolve('work/details-preview.html')).href, { waitUntil:'domcontentloaded' }); live = true;
    assert.equal(await page.locator('#switch-mode').count(),0);
    assert.ok(await page.getByRole('button',{name:'Back to all mods',exact:true}).isVisible());
    assert.ok(await page.locator('#wham-loading').isVisible());
    await page.getByRole('button',{name:'Open Windhawk',exact:true}).click(); assert.deepEqual(launches,['C:/Old Windhawk']);
    await page.getByRole('button',{name:'Source',exact:true}).click(); assert.deepEqual(actions,['open']); actions.length=0;
    assert.equal(messages.filter(item=>item.action==='windhawk').length,0,'Toolbar works before renderer assets load');
    const toolbarSize = () => page.locator('#wham-header').evaluate(header => ({height:header.offsetHeight, width:header.getBoundingClientRect().width, x:header.getBoundingClientRect().x, controls:[...header.querySelectorAll('button,summary')].map(control => ({width:control.offsetWidth,height:control.offsetHeight,font:getComputedStyle(control).fontSize}))}));
    const before = await toolbarSize();
    const tabs=await page.locator('.wham-navigation').boundingBox();
    assert.equal(tabs.x,12);assert.equal(tabs.width,1076,'Details navigation uses the same 12px inset on both sides');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).padding), '0px');
    await page.screenshot({path:'work/screenshots/pinned-draft-loading.png'});
    releaseAssets();
    const preview=page.getByTestId('mod-details');
    await preview.getByText('Preview heading',{exact:true}).waitFor();
    assert.deepEqual(await toolbarSize(),before,'Vendor styles must not resize the WHAM toolbar');
    assert.equal(await preview.locator('strong').filter({hasText:'Formatted text'}).count(),1);
    assert.equal(await page.evaluate(()=>window.hacked),undefined,'README scripts cannot execute');
    assert.ok(await preview.getByTestId('mod-details-tab-code').isHidden());
    assert.deepEqual(await page.locator('#mod-tools button:visible').allTextContents(),['Source','Output']);
    for(const action of ['generate','open','output','compare','restore','verify']) {
      if(!['open','output'].includes(action)) await page.getByRole('button',{name:'More actions',exact:true}).click();
      await page.locator('[data-mod-action="'+action+'"]').click();
    }
    assert.deepEqual(actions,['generate','open','output','compare','restore','verify']);
    await preview.getByTestId('mod-details-tab-settings').click();
    await preview.getByText('Enabled setting',{exact:true}).waitFor();
    assert.ok(await preview.getByTestId('mod-settings-save').isHidden());
    assert.ok(await preview.getByRole('switch').isDisabled());
    assert.equal(await preview.getByRole('spinbutton').getAttribute('readonly'),'');
    assert.equal(await preview.getByRole('spinbutton').getAttribute('placeholder'),'3');
    assert.equal(messages.filter(message=>['getModSettings','setModSettings','getModConfig'].includes(message.command)).length,0);
    const nextSource=source.replace('Preview heading','Updated preview heading');
    const nextData={...data,source:nextSource,parsed:parseDraftSource(nextSource,'src/mod.cpp','en'),outputBlocked:true};
    await details.update(nextData);
    assert.ok(await page.locator('#refresh.refresh-pending').isVisible());
    assert.equal(await preview.getByRole('spinbutton').getAttribute('placeholder'),'3');
    await page.locator('#refresh').click();
    await preview.getByText('Updated preview heading',{exact:true}).waitFor();
    assert.equal(await page.locator('#refresh.refresh-pending').count(),0);
    await page.screenshot({path:'work/screenshots/pinned-draft-details.png'});
    for(const width of [340,240]) {
      await page.setViewportSize({width,height:850});
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Narrow pane has no horizontal overflow');
      const controls = await page.locator('.wham-toolbar button:visible, .more-menu > summary').evaluateAll(elements => elements.map(element => ({ y: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height })));
      assert.ok(controls.every(control => control.y === controls[0].y && control.height === controls[0].height), 'Toolbar controls share one row and height');
      const previewBounds = await preview.boundingBox();
      assert.equal(previewBounds.x, 0, 'Preview has no outer left inset');
      assert.equal(previewBounds.width, width, 'Preview uses the full pane width');
      const cardBounds = await preview.locator(':scope > .ant-card').boundingBox();
      const headerBounds = await page.locator('#wham-header').boundingBox();
      assert.equal(cardBounds.y, headerBounds.y + headerBounds.height, 'Preview starts directly below the toolbar');
      await page.getByRole('button',{name:'More actions',exact:true}).click();
      await page.waitForTimeout(50); const bounds=await page.getByRole('menu').boundingBox();
      assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
      assert.ok(await page.getByRole('menuitem',{name:'Discard output edits…',exact:true}).isVisible());
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({width:340,height:850});
    await page.screenshot({path:'work/screenshots/pinned-draft-narrow.png'});
    await page.evaluate(()=>document.body.classList.replace('vscode-dark','vscode-light'));
    await page.waitForTimeout(200);
    assert.notEqual(await page.locator('link[data-theme-stylesheet="light"]').getAttribute('media'),'not all');
    await page.screenshot({path:'work/screenshots/pinned-draft-light.png'});
    await page.getByRole('button',{name:'Back to all mods',exact:true}).click(); assert.deepEqual(navigations,['project']);
    assert.deepEqual(errors,[]);
    // Even a forged frontend settings-write message is rejected before any native call.
    await receive({action:'windhawk',command:'setModSettings',messageId:999,data:{modId:'wham-preview-test',settings:{amount:8}},epoch:messages.at(-1).epoch,session:messages.at(-1).session});
    assert.match(errors.at(-1),/read-only source preview/);
    details.dispose();
    mock.env.language='zh-cn';
    const localizedSource=source.replace('// @name WHAM Preview Test','// @name WHAM Preview Test\n// @name:zh-CN 离线预览').replace('$name: Enabled setting','$name: Enabled setting\n  $name:zh-CN: 开启');
    const localized=create(Uri.file(path.resolve('.')),webview,{...data,installation:{root:'',parser:false,cli:false},source:localizedSource,parsed:parseDraftSource(localizedSource,'src/mod.cpp','zh-cn')},{onAction:async()=>{}});
    await preview.getByText('离线预览',{exact:true}).waitFor();
    await preview.getByTestId('mod-details-tab-settings').click();
    await preview.getByText('开启',{exact:true}).waitFor();
    const languageReply=messages.filter(message=>message.command==='getInitialAppSettings').at(-1);
    assert.ok(languageReply);
    assert.ok(await preview.getByRole('switch').isDisabled());
    assert.ok(await preview.getByTestId('mod-details-tab-settings').textContent()!=='Settings','Pinned translation uses the selected locale');
    await page.screenshot({path:'work/screenshots/pinned-draft-chinese.png'});
    localized.dispose();
    mock.env.language='en';
    const modernSource=await fs.readFile('test/fixtures/modern-settings.wh.cpp','utf8');
    const modern=create(Uri.file(path.resolve('.')),webview,{...data,source:modernSource,parsed:parseDraftSource(modernSource,'fixture.cpp','en')},{onAction:async()=>{}});
    await preview.getByText('Modern settings fixture',{exact:true}).waitFor();
    await preview.getByTestId('mod-details-tab-settings').click();
    await preview.getByRole('spinbutton').first().waitFor();
    assert.ok(await preview.getByRole('spinbutton').first().getAttribute('readonly')!==null);
    assert.ok(await preview.locator('input[placeholder="0.75"]').isVisible(),'Offline float default reaches the pinned renderer');
    assert.ok(await preview.getByTestId('mod-settings-save').isHidden());
    await page.screenshot({path:'work/screenshots/pinned-draft-modern.png'});
    modern.dispose();
    console.log('Pinned Draft passed without Windhawk: async shell, actions, read-only settings, refresh, themes, narrow layouts and mutation rejection.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
