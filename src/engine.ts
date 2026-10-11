import path from 'node:path';
import { createHash } from 'node:crypto';
import { contained, portablePath, validateConfig } from './config';
import { scanSource } from './scanner';
import { FileAccess, GenerationResult, Manifest, Project, RecoveryData, RestoreCandidate, RestoreResult } from './types';

export const checksum = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const utf8 = (bytes: Buffer): string => {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('NUL bytes are not supported in C++ sources.');
  return text;
};

/** Normalize legacy JSON markers and compact v2 boundaries for the same recovery algorithm. */
function recoveryMarkers(source: string) {
  const comments = scanSource(source).records, footer = comments.at(-1);
  const compact = footer?.text.startsWith('// WHAM@2 recovery ');
  const manifest = compact ? JSON.parse(footer!.text.slice('// WHAM@2 recovery '.length)) as Manifest : undefined;
  const data = new Map<number, RecoveryData>(), used = new Set<number>();
  if (manifest) {
    if (manifest.type !== 'manifest' || manifest.version !== 2 || !Array.isArray(manifest.records)) throw new Error('Malformed v2 recovery data.');
    for (const record of manifest.records) {
      if (!record || !['include', 'transform'].includes(record.type) || !Number.isSafeInteger(record.id) || record.id < 1 || data.has(record.id)) throw new Error('Invalid or duplicate recovery data ID.');
      if (record.directive !== undefined && typeof record.directive !== 'string') throw new Error('Invalid original directive.');
      data.set(record.id, record);
    }
  }
  const records = comments.map(comment => {
    if (comment.start !== 0 && !(comment.start === 1 && source[0] === '\uFEFF') && source[comment.start - 1] !== '\n') throw new Error('Recovery marker is not on a separate line.');
    let value;
    if (!compact) {
      if (!comment.text.startsWith('// WHAM@1 ')) throw new Error('Unsupported WHAM format version.');
      value = JSON.parse(comment.text.slice('// WHAM@1 '.length));
    } else if (comment === footer) value = manifest;
    else {
      const opening = /^\/\/ WHAM@2 (begin|transform) ([1-9]\d*): (.+)$/.exec(comment.text);
      const closing = /^\/\/ WHAM@2 (end|end-transform) ([1-9]\d*)$/.exec(comment.text);
      if (opening) {
        const id = Number(opening[2]), item = data.get(id), type = opening[1] === 'begin' ? 'include' : 'transform';
        if (!item || item.type !== type || used.has(id) || opening[3] !== (type === 'include' ? item.path : item.kind)) throw new Error('Boundary does not match recovery data.');
        used.add(id);
        value = { ...item, original: Buffer.from(item.directive ?? '', 'utf8').toString('base64'), before: item.separatorBefore ?? '', tail: item.separatorAfter ?? '' };
      } else if (closing) value = { type: closing[1] === 'end' ? 'include-end' : 'transform-end', id: Number(closing[2]) };
      else throw new Error('Malformed or unsupported WHAM boundary.');
    }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') throw new Error('Malformed recovery record.');
    return { ...comment, value };
  });
  if (compact && used.size !== data.size) throw new Error('Unused recovery data.');
  if (records.at(-1)?.value.type === 'manifest' && records.at(-1)!.value.version !== (compact ? 2 : 1)) throw new Error('Unsupported WHAM format version.');
  return records;
}

