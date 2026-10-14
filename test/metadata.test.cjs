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


test('offline Draft preserves localized metadata, nested groups, arrays, options, and README boundaries',()=>{
  const {parseDraftSource}=require('../dist/metadata');
  const source='// ==WindhawkMod==\n// @id offline-test\n// @name Offline\n// @name:zh-CN 离线\n// @version 1\n// @include a.exe\n// @include b.exe\n// ==/WindhawkMod==\n// ==WindhawkModReadme==\n/*\n# README only\n*/\n// ==/WindhawkModReadme==\n// ==WindhawkModSettings==\n/*\n- group:\n  - enabled: true\n    $name: Enabled\n    $name:zh-CN: 开启\n  - choice: first\n    $options:\n    - first: First\n    - second: Second\n- rows:\n  - - label: One\n  - - label: Two\n- numbers: [1, 2]\n*/\n// ==/WindhawkModSettings==\n';
  const parsed=parseDraftSource(source,'src/测试.cpp','zh-cn');
  assert.deepEqual(parsed.errors,{});assert.equal(parsed.metadata.name,'离线');
  assert.deepEqual(parsed.metadata.include,['a.exe','b.exe']);assert.equal(parsed.readme,'# README only');
  assert.equal(parsed.initialSettings[0].value[0].name,'开启');
  assert.deepEqual(parsed.initialSettings[0].value[1].options,[{first:'First'},{second:'Second'}]);
  assert.equal(parsed.initialSettings[1].value[1][0].value,'Two');assert.deepEqual(parsed.initialSettings[2].value,[1,2]);
  for(const yaml of ['- value: [','- value: null','- value: 1\n  $format: 2','- value: 1\n  #! $min: wrong','- value: 1\n  $options: invalid']) {
    const bad=parseDraftSource('// ==WindhawkModSettings==\n/*\n'+yaml+'\n*/\n// ==/WindhawkModSettings==\n','mod.cpp','en');
    assert.equal(bad.initialSettings,null);assert.ok(bad.errors.initialSettings);
  }
});

test('offline modern annotations match the renderer schema and resolve enclosing conditions',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const {parseDraftSource}=require('../dist/metadata');
  const source=fs.readFileSync(path.join(__dirname,'fixtures/modern-settings.wh.cpp'),'utf8');
  const parsed=parseDraftSource(source,'fixture.cpp','en');
  assert.deepEqual(parsed.errors,{});
  assert.equal(parsed.initialSettings[1].format,'colorRgb');
  assert.deepEqual(parsed.initialSettings[2],{key:'opacity',value:'0.75',float:true,min:0,max:1});
  const group=parsed.initialSettings[3].value;
  assert.deepEqual(group.slice(0,5).map(setting=>setting.format),['filePath','folderPath','slider','fontFamily','hotkey']);
  assert.equal(group[5].dynamicSelect,true);assert.deepEqual(group[6].showIf,{enabled:[true]});assert.deepEqual(group[7].hideIf,{enabled:[false]});
  assert.deepEqual(parsed.initialSettings[4].value,['0.1','0.2']);
  for(const declaration of ['- value: bad\n  $float: true','- value: 2\n  $min: 3\n  $max: 1','- value: true\n  $showIf: {missing: [true]}','- value: 1\n  $newUnknown: true','- value: 1.75\n  #! $float: true','- value: [true, false]','- value: 2\n  #! $min: 3','- value: false\n  #! $max: 1']) {
    const bad=parseDraftSource('// ==WindhawkModSettings==\n/*\n'+declaration+'\n*/\n// ==/WindhawkModSettings==\n','fixture.cpp','en');
    assert.equal(bad.initialSettings,null);assert.ok(bad.errors.initialSettings);
  }
});
