const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.resolve(__dirname, '..');
const artifacts = path.join(repo, 'work', 'footprint');
const registryKeys = {
  'hkcu-software': 'HKCU\\Software',
  'hklm-uninstall': 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
};

function snapshot(label) {
  const started = new Date().toISOString();
  const entries = new Map();
  const skipped = [];
  const scanned = new Set();
  const scopes = ['APPDATA', 'LOCALAPPDATA', 'TEMP', 'USERPROFILE'];
  const walk = (directory, topLevelOnly) => {
    if (scanned.has(directory.toLowerCase())) return;
    scanned.add(directory.toLowerCase());
    let names;
    try {
      names = fs.readdirSync(directory);
    } catch (error) {
      skipped.push([directory, error.code]);
      return;
    }
    const portableCode = names.some(name => name.toLowerCase() === 'code.exe');
    for (const name of names) {
      const file = path.join(directory, name);
      if (file.toLowerCase() === repo.toLowerCase()) continue;
      if (portableCode && name.toLowerCase() === 'data') {
        skipped.push([file, 'VS Code portable data']);
        continue;
      }
      try {
        const info = fs.lstatSync(file);
        entries.set(file, [info.size, info.mtimeMs]);
        // lstat records junctions and symlinks without following them outside the snapshot roots.
        if (info.isDirectory() && (!topLevelOnly || name.startsWith('.'))) walk(file, false);
      } catch (error) {
        skipped.push([file, error.code]);
      }
    }
  };
  for (const scope of scopes) {
    if (process.env[scope]) walk(path.resolve(process.env[scope]), scope === 'USERPROFILE');
    else skipped.push([scope, 'environment variable missing']);
  }

  const registry = {};
  for (const [name, key] of Object.entries(registryKeys)) {
    const file = path.join(artifacts, `${label}-${name}.reg`);
    const result = spawnSync('reg.exe', ['export', key, file, '/y'], { encoding: 'utf8', windowsHide: true });
    registry[name] = result.status === 0 ? 'exported' : (result.error?.message ?? result.stderr?.trim() ?? 'failed');
  }
  fs.writeFileSync(
    path.join(artifacts, `${label}.json`),
    JSON.stringify({ started, time: new Date().toISOString(), entries: [...entries], skipped, registry })
  );
  console.log(`${label}: ${entries.size} paths, ${skipped.length} skipped entries`, registry);
}

function readRegistry(label, name) {
  const file = path.join(artifacts, `${label}-${name}.reg`);
  const entries = new Map();
  let key;
  // reg export uses UTF-16LE and continues long binary values on indented lines.
  for (const line of fs
    .readFileSync(file, 'utf16le')
    .replace(/\\\r?\n[ \t]+/g, '')
    .split(/\r?\n/)) {
    if (line.startsWith('[') && line.endsWith(']')) {
      key = line.slice(1, -1);
      entries.set(key, true);
    } else if (key) {
      const value = /^(@|"(?:\\.|[^"\\])*")=(.*)$/.exec(line);
      if (value) entries.set(`${key}\\${value[1]}`, value[2]);
    }
  }
  return entries;
}

function differences(before, after) {
  const changes = [];
  for (const [entry, previous] of before) {
    const next = after.get(entry);
    if (JSON.stringify(previous) !== JSON.stringify(next)) changes.push({ entry, before: previous, after: next });
  }
  for (const [entry, next] of after) if (!before.has(entry)) changes.push({ entry, after: next });
  return changes;
}

function attribution({ entry, before, after, source }) {
  const identifier = source === 'files' ? entry : [entry, before, after].join('\n');
  if (/\b(?:wham|windhawk-amalgamation)\b/i.test(identifier) || identifier.toLowerCase().includes(repo.toLowerCase()))
    return { program: 'WHAM / repository test', test: true };
  if (/(?:^|[\\/\s._"-])(?:electron|code|vs ?code|visual studio code|pbqr\.rkr)(?=$|[\\/\s._"-])/i.test(identifier))
    return { program: 'VS Code / Electron', test: true };
  if (/\\Microsoft\\Windows\\(?:CurrentVersion\\)?(?:Explorer|Recent|Shell|UserAssist)(?:\\|$)/i.test(entry))
    return { program: 'Windows Explorer' };
  if (/\\(?:CrashDumps|WER)(?:\\|$)/i.test(entry)) return { program: 'Windows Error Reporting' };
  for (const scope of ['TEMP', 'APPDATA', 'LOCALAPPDATA']) {
    const base = process.env[scope];
    if (!base || !entry.toLowerCase().startsWith(path.resolve(base).toLowerCase() + path.sep)) continue;
    const [owner, product] = path.relative(base, entry).split(path.sep);
    if (scope === 'TEMP' || !product) break;
    return { program: /^(Microsoft|Google|Packages)$/i.test(owner) ? `${owner}\\${product}` : owner };
  }
  return { program: 'Unknown' };
}

function compare() {
  const read = label => JSON.parse(fs.readFileSync(path.join(artifacts, `${label}.json`), 'utf8'));
  const comparePair = (start, end) => {
    const before = read(start);
    const after = read(end);
    const changes = differences(new Map(before.entries), new Map(after.entries)).map(change => ({
      ...change,
      source: 'files'
    }));
    const unavailableRegistry = [];
    for (const name of Object.keys(registryKeys)) {
      if (before.registry[name] !== 'exported' || after.registry[name] !== 'exported') unavailableRegistry.push(name);
      else
        changes.push(
          ...differences(readRegistry(start, name), readRegistry(end, name)).map(change => ({
            ...change,
            source: name
          }))
        );
    }
    return { changes: changes.map(change => ({ ...change, ...attribution(change) })), unavailableRegistry };
  };
  const background = comparePair('A', 'B');
  const host = comparePair('C', 'D');
  const backgroundPaths = new Set(background.changes.map(change => change.entry.toLowerCase()));
  const backgroundPrograms = new Set(
    background.changes.map(change => change.program).filter(program => program !== 'Unknown')
  );
  for (const change of host.changes) {
    change.attributedTo = change.test
      ? 'test'
      : backgroundPaths.has(change.entry.toLowerCase())
        ? 'background path'
        : backgroundPrograms.has(change.program)
          ? 'background program'
          : 'unexplained';
  }
  fs.writeFileSync(path.join(artifacts, 'A-B.json'), JSON.stringify(background, null, 2));
  fs.writeFileSync(path.join(artifacts, 'C-D.json'), JSON.stringify(host, null, 2));
  const counts = {};
  for (const { attributedTo } of host.changes) counts[attributedTo] = (counts[attributedTo] ?? 0) + 1;
  console.log(`A→B: ${background.changes.length} changes. C→D: ${host.changes.length} changes.`, counts);
  console.log('Diffs:', artifacts);
}

const [command, label] = process.argv.slice(2);
if (!(command === 'snapshot' && /^[ABCD]$/.test(label)) && command !== 'compare') {
  console.error('Usage: node scripts/footprint.cjs snapshot <A|B|C|D> | compare');
  process.exitCode = 1;
} else {
  fs.mkdirSync(artifacts, { recursive: true });
  if (command === 'snapshot') snapshot(label);
  else compare();
}
