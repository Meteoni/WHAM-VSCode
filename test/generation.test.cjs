const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { defaults } = require('../dist/config');
const { createGenerationPipeline } = require('../dist/generation');

const settle = async state => {
  // Debounced timers enqueue more work; wait until the queue stops changing.
  for (let previous; previous !== state.queue;) {
    previous = state.queue;
    await new Promise(resolve => setTimeout(resolve, 40));
    await state.queue;
  }
};

/** A temporary project with a fake host. `files` are relative to the project root. */
async function project(files, config = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wham-pipeline-')));
  const write = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  await write('windhawk-amalgamation.json', JSON.stringify({ ...defaults, debounceMs: 20, ...config }));
  for (const [file, text] of Object.entries(files)) await write(file, text);
  const dirty = new Map();
  const events = { publishes: 0, saves: 0, drafts: [], logs: [], onPublish: undefined };
  const hashes = {};
  let pipeline;
  const host = {
    isDisposed: () => false,
    isDirty: file => dirty.has(file),
    dirtyText: file => dirty.get(file),
    dirtyFiles: () => [...dirty.keys()],
    log: line => events.logs.push(line),
    publish: () => {
      events.publishes++;
      events.onPublish?.();
    },
    presentDiagnostics: () => {},
    saveHashes: async () => events.saves++,
    gitStatus: async () => undefined,
    // The extension's Draft refresh ends by reconciling output status; that is all tests need.
    refreshDraft: async (state, entries = [...state.entries.values()]) => {
      events.drafts.push(entries.map(entry => path.basename(entry.path)));
      for (const entry of entries) await pipeline.reconcileOutput(state, entry);
    },
    refreshRuntime: async () => {},
    refreshEditorConfiguration: async () => {},
    editorFilesChanged: async () => {},
    timing: state => ({ generate: state.project.config.generate, debounceMs: state.project.config.debounceMs })
  };
  pipeline = createGenerationPipeline(host, hashes);
  const state = {
    project: { root, config: { ...defaults } },
    entries: new Map(),
    queue: Promise.resolve(),
    pending: new Set(),
    draftPending: new Set(),
    retained: [],
    editor: { installationPath: '', integration: 'cpp', indentStyle: 'spaces', indentSize: 4 }
  };
  await pipeline.refresh(state);
  const at = file => path.join(root, file);
  const entry = file => state.entries.get(at(file));
  const read = file => fs.readFile(at(file), 'utf8').catch(() => undefined);
  return {
    root,
    at,
    entry,
    read,
    write,
    state,
    pipeline,
    dirty,
    events,
    hashes,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

const sources = {
  'src/a.cpp': '#include "shared.h"\nint a;\n',
  'src/b.cpp': 'int b;\n',
  'src/shared.h': '#pragma once\nint shared = 1;\n'
};

test('generation writes outputs and records ownership', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    assert.match(await p.read('output/a.wh.cpp'), /int shared = 1;/);
    assert.equal(p.entry('src/a.cpp').status, 'current');
    assert.equal(p.entry('src/a.cpp').message, '2 source file(s)');
    assert.ok(p.hashes[p.at('output/a.wh.cpp')], 'Ownership is recorded for the written output');
    assert.equal(p.events.saves, 1);
  } finally {
    await p.cleanup();
  }
});

test('edited outputs are never overwritten without force', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    const edited = (await p.read('output/a.wh.cpp')).replace('int shared = 1;', 'int shared = 99;');
    await p.write('output/a.wh.cpp', edited);
    await p.write('src/shared.h', '#pragma once\nint shared = 2;\n');
    await p.pipeline.enqueue(p.state, [p.at('src/a.cpp')]);
    assert.equal(p.entry('src/a.cpp').status, 'blocked');
    assert.equal(await p.read('output/a.wh.cpp'), edited, 'The edit survives regeneration');
    await p.pipeline.enqueue(p.state, [p.at('src/a.cpp')], { force: true });
    assert.match(await p.read('output/a.wh.cpp'), /int shared = 2;/);
    assert.equal(p.entry('src/a.cpp').status, 'current');
  } finally {
    await p.cleanup();
  }
});

