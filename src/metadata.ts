import { parseDocument } from 'yaml';
import { scanSource } from './scanner';
import { Diagnostic } from './types';
import type { InitialSetting, ParsedModSource } from './windhawk';

export interface ModMetadata {
  fields: Record<string, string[]>;
  readme?: string;
  settingsText?: string;
  settingsCount?: number;
  lines: Partial<Record<'metadata' | 'readme' | 'settings', number>>;
  diagnostics: Diagnostic[];
}

/** Read Windhawk's comment blocks without treating markers inside C++ strings as metadata. */
export function parseMetadata(source: string, file: string): ModMetadata {
  const result: ModMetadata = { fields: Object.create(null), lines: {}, diagnostics: [] };
  try {
    const comments = scanSource(source).comments;
    for (const [section, marker] of [['metadata', 'WindhawkMod'], ['readme', 'WindhawkModReadme'], ['settings', 'WindhawkModSettings']] as const) {
      const starts = comments.filter(comment => comment.kind === 'line' && comment.text.trim() === `// ==${marker}==` &&
        !source.slice(source.lastIndexOf('\n', comment.start - 1) + 1, comment.start).trim());
      if (!starts.length) {
        if (section === 'metadata') result.diagnostics.push({ path: file, line: 0, severity: 'warning', message: 'No Windhawk metadata block found.' });
        continue;
      }
      const start = starts[0]; result.lines[section] = start.line;
      if (starts.length > 1) result.diagnostics.push({ path: file, line: starts[1].line, severity: 'warning', message: `Duplicate ${marker} block.` });
      const end = comments.find(comment => comment.start >= start.end && comment.kind === 'line' && comment.text.trim() === `// ==/${marker}==` &&
        !source.slice(source.lastIndexOf('\n', comment.start - 1) + 1, comment.start).trim());
      if (!end) { result.diagnostics.push({ path: file, line: start.line, severity: 'warning', message: `Missing closing ${marker} marker.` }); continue; }
      if (section === 'metadata') {
        const lines = source.slice(start.end, end.start).split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].trim() || /^\s*\/\/\s*$/.test(lines[index])) continue;
          const field = /^\s*\/\/\s*@([A-Za-z][\w]*(?::[\w-]+)?)\s+(.+?)\s*$/.exec(lines[index]);
          if (!field) { result.diagnostics.push({ path: file, line: start.line + index + 1, severity: 'warning', message: 'Expected a Windhawk metadata line: // @key value.' }); continue; }
          const values = result.fields[field[1]] ??= [];
          if (values.length && !['include', 'exclude', 'architecture'].includes(field[1])) result.diagnostics.push({ path: file, line: start.line + index + 1, severity: 'warning', message: `Duplicate @${field[1]} value.` });
          values.push(field[2]);
        }
        for (const required of ['id', 'name', 'version']) if (!result.fields[required]?.length) result.diagnostics.push({ path: file, line: start.line, severity: 'warning', message: `Missing @${required} in Windhawk metadata.` });
        if (result.fields.id?.[0] && !/^[a-z0-9-]+$/.test(result.fields.id[0])) result.diagnostics.push({ path: file, line: start.line, severity: 'warning', message: '@id must contain lowercase letters, digits, and hyphens.' });
      } else {
        const body = comments.filter(comment => comment.start >= start.end && comment.end <= end.start);
        if (body.length !== 1 || body[0].kind !== 'block' || source.slice(start.end, body[0].start).trim() || source.slice(body[0].end, end.start).trim()) {
          result.diagnostics.push({ path: file, line: start.line, severity: 'warning', message: `${marker} must contain one /* ... */ comment.` }); continue;
        }
        const rawText = body[0].text.slice(2, -2), leadingNewline = /^\r?\n/.exec(rawText)?.[0].length ?? 0;
        const text = rawText.slice(leadingNewline).trimEnd();
        if (section === 'readme') result.readme = text;
        else {
          result.settingsText = text;
          const document = parseDocument(text);
          for (const error of document.errors) result.diagnostics.push({ path: file, line: source.slice(0, body[0].start + 2 + leadingNewline + (error.pos?.[0] ?? 0)).split('\n').length - 1,
            severity: 'warning', message: `Windhawk settings YAML: ${error.message}` });
          if (!document.errors.length) {
            const settings = document.toJS({ maxAliasCount: 100 });
            if (!Array.isArray(settings)) result.diagnostics.push({ path: file, line: start.line, severity: 'warning', message: 'Windhawk settings must be a YAML list.' });
            else result.settingsCount = settings.length;
          }
        }
      }
    }
  } catch (error) { result.diagnostics.push({ path: file, line: 0, severity: 'warning', message: `Could not parse Windhawk metadata: ${(error as Error).message}` }); }
  return result;
}

