# WHAM reversible format v3

WHAM 1.5.12 generates v3 and continues to read v1 and v2. The project configuration still uses `formatVersion: 1`. Recovery data has the same meaning as [v2](format-v2.md); v3 changes its presentation to avoid overly long lines in Windhawk.

Source boundaries use `WHAM@3` with the same IDs, paths and transform kinds as v2. The output ends with:

```cpp
// #region WHAM recovery
// clang-format off
// WHAM@3 recovery-begin
// {
//   "type": "manifest",
//   "version": 3,
//   "root": "src/mod.cpp",
//   ...
// }
// WHAM@3 recovery-end
// clang-format on
// #endregion
```

The JSON above is abbreviated. Actual output includes full file provenance, portable configuration, padding and recovery records. Each JSON line has a `// ` prefix. Long lines are split into fragments: subsequent fragments use `//+ ` and are joined to the previous fragment without adding whitespace before JSON parsing. Ordinary JSON lines are joined with LF. Removing those comment prefixes reconstructs the JSON only after continuation fragments have been joined.

Footer lines contain at most 120 UTF-16 code units including their comment prefix, excluding the line terminator. Splitting preserves Unicode surrogate pairs. JSON-escaped literal backslashes use `\u005c`, so an arbitrarily long run of backslashes can be wrapped without ending a physical comment line with a backslash. These JSON escapes change no recovered values. No compression or second source archive is involved.

The folding region keeps the section together in VS Code, and clang-format guards prevent comment reflow from corrupting the JSON or its continuations. The opening, closing and folding/formatting lines are required. LF and CRLF footer line endings are accepted. Extra text after the footer, malformed payload prefixes, orphan continuations, mixed boundary versions and invalid recovery data are rejected before any writes. Existing path, checksum, nesting, BOM, conflict and separator checks remain in force.

Unchanged generate → recover → regenerate is byte-identical. Regenerating an unchanged v1/v2 output upgrades it to v3; older WHAM releases cannot recover the new format. Original source lines are not wrapped or reformatted, and unusually long source lines can still require manual correction for Windhawk repository validation.
