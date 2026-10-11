# WHAM user guide

Edit directory-based C++ sources, generate one standalone `.wh.cpp` per mod, and recover the entry and its local includes from that file alone. The extension includes a project sidebar, Git setup, configurable indentation, and Windhawk compiler integration.

## Install and start

1. In VS Code, run **Extensions: Install from VSIX…** and choose `wham-1.1.2.vsix`.
2. Open the **WHAM** activity-bar view. **Setup** offers a new project, an existing project, or recovery from one or more generated `.wh.cpp` files.
3. Select your Windhawk installation and indentation in the setup prompts. Change these later under **Settings → Editor**.
4. **Open project after setup** is enabled by default and opens the folder in the current window, activating its editor configuration. You can clear this checkbox or disable `wham.openProjectAfterSetup` in VS Code settings. Install the recommended C++ language extension if it is missing.

New projects get `src/`, `output/`, `windhawk-amalgamation.json`, and a Git repository when there is no enclosing repository. Ignore rules cover output, `.vscode/settings.json`, `.vscode/c_cpp_properties.json`, and `.clangd`. Source, portable rebuild configuration, `.clang-format`, extension recommendations, and `.gitignore` remain shareable. Existing ignore rules and repositories are preserved; already tracked files stay tracked. WHAM never commits or pushes. **Settings → Git** explains the policy, updates ignore rules for older projects, refreshes Git status, and opens Source Control.

Existing projects use their configuration if present. If there is no configuration, the default source directory is `src`; point **Settings → Generation** at existing source/include subdirectories as needed. Existing flat projects must place their mod sources in a source subdirectory; overlapping source and output roots are unsupported. Setup never moves existing sources automatically.

The **Project** screen shows the selected project, generation controls, and independent mods. Selecting a mod name opens **Mod Details**, including parsed `@id`, name, version, author, target processes, architecture, localized and other metadata fields, README text, and validated settings YAML. Warnings identify missing/duplicate metadata and malformed YAML in both the sidebar and Problems. Edit buttons jump to the corresponding block in source. Unsaved source edits update the metadata preview. Markdown and YAML previews are plain text; WHAM does not execute them or apply mod settings to a running process.

In the C++ editor, Windhawk metadata fields, README Markdown, and settings YAML receive syntax highlighting through an adaptation of Windhawk's own grammar. This works in source and generated `.wh.cpp` files without changing their C++ language mode or compiler integration. Colors follow your active theme; ordinary comments and strings keep normal C++ highlighting. Reload VS Code after upgrading to register the grammar. The sidebar previews remain plain text.

## Authoring and generation

```text
project/
  windhawk-amalgamation.json
  src/
    first.cpp
    shared.hpp
    tools/second.cpp
  output/
    first.wh.cpp
    tools/second.wh.cpp
```

Every matching `.cpp` is an independent mod. Only its explicitly included local files are bundled; sibling implementation files are not appended. A directly included `.cpp` works, but exclude it from entry discovery if it is not an independent mod. Each output keeps its entry's original Windhawk metadata at the beginning.

Generation runs after saves by default. Shared-header saves regenerate dependent entries, including references in inactive branches. External file changes use the same debounced project queue. Set generation to **Manual** to use the per-mod **Generate** or **Generate all** buttons instead. Generation reads saved contents; manual commands offer to save relevant dirty source documents.

Missing inputs or unsupported preprocessing produce Problems diagnostics and detailed logs while preserving previous outputs. Statuses are **current**, **stale**, **generating**, **pending** for unsaved sources, or **blocked** for edited output.

Output edits are protected. **Mod Details → Compare** opens the existing output against expected saved-source output. **Restore** recovers edits into a new or selected project after preview and conflict resolution. **Discard output edits…** requires an explicit confirmation; unsaved output buffers must first be saved or reverted. The extension writes only changed bytes and rechecks source fingerprints before committing. Deleted entries remove only unchanged outputs with previously established ownership; edited orphan outputs remain on disk.

Include boundaries use short readable comments, such as `// WHAM@2 begin 1: src/includes/test.h` and `// WHAM@2 end 1`. Exact original directives and padding details are stored in the final recovery footer. Empty padding fields are omitted and directives are readable JSON strings rather than Base64. Keep boundaries, synthetic guards, and the footer intact when editing an output. WHAM 1.1 reads both v1 and v2 outputs; older WHAM versions cannot recover v2. Regenerating an unchanged v1 output upgrades its layout to v2.

## Project configuration

```json
{
  "formatVersion": 1,
  "sourceDirectory": "src",
  "outputDirectory": "output",
  "entries": ["**/*.cpp"],
  "exclude": [],
  "includeDirectories": ["src"],
  "externalIncludes": [],
  "inlineAngleIncludes": false,
  "generate": "onSave",
  "debounceMs": 250
}
```

Entry and exclusion globs are relative to `sourceDirectory`. Other directories are relative to the project root and must use portable forward-slash paths. Quoted includes search the including file's directory first, then configured include directories in order. There is no basename search. `externalIncludes` lists exact quoted header names or complete macro expressions to preserve as external. Angle includes remain external unless local angle expansion is enabled.

All branches are preserved. Missing quoted includes inside `#if 0` still require a file or explicit external rule. Ordinary guards and repeatable headers retain compiler-controlled behavior. Conventional leading, unconditional `#pragma once` becomes a reversible per-file guard; repeated copies are expanded textually.

## Editor integration and indentation

