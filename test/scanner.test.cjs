const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanSource } = require('../dist/scanner');

test('scanner reports original line numbers across CRLF, splices and block comments', () => {
  const source =
    [
      'int a = 1; // first', // line 0
      '/* block', // line 1
      '   spans */ #define AFTER_COMMENT', // line 2: comments are whitespace
      '#define LONG \\', // line 3: spliced into line 4
      '  value',
      '#include "x.h"', // line 5
      'int b; // after splice' // line 6
    ].join('\r\n') + '\r\n';
  const scan = scanSource(source);
  assert.deepEqual(
    scan.comments.map(comment => [comment.kind, comment.line]),
    [
      ['line', 0],
      ['block', 1],
      ['line', 6]
    ]
  );
  assert.deepEqual(
    scan.directives.map(directive => [directive.name, directive.line]),
    [
      ['define', 2],
      ['define', 3],
      ['include', 5]
    ]
  );
});

test('scanner stays linear in the number of comments and directives', () => {
  const source =
    Array.from({ length: 40000 }, (_, index) =>
      index % 2 ? `#define V${index} ${index}` : `int v${index}; // ${index}`
    ).join('\n') + '\n';
  const started = performance.now();
  const scan = scanSource(source);
  const elapsed = performance.now() - started;
  assert.equal(scan.directives.at(-1).line, 39999);
  assert.equal(scan.comments.at(-1).line, 39998);
  // The former prefix-slicing implementation took tens of seconds here.
  assert.ok(elapsed < 5000, `scanSource took ${elapsed.toFixed(0)} ms`);
});
