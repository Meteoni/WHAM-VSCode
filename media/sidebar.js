/* Project content is inserted as text, including metadata, Markdown and YAML. */
const vscode = acquireVsCodeApi();
const projectSelect = document.getElementById('project');
const form = document.getElementById('config');
const editorForm = document.getElementById('editor-config');
const previousView = vscode.getState();
let state = { projects: [], projectChoices: [] }, currentRoot, configurationDirty = false, editorDirty = false;
let pageName = previousView?.page, settingsPage = previousView?.settings || 'editor', selectedEntry = previousView?.entry;
let settingUp = false, setupRoot;
const send = (action, extra = {}) => vscode.postMessage({ action, root: currentRoot, ...extra });

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => send(button.dataset.action)));
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { pageName = button.dataset.page; render(); }));
document.querySelectorAll('[data-settings]').forEach(button => button.addEventListener('click', () => { settingsPage = button.dataset.settings; render(); }));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  settingUp = true; setupRoot = currentRoot;
  document.getElementById('setup-status').textContent = 'Continue setup in the VS Code prompts.';
  send('initialize', { mode: button.dataset.mode, openProject: document.getElementById('open-after-setup').checked, initialCommit: document.getElementById('initial-commit').checked });
}));
projectSelect.addEventListener('change', () => {
  const projectRoot = projectSelect.value;
  send('openProject', projectRoot ? { projectRoot } : { browse: true });
  // Keep the active selection if browsing is cancelled or opening fails.
  projectSelect.value = currentRoot || '';
});
editorForm.addEventListener('input', () => { editorDirty = true; document.getElementById('editor-status').textContent = 'Unapplied editor settings'; });
editorForm.addEventListener('submit', event => {
  event.preventDefault();
  const settings = {};
  for (const key of ['installationPath', 'integration', 'indentStyle']) settings[key] = editorForm.elements.namedItem(key).value.trim();
  settings.indentSize = Number(editorForm.elements.namedItem('indentSize').value);
  send('editor', { settings });
});
form.addEventListener('input', () => { configurationDirty = true; document.getElementById('settings-status').textContent = 'Unsaved settings'; });
form.addEventListener('submit', event => {
  event.preventDefault();
  const config = { formatVersion: 1 };
  for (const name of ['sourceDirectory', 'outputDirectory', 'generate']) config[name] = form.elements.namedItem(name).value.trim();
  for (const name of ['entries', 'exclude', 'includeDirectories', 'externalIncludes']) config[name] = form.elements.namedItem(name).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  config.debounceMs = Number(form.elements.namedItem('debounceMs').value);
  config.inlineAngleIncludes = form.elements.namedItem('inlineAngleIncludes').checked;
  send('config', { config });
});
for (const [id, section] of [['edit-metadata', 'metadata'], ['edit-readme', 'readme'], ['edit-mod-settings', 'settings']]) {
  document.getElementById(id).addEventListener('click', () => {
    const entry = state.projects.find(project => project.root === currentRoot)?.entries.find(entry => entry.path === selectedEntry);
    if (entry) send('open', { entry: entry.path, line: entry.metadata?.lines[section] ?? 0 });
  });
}

