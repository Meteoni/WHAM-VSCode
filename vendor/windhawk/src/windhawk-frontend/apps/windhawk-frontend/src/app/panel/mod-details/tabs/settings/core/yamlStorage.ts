/**
 * Per-mod persistence of hand-formatted settings YAML.
 *
 * The settings editor regenerates YAML from the flat settings object, which
 * drops convenience data the object can't hold (comments, blank-line
 * separation). This module keeps the exact text a user saved so it can be
 * restored later - as long as it still represents the same settings, which the
 * caller verifies before reuse. Losing an entry is harmless; the editor falls
 * back to regenerating YAML from the settings.
 */

import { type ModKeyedStore, readModEntry, writeModEntry } from './modKeyedStorage';

const yamlStore: ModKeyedStore<string> = {
  storageKey: 'windhawk-modSettingsYaml',
  parseEntry: (value) => (typeof value === 'string' ? value : undefined),
};

export function readSavedYaml(modId: string): string | null {
  return readModEntry(yamlStore, modId);
}

export function saveYaml(modId: string, yaml: string): void {
  writeModEntry(yamlStore, modId, yaml);
}

// Exported for testing only.
export const exportedForTesting = {
  STORAGE_KEY: yamlStore.storageKey,
};
