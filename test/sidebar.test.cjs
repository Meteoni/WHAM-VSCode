const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSidebarMessage, createSidebarRouter, sidebarActions } = require('../dist/sidebar');

const computer = { installationPath: 'C:\\Windhawk', gsudoPath: '', elevation: 'none', integration: 'cpp' };

test('sidebar messages are validated and scoped', () => {
  // Not sidebar traffic: no action, or the details view's own messages.
  for (const raw of [undefined, null, 'ready', {}, { action: 7 }, { action: 'ready', details: true }])
    assert.equal(parseSidebarMessage(raw), undefined);
  assert.deepEqual(parseSidebarMessage({ action: 'openProject', projectRoot: 3, browse: 'yes' }), {
    scope: 'global',
    action: 'openProject',
    projectRoot: undefined,
    browse: false
  });
  // `restore` without an entry recovers chosen files; with one it recovers that mod's output.
  assert.equal(parseSidebarMessage({ action: 'restore', root: 'r' }).scope, 'global');
  assert.equal(parseSidebarMessage({ action: 'restore', root: 'r', entry: 'e' }).scope, 'entry');
  assert.equal(parseSidebarMessage({ action: 'enable', root: 'r', entry: 'e', enabled: 'on' }), undefined);
  assert.equal(parseSidebarMessage({ action: 'open', root: 'r', entry: 'e', line: '4' }).line, undefined);
  assert.equal(parseSidebarMessage({ action: 'computerPreferences', settings: computer }).settings, computer);
  for (const settings of [undefined, { ...computer, elevation: 'admin' }, { ...computer, integration: 'vim' }])
    assert.throws(() => parseSidebarMessage({ action: 'checkElevation', settings }), /Invalid computer preferences/);
  assert.throws(
    () => parseSidebarMessage({ action: 'projectPreferences', root: 'r', settings: {} }),
    /Invalid local project preferences/
  );
  // A missing or null language service keeps the saved preference.
  assert.equal(
    parseSidebarMessage({ action: 'editor', root: 'r', settings: { integration: null } }).integration,
    undefined
  );
  assert.throws(
    () => parseSidebarMessage({ action: 'reviewEditor', root: 'r', settings: { integration: 'vim' } }),
    /valid C\+\+ language service/
  );
  assert.throws(() => parseSidebarMessage({ action: 'selfDestruct' }), /Unknown sidebar action: selfDestruct/);
});

test('sidebar router selects the project before project and entry handlers', async () => {
  const calls = [];
  const project = { name: 'p', entries: new Map([['e', { name: 'e' }]]) };
  const record =
    label =>
    async (...args) =>
      calls.push([label, ...args.map(arg => arg.name ?? arg.action)]);
  const handlers = scope => Object.fromEntries(sidebarActions.map(action => [action, record(`${scope}:${action}`)]));
  const route = createSidebarRouter({
    findProject: root => (root === 'p' ? project : undefined),
    findEntry: (owner, entry) => owner.entries.get(entry),
    selectProject: owner => calls.push(['select', owner.name]),
    global: handlers('global'),
    project: handlers('project'),
    entry: handlers('entry')
  });
  await route({ action: 'ready' });
  await route({ action: 'generateAll', root: 'p' });
  await route({ action: 'compile', root: 'p', entry: 'e' });
  assert.deepEqual(calls, [
    ['global:ready', 'ready'],
    ['select', 'p'],
    ['project:generateAll', 'p', 'generateAll'],
    ['select', 'p'],
    ['entry:compile', 'p', 'e', 'compile']
  ]);
  await assert.rejects(route({ action: 'generateAll', root: 'missing' }), /Select a project first/);
  await assert.rejects(route({ action: 'compile', root: 'p', entry: 'missing' }), /Select a valid mod entry/);
  // As before the router existed, a known project is selected even when its entry is missing.
  assert.deepEqual(calls.at(-1), ['select', 'p']);
  await route({ action: 'compile', root: 'p', entry: 'e', details: true });
  assert.equal(calls.length, 6, 'Details-view messages and failed lookups reach no handler');
});

test('every action the sidebar webview sends is accepted, and the reverse', () => {
  const script = fs.readFileSync(path.join(__dirname, '../media/sidebar.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../media/sidebar.html'), 'utf8');
  const sent = new Set();
  const collect = (text, pattern) => {
    for (const match of text.matchAll(pattern)) for (const name of match.slice(1)) if (name) sent.add(name);
  };
  collect(script, /send\(\s*'(\w+)'/g); // send('action', ...)
  collect(script, /send\([^\n]*?\?\s*'(\w+)'\s*:\s*'(\w+)'/g); // send(condition ? 'a' : 'b', ...)
  collect(html, /data-action="(\w+)"/g); // buttons dispatched by data-action
  const modActions = /const modActions = \{([\s\S]*?)\n\s*\};/.exec(script)[1];
  collect(modActions, /^\s*(\w+): \[/gm); // per-mod action buttons
  const compileMenu = /for \(const \[action, label, tooltip\] of \[([\s\S]*?)\]\)/.exec(script)[1];
  collect(compileMenu, /\[\s*'(\w+)',/g); // compile-menu entries
  for (const action of sent) assert.ok(sidebarActions.includes(action), `sidebar.js sends unhandled action ${action}`);
  // Handled for tests and older webview states, but not sent by the current sidebar UI.
  const notSentByUi = ['checkElevation', 'projectPreferences', 'select'];
  for (const action of sidebarActions)
    assert.ok(sent.has(action) || notSentByUi.includes(action), `No sidebar UI sends ${action}`);
});
