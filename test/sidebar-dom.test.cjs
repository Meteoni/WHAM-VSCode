// The real sidebar markup and script in jsdom: state updates must not disturb what the user is doing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const media = path.join(__dirname, '..', 'media');
const root = 'C:\\Projects\\Mods';
const config = {
  formatVersion: 1,
  sourceDirectory: 'src',
  outputDirectory: 'output',
  entries: ['**/*.cpp'],
  exclude: [],
  includeDirectories: ['src'],
  externalIncludes: [],
  inlineAngleIncludes: false,
  generate: 'onSave',
  debounceMs: 250
};

const entry = (name, changes = {}) => ({
  path: `${root}\\src\\${name}.cpp`,
  label: `${name}.cpp`,
  status: 'current',
  message: '1 source file(s)',
  metadata: { fields: { name: [name.toUpperCase()], version: ['1.0'] }, diagnostics: [], lines: {} },
  runtime: { id: `local@${name}`, installed: true, enabled: false, changesPending: false, busy: false },
  output: `${root}\\output\\${name}.wh.cpp`,
  dependencies: 1,
  ...changes
});

const stateMessage = (entries, choices = [{ label: 'Mods', description: 'Recent project', detail: root, root }]) => ({
  type: 'state',
  selected: root,
  computer: { installationPath: '', integration: 'cpp', elevation: 'none', gsudoPath: '' },
  openAfterSetup: true,
  createInitialCommit: false,
  projectChoices: [...choices, { label: 'Browse for a project folder…', description: '', detail: '', root: '' }],
  projects: [
    {
      root,
      name: 'Mods',
      config,
      editor: { installationPath: '', integration: 'cpp', indentStyle: 'spaces', indentSize: 4 },
      editorNeedsApply: false,
      local: {},
      elevation: 'none',
      opened: true,
      retained: [],
      entries
    }
  ]
});

function sidebar() {
  const template = fs.readFileSync(path.join(media, 'sidebar.html'), 'utf8');
  const html = template.replace(/\{\{\w+\}\}/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const posted = [];
  dom.window.acquireVsCodeApi = () => ({
    postMessage: message => posted.push(message),
    getState: () => undefined,
    setState() {}
  });
  dom.window.eval(fs.readFileSync(path.join(media, 'sidebar.js'), 'utf8'));
  const document = dom.window.document;
  const post = data => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  const card = name =>
    [...document.querySelectorAll('#entries article')].find(article =>
      article.textContent.includes(name.toUpperCase())
    );
  return { dom, document, posted, post, card };
}

test('updates about other mods leave a card, its open menu and focus untouched', () => {
  const { document, post, card } = sidebar();
  post(stateMessage([entry('a'), entry('b')]));
  const a = card('a'),
    b = card('b');
  a.querySelector('.compile-menu').open = true;
  a.querySelector('[data-focus="compile"]').focus();
  post(stateMessage([entry('a'), entry('b', { status: 'stale', message: 'Saved sources changed.' })]));
  assert.equal(card('a'), a, 'Same DOM node');
  assert.equal(a.querySelector('.compile-menu').open, true);
  assert.equal(document.activeElement, a.querySelector('[data-focus="compile"]'));
  assert.notEqual(card('b'), b, 'The changed card is rebuilt');
  assert.match(card('b').textContent, /Saved sources changed\./);
});

test('a rebuilt card reopens its compile menu and refocuses the same control', () => {
  const { document, post, card } = sidebar();
  post(stateMessage([entry('a')]));
  const before = card('a');
  before.querySelector('.compile-menu').open = true;
  before.querySelector('[data-focus="generate"]').focus();
  post(stateMessage([entry('a', { status: 'stale', message: 'Saved sources changed.' })]));
  const after = card('a');
  assert.notEqual(after, before);
  assert.equal(after.querySelector('.badge').textContent, 'stale');
  assert.equal(after.querySelector('.compile-menu').open, true);
  assert.equal(document.activeElement, after.querySelector('[data-focus="generate"]'));
  assert.equal(before.isConnected, false, 'The old card is gone');
});

test('cards follow added, removed and reordered entries', () => {
  const { document, post, card } = sidebar();
  post(stateMessage([entry('a'), entry('b')]));
  const a = card('a');
  post(stateMessage([entry('c'), entry('a')]));
  const names = [...document.querySelectorAll('#entries article .link')].map(button => button.textContent);
  assert.deepEqual(names, ['C', 'A']);
  assert.equal(card('a'), a, 'An unchanged card is moved, not rebuilt');
  post(stateMessage([]));
  assert.match(document.getElementById('entries').textContent, /Add a \.cpp file under src/);
  assert.equal(document.querySelectorAll('#entries article').length, 0);
});

test('project choices are rebuilt only when they change', () => {
  const { document, post } = sidebar();
  post(stateMessage([entry('a')]));
  const option = document.querySelector('#project option');
  post(stateMessage([entry('a', { status: 'stale' })]));
  assert.equal(document.querySelector('#project option'), option);
  post(
    stateMessage(
      [entry('a')],
      [{ label: 'Other', description: 'Recent project', detail: 'C:\\Other', root: 'C:\\Other' }]
    )
  );
  assert.notEqual(document.querySelector('#project option'), option);
  assert.equal(document.querySelector('#project option').textContent, 'Other');
});

test('the mod page keeps its More menu open until its actions change', () => {
  const { document, post } = sidebar();
  post(stateMessage([entry('a'), entry('b')]));
  post({ type: 'detailsFallback', entry: entry('a').path });
  const more = () => document.querySelector('#mod-actions details.more-menu');
  const menu = more();
  menu.open = true;
  post(stateMessage([entry('a', { message: 'Regenerated.' }), entry('b', { status: 'stale' })]));
  assert.equal(more(), menu);
  assert.equal(menu.open, true);
  // Blocked output adds the Discard action, so the menu is rebuilt with it.
  post(stateMessage([entry('a', { status: 'blocked' }), entry('b')]));
  assert.notEqual(more(), menu);
  assert.ok([...more().querySelectorAll('button')].some(button => button.textContent === 'Discard output edits…'));
});

test('card controls still send their actions after updates', () => {
  const { posted, post, card } = sidebar();
  post(stateMessage([entry('a'), entry('b')]));
  post(stateMessage([entry('a'), entry('b', { status: 'stale' })]));
  card('a').querySelector('[data-focus="compile"]').click();
  card('b').querySelector('[data-focus="testCompile"]').click();
  assert.deepEqual(
    posted
      .filter(message => ['compile', 'testCompile'].includes(message.action))
      .map(message => [message.action, message.entry]),
    [
      ['compile', entry('a').path],
      ['testCompile', entry('b').path]
    ]
  );
});
