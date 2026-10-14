/* Project content is inserted as text, including metadata, Markdown and YAML. */
const vscode = acquireVsCodeApi();
const projectSelect = document.getElementById('project');
const form = document.getElementById('config');
const editorForm = document.getElementById('editor-config');
const computerForm = document.getElementById('computer-config');
const previousView = vscode.getState();
let state = { projects: [], projectChoices: [] }, currentRoot, configurationDirty = false, editorDirty = false, localDirty = false, computerDirty = false, computerInstallation;
let pageName = previousView?.page, settingsScope = previousView?.settingsScope || (previousView?.settings === 'extension' ? 'extension' : 'project');
let settingsPage = ['editor', 'generation', 'git'].includes(previousView?.settings) ? previousView.settings : 'editor', selectedEntry = previousView?.entry;
let settingUp = false, setupRoot;
const send = (action, extra = {}) => vscode.postMessage({ action, root: currentRoot, ...extra });
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.compile-menu[open]')) if (!menu.contains(event.target)) menu.open = false;
});

document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => send(button.dataset.action)));
document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => { pageName = button.dataset.page; render(); }));
document.querySelectorAll('[data-settings-scope]').forEach(button => button.addEventListener('click', () => { settingsScope = button.dataset.settingsScope; render(); }));
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
editorForm.addEventListener('input', event => {
  if (event.target.name === 'integration') localDirty = true;
  else editorDirty = true;
  document.getElementById('editor-status').textContent = localDirty ? 'Unsaved local preferences' : 'Unapplied editor settings';
  for (const button of editorForm.querySelectorAll('[type="submit"]')) button.disabled = localDirty;
});
editorForm.addEventListener('submit', event => {
  event.preventDefault();
  const settings = {};
  const project = state.projects.find(project => project.root === currentRoot);
  settings.installationPath = project.editor.installationPath; settings.integration = project.editor.integration;
  settings.indentStyle = editorForm.elements.namedItem('indentStyle').value;
  settings.indentSize = Number(editorForm.elements.namedItem('indentSize').value);
  send(event.submitter?.hasAttribute('data-editor-review') ? 'reviewEditor' : 'editor', { settings });
});
document.getElementById('save-project-preferences').addEventListener('click', () => send('projectPreferences', { settings: {
  integration: editorForm.elements.namedItem('integration').value
} }));
const readComputerForm = () => ({ installationPath: computerForm.elements.namedItem('installationPath').value.trim(),
  elevation: computerForm.elements.namedItem('elevation').value, gsudoPath: computerForm.elements.namedItem('gsudoPath').value.trim(),
  integration: computerForm.elements.namedItem('integration').value });