test('unsaved output or source buffers hold generation', async () => {
  const p = await project(sources);
  try {
    p.dirty.set(p.at('output/a.wh.cpp'), 'unsaved edit');
    p.dirty.set(p.at('src/shared.h'), 'unsaved header');
    await p.pipeline.enqueue(p.state);
    assert.equal(p.entry('src/a.cpp').status, 'blocked');
    assert.equal(await p.read('output/a.wh.cpp'), undefined, 'Nothing is written over an unsaved output');
    assert.equal(
      p.entry('src/b.cpp').status,
      'pending',
      'Before a first generation, any unsaved source holds the entry'
    );
    assert.equal(await p.read('output/b.wh.cpp'), undefined);
    assert.deepEqual(p.pipeline.relevantDirty(p.state).sort(), [p.at('src/shared.h')]);
  } finally {
    await p.cleanup();
  }
});

test('saves within the debounce coalesce and regenerate only dependent entries', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    const before = p.events.saves;
    p.events.drafts.length = 0;
    await p.write('src/shared.h', '#pragma once\nint shared = 3;\n');
    for (let save = 0; save < 3; save++) p.pipeline.changed([p.state], p.at('src/shared.h'));
    assert.equal(p.entry('src/a.cpp').status, 'stale', 'Dependents show the pending change immediately');
    assert.equal(p.entry('src/b.cpp').status, 'current');
    await settle(p.state);
    assert.equal(p.events.saves - before, 1, 'One generation pass for three saves');
    assert.deepEqual(p.events.drafts, [['a.cpp']]);
    assert.match(await p.read('output/a.wh.cpp'), /int shared = 3;/);
  } finally {
    await p.cleanup();
  }
});

test('switching to Manual skips automatic generation already queued by a save', async () => {
  const p = await project(sources);
  let releaseQueue;
  try {
    await p.pipeline.enqueue(p.state);
    const before = await p.read('output/a.wh.cpp');
    const blockedQueue = new Promise(resolve => {
      releaseQueue = resolve;
    });
    p.state.queue = blockedQueue;
    await p.write('src/shared.h', '#pragma once\nint shared = 2;\n');
    p.pipeline.changed([p.state], p.at('src/shared.h'));
    await new Promise(resolve => setTimeout(resolve, p.state.project.config.debounceMs));
    assert.notEqual(p.state.queue, blockedQueue, 'The debounce already handed the save to the queue');

    p.state.project.config.generate = 'manual';
    await p.write('src/shared.h', '#pragma once\nint shared = 5;\n');
    releaseQueue();
    await p.state.queue;
    assert.equal(await p.read('output/a.wh.cpp'), before, 'Queued automatic work must not write the Manual save');

    await p.pipeline.enqueue(p.state, [p.at('src/a.cpp')]);
    assert.match(await p.read('output/a.wh.cpp'), /int shared = 5;/, 'Explicit generation still works in Manual mode');
  } finally {
    clearTimeout(p.state.timer);
    releaseQueue?.();
    await p.state.queue;
    await p.cleanup();
  }
});

test('outputs changed on disk are flagged, and new entries are discovered', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    await p.write('output/b.wh.cpp', 'int b; // edited\n');
    p.pipeline.changed([p.state], p.at('output/b.wh.cpp'));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(p.entry('src/b.cpp').status, 'blocked');
    assert.equal(p.entry('src/b.cpp').message, 'Generated output changed on disk.');
    await p.write('src/c.cpp', 'int c;\n');
    p.pipeline.changed([p.state], p.at('src/c.cpp'), true);
    await settle(p.state);
    assert.equal(p.entry('src/c.cpp').status, 'current');
    assert.match(await p.read('output/c.wh.cpp'), /int c;/);
  } finally {
    await p.cleanup();
  }
});

test('switching to Manual while an automatic output is staged leaves the output unchanged', async () => {
  const p = await project(sources);
  const writeFile = fs.writeFile;
  try {
    await p.pipeline.enqueue(p.state);
    const output = p.at('output/a.wh.cpp');
    const before = await p.read('output/a.wh.cpp');
    await p.write('src/shared.h', '#pragma once\nint shared = 2;\n');
    fs.writeFile = async (file, ...args) => {
      await writeFile(file, ...args);
      if (file.startsWith(output + '.') && file.endsWith('.tmp')) p.state.project.config.generate = 'manual';
    };
    await p.pipeline.enqueue(p.state, [p.at('src/a.cpp')], { automatic: true });
    assert.equal(p.state.project.config.generate, 'manual');
    assert.equal(await p.read('output/a.wh.cpp'), before);
    assert.equal(p.entry('src/a.cpp').status, 'stale');
    assert.deepEqual(await fs.readdir(p.at('output')), ['a.wh.cpp', 'b.wh.cpp']);
  } finally {
    fs.writeFile = writeFile;
    await p.cleanup();
  }
});

