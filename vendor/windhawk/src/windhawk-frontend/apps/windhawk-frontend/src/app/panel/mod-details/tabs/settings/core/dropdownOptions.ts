/**
 * What a setting drawn as a dropdown offers.
 *
 * A dropdown's options come from up to two places: the `$options` a mod declares
 * in its settings block, and for a `$dynamicSelect` setting the entries the mod
 * wrote at runtime, which the host serves keyed by setting path. The list a
 * dropdown draws is the two merged, with the value it is holding always among
 * them. Pure: no React or IPC.
 */

import {
  type DynamicSelectOption,
  type InitialSettingItem,
  type InitialSettings,
} from '@app/webviewIPCMessages';
import { schemaSome } from './schemaQuery';

export type DropdownOption = DynamicSelectOption;

/**
 * The options a mod declares on a setting: the value each stores, and the label
 * it carries. A setting declaring none offers nothing.
 */
export function staticOptions(item: Pick<InitialSettingItem, 'options'>): DropdownOption[] {
  return (item.options ?? []).map((option) => {
    const [value, label] = Object.entries(option)[0];
    return { value, label };
  });
}

/**
 * The path a mod writes a setting's runtime options under: its flat key with
 * every array index removed, so every row of an object array and every element
 * of a string array offers the one set the mod wrote for the declaration.
 */
export function dynamicSelectPath(settingKey: string): string {
  return settingKey.replace(/\[\d+\]/g, '');
}

/**
 * The list a dropdown draws for the setting at `settingKey`: the declared
 * options first, then for a `$dynamicSelect` setting the runtime ones, and
 * last the value the setting holds when neither names it, labeled as itself,
 * so a selection the mod no longer offers (an unplugged device) stays selected
 * and readable rather than vanishing. A runtime option naming a value a
 * declared one does takes over that entry's label and keeps its place: the
 * declared entry is the mod's fixed "Default" or "None" above a list it fills
 * in at runtime, and the runtime write is how it relabels it. An empty stored
 * value is not made an entry: an unset setting is the dropdown's placeholder,
 * unless an option names `''` as a value.
 *
 * A dropdown of declared options alone is left as declared: a value outside
 * them is one the mod does not take, and is shown as itself in the closed
 * control without being made an entry of the list - which antd would open
 * scrolled to.
 */
export function dropdownOptions(
  item: Pick<InitialSettingItem, 'options' | 'dynamicSelect'>,
  settingKey: string,
  dynamicSelectOptions: Record<string, DropdownOption[]>,
  storedValue: string
): DropdownOption[] {
  const options = staticOptions(item);
  if (!item.dynamicSelect) {
    return options;
  }

  const slots = new Map(options.map((option, index) => [option.value, index]));
  for (const option of dynamicSelectOptions[dynamicSelectPath(settingKey)] ?? []) {
    const slot = slots.get(option.value);
    if (slot === undefined) {
      slots.set(option.value, options.length);
      options.push(option);
    } else {
      options[slot] = option;
    }
  }

  if (storedValue !== '' && !slots.has(storedValue)) {
    options.push({ value: storedValue, label: storedValue });
  }

  return options;
}

/**
 * How a stored value reads on a dropdown: the label its option carries. A value
 * no option names reads as itself.
 */
export function optionLabel(options: DropdownOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * Whether any setting of a schema, at any depth, fills its dropdown at runtime -
 * which is whether the host has anything to be asked for.
 */
export function schemaHasDynamicSelect(initialSettings: InitialSettings): boolean {
  return schemaSome(initialSettings, (item) => !!item.dynamicSelect);
}
