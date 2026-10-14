/**
 * Which settings the form shows, from the `$showIf` / `$hideIf` conditions a
 * mod declares. A hidden setting is only hidden: it keeps its value, is saved
 * with the rest, and is read by the mod as before. Pure: no React or IPC.
 */

import { type InitialSettings } from '@app/webviewIPCMessages';
import { schemaItemAt } from './schemaQuery';
import { describeSetting, type ModSettings, parseIntLax, SettingType } from './yamlConverter';

type ConditionValue = boolean | number | string;

/**
 * The flat key of the setting a condition names, beside the setting carrying
 * the condition. The core resolves a condition's path to the named setting's
 * declaration path, which has no array subscripts, and every array on it
 * encloses the annotated setting - so the subscripts are the annotated
 * setting's own: its segments are copied for as long as they match the path's,
 * and the path's remainder appended. `columns.force_width` beside
 * `columns[2].width` is `columns[2].force_width`; `items.subItems.type` beside
 * `items[2].subItems[0].iconGlyph` is `items[2].subItems[0].type`.
 */
export function conditionKey(path: string, settingKey: string): string {
  const pathSegments = path.split('.');
  const keySegments = settingKey.split('.');
  const segments: string[] = [];
  for (const [index, pathSegment] of pathSegments.entries()) {
    const keySegment = keySegments[index];
    if (keySegment === undefined || keySegment.replace(/\[\d+\]$/, '') !== pathSegment) {
      segments.push(...pathSegments.slice(index));
      break;
    }
    segments.push(keySegment);
  }
  return segments.join('.');
}

/**
 * The key of the group or array a setting sits in, or null for a top-level
 * setting. A row of an object array is not a setting, so a member of one sits
 * in the array itself.
 */
function parentKey(settingKey: string): string | null {
  const dot = settingKey.lastIndexOf('.');
  if (dot === -1) {
    return null;
  }
  return settingKey.slice(0, dot).replace(/\[\d+\]$/, '');
}

/**
 * Whether a stored value is one a condition names, compared the way the control
 * reads it: a boolean as the 0/1 the store holds it as, an integer as a number,
 * a string as text.
 */
function conditionHolds(named: ConditionValue[], value: string | number | undefined): boolean {
  return named.some((candidate) => {
    switch (typeof candidate) {
      case 'boolean':
        return candidate === !!parseIntLax(value);
      case 'number':
        return candidate === parseIntLax(value);
      default:
        return candidate === String(value ?? '');
    }
  });
}

/**
 * Whether the form shows each setting, judged against the draft - the values
 * as they are in the form, before a save - so a switch reveals its settings
 * as it is turned. A setting is shown when its own conditions hold, every
 * setting they name is shown, and the group or array it sits in is shown: a
 * setting whose gate is hidden is hidden whatever the gate holds, so a chain
 * of switches names one link at a time. A group with nothing shown in it is
 * hidden along with its members, and so is a group left holding only such
 * groups. A key the draft does not hold reads as the mod's declared default.
 *
 * One memo over the flat keys for the whole form, so a gate shared by many
 * settings is judged once. The core rejects a cycle among the conditions, so
 * the recursion ends; the guard against re-entering a key only keeps a schema
 * the core did not check from looping.
 */
export function createSettingVisibility(
  initialSettings: InitialSettings,
  draft: ModSettings,
  defaults: ModSettings
): (settingKey: string) => boolean {
  const memo = new Map<string, boolean>();
  const judging = new Set<string>();

  // Whether the conditions on a setting, and on the groups and arrays above
  // it, let it be shown. What a group holds is not asked here: a member asks
  // for its group, so a group asking for its members would loop.
  const isShown = (settingKey: string): boolean => {
    const known = memo.get(settingKey);
    if (known !== undefined) {
      return known;
    }
    if (judging.has(settingKey)) {
      return true;
    }
    judging.add(settingKey);

    const item = schemaItemAt(initialSettings, settingKey);
    const conditions = [
      ...Object.entries(item?.showIf ?? {}).map(([path, named]) => ({ path, named, shows: true })),
      ...Object.entries(item?.hideIf ?? {}).map(([path, named]) => ({ path, named, shows: false })),
    ];
    const parent = parentKey(settingKey);
    const shown =
      (parent === null || isShown(parent)) &&
      conditions.every(({ path, named, shows }) => {
        const gateKey = conditionKey(path, settingKey);
        return (
          isShown(gateKey) &&
          conditionHolds(named, draft[gateKey] ?? defaults[gateKey]) === shows
        );
      });

    judging.delete(settingKey);
    memo.set(settingKey, shown);
    return shown;
  };

  const isVisible = (settingKey: string): boolean => {
    if (!isShown(settingKey)) {
      return false;
    }
    const item = schemaItemAt(initialSettings, settingKey);
    const descriptor = item && describeSetting(item.value);
    return (
      descriptor?.kind !== SettingType.NestedObject ||
      descriptor.children.some((child) => isVisible(`${settingKey}.${child.key}`))
    );
  };

  return isVisible;
}
