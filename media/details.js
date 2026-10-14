// Draw WHAM's controls first, then start the pinned read-only Discover renderer.
const host = acquireVsCodeApi();
let context = window.whamPreviewContext, frontendStarted = false;
const displayedContext = context;
const epoch = context.epoch, session = context.session;
const send = message => host.postMessage({ ...message, details: true, epoch, session });
window.acquireVsCodeApi = () => ({ getState: () => ({}), setState() {}, postMessage: message => send({ ...message, action: 'windhawk', theme: document.body.classList.contains('vscode-light') ? 'light' : 'dark' }) });
const url = new URL(location.href); url.hash = '#/mods-browser/' + context.modId.replace(/^local@/, ''); history.replaceState(null, '', url);

const modActions = {
  generate: ['Generate', 'Generate a standalone .wh.cpp from saved source files.'],
  open: ['Source', 'Open this mod’s entry source file.'],
  output: ['Output', 'Open the generated .wh.cpp file.'],
  compare: ['Compare', 'Compare existing output with what saved source would generate.'],
  restore: ['Recover…', 'Recover source files and output edits. Choose a destination and review before writing.'],
  verify: ['Verify', 'Check generated output with the configured Windhawk compiler.'],
  discard: ['Discard output edits…', 'Discard output edits and regenerate after confirmation.']
};
const more = document.createElement('details'); more.className = 'more-menu';
const summary = document.createElement('summary'); summary.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="m4 6 4 4 4-4z"/></svg>'; summary.title = 'More actions'; summary.setAttribute('aria-label', 'More actions'); summary.setAttribute('role', 'button'); summary.setAttribute('aria-haspopup', 'menu'); summary.setAttribute('aria-expanded', 'false'); more.append(summary);
for (const [index, actions] of [['open', 'output'], ['generate', 'compare', 'restore', 'verify', 'discard']].entries()) {
  const group = document.createElement('div'); group.className = index === 0 ? 'action-group' : 'more-actions';
  if (index === 1) group.setAttribute('role', 'menu');
  for (const action of actions) {
    const button = document.createElement('button'); button.dataset.modAction = action; [button.textContent, button.title] = modActions[action]; group.append(button);
    if (index === 1) button.setAttribute('role', 'menuitem');
  }
  if (index === 0) document.getElementById('mod-tools').append(group); else more.append(group);
}
document.getElementById('mod-tools').append(more);
more.addEventListener('toggle', () => {
  summary.setAttribute('aria-expanded', String(more.open));
  if (more.open) {
    const menu = more.querySelector('[role="menu"]'), bounds = summary.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(bounds.left, innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(bounds.bottom + 4, innerHeight - menu.offsetHeight - 4)) + 'px';
  }
});
document.addEventListener('click', event => { if (!more.contains(event.target)) more.open = false; });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && more.open) { more.open = false; summary.focus(); } });
const updateActions = () => { document.querySelector('[data-mod-action="discard"]').hidden = !context.outputBlocked; };
updateActions();
document.getElementById('open-windhawk').addEventListener('click', () => send({ action: 'openWindhawk' }));
for (const button of document.querySelectorAll('[data-mod-action]')) button.addEventListener('click', () => { more.open = false; send({ action: 'modAction', modAction: button.dataset.modAction }); });
for (const button of document.querySelectorAll('[data-sidebar-page]')) button.addEventListener('click', () => send({ action: 'navigate', page: button.dataset.sidebarPage }));
document.getElementById('refresh').addEventListener('click', () => send({ action: 'refresh' }));
window.addEventListener('message', async event => {
  if (event.data.type === 'frontend' && event.data.epoch === epoch && !frontendStarted) {
    frontendStarted = true;
    try {
      const markup = new DOMParser().parseFromString(event.data.html, 'text/html');
      await Promise.all([...markup.querySelectorAll('link[rel="stylesheet"]')].map(original => new Promise((resolve, reject) => {
        const stylesheet = original.cloneNode(); stylesheet.href = new URL(original.getAttribute('href'), event.data.base).toString();
        stylesheet.onload = resolve; stylesheet.onerror = () => reject(new Error('Could not load Windhawk styles. Try Refresh.')); document.head.append(stylesheet);
      })));
      for (const original of markup.querySelectorAll('script[src]')) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = new URL(original.getAttribute('src'), event.data.base).toString(); script.type = original.type || 'text/javascript';
        script.onload = resolve; script.onerror = () => reject(new Error('Could not load the Windhawk renderer. Try Refresh.')); document.body.append(script);
      });
    } catch (error) { document.getElementById('wham-loading').hidden = true; document.getElementById('wham-error').textContent = error.message; }
  }
  if (event.data.type === 'context') {
    context = event.data; updateActions();
    const changed = displayedContext.modId !== context.modId || displayedContext.draftRevision !== context.draftRevision;
    const refresh = document.getElementById('refresh');
    refresh.classList.toggle('refresh-pending', changed);
    refresh.title = changed ? 'Source changed. Refresh to update mod details.' : 'Refresh the source preview';
    refresh.setAttribute('aria-label', changed ? 'Refresh mod details — update available' : 'Refresh');
  }
  if (event.data.type === 'windhawkReply' && event.data.epoch === epoch) window.dispatchEvent(new MessageEvent('message', { data: event.data.reply }));
  if (event.data.type === 'notice') document.getElementById('wham-error').textContent = event.data.message;
  if (event.data.type === 'error') { document.getElementById('wham-loading').hidden = true; document.getElementById('wham-error').textContent = event.data.message; }
});

// The pinned renderer's chrome is hidden by CSS before it can flash on screen.
// Observe only readiness, then detach; no repeated edits to upstream DOM.
const previewReady = new MutationObserver(() => {
  if (document.querySelector('#root [data-testid="mod-details"]')) {
    document.getElementById('wham-loading').hidden = true; previewReady.disconnect();
  }
});
previewReady.observe(document.getElementById('root'), { childList: true, subtree: true });
document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href]'); if (!link) return;
  const url = link.dataset.testid === 'mod-link' ? new URL('https://windhawk.net/mods/' + encodeURIComponent(link.dataset.modId)) : new URL(link.href);
  if (['http:', 'https:'].includes(url.protocol) && url.origin !== location.origin) { event.preventDefault(); event.stopPropagation(); send({ action: 'external', url: url.toString() }); }
}, true);
new ResizeObserver(() => document.documentElement.style.setProperty('--wham-toolbar-height', document.getElementById('wham-header').offsetHeight + 'px')).observe(document.getElementById('wham-header'));
send({ action: 'ready' });
requestAnimationFrame(() => requestAnimationFrame(() => send({ action: 'loadFrontend' })));
