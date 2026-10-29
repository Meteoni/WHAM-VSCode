# WHAM reversible format v2

WHAM 1.1 introduced v2. WHAM 1.7.0 generates [v5](format-v5.md) and continues to read v1 through v4. Project configuration retains its separate `formatVersion: 1`. Output v2 moves recovery payloads out of source boundaries into the final footer.

```cpp
// WHAM@2 begin 1: src/includes/test.h
void add(int* left, int* right, int* result) {
    *result = *left + *right;
}
// WHAM@2 end 1
```

Each opening boundary identifies its occurrence and project-relative file path. The closing ID matches it. Synthetic transformations use `// WHAM@2 transform 2: pragma-once` and `// WHAM@2 end-transform 2`; supported kinds remain `pragma-once`, `guard-open`, and `guard-close`.

The last line is `// WHAM@2 recovery ` followed by a JSON manifest. It contains `type: "manifest"`, `version: 2`, root path, file provenance, portable project configuration, root padding, and a `records` array sorted by occurrence ID. Include records contain `type`, `id`, `path`, and `directive`: the exact original directive as a UTF-8 JSON string, including original line endings. Transform records contain `type`, `id`, `kind`, generated-section SHA-256 `hash`, and a `directive` only when the original was nonempty.

`separatorBefore` records an inserted LF before a boundary when a directive followed indentation or a same-line comment. `separatorAfter` records an LF appended to an included file with no final newline. They are omitted when empty. Root `tail` still records final footer padding. Recovery removes only verified generated separators and preserves original source padding.

The footer contains recovery instructions and provenance, not a second copy of each file. Editable source regions still supply the recovered contents. Each recovery-data ID must be unique, used exactly once by an opening boundary, and agree with the visible path/kind. Boundaries must nest; end markers must match their opening ID. Synthetic sections are hash checked. Missing or extra recovery data, unsupported versions, invalid paths, malformed nesting, and changed generated separators fail before file writes.

File hashes, BOM handling, occurrence conflicts, source containment, and restore semantics follow [v1](format-v1.md). An unchanged v2 generate → restore → regenerate round trip is byte-identical. Regenerating v1 source with WHAM 1.1 creates v2 output; WHAM 1.0 cannot read that new format. Provenance hashes do not authenticate untrusted files.
