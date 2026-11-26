/* Project content is inserted as text, including metadata, Markdown and YAML. */
const vscode = acquireVsCodeApi();
const projectSelect = document.getElementById('project');
const form = document.getElementById('config');
const editorForm = document.getElementById('editor-config');
const computerForm = document.getElementById('computer-config');
const previousView = vscode.getState();
let state = { projects: [], projectChoices: [] },
  currentRoot,
  configurationDirty = false,
  configurationSaving = false,
  editorDirty = false,
  editorApplying = false,
  editorReviewing = false,
  editorFailed = false,
  computerDirty = false,
  computerSaving = false;
let pageName = previousView?.page,
  settingsScope = previousView?.settingsScope || (previousView?.settings === 'extension' ? 'extension' : 'project');
let settingsPage = ['editor', 'generation', 'git'].includes(previousView?.settings) ? previousView.settings : 'editor',
  selectedEntry = previousView?.entry;
let settingUp = false,
  setupRoot;
const send = (action, extra = {}) => vscode.postMessage({ action, root: currentRoot, ...extra });
document.addEventListener('click', event => {
  for (const menu of document.querySelectorAll('.compile-menu[open]'))
    if (!menu.contains(event.target)) menu.open = false;
});

document
  .querySelectorAll('[data-action]')
  .forEach(button => button.addEventListener('click', () => send(button.dataset.action)));
