import type { Memento } from 'vscode';
import { pathKey } from './projects';
import { editorDefaults, EditorSettings } from './setup';

export interface InstallationPreferences {
  elevation: 'none' | 'sudo' | 'gsudo';
  gsudoPath: string;
}
export interface LocalPreferences {
  version: 2;
  /** Before VS Code settings held these. Kept, unchanged, for older WHAM versions. */
  computer: {
    installationPath: string;
    integration: EditorSettings['integration'];
    installations: Record<string, InstallationPreferences>;
  };
  /** Kept for older WHAM versions. A project's language service now comes from its editor files. */
  projects: Record<string, { integration?: EditorSettings['integration'] }>;
}

/** Local extension storage is never written into a project or opted into Settings Sync. */
export async function loadLocalPreferences(global: Memento, workspace: Memento): Promise<LocalPreferences> {
  const saved = global.get<{
    version: number;
    computer: LocalPreferences['computer'];
    projects: Record<string, Partial<EditorSettings>>;
  }>('localPreferences');
  if (saved?.version === 2) return saved as LocalPreferences;
  const preferences: LocalPreferences = {
    version: 2,
    computer:
      saved?.version === 1
        ? saved.computer
        : { installationPath: '', integration: editorDefaults.integration, installations: {} },
    projects: {}
  };
  const legacy =
    saved?.version === 1
      ? saved.projects
      : {
          ...workspace.get<Record<string, EditorSettings>>('editorSettings', {}),
          ...global.get<Record<string, EditorSettings>>('editorSettings', {})
        };
  // Keep the selected global installation, or adopt the most recent project's
  // previous choice. Project formatting stays in its files.
  if (!preferences.computer.installationPath) {
    const roots = [...global.get<string[]>('recentProjects', []), ...Object.keys(legacy)];
    preferences.computer.installationPath = roots.map(root => legacy[root]?.installationPath).find(Boolean) ?? '';
  }
  for (const [root, editor] of Object.entries(legacy))
    preferences.projects[root] = editor.integration ? { integration: editor.integration } : {};
  await global.update('localPreferences', preferences);
  return preferences;
}

/** Preferences for every project on this computer, held in VS Code settings. */
export interface ComputerPreferences extends InstallationPreferences {
  installationPath: string;
  integration: EditorSettings['integration'];
}
/** The `wham.*` setting for each preference. Paths and elevation are `machine` scoped, so not synced. */
export const computerSettings = {
  installationPath: 'windhawkPath',
  elevation: 'elevation',
  gsudoPath: 'gsudoPath',
  integration: 'languageService'
} as const satisfies Record<keyof ComputerPreferences, string>;
const computerDefaults: ComputerPreferences = {
  installationPath: '',
  elevation: 'none',
  gsudoPath: '',
  integration: editorDefaults.integration
};

/** Read settings as preferences. A hand-edited value of the wrong kind reads as the default. */
export function readComputerPreferences(get: (setting: string) => unknown): ComputerPreferences {
  const text = (setting: string) => {
    const value = get(setting);
    return typeof value === 'string' ? value.trim() : '';
  };
  const choice = <T extends string>(setting: string, choices: readonly T[], fallback: T): T => {
    const value = get(setting);
    return choices.includes(value as T) ? (value as T) : fallback;
  };
  return {
    installationPath: text(computerSettings.installationPath),
    elevation: choice(computerSettings.elevation, ['none', 'sudo', 'gsudo'], computerDefaults.elevation),
    gsudoPath: text(computerSettings.gsudoPath),
    integration: choice(computerSettings.integration, ['cpp', 'clangd', 'both'], computerDefaults.integration)
  };
}

/**
 * Copy what earlier versions kept in extension storage into settings, once. Settings that are
 * already set win, and defaults are not written. Elevation was kept per installation; the
 * selected installation's choice becomes the setting.
 */
export async function migrateComputerPreferences(
  global: Memento,
  preferences: LocalPreferences,
  settings: { isSet(setting: string): boolean; set(setting: string, value: string): PromiseLike<unknown> }
): Promise<void> {
  if (global.get<boolean>('computerPreferencesMigrated')) return;
  const computer = preferences.computer;
  const installationPath = typeof computer?.installationPath === 'string' ? computer.installationPath.trim() : '';
  const installation = installationPath ? computer.installations?.[pathKey(installationPath)] : undefined;
  const stored = {
    windhawkPath: installationPath,
    languageService: computer?.integration,
    elevation: installation?.elevation,
    gsudoPath: installation?.gsudoPath
  };
  const saved = readComputerPreferences(setting => stored[setting as keyof typeof stored]);
  for (const key of Object.keys(computerSettings) as (keyof ComputerPreferences)[])
    if (saved[key] && saved[key] !== computerDefaults[key] && !settings.isSet(computerSettings[key]))
      await settings.set(computerSettings[key], saved[key]);
  await global.update('computerPreferencesMigrated', true);
}