test('a source edited during generation queues another pass instead of writing', async () => {
  const p = await project(sources);
  try {
    p.events.onPublish = () => {
      // The moment generation starts, the header gains unsaved edits.
      if (p.entry('src/a.cpp')?.status === 'generating') p.dirty.set(p.at('src/shared.h'), 'typing…');
    };
    await p.pipeline.enqueue(p.state, [p.at('src/a.cpp')]);
    p.events.onPublish = undefined;
    assert.equal(await p.read('output/a.wh.cpp'), undefined);
    assert.ok(p.state.pending.has(p.at('src/a.cpp')), 'Another pass is scheduled');
    p.dirty.clear();
    await settle(p.state);
    assert.equal(p.entry('src/a.cpp').status, 'current');
    assert.match(await p.read('output/a.wh.cpp'), /int shared = 1;/);
  } finally {
    await p.cleanup();
  }
});

test('outputs of removed entries: owned ones are deleted, edited ones kept with a notice', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    await p.write('output/b.wh.cpp', 'int b; // edited\n');
    await fs.rm(p.at('src/a.cpp'));
    await fs.rm(p.at('src/b.cpp'));
    await p.pipeline.refresh(p.state);
    assert.equal(await p.read('output/a.wh.cpp'), undefined, 'The unedited output WHAM wrote is removed');
    assert.equal(p.hashes[p.at('output/a.wh.cpp')], undefined);
    assert.equal(await p.read('output/b.wh.cpp'), 'int b; // edited\n');
    assert.deepEqual(p.state.retained, [`Preserved orphan output: ${p.at('output/b.wh.cpp')}`]);
    assert.equal(p.state.entries.size, 0);
  } finally {
    await p.cleanup();
  }
});

test('orphan ownership without stored hashes protects edited, dirty and foreign outputs', async () => {
  const p = await project({ ...sources, 'src/c.cpp': 'int c;\n', 'src/d.cpp': 'int d;\n' });
  try {
    await p.pipeline.enqueue(p.state);
    const otherRoot = await p.read('output/b.wh.cpp');
    const edited = otherRoot.replace('int b;', 'int b; // edited');
    const dirty = await p.read('output/d.wh.cpp');
    await p.write('output/b.wh.cpp', edited);
    await p.write('output/c.wh.cpp', otherRoot);
    p.dirty.set(p.at('output/d.wh.cpp'), dirty.replace('int d;', 'int d; // unsaved edit'));
    for (const entry of p.state.entries.values()) {
      delete p.hashes[entry.output];
      delete entry.ownedHash;
      await fs.rm(entry.path);
    }
    await p.pipeline.refresh(p.state);
    assert.equal(await p.read('output/a.wh.cpp'), undefined, 'An intact footer establishes ownership');
    assert.equal(await p.read('output/b.wh.cpp'), edited);
    assert.equal(await p.read('output/c.wh.cpp'), otherRoot);
    assert.equal(await p.read('output/d.wh.cpp'), dirty);
    assert.deepEqual(
      p.state.retained,
      ['b', 'c', 'd'].map(name => `Preserved orphan output: ${p.at(`output/${name}.wh.cpp`)}`)
    );
  } finally {
    await p.cleanup();
  }
});

test('debounced work does nothing once the project is removed', async () => {
  const p = await project(sources);
  try {
    await p.pipeline.enqueue(p.state);
    const before = { saves: p.events.saves, output: await p.read('output/a.wh.cpp') };
    await p.write('src/shared.h', '#pragma once\nint shared = 4;\n');
    p.pipeline.changed([p.state], p.at('src/shared.h'));
    p.state.removed = true; // The timer still fires; the pipeline must ignore it.
    await new Promise(resolve => setTimeout(resolve, 80));
    await p.state.queue;
    assert.equal(p.events.saves, before.saves);
    assert.equal(await p.read('output/a.wh.cpp'), before.output);
  } finally {
    await p.cleanup();
  }
});
