const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseMetadata } = require('../dist/metadata');

test('reads localized and repeated Windhawk fields, README and settings without modifying source', () => {
  const source = `// ==WindhawkMod==
// @id example-mod
// @name Example
// @name:zh-CN 示例
// @version 1.2
// @author Developer
// @include paint.exe
// @include notepad.exe
// @architecture x86-64
// @architecture arm64
// @compilerOptions -lcomctl32
// @futureField retained
// ==/WindhawkMod==
// ==WindhawkModReadme==
/*
# Example
<script>must remain plain text</script>
*/
// ==/WindhawkModReadme==
// ==WindhawkModSettings==
/*
- enabled: true
  $name: Enable feature
- color:
  - red: 255
*/
// ==/WindhawkModSettings==
int value;
`;
  const metadata = parseMetadata(source.replaceAll('\n', '\r\n'), 'mod.cpp');
  assert.deepEqual(metadata.diagnostics, []); assert.equal(metadata.fields['name:zh-CN'][0], '示例');
  assert.deepEqual(metadata.fields.include, ['paint.exe', 'notepad.exe']); assert.deepEqual(metadata.fields.architecture, ['x86-64', 'arm64']);
  assert.equal(metadata.fields.compilerOptions[0], '-lcomctl32'); assert.equal(metadata.fields.futureField[0], 'retained');
  assert.ok(metadata.readme.includes('<script>')); assert.equal(metadata.settingsCount, 2);
  assert.equal(metadata.lines.metadata, 0); assert.equal(metadata.lines.readme, 13); assert.equal(metadata.lines.settings, 19);
});

test('ignores fake markers in strings, raw strings and block comments', () => {
  const source = `const char* text = R"delim(
// ==WindhawkMod==
// @id fake
// ==/WindhawkMod==
)delim";
/*
// ==WindhawkMod==
// @name fake
// ==/WindhawkMod==
*/
const char* escaped = "// ==WindhawkMod==";
`;
  const metadata = parseMetadata(source, 'mod.cpp'); assert.equal(Object.keys(metadata.fields).length, 0);
  assert.equal(metadata.diagnostics.length, 1); assert.match(metadata.diagnostics[0].message, /No Windhawk/);
});

test('reports missing markers, invalid IDs, duplicate fields and malformed YAML at source lines', () => {
  const incomplete = parseMetadata('// ==WindhawkMod==\n// @id example\n', 'mod.cpp');
  assert.match(incomplete.diagnostics[0].message, /Missing closing/);
  const malformed = parseMetadata(`// ==WindhawkMod==
// @id Invalid_ID
// @name First
// @name Second
// strange line
// ==/WindhawkMod==
// ==WindhawkModSettings==
/*
- value: [unterminated
*/
// ==/WindhawkModSettings==
`, 'mod.cpp');
  for (const pattern of [/Duplicate @name/, /Expected a Windhawk/, /Missing @version/, /@id must/, /settings YAML/]) assert.ok(malformed.diagnostics.some(issue => pattern.test(issue.message)));
  assert.ok(malformed.diagnostics.filter(issue => /settings YAML/.test(issue.message)).every(issue => issue.line >= 8));
  assert.equal(malformed.settingsCount, undefined);
  const wrongType = parseMetadata('// ==WindhawkModSettings==\n/*\nvalue: true\n*/\n// ==/WindhawkModSettings==\n', 'mod.cpp');
  assert.ok(wrongType.diagnostics.some(issue => /YAML list/.test(issue.message)));
});
