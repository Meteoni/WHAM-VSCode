import type { Memento } from 'vscode';
import { editorDefaults, EditorSettings } from './setup';

export interface InstallationPreferences {
  elevation: 'none' | 'sudo' | 'gsudo';
  gsudoPath: string;
}
export interface LocalPreferences {
  version: 2;
  computer: { installationPath: string; integration: EditorSettings['integration']; installations: Record<string, InstallationPreferences> };
  projects: Record<string, { integration?: EditorSettings['integration'] }>;
}

/** Local extension storage is never written into a project or opted into Settings Sync. */
export async function loadLocalPreferences(global: Memento, workspace: Memento): Promise<LocalPreferences> {
  const saved = global.get<{ version: number; computer: LocalPreferences['computer']; projects: Record<string, Partial<EditorSettings>> }>('localPreferences');
  if (saved?.version === 2) return saved as LocalPreferences;
  const preferences: LocalPreferences = {
    version: 2, computer: saved?.version === 1 ? saved.computer : { installationPath: '', integration: editorDefaults.integration, installations: {} }, projects: {}
  };
  const legacy = saved?.version === 1 ? saved.projects : { ...workspace.get<Record<string, EditorSettings>>('editorSettings', {}), ...global.get<Record<string, EditorSettings>>('editorSettings', {}) };
  // Keep the selected global installation, or adopt the most recent project's
  // previous choice. Project formatting stays in its files.
  if (!preferences.computer.installationPath) {
    const roots = [...global.get<string[]>('recentProjects', []), ...Object.keys(legacy)];
    preferences.computer.installationPath = roots.map(root => legacy[root]?.installationPath).find(Boolean) ?? '';
  }
  for (const [root, editor] of Object.entries(legacy)) preferences.projects[root] = editor.integration ? { integration: editor.integration } : {};
  await global.update('localPreferences', preferences);
  return preferences;
}
