import { parseDocument } from 'yaml';
import { scanSource } from './scanner';
import { Diagnostic } from './types';

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
