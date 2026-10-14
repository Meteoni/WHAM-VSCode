/**
 * What a settings schema declares somewhere in it, at any depth - which is what
 * says whether the host has anything to be asked for on the editor's behalf -
 * and what it declares at one flat key. Pure: no React or IPC.
 */

import { type InitialSettingItem, type InitialSettings } from '@app/webviewIPCMessages';
import { describeSetting, SettingType } from './yamlConverter';

/**
 * Whether any item of the schema, at any depth, satisfies `predicate`.
 */
export function schemaSome(
  initialSettings: InitialSettings,
  predicate: (item: InitialSettingItem) => boolean
): boolean {
  return initialSettings.some((item) => {
    if (predicate(item)) {
      return true;
    }
    const descriptor = describeSetting(item.value);
    return (
      (descriptor.kind === SettingType.NestedObject ||
        descriptor.kind === SettingType.ObjectArray) &&
      schemaSome(descriptor.children, predicate)
    );
  });
}

/**
 * Whether any setting of the schema declares the given `$format`.
 */
export function schemaHasFormat(initialSettings: InitialSettings, format: string): boolean {
  return schemaSome(initialSettings, (item) => item.format === format);
}

/**
 * The item of the schema a flat key names (`a.b`, `a[2]`, `a[2].b`), or
 * undefined for a key the schema declares nothing at. A subscript lands on the
 * array's own item - an element of a value array is described by its array -
 * and one followed by more of the key descends into the template row, which
 * declares every row's members.
 */
export function schemaItemAt(
  initialSettings: InitialSettings,
  settingKey: string
): InitialSettingItem | undefined {
  let items = initialSettings;
  let item: InitialSettingItem | undefined;
  const segments = settingKey.split('.');
  for (const [index, segment] of segments.entries()) {
    const name = segment.replace(/\[\d+\]$/, '');
    item = items.find((candidate) => candidate.key === name);
    if (!item) {
      return undefined;
    }
    if (index === segments.length - 1) {
      break;
    }
    const descriptor = describeSetting(item.value);
    if (
      descriptor.kind !== SettingType.NestedObject &&
      descriptor.kind !== SettingType.ObjectArray
    ) {
      return undefined;
    }
    items = descriptor.children;
  }
  return item;
}
