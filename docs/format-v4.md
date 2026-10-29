# WHAM reversible format v4

WHAM 1.6.0 introduced v4. WHAM 1.7.0 generates [v5](format-v5.md) and continues reading v1 through v4. Project configuration retains `formatVersion: 1`. The wrapped JSON footer, formatting protection, 120-character footer limit, and existing include/transform recovery checks follow [v3](format-v3.md). All visible boundaries and footer delimiters use `WHAM@4`, and the manifest has `version: 4`.

## Deduplicated includes

A header's leading unconditional `#pragma once` is still converted to the same per-file synthetic guard. WHAM retains a full expansion until it can establish that the header has been included without any enclosing conditional, including conditions inherited from parent includes. Later includes of that same resolved file become reference comments:

```cpp
// WHAM@4 reference 5: src/shared.h -> 1
```

The reference has its own positive occurrence ID. Its footer record contains `type: "reference"`, `id: 5`, `path: "src/shared.h"`, `bodyId: 1`, the exact original `directive`, and optional `separatorBefore`. The target must be an earlier, completed full `include` occurrence for the exact same project-relative path. References cannot target another reference, a transform, the root, a missing body, or a later or still-open body. Each reference must have matching visible and footer data and be used exactly once.

WHAM deduplicates by resolved file identity, not equal content or guard macro names. Referenced headers are reread and their source hashes are checked, so concurrent changes are still detected. Dependencies discovered in the retained body remain generation dependencies.

## Conservative behaviour

WHAM does not evaluate conditional expressions or expand macros. A conditional first include remains fully expanded; a later unconditional include also remains fully expanded, and can establish proof for subsequent references. Includes in separate conditional branches are retained even if a human could determine that one branch must execute. A plain header's original `#ifndef`, `#define`, `#undef`, architecture flags, and repeatable include bodies are not removed or rewritten. Existing unsupported include-cycle handling is unchanged.

## Recovery

Recovery reconstructs each full body with its original BOM, pragma and include directives. A reference restores its own original include in the parent and adds its occurrence ID to the candidate supplied by its target body. There is no second saved body to reconcile for that reference. Editing the retained body changes the recovered header for all of its references; old provenance hashes mark it edited rather than rejecting the edit.

Other retained copies can still disagree, for example when an earlier conditional expansion was retained. Those remain explicit conflicts, handled by the existing copy chooser and comparison interface. A reference does not choose between different retained candidates or override an unresolved conflict. Missing or malformed references fail before writes.

Unchanged generate → recover → regenerate is byte-identical. New output requires WHAM 1.6.0 or newer for recovery; older outputs remain readable. Source lines are not wrapped or reformatted.