/** Expand local includes in place, preserving readable source and reversible transformations. */
export async function generateEntry(project: Project, entryPath: string, files: FileAccess): Promise<GenerationResult> {
  const result: GenerationResult = { dependencies: new Map(), attempts: [], spans: [], diagnostics: [] };
  const manifestFiles = new Map<string, { path: string; hash: string; bom: boolean }>();
  const identities = new Map<string, string>();
  const recoveryData: RecoveryData[] = [];
  const marker = (record: { type: string; id: number; path?: string; kind?: string; original?: string; before?: string; tail?: string; hash?: string }): string => {
    if (record.type === 'include' || record.type === 'transform') {
      recoveryData.push({ type: record.type, id: record.id,
        ...(record.path !== undefined ? { path: record.path } : {}), ...(record.kind !== undefined ? { kind: record.kind } : {}),
        ...(record.original ? { directive: record.original } : {}),
        ...(record.before ? { separatorBefore: record.before } : {}), ...(record.tail ? { separatorAfter: record.tail } : {}),
        ...(record.hash !== undefined ? { hash: record.hash } : {}) });
      return `// WHAM@2 ${record.type === 'include' ? 'begin' : 'transform'} ${record.id}: ${record.path ?? record.kind}\n`;
    }
    return `// WHAM@2 ${record.type === 'include-end' ? 'end' : 'end-transform'} ${record.id}\n`;
  };
  const sourceRoot = path.resolve(project.root, project.config.sourceDirectory);
  let nextId = 1, generatedSize = 0;
  const report = (file: string, line: number, message: string, severity: 'error' | 'warning' = 'error') => result.diagnostics.push({ path: file, line, message, severity });
  try {
    validateConfig(project.config);
    const canonicalRoot = await files.identity(sourceRoot);
    const expand = async (file: string, stack: string[]): Promise<string> => {
      if (stack.length >= 64) throw new Error('Expansion exceeds 64 levels. Reduce recursive include depth.');
      if (!contained(sourceRoot, file)) throw new Error(`Local include escapes source root: ${file}`);
      const canonical = await files.identity(file);
      if (!contained(canonicalRoot, canonical)) throw new Error(`Symlink escapes source root: ${file}`);
      if (stack.includes(canonical)) throw new Error(`Include cycle: ${[...stack, canonical].map(item => path.relative(project.root, item)).join(' -> ')}`);
      const display = path.relative(project.root, file).split(path.sep).join('/');
      portablePath(display);
      const recorded = identities.get(canonical);
      if (recorded && recorded !== display) throw new Error(`Ambiguous file identity: ${recorded} and ${display}`);
      identities.set(canonical, display);
      const bytes = await files.read(file), hash = checksum(bytes);
      if (bytes.length > 16 * 1024 * 1024) throw new Error(`Source exceeds 16 MiB: ${display}`);
      const priorHash = result.dependencies.get(canonical);
      if (priorHash && priorHash !== hash) throw new Error(`Source changed during generation: ${display}`);
      result.dependencies.set(canonical, hash);
      const decoded = utf8(bytes), bom = decoded.startsWith('\uFEFF');
      manifestFiles.set(display, { path: display, hash, bom });
      if (manifestFiles.size > 10000) throw new Error('More than 10000 source files participate in one entry.');
      const source = bom ? decoded.slice(1) : decoded;
      const scan = scanSource(source);
      if (scan.records.length) throw new Error(`Reserved WHAM recovery comment in ${display}`);
      if (/\b(?:__INCLUDE_LEVEL__|__BASE_FILE__|__COUNTER__)\b/.test(scan.code)) report(file, 0, 'File-specific preprocessing extensions may change behavior after amalgamation.', 'warning');
      if (/^\s*(?:export\s+)?(?:import|module)\s+[\w:<]/m.test(scan.code)) throw new Error(`C++ modules are unsupported: ${display}`);
      if (/\b__has_include\s*\(/.test(scan.code)) throw new Error(`__has_include is unsupported because its file tests change after bundling: ${display}`);
      let cursor = 0, output = '', conditionDepth = 0, once = false;
      const transform = (directiveStart: number, original: string, generated: string, kind: string): string => {
        const id = nextId++, before = directiveStart > 0 && source[directiveStart - 1] !== '\n' ? '\n' : '';
        return before + marker({ type: 'transform', id, kind, original, before, hash: checksum(generated) }) + generated + marker({ type: 'transform-end', id });
      };
      for (const directive of scan.directives) {
        const { start, end, line, name, argument } = directive;
        if (['if', 'ifdef', 'ifndef'].includes(name)) conditionDepth++;
        if (name === 'endif') conditionDepth--;
        if (name === 'include_next') { report(file, line, '#include_next is unsupported.'); continue; }
        if (name === 'pragma' && /^once\b/.test(argument)) {
          const prefix = scanSource(source.slice(0, start));
          if (argument !== 'once' || conditionDepth !== 0 || once || prefix.code.trim()) {
            report(file, line, '#pragma once must be unconditional and before other code or directives.'); continue;
          }
          once = true;
          output += source.slice(cursor, start) + transform(start, source.slice(start, end), '', 'pragma-once'); cursor = end; continue;
        }
        if (name !== 'include') continue;
        const literal = /^(?:"([^"\r\n]+)"|<([^>\r\n]+)>)$/.exec(argument);
        if (!literal) {
          if (!project.config.externalIncludes.includes(argument)) report(file, line, `Macro include ${argument} needs an explicit externalIncludes rule.`);
          continue;
        }
        const includeName = literal[1] ?? literal[2], quoted = literal[1] !== undefined;
        if (project.config.externalIncludes.includes(includeName) || (!quoted && !project.config.inlineAngleIncludes)) continue;
        const search = [...(quoted ? [path.dirname(file)] : []), ...project.config.includeDirectories.map(directory => path.resolve(project.root, directory))];
        let target: string | undefined;
        for (const directory of search) {
          const candidate = path.resolve(directory, includeName);
          result.attempts.push(candidate);
          try { await files.identity(candidate); target = candidate; break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error; }
        }
        if (!target) {
          if (quoted) report(file, line, `Missing local include "${includeName}". All conditional branches are bundled; add an externalIncludes rule for SDK headers. Searched: ${search.join(', ')}`);
          continue;
        }
        if (!contained(sourceRoot, target)) { report(file, line, `Include "${includeName}" resolves outside the supported source root.`); continue; }
        const id = nextId++, before = start > 0 && source[start - 1] !== '\n' ? '\n' : '';
        let child: string;
        try { child = await expand(target, [...stack, canonical]); }
        catch (error) { report(file, line, (error as Error).message); continue; }
        const tail = child && !child.endsWith('\n') ? '\n' : '';
        const childPath = path.relative(project.root, target).split(path.sep).join('/');
        const expansion = before + marker({ type: 'include', id, path: childPath, original: source.slice(start, end), before, tail }) + child + tail + marker({ type: 'include-end', id });
        output += source.slice(cursor, start) + expansion;
        cursor = end;
      }
      output += source.slice(cursor);
      if (once) {
        const guard = 'WHAM_ONCE_' + checksum(display).slice(0, 24).toUpperCase();
        const open = `#ifndef ${guard}\n#define ${guard}\n`, close = `#endif // ${guard}\n`;
        const id = nextId++;
        const tail = output && !output.endsWith('\n') ? '\n' : '';
        output = marker({ type: 'transform', id, kind: 'guard-open', original: '', before: '', hash: checksum(open) }) + open + marker({ type: 'transform-end', id }) + output + tail +
          marker({ type: 'transform', id: nextId, kind: 'guard-close', original: '', before: tail, hash: checksum(close) }) + close + marker({ type: 'transform-end', id: nextId++ });
      }
      generatedSize += Buffer.byteLength(output);
      if (generatedSize > 64 * 1024 * 1024) throw new Error('Expanded output exceeds 64 MiB. Reduce repeated includes.');
      return stack.length === 0 && bom ? '\uFEFF' + output : output;
    };
    const body = await expand(path.resolve(entryPath), []);
    if (result.diagnostics.some(item => item.severity === 'error')) return result;
    const root = path.relative(project.root, entryPath).split(path.sep).join('/');
    const rootRelative = path.posix.relative(project.config.sourceDirectory, root);
    const config = { ...project.config, entries: [rootRelative.replace(/([*?\[\]{}()!+@])/g, '[$1]')], exclude: [] };
    const tail = body && !body.endsWith('\n') ? '\n' : '';
    const manifest: Manifest = { type: 'manifest', version: 2, root, files: [...manifestFiles.values()].sort((a, b) => a.path.localeCompare(b.path)), config, tail,
      records: recoveryData.sort((left, right) => left.id - right.id) };
    const container = body + tail + '// WHAM@2 recovery ' + JSON.stringify(manifest) + '\n';
    if (Buffer.byteLength(container) > 64 * 1024 * 1024) throw new Error('Recovery container exceeds 64 MiB.');
    result.bytes = Buffer.from(container);
    // Recompute spans against the final container so nested includes and guards
    // cannot shift recorded offsets. Offsets are UTF-16 indexes, as used by VS Code.
    result.spans = [];
    const regions = [{ path: entryPath, sourceLine: 0, directiveLines: 0, tail: '' }];
    const recoveryRecords = recoveryMarkers(container);
    let spanCursor = 0;
    for (let index = 0; index < recoveryRecords.length; index++) {
      const comment = recoveryRecords[index];
      const region = regions.at(-1)!;
      const record = comment.value;
      const separator = record.type === 'include-end' ? region.tail : record.type === 'manifest' ? record.tail : record.before ?? '';
      const spanEnd = comment.start - separator.length;
      if (spanEnd > spanCursor) {
        result.spans.push({ path: region.path, sourceLine: region.sourceLine, outputStart: spanCursor, outputEnd: spanEnd });
        region.sourceLine += container.slice(spanCursor, spanEnd).split('\n').length - 1;
      }
      if (record.type === 'include') regions.push({ path: path.resolve(project.root, record.path), sourceLine: 0,
        directiveLines: Buffer.from(record.original, 'base64').toString().split('\n').length - 1, tail: record.tail });
      else if (record.type === 'include-end') {
        regions.pop();
        regions.at(-1)!.sourceLine += region.directiveLines;
      } else if (record.type === 'transform') {
        region.sourceLine += Buffer.from(record.original, 'base64').toString().split('\n').length - 1;
        spanCursor = recoveryRecords[++index].end; continue;
      }
      spanCursor = comment.end;
    }
  } catch (error) { report(entryPath, 0, (error as Error).message); }
  return result;
}

