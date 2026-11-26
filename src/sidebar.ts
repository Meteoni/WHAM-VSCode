import type { EditorSettings } from './setup';
import type { InstallationPreferences } from './preferences';

/*
 * The protocol media/sidebar.js uses to talk to the extension. Every message has an
 * `action`; project and entry actions also carry the project `root` and mod `entry` path.
 * test/sidebar.test.cjs checks that the actions the webview sends are listed here.
 */

type Integration = EditorSettings['integration'];
export interface ComputerPreferencesInput {
  installationPath: string;
  gsudoPath: string;
  elevation: InstallationPreferences['elevation'];
  integration: Integration;
}

/** Actions that need no project. */
export type GlobalMessage =
  | { action: 'ready' | 'logs' | 'browseComputerInstallation' | 'browseGsudo' }
  | { action: 'openProject'; projectRoot?: string; browse: boolean }
  | { action: 'initialize'; mode?: string; openProject?: boolean; initialCommit?: boolean }
  | { action: 'computerPreferences' | 'checkElevation'; settings: ComputerPreferencesInput }
  /** Recover from files chosen in a dialog; `restore` with an entry recovers that mod's output. */
  | { action: 'restore' };

/** Actions on the selected project. */
export type ProjectMessage =
  | { action: 'openFolder' | 'refreshGit' | 'sourceControl' | 'gitSetup' | 'select' | 'generateAll' }
  | {
      action: 'editor' | 'reviewEditor';
      /** Undefined keeps the project's current service. */
      integration?: Integration;
      indentStyle: unknown;
      indentSize: unknown;
    }
  /** Validated by validateConfig when applied. */
  | { action: 'config'; config: unknown };

/** Actions on one mod entry of the selected project. */
export type EntryMessage =
  | { action: 'details' | 'compile' | 'testCompile' | 'stopCompile' }
  | { action: 'enable'; enabled: boolean }
  | { action: 'generate' | 'compare' | 'restore' | 'discard' | 'output' | 'verify' }
  | { action: 'open'; line?: number };

export type SidebarMessage =
  | ({ scope: 'global' } & GlobalMessage)
  | ({ scope: 'project'; root: unknown } & ProjectMessage)
  | ({ scope: 'entry'; root: unknown; entry: unknown } & EntryMessage);

const globalActions = new Set([
  'ready',
  'logs',
  'browseComputerInstallation',
  'browseGsudo',
  'openProject',
  'initialize',
  'computerPreferences',
  'checkElevation'
]);
const projectActions = new Set([
  'openFolder',
  'refreshGit',
  'sourceControl',
  'gitSetup',
  'select',
  'generateAll',
  'editor',
  'reviewEditor',
  'config'
]);
const entryActions = new Set([
  'details',
  'compile',
  'testCompile',
  'stopCompile',
  'enable',
  'generate',
  'compare',
  'restore',
  'discard',
  'output',
  'verify',
  'open'
]);
/** Every action the extension accepts from the sidebar. */
export const sidebarActions: readonly string[] = [...globalActions, ...projectActions, ...entryActions];

const integrations = ['cpp', 'clangd', 'both'];
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const optionalBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);

/**
 * Validate a raw webview message. Returns undefined for messages the sidebar router
 * does not own (details-view traffic, or no action) and throws for malformed ones.
 */