function fillInstallationPreferences() {
  const installation = computerForm.elements.namedItem('installationPath').value.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const computer = state.computer || { installationPath: '', installations: {} };
  const key = Object.keys(computer.installations).find(key => key.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase() === installation);
  const preference = computer.installations[key] || { elevation: 'none', gsudoPath: '' };
  computerForm.elements.namedItem('elevation').value = preference.elevation; computerForm.elements.namedItem('gsudoPath').value = preference.gsudoPath;
}
computerForm.addEventListener('input', event => { computerDirty = true; document.getElementById('computer-status').textContent = 'Unsaved computer preferences'; if (event.target.name === 'elevation') render(); });
computerForm.elements.namedItem('installationPath').addEventListener('change', () => { fillInstallationPreferences(); render(); });
computerForm.addEventListener('submit', event => { event.preventDefault(); send('computerPreferences', { settings: readComputerForm() }); });
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
  if (!pageName || !project && !['settings', 'setup'].includes(pageName)) pageName = project ? 'project' : 'setup';
  if (!project && pageName === 'settings') settingsScope = 'extension';
  const selectedMod = project?.entries.find(entry => entry.path === selectedEntry);
  if (pageName === 'mod' && !selectedMod) pageName = 'project';
  for (const name of ['setup', 'project', 'settings', 'mod']) document.getElementById('page-' + name).hidden = name !== pageName;
  document.querySelectorAll('nav[aria-label="Main navigation"] button').forEach(button => {
    button.disabled = !project && button.dataset.page === 'project';
    button.setAttribute('aria-current', button.dataset.page === (pageName === 'mod' ? 'project' : pageName) ? 'page' : 'false');
  });
  document.querySelectorAll('[data-settings-scope]').forEach(button => { button.disabled = !project && button.dataset.settingsScope === 'project'; button.setAttribute('aria-current', button.dataset.settingsScope === settingsScope ? 'page' : 'false'); });
  document.getElementById('project-settings-navigation').hidden = settingsScope !== 'project';
  document.getElementById('settings-project').textContent = project ? `These settings apply to ${project.name}.` : '';
  document.getElementById('settings-project').hidden = settingsScope !== 'project' || !project;
  document.querySelectorAll('[data-settings]').forEach(button => { button.disabled = !project; button.setAttribute('aria-current', button.dataset.settings === settingsPage ? 'page' : 'false'); });
  form.hidden = settingsScope !== 'project' || settingsPage !== 'generation'; editorForm.hidden = settingsScope !== 'project' || settingsPage !== 'editor' || !project;
  computerForm.hidden = settingsScope !== 'extension';
  if (!computerDirty) {
    computerForm.elements.namedItem('installationPath').value = computerInstallation ?? state.computer?.installationPath ?? '';
    computerForm.elements.namedItem('integration').value = state.computer?.integration ?? 'cpp';
    fillInstallationPreferences();
  }
  const method = computerForm.elements.namedItem('elevation').value;
  document.getElementById('gsudo-path').hidden = method !== 'gsudo';
  document.getElementById('git-settings').hidden = settingsScope !== 'project' || settingsPage !== 'git';
  vscode.setState({ page: pageName, settingsScope, settings: settingsPage, entry: selectedEntry });
  document.getElementById('root').textContent = project?.root || '';
  document.getElementById('error').textContent = project?.error || '';
  document.getElementById('notice').textContent = project?.retained.join('\n') || '';
  document.getElementById('folder-status').textContent = project?.opened ? '' : 'Open this project folder to activate its editor configuration.';
  const gitText = project?.git ? `Git · ${project.git.branch} · ${project.git.changes} changed file(s)` : 'Git is not initialized or unavailable.';
  document.getElementById('git-status').textContent = gitText; document.getElementById('settings-git-status').textContent = gitText;
  document.getElementById('count').textContent = String(project?.entries.length || 0);
  document.querySelector('[data-action="generateAll"]').disabled = !project?.entries.length || !!project?.error;
  const modActions = {
    generate: ['Generate', 'Generate a standalone .wh.cpp from saved source files.'],
    open: ['Source', 'Open this mod’s entry source file.'],
    output: ['Output', 'Open the generated .wh.cpp file.'],
    compare: ['Compare', 'Compare existing output with what saved source would generate.'],
    restore: ['Recover…', 'Recover source files and output edits. Choose a destination and review before writing.'],
    verify: ['Verify', 'Check generated output using its compiler options and declared architectures. View results in the log.'],
    discard: ['Discard output edits…', 'Discard saved output edits and regenerate from saved source files after confirmation.']
  };
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
    name.title = 'View mod details'; name.addEventListener('click', () => {
      send('details', { entry: entry.path });
    });
    const badge = document.createElement('span'); badge.className = 'badge ' + entry.status; badge.textContent = entry.status;
    badge.title = ({ current: 'Generated output matches the current saved source.', stale: 'Generated output needs regeneration.',
      pending: 'Source has unsaved changes or generation is waiting.', generating: 'Generating output.',
      blocked: 'Output has edits that WHAM will preserve.' })[entry.status] || entry.message || entry.status;
    const badges = document.createElement('div'); badges.className = 'entry-badges';
    if (entry.runtime?.changesPending) {
      const pending = document.createElement('span'); pending.className = 'build-indicator warning compile-needed';
      pending.setAttribute('role', 'img'); pending.setAttribute('aria-label', 'Needs compilation');
      pending.textContent = '\ueb6d'; // Codicon tools
      pending.title = entry.runtime?.installed ? 'Source changes need compilation.' : 'This mod has no installed build. Compile it first.'; badges.append(pending);
    }
    if (entry.runtime?.installed && entry.runtime?.compileStatus === 'unknown') {
      const unknown = document.createElement('span'); unknown.className = 'build-indicator muted'; unknown.textContent = '\ueb32'; // Codicon question
      unknown.setAttribute('role', 'img'); unknown.setAttribute('aria-label', 'Build unknown');
      unknown.title = 'WHAM cannot confirm which source produced this build.'; badges.append(unknown);
    }
    badges.append(badge); top.append(name, badges); card.append(top);
    const filename = document.createElement('p'); filename.className = 'muted'; filename.textContent = entry.label + (fields.version?.[0] ? ` · v${fields.version[0]}` : ''); card.append(filename);
    const sourceInfo = document.createElement('div'); sourceInfo.className = 'entry-source-info';
    const sourceCount = document.createElement('p'); sourceCount.textContent = `${entry.dependencies || 0} source file(s)`; sourceInfo.append(sourceCount);
    const compile = document.createElement('button'); compile.className = 'primary'; compile.textContent = 'Compile'; compile.disabled = !!entry.runtime?.busy;
    const building = ['compile', 'test', 'verify'].includes(entry.runtime?.operation);
    if (building) {
      const spinner = document.createElement('span'); spinner.className = 'compile-spinner'; spinner.setAttribute('aria-hidden', 'true');
      compile.replaceChildren(spinner, document.createTextNode(entry.runtime?.stopping ? 'Stopping…' : entry.runtime?.operation === 'test' ? 'Test build' : entry.runtime?.operation === 'verify' ? 'Verify' : 'Compile')); compile.setAttribute('aria-busy', 'true');
    }
    compile.title = 'Generate, compile, and install saved source. Preserve Enabled; the first build starts disabled.';
    compile.addEventListener('click', () => send('compile', { entry: entry.path }));
    const split = document.createElement('div'); split.className = 'compile-split'; split.append(compile);
    const menu = document.createElement('details'); menu.className = 'more-menu compile-menu';
    const expander = document.createElement('summary'); expander.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 6 4 4 4-4"/></svg>';
    expander.setAttribute('role', 'button'); expander.setAttribute('aria-label', 'Compile options for ' + (fields.name?.[0] || entry.label)); expander.setAttribute('aria-haspopup', 'menu'); expander.setAttribute('aria-expanded', 'false'); expander.title = 'Compile options';
    const choices = document.createElement('div'); choices.className = 'more-actions'; choices.setAttribute('role', 'menu');
    for (const [action, label, tooltip] of [
      ['testCompile', 'Test build', 'Compile and link saved source into temporary DLLs without installing or enabling the mod.'],
      ['verify', 'Verify syntax', 'Check generated output for each declared architecture using its compiler options.'],
      ['stopCompile', 'Stop compilation', 'Cancel the current build or verification.']
    ]) {
      const button = document.createElement('button'); button.textContent = label; button.title = tooltip; button.setAttribute('role', 'menuitem');
      button.hidden = action === 'stopCompile' && !building;
      button.disabled = action === 'stopCompile' ? !!entry.runtime?.stopping : !!entry.runtime?.busy;
      button.addEventListener('click', () => { menu.open = false; send(action, { entry: entry.path }); }); choices.append(button);
    }
    menu.append(expander, choices); split.append(menu);
    menu.addEventListener('toggle', () => {
      expander.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) {
        const bounds = expander.getBoundingClientRect();
        choices.style.left = Math.max(4, Math.min(bounds.right - choices.offsetWidth, innerWidth - choices.offsetWidth - 4)) + 'px';
        choices.style.top = Math.max(4, Math.min(bounds.bottom + 4, innerHeight - choices.offsetHeight - 4)) + 'px';
      }
    });
    menu.addEventListener('keydown', event => { if (event.key === 'Escape') { menu.open = false; expander.focus(); } });
    const toggle = document.createElement('label'); toggle.className = 'runtime-toggle';
    const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.setAttribute('role', 'switch'); enabled.setAttribute('aria-label', 'Enable installed ' + (fields.name?.[0] || entry.label));
    enabled.checked = entry.runtime?.enabled === true; enabled.disabled = !entry.runtime?.installed || !!entry.runtime?.busy;
    toggle.title = entry.runtime?.installed ? 'Enable or disable the installed build. Draft edits need compilation first.' : 'Compile this mod before enabling it.';
    enabled.addEventListener('change', () => { send('enable', { entry: entry.path, enabled: enabled.checked }); enabled.checked = entry.runtime?.enabled === true; });
    toggle.append(document.createTextNode(entry.runtime?.operation === 'enable' ? 'Enabling…' : entry.runtime?.operation === 'disable' ? 'Disabling…' : entry.runtime?.enabled ? 'Enabled' : 'Disabled'), enabled); sourceInfo.append(toggle); card.append(sourceInfo);

    if (entry.runtime?.error) { const error = document.createElement('p'); error.className = 'warning'; error.textContent = entry.runtime.error; card.append(error); }
    if (entry.message && !/^\d+ source file\(s\)$/.test(entry.message)) { const message = document.createElement('p'); message.textContent = entry.message; card.append(message); }
    if (entry.metadata?.diagnostics.length) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = `${entry.metadata.diagnostics.length} metadata warning(s) · View details`; card.append(warning); }
    const buttons = document.createElement('div'); buttons.className = 'toolbar entry-actions';
    for (const action of ['generate', 'open']) {
      const [label, tooltip] = modActions[action];
      const button = document.createElement('button'); button.textContent = label; button.title = tooltip;
      button.setAttribute('aria-description', tooltip);
      button.addEventListener('click', () => send(action, { entry: entry.path })); buttons.append(button);
    }
    buttons.append(split); card.append(buttons);
    entries.append(card);
  }
  if (selectedMod) {
    const metadata = selectedMod.metadata, fields = metadata?.fields || {};
    document.getElementById('mod-name').textContent = fields['name:' + navigator.language]?.[0] || fields.name?.[0] || selectedMod.label;
    document.getElementById('mod-file').textContent = selectedMod.label;
    const actions = document.getElementById('mod-actions'); actions.replaceChildren();
    const more = document.createElement('details'); more.className = 'more-menu';
    const summary = document.createElement('summary'); summary.textContent = '...'; summary.title = 'More actions'; summary.setAttribute('aria-label', 'More actions'); summary.setAttribute('role', 'button'); summary.setAttribute('aria-haspopup', 'menu'); more.append(summary);
    for (const [index, group] of [['generate', 'open', 'output'], ['compare', 'restore', 'verify', ...(selectedMod.status === 'blocked' ? ['discard'] : [])]].entries()) {
      const buttons = document.createElement('div'); buttons.className = index === 0 ? 'toolbar' : 'more-actions';
      buttons.setAttribute('role', index === 0 ? 'group' : 'menu'); buttons.setAttribute('aria-label', index === 0 ? 'Mod actions' : 'Output actions');
      for (const action of group) {
        const [label, tooltip] = modActions[action];
        const button = document.createElement('button'); button.textContent = label; button.title = tooltip;
        button.setAttribute('aria-description', tooltip); button.className = action === 'generate' ? 'primary' : action === 'discard' ? 'danger' : '';
        if (index === 1) button.setAttribute('role', 'menuitem');
        button.addEventListener('click', () => { more.open = false; send(action, { entry: selectedMod.path }); }); buttons.append(button);
      }
      if (index === 0) actions.append(buttons); else more.append(buttons);
    }
    actions.append(more);
    more.addEventListener('toggle', () => {
      if (more.open) {
        const menu = more.querySelector('[role="menu"]'), bounds = summary.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(bounds.left, innerWidth - menu.offsetWidth - 4)) + 'px';
        menu.style.top = Math.max(4, Math.min(bounds.bottom + 4, innerHeight - menu.offsetHeight - 4)) + 'px';
      }
    });
    more.addEventListener('keydown', event => { if (event.key === 'Escape') { more.open = false; summary.focus(); } });
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
    if (['installationPath', 'integration'].includes(key)) continue;
    const input = editorForm.elements.namedItem(key); if (input) input.value = value;
  }
  if (project?.editor && !localDirty) {
    editorForm.elements.namedItem('integration').value = project.local?.integration ?? 'default';
  }
  for (const button of editorForm.querySelectorAll('[type="submit"]')) button.disabled = localDirty;
}
window.addEventListener('message', event => {
  if (event.data.type === 'state') {
    const firstState = !state.type;
    const previousRoot = currentRoot;
    state = event.data; currentRoot = state.selected;
    if (previousRoot !== currentRoot) {
      configurationDirty = false; editorDirty = false; localDirty = false; selectedEntry = undefined;
      document.getElementById('settings-status').textContent = ''; document.getElementById('editor-status').textContent = '';
    }
    if (firstState) pageName = previousView?.page || (currentRoot ? 'project' : 'setup');
    if (event.data.page) pageName = event.data.page;
    if (firstState) {
      document.getElementById('open-after-setup').checked = state.openAfterSetup !== false;
      document.getElementById('initial-commit').checked = state.createInitialCommit === true;
    }
    if (settingUp && currentRoot && currentRoot !== setupRoot) { settingUp = false; pageName = 'project'; configurationDirty = false; editorDirty = false; }
    render();
  }
  if (event.data.type === 'detailsFallback') { selectedEntry = event.data.entry; pageName = 'mod'; render(); }
  if (event.data.type === 'error') { document.getElementById('error').textContent = event.data.message; document.getElementById('setup-status').textContent = ''; settingUp = false; }
  if (event.data.type === 'setupFinished') {
    settingUp = false; document.getElementById('setup-status').textContent = '';
    if (event.data.completed && currentRoot) { pageName = 'project'; configurationDirty = false; editorDirty = false; render(); }
  }
  if (event.data.type === 'saved') { configurationDirty = false; document.getElementById('settings-status').textContent = 'Configuration saved'; render(); }
  if (event.data.type === 'editorSaved') { editorDirty = false; document.getElementById('editor-status').textContent = 'Editor settings applied'; render(); }
  if (event.data.type === 'projectPreferencesSaved') { localDirty = false; document.getElementById('editor-status').textContent = 'Local preferences saved. Project files unchanged.'; render(); }
  if (event.data.type === 'computerSaved') { computerInstallation = computerForm.elements.namedItem('installationPath').value; computerDirty = false; document.getElementById('computer-status').textContent = 'Preferences saved.'; render(); }
  if (event.data.type === 'computerInstallation') { computerForm.elements.namedItem('installationPath').value = event.data.value; computerInstallation = event.data.value; fillInstallationPreferences(); computerDirty = true; render(); }
  if (event.data.type === 'gsudoPath') { computerForm.elements.namedItem('gsudoPath').value = event.data.value; document.getElementById('gsudo-path').open = true; computerDirty = true; }
});
if (window.whamSidebarState) window.dispatchEvent(new MessageEvent('message', { data: window.whamSidebarState }));
else render();
send('ready');