/** Reconstruct candidates without writing; divergent occurrences require adapter-level resolution. */
export function restoreSource(bytes: Buffer): RestoreResult {
  if (bytes.length > 64 * 1024 * 1024) throw new Error('Recovery container exceeds 64 MiB.');
  const source = utf8(bytes), records = recoveryMarkers(source);
  const footer = records.at(-1);
  if (!footer || footer.value.type !== 'manifest' || footer.end !== source.length) throw new Error('Missing or misplaced WHAM footer manifest.');
  const manifest = footer.value as Manifest;
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.files) || manifest.files.length > 10000) throw new Error('Unsupported or malformed manifest.');
  portablePath(manifest.root); validateConfig(manifest.config);
  if (manifest.tail !== '' && manifest.tail !== '\n') throw new Error('Invalid root padding.');
  const fileRecords = new Map<string, Manifest['files'][number]>(), cases = new Set<string>();
  for (const file of manifest.files) {
    portablePath(file.path);
    if (!(file.path.startsWith(manifest.config.sourceDirectory + '/')) || !/^[a-f0-9]{64}$/.test(file.hash) || typeof file.bom !== 'boolean') throw new Error('Invalid file provenance.');
    if (cases.has(file.path.toLowerCase())) throw new Error(`Duplicate or case-colliding file: ${file.path}`);
    cases.add(file.path.toLowerCase()); fileRecords.set(file.path, file);
  }
  if (!fileRecords.has(manifest.root)) throw new Error('Manifest omits the root file.');
  const files = new Map<string, RestoreCandidate[]>(), ids = new Set<number>();
  const original = (value: unknown): string => {
    if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid original directive encoding.');
    return utf8(Buffer.from(value, 'base64'));
  };
  const add = (file: string, body: string, id: number, isRoot = false) => {
    const record = fileRecords.get(file);
    if (!record) throw new Error(`Unrecorded file: ${file}`);
    const restored = Buffer.from((record.bom && !isRoot ? '\uFEFF' : '') + body);
    if (isRoot && restored.subarray(0, 3).equals(Buffer.from([239, 187, 191])) !== record.bom) throw new Error('Root BOM has been changed.');
    const candidates = files.get(file) ?? [];
    const same = candidates.find(candidate => candidate.bytes.equals(restored));
    if (same) same.occurrences.push(id);
    else candidates.push({ bytes: restored, occurrences: [id], changed: checksum(restored) !== record.hash });
    files.set(file, candidates);
  };
  let recordIndex = 0;
  const parseRegion = (start: number, expectedId?: number, depth = 0): { body: string; end: number } => {
    if (depth > 64) throw new Error('Recovery nesting exceeds 64 levels.');
    let cursor = start, body = '';
    while (recordIndex < records.length - 1) {
      const record = records[recordIndex++], value = record.value;
      body += source.slice(cursor, record.start);
      if (value.type === 'include-end') {
        if (value.id !== expectedId) throw new Error('Malformed include nesting.');
        return { body, end: record.end };
      }
      if (!['include', 'transform'].includes(value.type) || !Number.isSafeInteger(value.id) || value.id < 1 || ids.has(value.id)) throw new Error('Unexpected record or duplicate occurrence ID.');
      ids.add(value.id);
      if (value.before !== '' && value.before !== '\n') throw new Error('Invalid separator.');
      if (value.before && !body.endsWith(value.before)) throw new Error('Edited generated separator.');
      body = value.before ? body.slice(0, -value.before.length) : body;
      if (value.type === 'include') {
        portablePath(value.path);
        if (value.tail !== '' && value.tail !== '\n') throw new Error('Invalid child padding.');
        const child = parseRegion(record.end, value.id, depth + 1);
        if (value.tail && !child.body.endsWith(value.tail)) throw new Error('Edited child separator.');
        add(value.path, value.tail ? child.body.slice(0, -value.tail.length) : child.body, value.id);
        body += original(value.original); cursor = child.end;
      } else {
        const close = records[recordIndex++];
        if (!close || close.value.type !== 'transform-end' || close.value.id !== value.id || !['pragma-once', 'guard-open', 'guard-close'].includes(value.kind)) throw new Error('Malformed transform nesting.');
        if (checksum(source.slice(record.end, close.start)) !== value.hash) throw new Error(`Edited synthetic section: ${value.kind}`);
        body += original(value.original); cursor = close.end;
      }
    }
    if (expectedId !== undefined) throw new Error('Missing include-end record.');
    body += source.slice(cursor, footer.start);
    return { body, end: footer.start };
  };
  const root = parseRegion(0).body;
  if (manifest.tail && !root.endsWith(manifest.tail)) throw new Error('Edited root separator.');
  add(manifest.root, manifest.tail ? root.slice(0, -manifest.tail.length) : root, 0, true);
  if (files.size !== fileRecords.size) throw new Error('Manifest and recovered file set differ.');
  const conflicts = [...files].filter(([, candidates]) => candidates.length > 1).map(([file]) => file);
  return { manifest, files, conflicts };
}
