/**
 * A localStorage map keyed by mod id: one JSON object per store, holding what a
 * screen keeps about each mod between visits.
 *
 * Best-effort, on top of utils/storage: closed or full storage reads as nothing
 * kept, and what is kept this way is something the screen runs fine without.
 * The map is bounded to the mods most recently written - a write re-inserts its
 * mod at the end, and the oldest entries are dropped past the cap - so it prunes
 * itself as mods come and go.
 */

import { readStoredValue, writeStoredValue } from '@app/utils';

// Cap on the mods a store keeps entries for. An entry is KB-scale at most, so
// this stays well under the localStorage quota.
const MAX_STORED_MODS = 500;

export interface ModKeyedStore<T> {
  storageKey: string;

  // What an entry read back has to be to count. Anything else is dropped, so a
  // malformed map degrades to entries missing rather than to junk handed out.
  parseEntry: (value: unknown) => T | undefined;
}

// The stored object, or null for text that is not one: that comes to the same
// thing as nothing stored.
function parseStoredMap(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Insertion-ordered, which is what the eviction relies on, and free of the
// prototype a plain object would answer a mod id like "constructor" from.
function readMap<T>(store: ModKeyedStore<T>): Map<string, T> {
  const map = new Map<string, T>();

  const raw = readStoredValue(store.storageKey);
  const parsed = raw ? parseStoredMap(raw) : null;
  if (parsed) {
    for (const [modId, value] of Object.entries(parsed)) {
      const entry = store.parseEntry(value);
      if (entry !== undefined) {
        map.set(modId, entry);
      }
    }
  }

  return map;
}

export function readModEntry<T>(store: ModKeyedStore<T>, modId: string): T | null {
  const entry = readMap(store).get(modId);
  return entry === undefined ? null : entry;
}

/**
 * Writes the mod's entry as the most recently written, or removes it for null.
 */
export function writeModEntry<T>(
  store: ModKeyedStore<T>,
  modId: string,
  value: T | null
): void {
  const map = readMap(store);

  map.delete(modId);
  if (value !== null) {
    map.set(modId, value);
  }

  const modIds = [...map.keys()];
  for (const staleModId of modIds.slice(0, Math.max(0, modIds.length - MAX_STORED_MODS))) {
    map.delete(staleModId);
  }

  writeStoredValue(store.storageKey, JSON.stringify(Object.fromEntries(map)));
}

// Exported for testing only.
export const exportedForTesting = {
  MAX_STORED_MODS,
};
