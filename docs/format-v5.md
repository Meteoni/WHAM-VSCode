# WHAM reversible format v5

WHAM 1.7.0 generates v5 and reads v1 through v5. Project configuration remains `formatVersion: 1`. Include and transform records follow [v4](format-v4.md), with `WHAM@5` boundaries and manifest `version: 5`. The foldable recovery footer retains its 120-character physical line limit.

## Header-guard proof

WHAM recognizes one top-level `#ifndef NAME` block followed immediately by an object-like `#define NAME`, allowing comments and whitespace between them. The block must have a matching `#endif` and no outer `#else` or `#elif`. Nested conditionals are allowed. Multiple recognized top-level guard blocks are left unchanged. More elaborate guard spellings are not recognized.

Macro states start unknown, including names that could come from compiler flags or predefined architecture macros. Literal `#define` and `#undef` establish definedness. Simple `#ifdef`, `#ifndef`, `#if defined(NAME)`, `#if !defined(NAME)`, `#if 0`, and `#if 1` split reachable paths; branch exits retain only facts shared by every reachable path. No numeric macro values are evaluated.

Ordinary code can expand a macro containing `_Pragma` and restore a guard with `pop_macro`, even when that macro came from command-line flags or an external header. Therefore non-directive code discards all facts on reachable paths. Unknown conditional expressions, unexpanded includes, pragmas other than supported `once`, and unsupported directives also discard facts. This deliberately leaves many ordinary declaration headers expanded. An explicit later definition or a directive-only guarded header can establish a fresh proof. Conditional execution of transformed pragma-once bodies is included in this analysis.

A first full insertion is always retained. A later entire header becomes an ordinary v4-style `reference` only when its complete guarded body is proven inactive and everything outside it is comments or whitespace. Defines, undefines, architecture branches, and code that are not proven inactive remain present.

## Partial compaction

If repeatable text exists outside the guard, WHAM checks definedness at the guard's actual location, after processing the prefix. Only the inactive guarded block is replaced:

```cpp
// WHAM@5 begin 2: src/shared.h
// WHAM@5 fragment 3: src/shared.h [SHARED_H] -> 1
#undef MODE
#define MODE 2
// WHAM@5 end 2
```

The fragment's footer record contains `type: "fragment"`, its positive `id`, source `path`, `guard: "SHARED_H"`, `bodyId: 1`, `lines` (the original omitted block's newline count for source mapping), and optional `separatorBefore`. It contains no duplicate body or original directive. The surrounding include record preserves the original include directive, as usual.

`bodyId` must name an earlier completed full include of the same source file. A fragment cannot target another fragment, a whole-file reference, a transform, the root, an open include, or a future include. Its visible marker must match its footer record, and it must be inside an include of that same file. Source files are reread and compared by hash even when their content is compacted.

## Recovery and editing

Recovery first reconstructs the target's complete source, including its original nested includes and BOM. It rescans that source and extracts the uniquely recognized block with the recorded guard name. This avoids relying on stale byte offsets when the retained body was edited. The recovered block replaces the fragment marker; the visible prefix and suffix remain from the partial copy. The completed source goes through the existing candidate comparison and conflict handling.

Editing the retained guarded body updates all of its fragments. Editing a visible repeatable remainder can produce a conflict with other retained copies; recovery never silently chooses a copy. Changing or making the target guard ambiguous stops recovery before writes. Restore the original guard boundaries before recovery, then restructure the recovered source.

Unchanged generate → recover → regenerate remains byte-identical. Regenerate from source after changing include order or guard behaviour: an omitted body cannot reactivate in an edited generated file. New output requires WHAM 1.7.0 or newer for recovery; existing v1-v4 outputs remain readable. Source line positions and file-specific builtins have the existing textual-amalgamation limitations described in the [guide](guide.md).