function render() {
  projectSelect.replaceChildren();
  for (const choice of state.projectChoices) {
    const option = document.createElement('option'); option.value = choice.root; option.title = choice.detail;
    const duplicateName = choice.root && state.projectChoices.filter(other => other.label === choice.label).length > 1;
    option.textContent = duplicateName ? `${choice.label} — ${choice.detail}` : choice.label;
    projectSelect.append(option);
  }
  const project = state.projects.find(project => project.root === currentRoot) || state.projects[0];
  currentRoot = project?.root; projectSelect.value = currentRoot || '';
  if (!pageName || !project) pageName = project ? 'project' : 'setup';
  const selectedMod = project?.entries.find(entry => entry.path === selectedEntry);
  if (pageName === 'mod' && !selectedMod) pageName = 'project';
  for (const name of ['setup', 'project', 'settings', 'mod']) document.getElementById('page-' + name).hidden = name !== pageName;
  document.querySelectorAll('nav[aria-label="Main navigation"] button').forEach(button => {
    button.disabled = !project && button.dataset.page !== 'setup';
    button.setAttribute('aria-current', button.dataset.page === (pageName === 'mod' ? 'project' : pageName) ? 'page' : 'false');
  });
  document.querySelectorAll('[data-settings]').forEach(button => button.setAttribute('aria-current', button.dataset.settings === settingsPage ? 'page' : 'false'));
  form.hidden = settingsPage !== 'generation'; editorForm.hidden = settingsPage !== 'editor';
  document.getElementById('git-settings').hidden = settingsPage !== 'git';
  vscode.setState({ page: pageName, settings: settingsPage, entry: selectedEntry });
  document.getElementById('root').textContent = project?.root || '';
  document.getElementById('settings-project').textContent = project?.name || '';
  document.getElementById('error').textContent = project?.error || '';
  document.getElementById('notice').textContent = project?.retained.join('\n') || '';
  document.getElementById('folder-status').textContent = project?.opened ? '' : 'Open this project folder to activate its editor configuration.';
  const gitText = project?.git ? `Git · ${project.git.branch} · ${project.git.changes} changed file(s)` : 'Git is not initialized or unavailable.';
  document.getElementById('git-status').textContent = gitText; document.getElementById('settings-git-status').textContent = gitText;
  document.getElementById('count').textContent = String(project?.entries.length || 0);
  document.querySelector('[data-action="generateAll"]').disabled = !project?.entries.length || !!project?.error;
  const entries = document.getElementById('entries'); entries.replaceChildren();
  if (project && !project.entries.length) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = `Add a .cpp file under ${project.config.sourceDirectory}. Each matching file is an independent mod.`; entries.append(empty);
  }
  for (const entry of project?.entries || []) {
    const card = document.createElement('article'); card.className = 'entry';
    const top = document.createElement('div'); top.className = 'entry-heading';
    const fields = entry.metadata?.fields || {};
    const name = document.createElement('button'); name.className = 'link';
    name.textContent = fields['name:' + navigator.language]?.[0] || fields.name?.[0] || entry.label;
    name.title = 'View mod details'; name.addEventListener('click', () => { selectedEntry = entry.path; pageName = 'mod'; render(); });
    const badge = document.createElement('span'); badge.className = 'badge ' + entry.status; badge.textContent = entry.status;
    top.append(name, badge); card.append(top);
    const filename = document.createElement('p'); filename.className = 'muted'; filename.textContent = entry.label + (fields.version?.[0] ? ` · v${fields.version[0]}` : ''); card.append(filename);
    if (entry.message) { const message = document.createElement('p'); message.textContent = entry.message; card.append(message); }
    if (entry.metadata?.diagnostics.length) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = `${entry.metadata.diagnostics.length} metadata warning(s) · View details`; card.append(warning); }
    const buttons = document.createElement('div'); buttons.className = 'toolbar';
    for (const [label, action] of [['Generate', 'generate'], ['Source', 'open'], ...(entry.status === 'blocked' ? [['Compare', 'compare'], ['Restore', 'restore']] : [])]) {
      const button = document.createElement('button'); button.textContent = label; button.addEventListener('click', () => send(action, { entry: entry.path })); buttons.append(button);
    }
    card.append(buttons); entries.append(card);
  }
  if (selectedMod) {
    const metadata = selectedMod.metadata, fields = metadata?.fields || {};
    document.getElementById('mod-name').textContent = fields['name:' + navigator.language]?.[0] || fields.name?.[0] || selectedMod.label;
    document.getElementById('mod-file').textContent = selectedMod.label;
    const actions = document.getElementById('mod-actions'); actions.replaceChildren();
    for (const [label, action] of [['Generate', 'generate'], ['Source', 'open'], ['Output', 'output'], ['Compare', 'compare'], ['Restore', 'restore'], ['Verify', 'verify'], ...(selectedMod.status === 'blocked' ? [['Discard output edits…', 'discard']] : [])]) {
      const button = document.createElement('button'); button.textContent = label; button.className = action === 'discard' ? 'danger' : '';
      button.addEventListener('click', () => send(action, { entry: selectedMod.path })); actions.append(button);
    }
    const details = document.getElementById('metadata-fields'); details.replaceChildren();
    for (const [key, values] of Object.entries(fields)) {
      const label = document.createElement('dt'); label.textContent = '@' + key;
      const value = document.createElement('dd'); value.textContent = values.join('\n'); details.append(label, value);
    }
    document.getElementById('metadata-issues').textContent = metadata?.diagnostics.map(item => `Line ${item.line + 1}: ${item.message}`).join('\n') || '';
    document.getElementById('readme-section').hidden = metadata?.readme === undefined;
    document.getElementById('readme').textContent = metadata?.readme || '';
    document.getElementById('mod-settings-section').hidden = metadata?.settingsText === undefined;
    document.getElementById('mod-settings').textContent = metadata?.settingsText || '';
    document.getElementById('mod-settings-title').textContent = 'Mod settings' + (metadata?.settingsCount !== undefined ? ` · ${metadata.settingsCount} top-level setting(s)` : '');
  }
  if (project && !configurationDirty) for (const [name, value] of Object.entries(project.config)) {
    const input = form.elements.namedItem(name); if (!input) continue;
    if (typeof value === 'boolean') input.checked = value;
    else input.value = Array.isArray(value) ? value.join('\n') : value;
  }
  if (project?.editor && !editorDirty) for (const [key, value] of Object.entries(project.editor)) {
    const input = editorForm.elements.namedItem(key); if (input) input.value = value;
  }
}
window.addEventListener('message', event => {
  if (event.data.type === 'state') {
    const firstState = !state.type;
    const previousRoot = currentRoot;
    state = event.data; currentRoot = state.selected;
    if (previousRoot !== currentRoot) {
      configurationDirty = false; editorDirty = false; selectedEntry = undefined;
      document.getElementById('settings-status').textContent = ''; document.getElementById('editor-status').textContent = '';
    }
    if (firstState) pageName = previousView?.page || (currentRoot ? 'project' : 'setup');
    if (firstState) {
      document.getElementById('open-after-setup').checked = state.openAfterSetup !== false;
      document.getElementById('initial-commit').checked = state.createInitialCommit === true;
    }
    if (settingUp && currentRoot && currentRoot !== setupRoot) { settingUp = false; pageName = 'project'; configurationDirty = false; editorDirty = false; }
    render();
  }
  if (event.data.type === 'error') { document.getElementById('error').textContent = event.data.message; document.getElementById('setup-status').textContent = ''; settingUp = false; }
  if (event.data.type === 'setupFinished') {
    settingUp = false; document.getElementById('setup-status').textContent = '';
    if (event.data.completed && currentRoot) { pageName = 'project'; configurationDirty = false; editorDirty = false; render(); }
  }
  if (event.data.type === 'saved') { configurationDirty = false; document.getElementById('settings-status').textContent = 'Configuration saved'; render(); }
  if (event.data.type === 'editorSaved') { editorDirty = false; document.getElementById('editor-status').textContent = 'Editor settings applied'; render(); }
  if (event.data.type === 'installation') { editorForm.elements.namedItem('installationPath').value = event.data.value; editorDirty = true; document.getElementById('editor-status').textContent = 'Unapplied editor settings'; }
});
render(); send('ready');
