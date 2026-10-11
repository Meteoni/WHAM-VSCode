export interface Directive { start: number; end: number; line: number; name: string; argument: string }
export interface RecoveryComment { start: number; end: number; text: string }
export interface SourceComment extends RecoveryComment { kind: 'line' | 'block'; line: number }

/** Scan preprocessing tokens after phase-two line splicing; offsets refer to the untouched input. */
export function scanSource(source: string): { directives: Directive[]; records: RecoveryComment[]; comments: SourceComment[]; code: string } {
  let logical = '';
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\\' && (source[index + 1] === '\n' || source.slice(index + 1, index + 3) === '\r\n')) {
      index += source[index + 1] === '\n' ? 1 : 2;
    } else { offsets.push(index); logical += source[index]; }
  }
  offsets.push(source.length);
  const directives: Directive[] = [], records: RecoveryComment[] = [];
  const comments: SourceComment[] = [];
  let clean = '', prefixOnly = true, index = 0;
  while (index < logical.length) {
    const character = logical[index];
    if (character === '\n') { clean += '\n'; prefixOnly = true; index++; continue; }
    if (/\s|\uFEFF/.test(character)) { clean += character; index++; continue; }
    if (logical.startsWith('//', index)) {
      let end = logical.indexOf('\n', index);
      if (end < 0) end = logical.length; else end++;
      const comment = logical.slice(index, end);
      comments.push({ start: offsets[index], end: offsets[end], text: source.slice(offsets[index], offsets[end]), kind: 'line', line: source.slice(0, offsets[index]).split('\n').length - 1 });
      if (/^\/\/ WHAM@\d+ /.test(comment)) records.push({ start: offsets[index], end: offsets[end], text: comment.trimEnd() });
      clean += comment.replace(/[^\n]/g, ' '); prefixOnly = comment.endsWith('\n'); index = end; continue;
    }
    if (logical.startsWith('/*', index)) {
      const close = logical.indexOf('*/', index + 2);
      if (close < 0) throw new Error('Unterminated block comment.');
      const comment = logical.slice(index, close + 2);
      comments.push({ start: offsets[index], end: offsets[close + 2], text: source.slice(offsets[index], offsets[close + 2]), kind: 'block', line: source.slice(0, offsets[index]).split('\n').length - 1 });
      clean += comment.replace(/[^\n]/g, ' ');
      if (comment.includes('\n')) prefixOnly = true;
      index = close + 2; continue;
    }
    if (character === '#' && prefixOnly) {
      let end = logical.indexOf('\n', index);
      if (end < 0) end = logical.length; else end++;
      let directive = logical.slice(index, end);
      // Comments are whitespace in directives; quoted include names are retained.
      let tokens = '', cursor = 0;
      while (cursor < directive.length) {
        if (directive.startsWith('//', cursor)) break;
        if (directive.startsWith('/*', cursor)) {
          const close = directive.indexOf('*/', cursor + 2);
          if (close < 0) {
            // Leave a trailing multiline comment in the parent source. Removing its
            // opening delimiter would strand the closing delimiter after expansion.
            if (/^#\s*(?:include|pragma)\b/.test(tokens)) {
              end = index + cursor; directive = logical.slice(index, end); break;
            }
            throw new Error('A multiline comment inside directive tokens is unsupported.');
          }
          tokens += ' '; cursor = close + 2;
        } else if (directive[cursor] === '"') {
          const begin = cursor++;
          while (cursor < directive.length && directive[cursor] !== '"') { if (directive[cursor] === '\\') cursor++; cursor++; }
          cursor++; tokens += directive.slice(begin, cursor);
        } else tokens += directive[cursor++];
      }
      const match = /^#\s*([A-Za-z_][\w]*)\s*([\s\S]*)$/.exec(tokens.trimEnd());
      if (match) directives.push({ start: offsets[index], end: offsets[end], line: source.slice(0, offsets[index]).split('\n').length - 1, name: match[1], argument: match[2].trim() });
      clean += tokens; index = end; prefixOnly = directive.endsWith('\n'); continue;
    }
    const raw = /^(?:u8|u|U|L)?R"([^ ()\\\t\r\n]{0,16})\(/.exec(logical.slice(index));
    if (raw) {
      const terminator = ')' + raw[1] + '"';
      const close = logical.indexOf(terminator, index + raw[0].length);
      if (close < 0) throw new Error('Unterminated raw string.');
      const end = close + terminator.length;
      clean += logical.slice(index, end).replace(/[^\n]/g, ' '); prefixOnly = false; index = end; continue;
    }
    if (character === "'" && /\b\d[\w.]*$/.test(logical.slice(Math.max(0, index - 128), index)) && /[\w]/.test(logical[index + 1] ?? '')) {
      clean += character; prefixOnly = false; index++; continue;
    }
    if (character === '"' || character === "'") {
      const start = index++;
      while (index < logical.length) {
        if (logical[index] === '\\') { index += 2; continue; }
        if (logical[index++] === character) break;
      }
      clean += logical.slice(start, index).replace(/[^\n]/g, ' '); prefixOnly = false; continue;
    }
    prefixOnly = false; clean += character; index++;
  }
  return { directives, records, comments, code: clean };
}
