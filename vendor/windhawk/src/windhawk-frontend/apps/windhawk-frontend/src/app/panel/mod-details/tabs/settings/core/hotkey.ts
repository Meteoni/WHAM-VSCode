/**
 * The `hotkey` format: a keyboard chord stored as `[ctrl+][alt+][shift+][win+]<vk>`,
 * the modifiers held spelled exactly so, lowercase and in that order, then the
 * Windows virtual-key code of the key as a decimal number (1..254, no leading
 * zeros). `ctrl+alt+84` is Ctrl+Alt+T; `116` is F5 alone; the empty string is
 * no hotkey. A mod reads the modifiers with `wcsstr` and the key with `_wtoi`,
 * so the spelling is exact: `Ctrl+65` and `alt+ctrl+65` are not hotkeys to it,
 * and not to the parser here either. Pure: no React or IPC.
 */

export type HotkeyModifiers = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
};

export type HotkeyChord = HotkeyModifiers & {
  // The virtual-key code, 1..254.
  vk: number;
};

export const NO_MODIFIERS: HotkeyModifiers = {
  ctrl: false,
  alt: false,
  shift: false,
  win: false,
};

// The modifiers in the order the stored form spells them - each by the word
// it is stored as, which is the field's own name - with the label a person
// reads it by.
export const MODIFIER_NAMES: ReadonlyArray<[keyof HotkeyModifiers, string]> = [
  ['ctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['win', 'Win'],
];

const VK_MIN = 1;
const VK_MAX = 254;

// The codes that are not the key of a chord: the modifiers (VK_SHIFT / CONTROL /
// MENU, the two Win keys, and the left/right variants), which a chord holds
// rather than ends on, and the mouse buttons, which no keyboard presses.
const MODIFIER_VKS = new Set([16, 17, 18, 91, 92, 160, 161, 162, 163, 164, 165]);
const MOUSE_BUTTON_VKS = new Set([1, 2, 4, 5, 6]);

const HOTKEY_PATTERN = /^(ctrl\+)?(alt\+)?(shift\+)?(win\+)?([1-9]\d{0,2})$/;

/**
 * The chord a stored value spells, or null for text that is not a hotkey - the
 * empty string, an older spelling such as `Ctrl+Alt+T`, or a hand edit.
 */
export function parseHotkey(text: string): HotkeyChord | null {
  const match = HOTKEY_PATTERN.exec(text);
  if (!match) {
    return null;
  }
  const vk = Number(match[5]);
  if (vk < VK_MIN || vk > VK_MAX) {
    return null;
  }
  return {
    ctrl: match[1] !== undefined,
    alt: match[2] !== undefined,
    shift: match[3] !== undefined,
    win: match[4] !== undefined,
    vk,
  };
}

/**
 * The stored form of a chord: the modifiers held, in order, then the key code.
 */
export function formatHotkey(chord: HotkeyChord): string {
  return modifierPrefix(chord, (word) => word) + String(chord.vk);
}

function modifierPrefix(
  modifiers: HotkeyModifiers,
  spell: (word: keyof HotkeyModifiers, label: string) => string
): string {
  return MODIFIER_NAMES.filter(([word]) => modifiers[word])
    .map(([word, label]) => `${spell(word, label)}+`)
    .join('');
}

/**
 * The chord as a person reads it: the modifiers by their labels, then the key
 * by name (`Ctrl+Alt+T`, `F5`). Display only; the stored form is lowercase.
 */
export function hotkeyLabel(chord: HotkeyChord): string {
  return modifierPrefix(chord, (_word, label) => label) + vkLabel(chord.vk);
}

export type KeyOption = {
  vk: number;
  label: string;
};

/**
 * The keys a manual editor lists: every code a chord can end on, in code
 * order, each by the name the badge draws it with. The modifiers and the mouse
 * buttons are left out; a code with no name of its own is listed as `VK 0xNN`,
 * since a key this keyboard lacks may still be the one a mod is for.
 */
export function keyOptions(): KeyOption[] {
  const options: KeyOption[] = [];
  for (let vk = VK_MIN; vk <= VK_MAX; vk++) {
    if (!MODIFIER_VKS.has(vk) && !MOUSE_BUTTON_VKS.has(vk)) {
      options.push({ vk, label: vkLabel(vk) });
    }
  }
  return options;
}

/**
 * Whether a key matches what was typed into the list's search: its name, by
 * case-insensitive substring, or its code, by decimal prefix - so `116` and
 * `f5` both find F5, and a number typed is the number input the editor would
 * otherwise need.
 */
export function keyOptionMatches(option: KeyOption, search: string): boolean {
  const text = search.trim();
  if (text === '') {
    return true;
  }
  if (/^\d+$/.test(text)) {
    return String(option.vk).startsWith(text);
  }
  return option.label.toLowerCase().includes(text.toLowerCase());
}

// Keys with a name of their own. Letters and digits read as themselves, and
// the OEM punctuation keys by their US-layout character (with the number in
// the tooltip, since the glyph is the layout's); anything else is `VK 0xNN`.
const VK_NAMES: Record<number, string> = {
  8: 'Backspace',
  9: 'Tab',
  12: 'Clear',
  13: 'Enter',
  19: 'Pause',
  20: 'Caps Lock',
  27: 'Esc',
  32: 'Space',
  33: 'PgUp',
  34: 'PgDn',
  35: 'End',
  36: 'Home',
  37: 'Left',
  38: 'Up',
  39: 'Right',
  40: 'Down',
  41: 'Select',
  42: 'Print',
  43: 'Execute',
  44: 'Print Screen',
  45: 'Insert',
  46: 'Delete',
  47: 'Help',
  93: 'Menu',
  95: 'Sleep',
  106: 'Num *',
  107: 'Num +',
  108: 'Separator',
  109: 'Num -',
  110: 'Num .',
  111: 'Num /',
  144: 'Num Lock',
  145: 'Scroll Lock',
  166: 'Browser Back',
  167: 'Browser Forward',
  168: 'Browser Refresh',
  169: 'Browser Stop',
  170: 'Browser Search',
  171: 'Browser Favorites',
  172: 'Browser Home',
  173: 'Volume Mute',
  174: 'Volume Down',
  175: 'Volume Up',
  176: 'Media Next',
  177: 'Media Previous',
  178: 'Media Stop',
  179: 'Media Play/Pause',
  180: 'Mail',
  181: 'Media Select',
  182: 'App 1',
  183: 'App 2',
  186: ';',
  187: '=',
  188: ',',
  189: '-',
  190: '.',
  191: '/',
  192: '`',
  219: '[',
  220: '\\',
  221: ']',
  222: "'",
  // The extra key of a 102-key layout, told apart from VK_OEM_5 above.
  226: '\\ (OEM 102)',
};

const VK_DIGIT_0 = 48;
const VK_DIGIT_9 = 57;
const VK_A = 65;
const VK_Z = 90;
const VK_NUMPAD_0 = 96;
const VK_NUMPAD_9 = 105;
const VK_F1 = 112;
const VK_F24 = 135;

/**
 * The name the key box and the read-only rendering show a key by. The stored
 * value carries the number; this is display only.
 */
export function vkLabel(vk: number): string {
  if ((vk >= VK_DIGIT_0 && vk <= VK_DIGIT_9) || (vk >= VK_A && vk <= VK_Z)) {
    return String.fromCharCode(vk);
  }
  if (vk >= VK_NUMPAD_0 && vk <= VK_NUMPAD_9) {
    return `Num ${vk - VK_NUMPAD_0}`;
  }
  if (vk >= VK_F1 && vk <= VK_F24) {
    return `F${vk - VK_F1 + 1}`;
  }
  return VK_NAMES[vk] ?? `VK 0x${vk.toString(16).toUpperCase().padStart(2, '0')}`;
}