/** Convert Windhawk metadata/settings for preview when no native parser exists.
 * This is a display fallback, not Windhawk's compilation/schema validator. */
export function parseDraftSource(source: string, file: string, language: string): ParsedModSource {
  const parsed = parseMetadata(source, file);
  const result: ParsedModSource = { metadata: {}, readme: parsed.readme ?? null, initialSettings: null, errors: {} };
  // Keep localization selection local to the two places that need it.
  const localized = (entries: [string, unknown][], key: string) => {
    let candidate = language.toLowerCase();
    while (candidate) {
      const exact = entries.find(([field]) => field.toLowerCase() === key.toLowerCase() + ':' + candidate);
      const specific = entries.find(([field]) => field.toLowerCase().startsWith(key.toLowerCase() + ':' + candidate + '-'));
      if (exact || specific) return (exact ?? specific)![1];
      candidate = candidate.includes('-') ? candidate.slice(0, candidate.lastIndexOf('-')) : '';
    }
    return entries.find(([field]) => field === key)?.[1] ?? entries.find(([field]) => field.startsWith(key + ':'))?.[1];
  };
  for (const key of new Set(Object.keys(parsed.fields).map(field => field.split(':')[0]))) {
    const values = localized(Object.entries(parsed.fields), key) as string[];
    result.metadata![key] = ['include', 'exclude', 'architecture'].includes(key) ? values : values[0];
  }
  if (!result.metadata!.name) result.metadata!.name = file.split(/[\\/]/).pop() ?? 'Mod';
  if (parsed.settingsText !== undefined) {
    try {
      const document = parseDocument(parsed.settingsText.replace(/^(\s*)#! ?/gm, '$1'));
      if (document.errors.length) throw document.errors[0];
      const settingPaths = new Map<string, InitialSetting>();
      const conditionalSettings: { setting: InitialSetting; scope: string }[] = [];
      const convert = (items: unknown, depth = 0, scope = ''): InitialSetting[] => {
        if (!Array.isArray(items) || depth > 32) throw new Error('Settings must be a YAML list with at most 32 nested levels.');
        return items.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Each setting must be a YAML mapping.');
          const entries = Object.entries(item), keys = entries.filter(([key]) => !key.startsWith('$'));
          const annotations = Object.fromEntries(entries);
          if (keys.length !== 1) throw new Error('Each setting must have one value key.');
          const [key, value] = keys[0];
          const setting: InitialSetting = { key, value: value as InitialSetting['value'] };
          const settingPath = scope ? scope + '.' + key : key;
          settingPaths.set(settingPath, setting);
          const floating = annotations['$float'] === true;
          const scalar = (value: unknown): string | number | boolean => {
            if (floating) {
              if ((typeof value !== 'number' && typeof value !== 'string') || typeof value === 'number' && !Number.isInteger(value) || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(String(value)) || !Number.isFinite(Number(value))) throw new Error('Invalid floating-point default.');
              return String(Number(value));
            }
            if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isInteger(value)) throw new Error('Unsupported settings value.');
            return value as string | number | boolean;
          };
          if (Array.isArray(value)) {
            if (value.length && Array.isArray(value[0])) setting.value = value.map(group => convert(group, depth + 1, settingPath));
            else if (value.length && typeof value[0] === 'object') setting.value = convert(value, depth + 1, settingPath);
            else {
              const values = value.map(scalar);
              if (values.some(item => typeof item === 'boolean' || typeof item !== typeof values[0])) throw new Error('Unsupported settings array.');
              setting.value = values;
            }
          } else setting.value = scalar(value);
          for (const annotation of ['name', 'description', 'options']) {
            const selected = localized(entries, '$' + annotation);
            if (selected !== undefined) {
              if (annotation === 'options' ? !Array.isArray(selected) || selected.length < 2 || selected.some(option => !option || typeof option !== 'object' || Object.keys(option).length !== 1 || typeof Object.values(option)[0] !== 'string') : typeof selected !== 'string') throw new Error('Invalid annotation: ' + annotation);
              setting[annotation] = selected;
            }
          }
          for (const annotation of ['format', 'float', 'dynamicSelect', 'min', 'max', 'showIf', 'hideIf']) {
            const value = annotations['$' + annotation];
            if (value === undefined) continue;
            if (annotation === 'format') {
              if (typeof value !== 'string') throw new Error('Invalid $format.');
              setting.format = value;
            } else if (annotation === 'float' || annotation === 'dynamicSelect') {
              if (typeof value !== 'boolean') throw new Error('Invalid $' + annotation + '.');
              if (value) setting[annotation] = true;
            } else if (annotation === 'min' || annotation === 'max') {
              if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid $' + annotation + '.');
              setting[annotation] = value;
            } else {
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid $' + annotation + '.');
              setting[annotation] = Object.fromEntries(Object.entries(value).map(([path, values]) => {
                const choices = Array.isArray(values) ? values : [values];
                if (!choices.length || choices.some(choice => !['string', 'number', 'boolean'].includes(typeof choice))) throw new Error('Invalid $' + annotation + ' condition.');
                return [path, choices];
              }));
            }
          }
          if (floating || setting.min !== undefined || setting.max !== undefined) {
            const defaults = Array.isArray(setting.value) ? setting.value : [setting.value];
            if (defaults.some(value => floating ? typeof value !== 'string' : typeof value !== 'number')) throw new Error('Numeric annotations require numeric defaults.');
            if (defaults.some(value => typeof setting.min === 'number' && Number(value) < setting.min || typeof setting.max === 'number' && Number(value) > setting.max)) throw new Error('Default is outside $min/$max.');
          }
          if (typeof setting.min === 'number' && typeof setting.max === 'number' && setting.min > setting.max) throw new Error('$min exceeds $max.');
          if (setting.showIf || setting.hideIf) conditionalSettings.push({ setting, scope });
          if (entries.some(([key]) => key.startsWith('$') && !/^\$(name|description|options|format|float|dynamicSelect|min|max|showIf|hideIf)(:|$)|^\$_/.test(key))) throw new Error('Unsupported settings annotation.');
          return setting;
        });
      };
      result.initialSettings = convert(document.toJS({ maxAliasCount: 100 }));
      for (const { setting, scope } of conditionalSettings) for (const annotation of ['showIf', 'hideIf']) {
        if (!setting[annotation]) continue;
        const resolved: Record<string, unknown> = {};
        for (const [reference, values] of Object.entries(setting[annotation] as object)) {
          let parent = scope, path = reference;
          for (;;) {
            path = parent ? parent + '.' + reference : reference;
            if (settingPaths.has(path)) break;
            if (!parent) throw new Error('Unknown setting in $' + annotation + ': ' + reference);
            parent = parent.includes('.') ? parent.slice(0, parent.lastIndexOf('.')) : '';
          }
          resolved[path] = values;
        }
        setting[annotation] = resolved;
      }
    } catch (error) { result.initialSettings = null; result.errors.initialSettings = 'Settings preview: ' + (error as Error).message; }
  }
  return result;
}