document.querySelectorAll('[data-page]').forEach(button =>
  button.addEventListener('click', () => {
    pageName = button.dataset.page;
    render();
  })
);
document.querySelectorAll('[data-settings-scope]').forEach(button =>
  button.addEventListener('click', () => {
    settingsScope = button.dataset.settingsScope;
    render();
  })
);
document.querySelectorAll('[data-settings]').forEach(button =>
  button.addEventListener('click', () => {
    settingsPage = button.dataset.settings;
    render();
  })
);
document.querySelectorAll('[data-mode]').forEach(button =>
  button.addEventListener('click', () => {
    settingUp = true;
    setupRoot = currentRoot;
    document.getElementById('setup-status').textContent = 'Continue setup in the VS Code prompts.';
    send('initialize', {
      mode: button.dataset.mode,
      openProject: document.getElementById('open-after-setup').checked,
      initialCommit: document.getElementById('initial-commit').checked
    });
  })
);
projectSelect.addEventListener('change', () => {
  const projectRoot = projectSelect.value;
  send('openProject', projectRoot ? { projectRoot } : { browse: true });
  // Keep the active selection if browsing is cancelled or opening fails.
  projectSelect.value = currentRoot || '';
});
function updateEditorActions() {
  const project = state.projects.find(project => project.root === currentRoot);
  editorDirty =
    !!project &&
    (editorForm.elements.namedItem('integration').value !== project.editor.integration ||
      editorForm.elements.namedItem('indentStyle').value !== project.editor.indentStyle ||
      Number(editorForm.elements.namedItem('indentSize').value) !== project.editor.indentSize);
  const pending = !!project && (editorDirty || project.editorNeedsApply !== false || editorFailed);
  const apply = document.getElementById('apply-editor');
  apply.title = pending
    ? 'Apply pending editor changes. Writes editor configuration and .clang-format.'
    : 'Editor settings already match.';
  apply.setAttribute('aria-busy', String(editorApplying));
  for (const button of editorForm.querySelectorAll('[type="submit"]'))
    button.disabled =
      !pending || editorApplying || editorReviewing || !editorForm.elements.namedItem('indentSize').validity.valid;
}
editorForm.addEventListener('input', () => {
  document.getElementById('editor-status').textContent = '';
  document.getElementById('editor-status').classList.remove('danger');
  editorFailed = false;
  updateEditorActions();
});
editorForm.addEventListener('submit', event => {
  event.preventDefault();
  const settings = {};
  settings.integration = editorForm.elements.namedItem('integration').value;
  settings.indentStyle = editorForm.elements.namedItem('indentStyle').value;
  settings.indentSize = Number(editorForm.elements.namedItem('indentSize').value);
  if (event.submitter?.hasAttribute('data-editor-review')) editorReviewing = true;
  else editorApplying = true;
  updateEditorActions();
  send(event.submitter?.hasAttribute('data-editor-review') ? 'reviewEditor' : 'editor', { settings });
});
const readComputerForm = () => ({
  installationPath: computerForm.elements
    .namedItem('installationPath')
    .value.trim()
    .replace(/^(['"])(.*)\1$/, '$2'),
  elevation: computerForm.elements.namedItem('elevation').value,
  gsudoPath: computerForm.elements
    .namedItem('gsudoPath')
    .value.trim()
    .replace(/^(['"])(.*)\1$/, '$2'),
  integration: computerForm.elements.namedItem('integration').value
});
const defaultComputer = { installationPath: '', integration: 'cpp', elevation: 'none', gsudoPath: '' };
computerForm.addEventListener('input', event => {
  updateSaveActions();
  document.getElementById('computer-status').textContent = '';
  document.getElementById('computer-status').classList.remove('danger');
  if (event.target.name === 'elevation') render();
});
computerForm.addEventListener('submit', event => {
  event.preventDefault();
  computerSaving = true;
  updateSaveActions();
  send('computerPreferences', { settings: readComputerForm() });
});
function readGenerationForm() {
  const config = { formatVersion: 1 };
  for (const name of ['sourceDirectory', 'outputDirectory', 'generate'])
    config[name] = form.elements.namedItem(name).value.trim();
  for (const name of ['entries', 'exclude', 'includeDirectories', 'externalIncludes'])
    config[name] = form.elements
      .namedItem(name)
      .value.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  config.debounceMs = Number(form.elements.namedItem('debounceMs').value);
  config.inlineAngleIncludes = form.elements.namedItem('inlineAngleIncludes').checked;
  return config;
}
function updateSaveActions() {
  const project = state.projects.find(project => project.root === currentRoot);
  configurationDirty =
    !!project &&
    Object.entries(readGenerationForm()).some(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(project.config[key])
    );
  form.querySelector('[type="submit"]').disabled =
    !project ||
    configurationSaving ||
    !(configurationDirty || project.error) ||
    ![...form.elements].every(input => !input.validity || input.validity.valid);
  const computer = state.computer || defaultComputer;
  const normalize = file => file.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  const settings = readComputerForm();
  computerDirty =
    normalize(settings.installationPath) !== normalize(computer.installationPath) ||
    settings.integration !== computer.integration ||
    settings.elevation !== computer.elevation ||
    settings.gsudoPath !== computer.gsudoPath;
  computerForm.querySelector('[type="submit"]').disabled = !computerDirty || computerSaving;
}
form.addEventListener('input', () => {
  updateSaveActions();
  document.getElementById('settings-status').textContent = '';
  document.getElementById('settings-status').classList.remove('danger');
});
form.addEventListener('submit', event => {
  event.preventDefault();
  configurationSaving = true;
  updateSaveActions();
  send('config', { config: readGenerationForm() });
});
for (const [id, section] of [
  ['edit-metadata', 'metadata'],
  ['edit-readme', 'readme'],
  ['edit-mod-settings', 'settings']
]) {
  document.getElementById(id).addEventListener('click', () => {
    const entry = state.projects
      .find(project => project.root === currentRoot)
      ?.entries.find(entry => entry.path === selectedEntry);
    if (entry) send('open', { entry: entry.path, line: entry.metadata?.lines[section] ?? 0 });
  });
}

const modActions = {
  generate: ['Generate', 'Generate a standalone .wh.cpp from saved source files.'],
  open: ['Source', 'Open this mod’s entry source file.'],
  output: ['Output', 'Open the generated .wh.cpp file.'],
  compare: ['Compare', 'Compare existing output with what saved source would generate.'],
  restore: ['Recover…', 'Recover source files and output edits. Choose a destination and review before writing.'],
  verify: [
    'Verify',
    'Check generated output using its compiler options and declared architectures. View results in the log.'
  ],
  discard: [
    'Discard output edits…',
    'Discard saved output edits and regenerate from saved source files after confirmation.'
  ]
};

/** What a card shows; the card is rebuilt only when this changes. */
const cardKey = entry =>
  JSON.stringify([
    entry.path,
    entry.label,
    entry.status,
    entry.message,
    entry.dependencies,
    entry.runtime,
    entry.metadata?.fields,
    entry.metadata?.diagnostics.length,
    navigator.language
  ]);
let cards = new Map(); // entry path -> { key, card }

/** Make parent's children exactly `nodes`, leaving nodes already in place untouched. */
function syncChildren(parent, nodes) {
  nodes.forEach((node, index) => {
    const current = parent.children[index];
    if (current === node) return;
    if (current && !nodes.includes(current)) current.replaceWith(node);
    else parent.insertBefore(node, current ?? null);
  });
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

/**
 * Update the mod cards. Unchanged cards keep their DOM node, so an open compile menu,
 * focus and hover survive state updates about other mods. A rebuilt card reopens its
 * compile menu and refocuses the same control.
 */
function renderEntries(project) {
  const entries = document.getElementById('entries');
  const next = new Map(),
    nodes = [],
    restore = [];
  if (project && !project.entries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = `Add a .cpp file under ${project.config.sourceDirectory}. Each matching file is an independent mod.`;
    const previous = entries.firstElementChild;
    nodes.push(previous?.tagName === 'P' && previous.textContent === empty.textContent ? previous : empty);
  }
  for (const entry of project?.entries || []) {
    const key = cardKey(entry),
      cached = cards.get(entry.path);
    let card = cached?.key === key ? cached.card : undefined;
    if (!card) {
      card = createEntryCard(entry);
      if (cached) restore.push([cached.card, card]);
    }
    next.set(entry.path, { key, card });
    nodes.push(card);
  }
  // Capture before the old cards leave the document.
  const carried = restore.map(([previous, card]) => ({
    card,
    menuOpen: !!previous.querySelector('.compile-menu')?.open,
    focus: previous.contains(document.activeElement)
      ? document.activeElement.closest('[data-focus]')?.dataset.focus
      : undefined
  }));
  syncChildren(entries, nodes);
  cards = next;
  for (const { card, menuOpen, focus } of carried) {
    if (menuOpen) card.querySelector('.compile-menu').open = true;
    if (focus) card.querySelector(`[data-focus="${focus}"]`)?.focus();
  }
}

/** Build one mod card. Controls carry data-focus so a rebuilt card can restore focus. */
function createEntryCard(entry) {
  const card = document.createElement('article');
  card.className = 'entry';
  const top = document.createElement('div');
  top.className = 'entry-heading';
  const fields = entry.metadata?.fields || {};
  const name = document.createElement('button');
  name.dataset.focus = 'details';
  name.className = 'link';
  name.textContent = fields['name:' + navigator.language]?.[0] || fields.name?.[0] || entry.label;
  name.title = 'View mod details';
  name.addEventListener('click', () => {
    send('details', { entry: entry.path });
  });
  const badge = document.createElement('span');
  badge.className = 'badge ' + entry.status;
  badge.textContent = entry.status;
  badge.title =
    {
      current: 'Generated output matches the current saved source.',
      stale: 'Generated output needs regeneration.',
      pending: 'Source has unsaved changes or generation is waiting.',
      generating: 'Generating output.',
      blocked: 'Output has edits that WHAM will preserve.'
    }[entry.status] ||
    entry.message ||
    entry.status;
  const badges = document.createElement('div');
  badges.className = 'entry-badges';
  if (entry.runtime?.changesPending) {
    const pending = document.createElement('span');
    pending.className = 'build-indicator warning compile-needed';
    pending.setAttribute('role', 'img');
    pending.setAttribute('aria-label', 'Needs compilation');
    pending.textContent = '\ueb6d'; // Codicon tools
    pending.title = entry.runtime?.installed
      ? 'Source changes need compilation.'
      : 'This mod has no installed build. Compile it first.';
    badges.append(pending);
  }
  if (entry.runtime?.installed && entry.runtime?.compileStatus === 'unknown') {
    const unknown = document.createElement('span');
    unknown.className = 'build-indicator muted';
    unknown.textContent = '\ueb32'; // Codicon question
    unknown.setAttribute('role', 'img');
    unknown.setAttribute('aria-label', 'Build unknown');
    unknown.title = 'WHAM cannot confirm which source produced this build.';
    badges.append(unknown);
  }
  badges.append(badge);
  top.append(name, badges);
  card.append(top);
  const filename = document.createElement('p');
  filename.className = 'muted';
  filename.textContent = entry.label + (fields.version?.[0] ? ` · v${fields.version[0]}` : '');
  card.append(filename);
  const sourceInfo = document.createElement('div');
  sourceInfo.className = 'entry-source-info';
  const sourceCount = document.createElement('p');
  sourceCount.textContent = `${entry.dependencies || 0} source file(s)`;
  sourceInfo.append(sourceCount);
  const compile = document.createElement('button');
  compile.dataset.focus = 'compile';
  compile.className = 'primary';
  compile.disabled = !!entry.runtime?.busy;
  const caption = document.createElement('span');
  caption.className = 'compile-caption';
  caption.textContent = 'Compile';
  compile.append(caption);
  compile.title = 'Generate, compile, and install saved source. Preserve Enabled; the first build starts disabled.';
  const building = ['compile', 'test', 'verify'].includes(entry.runtime?.operation);
  if (building) {
    const progress = document.createElement('span');
    progress.className = entry.runtime?.stopping ? 'compile-stopping' : 'compile-spinner';
    progress.setAttribute('aria-hidden', 'true');
    if (entry.runtime?.stopping) progress.textContent = 'Stopping';
    compile.append(progress);
    compile.setAttribute('aria-busy', 'true');
    const label = entry.runtime?.stopping
      ? 'Stopping…'
      : entry.runtime?.operation === 'test'
        ? 'Testing build…'
        : entry.runtime?.operation === 'verify'
          ? 'Verifying…'
          : 'Compiling…';
    compile.setAttribute('aria-label', label);
    compile.title = label;
  }
  compile.addEventListener('click', () => send('compile', { entry: entry.path }));
  const split = document.createElement('div');
  split.className = 'compile-split';
  split.append(compile);
  const menu = document.createElement('details');
  menu.className = 'more-menu compile-menu';
  const expander = document.createElement('summary');
  expander.dataset.focus = 'compile-options';
  expander.innerHTML =
    '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 6 4 4 4-4"/></svg>';
  expander.setAttribute('role', 'button');
  expander.setAttribute('aria-label', 'Compile options for ' + (fields.name?.[0] || entry.label));
  expander.setAttribute('aria-haspopup', 'menu');
  expander.setAttribute('aria-expanded', 'false');
  expander.title = 'Compile options';
  const choices = document.createElement('div');
  choices.className = 'more-actions';
  choices.setAttribute('role', 'menu');
  for (const [action, label, tooltip] of [
    [
      'testCompile',
      'Test build',
      'Compile and link saved source into temporary DLLs without installing or enabling the mod.'
    ],
    ['verify', 'Verify syntax', 'Check generated output for each declared architecture using its compiler options.'],
    ['stopCompile', 'Stop compilation', 'Cancel the current build or verification.']
  ]) {
    const button = document.createElement('button');
    button.dataset.focus = action;
    button.textContent = label;
    button.title = tooltip;
    button.setAttribute('role', 'menuitem');
    button.hidden = action === 'stopCompile' && !building;
    button.disabled = action === 'stopCompile' ? !!entry.runtime?.stopping : !!entry.runtime?.busy;
    button.addEventListener('click', () => {
      menu.open = false;
      send(action, { entry: entry.path });
    });
    choices.append(button);
  }
  menu.append(expander, choices);
  split.append(menu);
  menu.addEventListener('toggle', () => {
    expander.setAttribute('aria-expanded', String(menu.open));
    if (menu.open) {
      const bounds = expander.getBoundingClientRect();
      choices.style.left =
        Math.max(4, Math.min(bounds.right - choices.offsetWidth, innerWidth - choices.offsetWidth - 4)) + 'px';
      choices.style.top = Math.max(4, Math.min(bounds.bottom + 4, innerHeight - choices.offsetHeight - 4)) + 'px';
    }
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      menu.open = false;
      expander.focus();
    }
  });
  const toggle = document.createElement('label');
  toggle.className = 'runtime-toggle';
  const enabled = document.createElement('input');
  enabled.dataset.focus = 'enable';
  enabled.type = 'checkbox';
  enabled.setAttribute('role', 'switch');
  enabled.setAttribute('aria-label', 'Enable installed ' + (fields.name?.[0] || entry.label));
  enabled.checked = entry.runtime?.enabled === true;
  enabled.disabled = !entry.runtime?.installed || !!entry.runtime?.busy;
  toggle.title = entry.runtime?.installed
    ? 'Enable or disable the installed build. Draft edits need compilation first.'
    : 'Compile this mod before enabling it.';
  enabled.addEventListener('change', () => {
    send('enable', { entry: entry.path, enabled: enabled.checked });
    enabled.checked = entry.runtime?.enabled === true;
  });
  toggle.append(
    document.createTextNode(
      entry.runtime?.operation === 'enable'
        ? 'Enabling…'
        : entry.runtime?.operation === 'disable'
          ? 'Disabling…'
          : entry.runtime?.enabled
            ? 'Enabled'
            : 'Disabled'
    ),
    enabled
  );
  sourceInfo.append(toggle);
  card.append(sourceInfo);

  if (entry.runtime?.error) {
    const error = document.createElement('p');
    error.className = 'warning';
    error.textContent = entry.runtime.error;
    card.append(error);
  }
  if (entry.message && !/^\d+ source file\(s\)$/.test(entry.message)) {
    const message = document.createElement('p');
    message.textContent = entry.message;
    card.append(message);
  }
  if (entry.metadata?.diagnostics.length) {
    const warning = document.createElement('p');
    warning.className = 'warning';
    warning.textContent = `${entry.metadata.diagnostics.length} metadata warning(s) · View details`;
    card.append(warning);
  }
  const buttons = document.createElement('div');
  buttons.className = 'toolbar entry-actions';
  for (const action of ['generate', 'open']) {
    const [label, tooltip] = modActions[action];
    const button = document.createElement('button');
    button.dataset.focus = action;
    button.textContent = label;
    button.title = tooltip;
    button.setAttribute('aria-description', tooltip);
    button.addEventListener('click', () => send(action, { entry: entry.path }));
    buttons.append(button);
  }
  buttons.append(split);
  card.append(buttons);
  return card;
}

function render() {
  const choicesKey = JSON.stringify(state.projectChoices);
  if (projectSelect.dataset.choices !== choicesKey) {
    projectSelect.dataset.choices = choicesKey;
    projectSelect.replaceChildren();
  }
  if (!projectSelect.options.length)
    for (const choice of state.projectChoices) {
      const option = document.createElement('option');
      option.value = choice.root;
      option.title = choice.detail;
      const duplicateName =
        choice.root && state.projectChoices.filter(other => other.label === choice.label).length > 1;
      option.textContent = duplicateName ? `${choice.label} — ${choice.detail}` : choice.label;
      projectSelect.append(option);
    }
  const project = state.projects.find(project => project.root === currentRoot) || state.projects[0];
  currentRoot = project?.root;
  projectSelect.value = currentRoot || '';
  if (!pageName || (!project && !['settings', 'setup'].includes(pageName))) pageName = project ? 'project' : 'setup';
  if (!project && pageName === 'settings') settingsScope = 'extension';
  const selectedMod = project?.entries.find(entry => entry.path === selectedEntry);
  if (pageName === 'mod' && !selectedMod) pageName = 'project';
  for (const name of ['setup', 'project', 'settings', 'mod'])
    document.getElementById('page-' + name).hidden = name !== pageName;
  document.querySelectorAll('nav[aria-label="Main navigation"] button').forEach(button => {
    button.disabled = !project && button.dataset.page === 'project';
    button.setAttribute(
      'aria-current',
      button.dataset.page === (pageName === 'mod' ? 'project' : pageName) ? 'page' : 'false'
    );
  });
  document.querySelectorAll('[data-settings-scope]').forEach(button => {
    button.disabled = !project && button.dataset.settingsScope === 'project';
    button.setAttribute('aria-current', button.dataset.settingsScope === settingsScope ? 'page' : 'false');
  });
  document.getElementById('project-settings-navigation').hidden = settingsScope !== 'project';
  document.getElementById('settings-project').textContent = project ? `These settings apply to ${project.name}.` : '';
  document.getElementById('settings-project').hidden = settingsScope !== 'project' || !project;
  document.querySelectorAll('[data-settings]').forEach(button => {
    button.disabled = !project;
    button.setAttribute('aria-current', button.dataset.settings === settingsPage ? 'page' : 'false');
  });
  form.hidden = settingsScope !== 'project' || settingsPage !== 'generation';
  editorForm.hidden = settingsScope !== 'project' || settingsPage !== 'editor' || !project;
  computerForm.hidden = settingsScope !== 'extension';
  if (!computerDirty)
    for (const [name, value] of Object.entries(state.computer || defaultComputer))
      computerForm.elements.namedItem(name).value = value;
  const method = computerForm.elements.namedItem('elevation').value;
  document.getElementById('elevation-help').hidden = method !== 'sudo';
  document.getElementById('gsudo-path').hidden = method !== 'gsudo';
  document.getElementById('git-settings').hidden = settingsScope !== 'project' || settingsPage !== 'git';
  vscode.setState({ page: pageName, settingsScope, settings: settingsPage, entry: selectedEntry });
  document.getElementById('root').textContent = project?.root || '';
  document.getElementById('error').textContent = project?.error || '';
  document.getElementById('notice').textContent = project?.retained.join('\n') || '';
  document.getElementById('folder-status').textContent = project?.opened
    ? ''
    : 'Open this project folder to activate its editor configuration.';
  const gitText = project?.git
    ? `Git · ${project.git.branch} · ${project.git.changes} changed file(s)`
    : 'Git is not initialized or unavailable.';
  document.getElementById('git-status').textContent = gitText;
  document.getElementById('settings-git-status').textContent = gitText;
  document.getElementById('count').textContent = String(project?.entries.length || 0);
  document.querySelector('[data-action="generateAll"]').disabled = !project?.entries.length || !!project?.error;
  renderEntries(project);
  if (selectedMod) {
    const metadata = selectedMod.metadata,
      fields = metadata?.fields || {};
    document.getElementById('mod-name').textContent =
      fields['name:' + navigator.language]?.[0] || fields.name?.[0] || selectedMod.label;
    document.getElementById('mod-file').textContent = selectedMod.label;
    const actions = document.getElementById('mod-actions');
    const actionsKey = JSON.stringify([selectedMod.path, selectedMod.status === 'blocked']);
    if (actions.dataset.key !== actionsKey) {
      actions.dataset.key = actionsKey;
      actions.replaceChildren();
      const more = document.createElement('details');
      more.className = 'more-menu';
      const summary = document.createElement('summary');
      summary.textContent = '...';
      summary.title = 'More actions';
      summary.setAttribute('aria-label', 'More actions');
      summary.setAttribute('role', 'button');
      summary.setAttribute('aria-haspopup', 'menu');
      more.append(summary);
      for (const [index, group] of [
        ['generate', 'open', 'output'],
        ['compare', 'restore', 'verify', ...(selectedMod.status === 'blocked' ? ['discard'] : [])]
      ].entries()) {
        const buttons = document.createElement('div');
        buttons.className = index === 0 ? 'toolbar' : 'more-actions';
        buttons.setAttribute('role', index === 0 ? 'group' : 'menu');
        buttons.setAttribute('aria-label', index === 0 ? 'Mod actions' : 'Output actions');
        for (const action of group) {
          const [label, tooltip] = modActions[action];
          const button = document.createElement('button');
          button.textContent = label;
          button.title = tooltip;
          button.setAttribute('aria-description', tooltip);
          button.className = action === 'generate' ? 'primary' : action === 'discard' ? 'danger' : '';
          if (index === 1) button.setAttribute('role', 'menuitem');
          button.addEventListener('click', () => {
            more.open = false;
            send(action, { entry: selectedMod.path });
          });
          buttons.append(button);
        }
        if (index === 0) actions.append(buttons);
        else more.append(buttons);
      }
      actions.append(more);
      more.addEventListener('toggle', () => {
        if (more.open) {
          const menu = more.querySelector('[role="menu"]'),
            bounds = summary.getBoundingClientRect();
          menu.style.left = Math.max(4, Math.min(bounds.left, innerWidth - menu.offsetWidth - 4)) + 'px';
          menu.style.top = Math.max(4, Math.min(bounds.bottom + 4, innerHeight - menu.offsetHeight - 4)) + 'px';
        }
      });
      more.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          more.open = false;
          summary.focus();
        }
      });
    }
    const details = document.getElementById('metadata-fields');
    details.replaceChildren();
    for (const [key, values] of Object.entries(fields)) {
      const label = document.createElement('dt');
      label.textContent = '@' + key;
      const value = document.createElement('dd');
      value.textContent = values.join('\n');
      details.append(label, value);
    }
    document.getElementById('metadata-issues').textContent =
      metadata?.diagnostics.map(item => `Line ${item.line + 1}: ${item.message}`).join('\n') || '';
    document.getElementById('readme-section').hidden = metadata?.readme === undefined;
    document.getElementById('readme').textContent = metadata?.readme || '';
    document.getElementById('mod-settings-section').hidden = metadata?.settingsText === undefined;
    document.getElementById('mod-settings').textContent = metadata?.settingsText || '';
    document.getElementById('mod-settings-title').textContent =
      'Mod settings' +
      (metadata?.settingsCount !== undefined ? ` · ${metadata.settingsCount} top-level setting(s)` : '');
  }
  if (project && !configurationDirty)
    for (const [name, value] of Object.entries(project.config)) {
      const input = form.elements.namedItem(name);
      if (!input) continue;
      if (typeof value === 'boolean') input.checked = value;
      else input.value = Array.isArray(value) ? value.join('\n') : value;
    }
  if (project?.editor && !editorDirty)
    for (const [key, value] of Object.entries(project.editor)) {
      if (key === 'installationPath') continue;
      const input = editorForm.elements.namedItem(key);
      if (input) input.value = value;
    }
  updateEditorActions();
  updateSaveActions();
}
window.addEventListener('message', event => {
  if (event.data.type === 'state') {
    const firstState = !state.type;
    const previousRoot = currentRoot;
    state = event.data;
    currentRoot = state.selected;
    if (previousRoot !== currentRoot) {
      configurationDirty = false;
      configurationSaving = false;
      editorDirty = false;
      editorApplying = false;
      editorReviewing = false;
      editorFailed = false;
      selectedEntry = undefined;
      document.getElementById('settings-status').textContent = '';
      document.getElementById('editor-status').textContent = '';
    }
    if (firstState) pageName = previousView?.page || (currentRoot ? 'project' : 'setup');
    if (event.data.page) pageName = event.data.page;
    if (firstState) {
      document.getElementById('open-after-setup').checked = state.openAfterSetup !== false;
      document.getElementById('initial-commit').checked = state.createInitialCommit === true;
    }
    if (settingUp && currentRoot && currentRoot !== setupRoot) {
      settingUp = false;
      pageName = 'project';
      configurationDirty = false;
      editorDirty = false;
    }
    render();
  }
  if (event.data.type === 'detailsFallback') {
    selectedEntry = event.data.entry;
    pageName = 'mod';
    render();
  }
  if (event.data.type === 'error') {
    if (['editor', 'reviewEditor'].includes(event.data.action) && event.data.root === currentRoot) {
      editorApplying = false;
      editorReviewing = false;
      editorFailed = true;
      document.getElementById('editor-status').textContent = event.data.message;
      document.getElementById('editor-status').classList.add('danger');
      updateEditorActions();
    } else if (event.data.action === 'config' && event.data.root === currentRoot) {
      configurationSaving = false;
      document.getElementById('settings-status').textContent = event.data.message;
      document.getElementById('settings-status').classList.add('danger');
      updateSaveActions();
    } else if (event.data.action === 'computerPreferences') {
      computerSaving = false;
      document.getElementById('computer-status').textContent = event.data.message;
      document.getElementById('computer-status').classList.add('danger');
      updateSaveActions();
    } else document.getElementById('error').textContent = event.data.message;
    document.getElementById('setup-status').textContent = '';
    settingUp = false;
  }
  if (event.data.type === 'setupFinished') {
    settingUp = false;
    document.getElementById('setup-status').textContent = '';
    if (event.data.completed && currentRoot) {
      pageName = 'project';
      configurationDirty = false;
      editorDirty = false;
      render();
    }
  }
  if (event.data.type === 'saved' && (!event.data.root || event.data.root === currentRoot)) {
    configurationSaving = false;
    updateSaveActions();
    document.getElementById('settings-status').textContent = 'Configuration saved';
    document.getElementById('settings-status').classList.remove('danger');
    render();
  }
  if (event.data.type === 'editorSaved' && (!event.data.root || event.data.root === currentRoot)) {
    editorApplying = false;
    editorFailed = false;
    updateEditorActions();
    document.getElementById('editor-status').textContent = 'Editor settings applied';
    document.getElementById('editor-status').classList.remove('danger');
    render();
  }
  if (event.data.type === 'editorReviewed' && event.data.root === currentRoot) {
    editorReviewing = false;
    updateEditorActions();
  }
  if (event.data.type === 'computerSaved') {
    computerSaving = false;
    updateSaveActions();
    document.getElementById('computer-status').textContent = 'Preferences saved.';
    document.getElementById('computer-status').classList.remove('danger');
    render();
  }
  if (event.data.type === 'computerInstallation') {
    computerForm.elements.namedItem('installationPath').value = event.data.value;
    updateSaveActions();
    render();
  }
  if (event.data.type === 'gsudoPath') {
    computerForm.elements.namedItem('gsudoPath').value = event.data.value;
    document.getElementById('gsudo-path').open = true;
    updateSaveActions();
  }
});
if (window.whamSidebarState) window.dispatchEvent(new MessageEvent('message', { data: window.whamSidebarState }));
else render();
send('ready');