export function parseSidebarMessage(raw: unknown): SidebarMessage | undefined {
  if (!isRecord(raw) || typeof raw.action !== 'string' || raw.details === true) return undefined;
  const action = raw.action;
  // Without an entry, `restore` asks for containers in a dialog instead of using a mod's output.
  if (action === 'restore' && !raw.entry) return { scope: 'global', action };
  if (globalActions.has(action)) {
    switch (action) {
      case 'openProject':
        return {
          scope: 'global',
          action,
          projectRoot: typeof raw.projectRoot === 'string' ? raw.projectRoot : undefined,
          browse: raw.browse === true
        };
      case 'initialize':
        return {
          scope: 'global',
          action,
          mode: typeof raw.mode === 'string' ? raw.mode : undefined,
          openProject: optionalBoolean(raw.openProject),
          initialCommit: optionalBoolean(raw.initialCommit)
        };
      case 'computerPreferences':
      case 'checkElevation': {
        const settings = raw.settings;
        if (
          !isRecord(settings) ||
          typeof settings.installationPath !== 'string' ||
          typeof settings.gsudoPath !== 'string' ||
          !['none', 'sudo', 'gsudo'].includes(settings.elevation as string) ||
          !integrations.includes(settings.integration as string)
        )
          throw new Error('Invalid computer preferences.');
        return { scope: 'global', action, settings: settings as unknown as ComputerPreferencesInput };
      }
      default:
        return { scope: 'global', action: action as 'ready' | 'logs' | 'browseComputerInstallation' | 'browseGsudo' };
    }
  }
  if (projectActions.has(action)) {
    const root = raw.root;
    switch (action) {
      case 'editor':
      case 'reviewEditor': {
        const settings = isRecord(raw.settings) ? raw.settings : {};
        const integration = settings.integration ?? undefined;
        if (integration !== undefined && !integrations.includes(integration as string))
          throw new Error('Choose a valid C++ language service.');
        return {
          scope: 'project',
          root,
          action,
          integration: integration as Integration | undefined,
          indentStyle: settings.indentStyle,
          indentSize: settings.indentSize
        };
      }
      case 'config':
        return { scope: 'project', root, action, config: raw.config };
      default:
        return {
          scope: 'project',
          root,
          action: action as Exclude<ProjectMessage['action'], 'editor' | 'reviewEditor' | 'config'>
        };
    }
  }
  if (entryActions.has(action)) {
    const target = { scope: 'entry' as const, root: raw.root, entry: raw.entry };
    if (action === 'enable') {
      // A toggle without a boolean is ignored, as before; treat it as no message.
      if (typeof raw.enabled !== 'boolean') return undefined;
      return { ...target, action, enabled: raw.enabled };
    }
    if (action === 'open') return { ...target, action, line: typeof raw.line === 'number' ? raw.line : undefined };
    return { ...target, action: action as Exclude<EntryMessage['action'], 'enable' | 'open'> };
  }
  throw new Error(`Unknown sidebar action: ${action}`);
}

/** The union members that accept action A, including members listing several actions. */
type ForAction<Union, A> = Union extends { action: infer Actions } ? (A extends Actions ? Union : never) : never;
type Handler<M, Args extends unknown[]> = (...args: [...Args, M]) => PromiseLike<unknown>;
type HandlerMap<Union extends { action: string }, Args extends unknown[]> = {
  [A in Union['action']]: Handler<ForAction<Union, A>, Args>;
};

export interface SidebarRoutes<Project, Entry> {
  findProject(root: unknown): Project | undefined;
  findEntry(project: Project, entry: unknown): Entry | undefined;
  /** Runs before every project or entry action: the sidebar's choice becomes the active project. */
  selectProject(project: Project): void;
  global: HandlerMap<GlobalMessage, []>;
  project: HandlerMap<ProjectMessage, [Project]>;
  entry: HandlerMap<EntryMessage, [Project, Entry]>;
}

/**
 * Dispatch a validated sidebar message. Missing projects and entries throw the errors the
 * sidebar shows; the caller reports thrown errors back to the webview.
 */
export function createSidebarRouter<Project, Entry>(routes: SidebarRoutes<Project, Entry>) {
  return async (raw: unknown): Promise<void> => {
    const message = parseSidebarMessage(raw);
    if (!message) return;
    if (message.scope === 'global') {
      const handler = routes.global[message.action] as Handler<GlobalMessage, []>;
      await handler(message);
      return;
    }
    const project = routes.findProject(message.root);
    if (!project) throw new Error('Select a project first.');
    routes.selectProject(project);
    if (message.scope === 'project') {
      const handler = routes.project[message.action] as Handler<ProjectMessage, [Project]>;
      await handler(project, message);
      return;
    }
    const entry = routes.findEntry(project, message.entry);
    if (!entry) throw new Error('Select a valid mod entry.');
    const handler = routes.entry[message.action] as Handler<EntryMessage, [Project, Entry]>;
    await handler(project, entry, message);
  };
}
