import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ParsedModSource, WindhawkInstallation, openWindhawk, previewLanguage } from './windhawk';

export interface DetailsData {
  installation: WindhawkInstallation; modId: string; entry: string;
  source: string; parsed: ParsedModSource; outputBlocked?: boolean;
}

interface DetailsCallbacks {
  onAction: (action: string) => Promise<unknown>;
  onRefresh?: () => Promise<unknown>;
  onNavigate?: (page: string) => Promise<unknown>;
}

/** Show the bundled Discover renderer, restricted to this source-only preview. */
export function createDetailsView(extensionUri: vscode.Uri, webview: vscode.Webview, initial: DetailsData, callbacks: DetailsCallbacks) {
  let data = initial;
  const directory = path.join(extensionUri.fsPath, 'media', 'windhawk-renderer');
  const nonce = randomBytes(16).toString('hex');
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')] };
  const base = webview.asWebviewUri(vscode.Uri.file(path.join(directory, 'wham-base'))).toString().replace(/wham-base$/, '');
  const styles = readFileSync(path.join(extensionUri.fsPath, 'media', 'details.css'), 'utf8');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'details.js'));
  const language = previewLanguage(vscode.env?.language ?? 'en');
  let frontend: Promise<string> | undefined;
  let disposed = false, heldEpoch = 0, heldData = data;
  const previewContext = () => ({ type: 'context', draftRevision: createHash('sha256').update(data.source).update(JSON.stringify(data.parsed)).digest('hex'), outputBlocked: data.outputBlocked, modId: data.modId });
  const post = () => webview.postMessage(previewContext());
  const mount = () => {
    if (disposed) return;
    heldData = data; heldEpoch++;
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; connect-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} data:; form-action 'none';">`;
    webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${base}">${policy}<style>${styles}</style></head><body data-content="panel">
      <div id="wham-header">
        ${callbacks.onNavigate ? '<nav class="wham-navigation" aria-label="Main navigation"><button data-sidebar-page="project" aria-current="page">Project</button><button data-sidebar-page="settings">Settings</button><button data-sidebar-page="setup">Setup</button></nav>' : ''}
        <div class="wham-toolbar" role="toolbar" aria-label="Draft preview controls" title="Preview the source README and default settings.">
          ${callbacks.onNavigate ? '<button class="icon-button" data-sidebar-page="project" title="Back to all mods" aria-label="Back to all mods"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="m8 3-5 5 5 5M3 8h11"/></svg></button>' : ''}<div id="mod-tools" aria-label="Mod actions"></div><div class="right-actions"><button class="icon-button" id="open-windhawk" title="Open Windhawk to manage installed mods and settings" aria-label="Open Windhawk"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9 2h5v5M14 2 7 9M7 3H2v11h11V9"/></svg></button><button class="icon-button" id="refresh" title="Refresh the source preview" aria-label="Refresh"><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 6A5.5 5.5 0 1 0 13 11M14 2v4h-4"/></svg></button></div>
        </div><p id="wham-error" role="alert"></p>
      </div><p id="wham-loading" role="status">Loading mod details…</p><div id="root"></div>
      <script nonce="${nonce}">window.whamPreviewContext = ${JSON.stringify({ ...previewContext(), epoch: heldEpoch, session: nonce })};</script><script nonce="${nonce}" src="${script}"></script></body></html>`;
  };
  const reply = (message: any, result: Record<string, unknown>) => !disposed && webview.postMessage({ type: 'windhawkReply', epoch: message.epoch,
    reply: { type: 'reply', command: message.command, messageId: message.messageId, data: result } });
  const listener = webview.onDidReceiveMessage(async message => {
    if (disposed || message.session !== nonce || message.epoch !== heldEpoch) return;
    try {
      if (message.action === 'ready') { await post(); return; }
      if (message.action === 'loadFrontend') {
        const epoch = heldEpoch;
        frontend ??= fs.readFile(path.join(directory, 'index.html'), 'utf8');
        const html = await frontend;
        if (!disposed && epoch === heldEpoch) await webview.postMessage({ type: 'frontend', epoch, html, base });
        return;
      }
      if (message.action === 'openWindhawk') {
        if (!data.installation.root) { void vscode.window.showInformationMessage('Select your Windhawk installation in Settings → Extension settings.'); return; }
        await openWindhawk(data.installation.root); return;
      }
      if (message.action === 'modAction' && ['generate', 'open', 'output', 'compare', 'restore', 'verify', 'discard'].includes(message.modAction)) { await callbacks.onAction(message.modAction); return; }
      if (message.action === 'external' && typeof message.url === 'string') {
        const uri = vscode.Uri.parse(message.url); if (['http', 'https'].includes(uri.scheme)) await vscode.env.openExternal(uri); return;
      }
      if (message.action === 'navigate') { if (['project', 'settings', 'setup'].includes(message.page)) await callbacks.onNavigate?.(message.page); return; }
      if (message.action === 'refresh') { await callbacks.onRefresh?.(); mount(); return; }
      if (message.action !== 'windhawk' || !Number.isInteger(message.messageId) || typeof message.command !== 'string') return;
      const current = heldData;
      const previewId = current.modId.replace(/^local@/, '');
      if (message.data?.modId && message.data.modId !== previewId) throw new Error('The requested mod does not match this details pane.');
      switch (message.command) {
        case 'getInitialAppSettings': await reply(message, { contractVersion: '1.26.0', appUISettings: { language, devModeOptOut: true, theme: message.theme ?? 'dark', safeMode: false } }); break;
        case 'getInstalledMods': await reply(message, { installedMods: {} }); break;
        case 'getRepositoryMods': await reply(message, { mods: { [previewId]: { repository: { metadata: current.parsed.metadata, details: { users: 0, rating: 0, ratingBreakdown: [], defaultSorting: 0, published: 0, updated: 0 } } } } }); break;
        case 'getModSourceData': case 'getRepositoryModSourceData':
          await reply(message, { modId: previewId, data: { source: current.source, metadata: current.parsed.metadata, readme: current.parsed.readme, initialSettings: current.parsed.initialSettings } });
          if (Object.keys(current.parsed.errors).length) await webview.postMessage({ type: 'notice', message: Object.values(current.parsed.errors).join('\n') });
          break;
        // No installed settings, native session reads, or mutation commands are exposed.
        default: throw new Error('This is a read-only source preview. Manage installed settings in Windhawk.');
      }
    } catch (error) {
      if (disposed || message.epoch !== heldEpoch) return;
      const text = (error as Error).message;
      if (message.action === 'windhawk') await reply(message, { modId: heldData.modId.replace(/^local@/, ''), succeeded: false, error: { code: 'WHAM', message: text } });
      await webview.postMessage({ type: 'error', message: text });
      void vscode.window.showErrorMessage(text);
    }
  });
  mount();
  return { update: async (next: DetailsData) => { if (disposed) return; data = next; await post(); }, dispose: () => { disposed = true; listener?.dispose(); } };
}

export async function createDetailsPanel(extensionUri: vscode.Uri, initial: DetailsData, onAction: (action: string) => Promise<unknown>, onRefresh?: () => Promise<unknown>) {
  const panel = vscode.window.createWebviewPanel('wham.details', 'WHAM: ' + (initial.parsed.metadata?.name ?? path.basename(initial.entry)), vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
  const details = createDetailsView(extensionUri, panel.webview, initial, { onAction, onRefresh });
  panel.onDidDispose(() => details.dispose());
  return { panel, update: details.update, dispose: () => panel.dispose() };
}
