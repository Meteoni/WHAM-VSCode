const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadLocalPreferences, migrateComputerPreferences, readComputerPreferences } = require('../dist/preferences');

test('legacy choices migrate to one local installation and project language preferences', async () => {
  const globalData = {
    editorSettings: {
      one: { installationPath: 'C:/Windhawk', integration: 'clangd', indentSize: 2, indentStyle: 'tabs' }
    }
  };
  const workspaceData = {
    editorSettings: {
      one: { installationPath: 'C:/old', integration: 'cpp' },
      two: { installationPath: '', integration: 'cpp' }
    }
  };
  const writes = [];
  const storage = data => ({
    get: (key, fallback) => data[key] ?? fallback,
    update: async (key, value) => {
      writes.push(key);
      data[key] = value;
    }
  });
  const preferences = await loadLocalPreferences(storage(globalData), storage(workspaceData));
  assert.deepEqual(preferences.projects.one, { integration: 'clangd' });
  assert.deepEqual(preferences.projects.two, { integration: 'cpp' });
  assert.deepEqual(preferences.computer, { installationPath: 'C:/Windhawk', integration: 'cpp', installations: {} });
  assert.equal(preferences.projects.one.indentSize, undefined);
  preferences.computer.installationPath = 'C:/default';
  const reloaded = await loadLocalPreferences(storage(globalData), storage(workspaceData));
  assert.equal(reloaded.computer.installationPath, 'C:/default');
  assert.equal(reloaded.projects.one.installationPath, undefined);
  assert.deepEqual(writes, ['localPreferences'], 'Migration is written once to local user storage');
});

test('migration preserves an existing global installation and its elevation preferences', async () => {
  const computer = {
    installationPath: 'C:/global',
    integration: 'clangd',
    installations: { 'c:/global': { elevation: 'gsudo', gsudoPath: '' } }
  };
  const data = {
    localPreferences: { version: 1, computer, projects: { one: { installationPath: 'C:/old', integration: 'cpp' } } }
  };
  const global = {
    get: (key, fallback) => data[key] ?? fallback,
    update: async (key, value) => {
      data[key] = value;
    }
  };
  const preferences = await loadLocalPreferences(global, { get: (key, fallback) => fallback });
  assert.equal(preferences.version, 2);
  assert.deepEqual(preferences.computer, computer);
  assert.deepEqual(preferences.projects, { one: { integration: 'cpp' } });
  assert.equal(await loadLocalPreferences(global, {}), preferences, 'Migration is idempotent');
});

test('without a global installation migration adopts the most recent project choice', async () => {
  const data = {
    recentProjects: ['two'],
    localPreferences: {
      version: 1,
      computer: { installationPath: '', integration: 'cpp', installations: {} },
      projects: { one: { installationPath: 'C:/one' }, two: { installationPath: 'C:/two' } }
    }
  };
  const preferences = await loadLocalPreferences(
    { get: (key, fallback) => data[key] ?? fallback, update: async () => {} },
    { get: (key, fallback) => fallback }
  );
  assert.equal(preferences.computer.installationPath, 'C:/two');
  assert.deepEqual(preferences.projects, { one: {}, two: {} });
});

test('stored computer preferences move into settings once, without overriding or writing defaults', async () => {
  const data = {};
  const global = {
    get: key => data[key],
    update: async (key, value) => {
      data[key] = value;
    }
  };
  const preferences = {
    version: 2,
    computer: {
      installationPath: 'C:/Windhawk',
      integration: 'cpp',
      installations: { 'c:\\windhawk': { elevation: 'gsudo', gsudoPath: 'C:/tools/gsudo.exe' } }
    },
    projects: {}
  };
  const settings = { gsudoPath: 'C:/chosen/gsudo.exe' },
    writes = [];
  const access = {
    isSet: setting => settings[setting] !== undefined,
    set: async (setting, value) => {
      writes.push(setting);
      settings[setting] = value;
    }
  };
  await migrateComputerPreferences(global, preferences, access);
  // The selected installation's elevation carries over; a gsudo path already set wins.
  assert.deepEqual(settings, { windhawkPath: 'C:/Windhawk', elevation: 'gsudo', gsudoPath: 'C:/chosen/gsudo.exe' });
  assert.deepEqual(writes, ['windhawkPath', 'elevation'], 'The default language service is not written');
  // Later activations leave settings alone, even after the user clears one.
  delete settings.windhawkPath;
  await migrateComputerPreferences(global, preferences, access);
  assert.equal(settings.windhawkPath, undefined);
});

test('hand-edited computer settings of the wrong kind read as defaults', () => {
  const read = values => readComputerPreferences(setting => values[setting]);
  assert.deepEqual(read({}), { installationPath: '', elevation: 'none', gsudoPath: '', integration: 'cpp' });
  assert.deepEqual(
    read({ windhawkPath: '  C:/Windhawk ', elevation: 'runas', gsudoPath: 7, languageService: 'both' }),
    {
      installationPath: 'C:/Windhawk',
      elevation: 'none',
      gsudoPath: '',
      integration: 'both'
    }
  );
});
