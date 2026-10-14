/**
 * Per-mod persistence of which settings are folded away in the form.
 *
 * Keyed the way the form keys its rows (`a.b`, `a[2]`), so a fold is remembered
 * as of the form it was left in: one carried along by an edit to the rows is
 * stored where the edit put it, whether or not the edit is then saved. A key
 * naming nothing the mod has is left alone and simply matches no row.
 */

import { type ModKeyedStore, readModEntry, writeModEntry } from './modKeyedStorage';

const collapsedStore: ModKeyedStore<string[]> = {
  storageKey: 'windhawk-modSettingsCollapsed',
  parseEntry: (value) =>
    Array.isArray(value)
      ? value.filter((key): key is string => typeof key === 'string')
      : undefined,
};

export function readCollapsedKeys(modId: string): Set<string> {
  return new Set(readModEntry(collapsedStore, modId) ?? []);
}

// A mod with nothing folded takes no entry, the same as one never visited.
export function writeCollapsedKeys(modId: string, keys: ReadonlySet<string>): void {
  writeModEntry(collapsedStore, modId, keys.size > 0 ? [...keys] : null);
}

// Exported for testing only.
export const exportedForTesting = {
  STORAGE_KEY: collapsedStore.storageKey,
};
