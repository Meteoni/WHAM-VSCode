# WHAM reversible format v1

This version is frozen for 1.0.0. Records are UTF-8 single-line JSON following the exact line-comment prefix `// WHAM@1 `. The scanner recognizes actual comments, ignoring strings and raw strings. Generated inputs containing reserved recovery comments are rejected. Record lines use LF; ordinary source retains its original encoding and newlines.

The entry is the implicit root and retains its BOM and leading Windhawk metadata. A final manifest line terminates the container. No archive or duplicate full source snapshot is stored. Ordinary editable source regions supply reconstructed content.

| Record | Fields |
|---|---|
| `include` | Positive unique `id`, project-relative `path`, Base64 UTF-8 `original` directive, `before`, `tail` |
| `include-end` | Matching `id` |
| `transform` | Unique `id`, `kind`, Base64 `original`, `before`, SHA-256 `hash` of exact generated section |
| `transform-end` | Matching `id` |
| `manifest` | `version: 1`, `root`, `files`, entry-specific portable `config`, root `tail` |

`before` and `tail` are either the empty string or one LF. `before` records an inserted separator preceding a marker when the original directive followed a same-line comment or indentation. `tail` records a separator appended to a body without a final newline. Restoration verifies and removes exactly those separators; original source padding is preserved.

Occurrence IDs are deterministic positive integers assigned during depth-first traversal, including synthetic transformations. Include-end IDs repeat their matching opening ID; opening IDs must be unique across include and transform records. All boundaries must nest correctly. Guards use `WHAM_ONCE_` plus 24 uppercase hexadecimal characters from the SHA-256 of the canonical file's project-relative display identity. Multiple display aliases of one canonical file are rejected.

Transformation kinds are `pragma-once`, `guard-open`, and `guard-close`. The pragma directive is replaced by a transform with an empty generated section. Guard-open and guard-close use empty originals. A changed synthetic section produces a structural recovery error. Manifests record each participating path, SHA-256 of the original bytes, and a Boolean `bom`; child BOMs are removed from expansions and restored later. The entry BOM remains in the container.

Recovery parses the complete container in memory, reconstructs children independently, replaces expanded children with exact original directives, and groups candidates by recorded path. Changed checksums indicate source edits rather than errors. Identical candidates deduplicate; divergent candidates are always a visible conflict. Hashes describe provenance and do not authenticate untrusted files.

Unknown format versions, edited synthetic sections, duplicate IDs, invalid Base64, malformed nesting, absent/extra files, unsafe paths, and case collisions are rejected before writing. Relative paths use forward slashes and remain under the recorded source directory. Windows reserved names and unsafe characters are forbidden for portability. Destination adapters separately reject symlink traversal and existing-file conflicts.

The independently assembled [handcrafted fixture](../test/fixtures/handcrafted.wh.cpp) nests `src/b.h` inside `src/a.h` inside the entry `src/mod.cpp`. Its [expected files](../test/fixtures/expected/src/mod.cpp) establish byte-for-byte restoration, including the missing final newline in `b.h`.