**Apply editor settings** creates or updates configuration for Microsoft C/C++, clangd, or both. It uses your selected installation's `Compiler/bin/clang++.exe`, `Compiler/include/windhawk_api.h`, C++23, the x64 MinGW target, Windows version defines, `WH_MOD`, and `WH_EDITING`. This resolves Windhawk-only API declarations while authoring. The language-service extension itself must be installed; WHAM creates extension recommendations without installing extensions automatically.

Detection checks `WINDHAWK_HOME`, both Windows registry views, Program Files, `<home>/Portable Programs/Windhawk`, and `<home>/scoop/apps/windhawk/current`. The portable paths are fixed layout guesses using the current user's home directory; WHAM does not scan the disk or hard-code a username. Every candidate must contain the compiler and API header. Saved preferences and existing project compiler settings can also supply the path. You can always browse to a custom installation.

The named Microsoft C/C++ configuration is **Windhawk (WHAM)**. Select it through **C/C++: Select a Configuration** if your editor remains on another configuration. clangd configuration uses Windhawk's own `clangd.exe` and a managed fragment in `.clangd`. Choosing clangd disables the Microsoft C/C++ IntelliSense engine for the project to avoid competing diagnostics. Configuring both prepares both services; choose one as your primary provider.

Spaces/tabs and a width from 1–16 are configurable per project in the sidebar. Settings update C++ editor indentation and `.clang-format`; existing formatting options and JSONC comments are preserved. New formatting starts with Windhawk's Chromium base. Metadata and `WHAM` comments are protected from comment reflow. Formatting source is supported; formatting an amalgamated output can change generated guard sections and break automatic recovery, so keep generated sections intact.

Editor changes to existing files are shown in a review picker with diffs. Dirty settings buffers block application. Preferences persist across folder switches, and opening a project reads its applied JSONC and formatting configuration to populate the sidebar. Saved changes to those files also refresh the displayed preferences without replacing unapplied form edits. Installation paths are stored locally and are absent from the recovery manifest. Machine-specific editor files receive Git ignore rules; already tracked files remain tracked by Git. Output is excluded from project search, and clangd background indexing skips generated copies. Source/include-directory changes can be synchronized by applying editor settings again.

**Verify** runs the configured compiler's syntax check explicitly. It never runs during ordinary generation and does not install or activate a mod. Windhawk metadata `@compilerOptions` are not automatically added; use the CLI verification command with additional arguments for mods needing custom flags or libraries.

## Recovery

**Recover mods** accepts one or several WHAM-generated `.wh.cpp` files. It validates all containers before any file writes, deduplicates identical shared-file candidates, and requires selection of divergent candidates. The picker can compare any two copies. Select a new directory or an existing destination, inspect reconstructed files and diffs, then write the tree. Differing existing files require explicit overwrite approval; dirty destination editors are protected.

Recovery recreates portable configuration selecting exactly the recovered entries, an empty output directory, and Git setup. Files are staged before commit with rollback on file-write errors. Destination symlinks and unsafe/case-colliding paths are rejected. Only files seen by the recovered entries are reconstructed; unused headers, other mods, Git history, and machine-specific editor settings are not embedded.

Multiple containers must share their source/output/include layout and external-include rules. Recover incompatible layouts separately. Recovered source edits are retained; unchanged generate → restore → regenerate is byte-identical. Edited repeated copies can be unified during recovery, so regeneration after edits may intentionally produce different hashes or source copies.

Recovery works with WHAM format-v1 and format-v2 outputs. An ordinary third-party `.wh.cpp` has no source-boundary records and cannot reconstruct its former source tree.

## CLI and development

Node.js 20+ is required for the standalone CLI. VS Code provides its own extension runtime.

```sh
npm ci
npm test
npm run package
node dist/cli.js init ./my-project
node dist/cli.js generate ./my-project
node dist/cli.js check ./my-project
node dist/cli.js restore first.wh.cpp second.wh.cpp ./recovered
node dist/cli.js verify first.wh.cpp /path/to/clang++ -std=c++23 -fsyntax-only
```

`init` and `restore` initialize Git by default; use `--no-git` to skip it. `generate --force` explicitly discards saved output edits. `restore --overwrite` explicitly permits differing existing destination files. CLI recovery fails before writes on divergent shared-file copies; resolve those using the extension UI. Use VS Code F5 with the included launch configuration to start an Extension Development Host.

See [current format specification](format-v2.md), [legacy format](format-v1.md), [validation report](validation.md), and [reference decisions](references.md). `examples/demo` contains two independent Windhawk mods sharing nested headers.

## Supported subset and limitations

Source is strict UTF-8, optionally with BOM. Unchanged recovery preserves original bytes and mixed line endings, including absent final newlines. Include cycles, conditional/late `#pragma once`, `#include_next`, module imports, `__has_include`, macro-generated local includes without explicit external rules, and multiline comments splitting directive tokens are diagnosed. Trailing multiline include comments are supported. Local source-root escapes and symlink aliases are rejected. Expansion is capped at 64 levels, 16 MiB per input file, 10000 participating files, and a 64 MiB expansion budget.

`__FILE__` and `__LINE__` observe the generated source. `#line` mapping and guard-aware cycle cutting are deferred. This is a textual include bundler, not an arbitrary compiler preprocessor or a multi-translation-unit linker. It does not deploy mods, run hooks, or publish to the Marketplace.

WHAM's own code is MIT licensed. The Windhawk icon and adapted syntax grammar are bundled under GPLv3, with editable source, licenses, and attribution in [third-party notices](../THIRD-PARTY-NOTICES.md). Unaffiliated with Ramen Software or Windhawk.
