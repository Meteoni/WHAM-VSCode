# WHAM user guide

Edit directory-based C++ sources, generate one standalone `.wh.cpp` per mod, and recover the entry and its local includes from that file alone. The extension includes a project sidebar, Git setup, configurable indentation, and Windhawk compiler integration.

## Install and start

1. In VS Code, run **Extensions: Install from VSIX…** and choose the WHAM `.vsix` file.
2. Open the **WHAM** activity-bar view. **Setup** offers a new project, an existing project, or recovery from one or more generated `.wh.cpp` files.
3. Select your Windhawk installation and indentation in the setup prompts. Change these later under **Settings → Editor**.
4. **Open project after setup** is enabled by default and opens the folder in the current window, activating its editor configuration. You can clear this checkbox or disable `wham.openProjectAfterSetup` in VS Code settings. Install the recommended C++ language extension if it is missing.

New projects get `src/`, `output/`, `windhawk-amalgamation.json`, and a Git repository when there is no enclosing repository. Ignore rules cover output, `.vscode/settings.json`, `.vscode/c_cpp_properties.json`, and `.clangd`. Source, portable rebuild configuration, `.clang-format`, extension recommendations, and `.gitignore` remain shareable. Existing ignore rules and repositories are preserved; already tracked files stay tracked. **Create initial Git commit** is opt-in (default off, also configurable with `wham.createInitialCommit`). It applies to new or recovered projects only when WHAM creates the repository, after editor setup. The commit includes setup files and recovered sources; it excludes generated output and machine-specific settings. Existing repositories and staged changes are left alone. WHAM uses your configured Git identity and never pushes. If committing fails, the project still opens; check the WHAM log and commit from Source Control after fixing Git configuration. **Settings → Git** explains the policy, updates ignore rules for older projects, refreshes Git status, and opens Source Control.

**Open project** lists up to 15 recent project folders across VS Code sessions, with their paths, plus **Browse for a project folder…**. With no history, it goes directly to the folder picker. Missing folders/configurations are removed from the list. Existing WHAM projects open directly without editor setup, configuration review, or Git changes. The Active project dropdown uses the same recent-project list and Browse option as the picker in Setup. Select a project to open its folder, or Browse to choose another source folder.

Existing projects use their configuration if present. Opening a source folder without WHAM configuration creates the project layout and Git setup without an editor review step. Configure the compiler and indentation later under **Settings → Editor**. If there is no configuration, the default source directory is `src`; point **Settings → Generation** at existing source/include subdirectories as needed. Existing flat projects must place their mod sources in a source subdirectory; overlapping source and output roots are unsupported. Setup never moves existing sources automatically.

The **Project** screen shows the selected project, generation controls, and independent mods. Selecting a mod name opens its Details and Settings in the sidebar; see Windhawk integration below. Without a supported Windhawk UI bundle, WHAM shows parsed metadata, README text, and settings YAML instead. Warnings identify missing/duplicate metadata and malformed YAML in Problems. **Generate**, **Source**, and **Output** are visible; the **...** menu holds **Compare**, **Recover…**, and **Verify**. Hover over an action for a short explanation. Unsaved source edits update the preview. The folder icon beside **Active project** opens the selected project's folder in VS Code.

In the C++ editor, Windhawk metadata fields, README Markdown, and settings YAML receive syntax highlighting through an adaptation of Windhawk's own grammar. This works in source and generated `.wh.cpp` files without changing their C++ language mode or compiler integration. Colors follow your active theme; ordinary comments and strings keep normal C++ highlighting. Reload VS Code after upgrading to register the grammar.


## Windhawk integration

Select your installation in **Settings → Editor**. WHAM uses the local core for metadata, Markdown/settings parsing, and baseline compiler flags. It retains its source locations for diagnostics and source navigation.

Each mod card keeps **Generate** and **Source** on the left, with **Compile** on the right. The **Enabled** switch sits beside the source-file count, and an amber tools icon appears beside the output status when compilation is needed. A muted question mark means WHAM cannot confirm the installed build’s source. Hover over the icons or output pill for their meaning. Compile regenerates saved source first and submits that fixed snapshot through `mod install --file -`. New local mods install disabled as `local@<id>`; existing builds preserve their enabled state. Generation remains independent and never installs a mod by itself. Edited output is protected and must be resolved before compilation.

Click a mod’s name to open its read-only Draft preview in the sidebar. Back returns to the list. Source and Output stay visible; the triangle opens More, containing Generate, Compare, Recover…, Verify, and Discard output edits when needed. The external-open glyph beside Refresh opens Windhawk so you can manage installed settings. The toolbar appears first while the content loads. A dot on Refresh indicates changed source.

“Uncompiled” means the draft differs from the installed source. Compiling an enabled mod replaces its active build. If compilation fails, the previous build and its enabled switch remain available. Compiler diagnostics map back to original project files. Runtime state refreshes when VS Code regains focus.

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

Output edits are protected. **Mod Details → Compare** opens the existing output against expected saved-source output. **Recover…** recovers edits into a new or selected project after preview and conflict resolution. **Discard output edits…** requires an explicit confirmation; unsaved output buffers must first be saved or reverted. The extension writes only changed bytes and rechecks source fingerprints before committing. Deleted entries remove only unchanged outputs with previously established ownership; edited orphan outputs remain on disk.

Include boundaries use short readable comments, such as `// WHAM@3 begin 1: src/includes/test.h` and `// WHAM@3 end 1`. Exact original directives and padding details are stored in a foldable recovery section at the end. Its lines stay within 120 characters, including long directives and configuration strings. Empty padding fields are omitted. Keep boundaries, synthetic guards, and the footer intact when editing an output. WHAM 1.5.12 reads v1, v2, and [v3](format-v3.md); older WHAM versions cannot recover v3. Regenerating unchanged older output upgrades it to v3.

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

**Apply editor settings** applies directly. **Review changes…** optionally opens a diff without writing files. Apply creates or updates configuration for Microsoft C/C++, clangd, or both. It uses your selected installation's `Compiler/bin/clang++.exe`, `Compiler/include/windhawk_api.h`, C++23, the x64 MinGW target, Windows version defines, `WH_MOD`, and `WH_EDITING`. This resolves Windhawk-only API declarations while authoring. The language-service extension itself must be installed; WHAM creates extension recommendations without installing extensions automatically.

Detection checks `WINDHAWK_HOME`, both Windows registry views, Program Files, `<home>/Portable Programs/Windhawk`, and `<home>/scoop/apps/windhawk/current`. The portable paths are fixed layout guesses using the current user's home directory; WHAM does not scan the disk or hard-code a username. Every candidate must contain the compiler and API header. Saved preferences and existing project compiler settings can also supply the path. You can always browse to a custom installation.

The named Microsoft C/C++ configuration is **Windhawk (WHAM)**. Select it through **C/C++: Select a Configuration** if your editor remains on another configuration. clangd configuration uses Windhawk's own `clangd.exe` and a managed fragment in `.clangd`. Choosing clangd disables the Microsoft C/C++ IntelliSense engine for the project to avoid competing diagnostics. Configuring both prepares both services; choose one as your primary provider.

Spaces/tabs and a width from 1–16 are configurable per project in the sidebar. Settings update C++ editor indentation and `.clang-format`; existing formatting options and JSONC comments are preserved. New formatting starts with Windhawk's Chromium base. Metadata and `WHAM` comments are protected from comment reflow. Formatting source is supported; formatting an amalgamated output can change generated guard sections and break automatic recovery, so keep generated sections intact.

Editor changes to existing files are shown in a review picker with diffs. Dirty settings buffers block application. Preferences persist across folder switches, and opening a project reads its applied JSONC and formatting configuration to populate the sidebar. Saved changes to those files also refresh the displayed preferences without replacing unapplied form edits. Installation paths are stored locally and are absent from the recovery manifest. Machine-specific editor files receive Git ignore rules; already tracked files remain tracked by Git. Output is excluded from project search, and clangd background indexing skips generated copies. Source/include-directory changes can be synchronized by applying editor settings again.

**Test build** compiles and links saved source into temporary DLLs with the selected Windhawk compiler and engine import libraries. It follows `@architecture` and `@compilerOptions`, then removes the DLLs. It does not install or load the result, change Enabled, or establish a compiled-source baseline. It uses baseline Windhawk build flags; installation-only compatibility exceptions and precompiled-header caches remain Windhawk’s responsibility.

The Compile dropdown offers **Stop compilation** during compilation, Test build, or verification. Stop first asks the process to cancel and then closes its owned process tree if necessary. A completed installation can win a late Stop request; WHAM reports the actual result. CLI reads have a 15-second deadline, builds have a ten-minute deadline, and output is bounded.

**Verify** syntax-checks the existing generated output for every architecture declared in that file. With a Windhawk installation selected, it shares Test build’s compiler setup, `@compilerOptions`, and mod/version defines, without linking, installing, or activating a DLL. Without a selected installation, it prompts for a compiler and explicit arguments. Verification never runs during ordinary generation.

## Recovery

**Recover mods** accepts one or several WHAM-generated `.wh.cpp` files. It validates all containers before any file writes, deduplicates identical shared-file candidates, and requires selection of divergent candidates. The picker can compare any two copies. Select a new directory or an existing destination. One final action lists the files and any replacements. Review files is optional; after opening a preview, the final recovery action remains in a notification so the diff stays visible. Dirty editors and files changed during review are protected.

Recovery recreates portable configuration selecting exactly the recovered entries, an empty output directory, and Git setup. Files are staged before commit with rollback on file-write errors. Destination symlinks and unsafe/case-colliding paths are rejected. Only files seen by the recovered entries are reconstructed; unused headers, other mods, Git history, and machine-specific editor settings are not embedded.

Multiple containers must share their source/output/include layout and external-include rules. Recover incompatible layouts separately. Recovered source edits are retained; unchanged generate → restore → regenerate is byte-identical. Edited repeated copies can be unified during recovery, so regeneration after edits may intentionally produce different hashes or source copies.

Recovery works with WHAM format-v1 and format-v2 outputs. An ordinary third-party `.wh.cpp` has no source-boundary records and cannot reconstruct its former source tree.

## CLI and development

Node.js 20+ is required for the standalone CLI. VS Code provides its own extension runtime.

```sh
npm ci
npm test
npm run build:bridge -- "C:/path/to/Windhawk/Compiler/bin/clang++.exe"
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

`__FILE__` and `__LINE__` observe the generated source. `#line` mapping and guard-aware cycle cutting are deferred. This is a textual include bundler, not an arbitrary compiler preprocessor or a multi-translation-unit linker. Generation does not deploy mods or run hooks. Compile delegates installation to Windhawk; WHAM does not publish to the Marketplace.

WHAM's own code is MIT licensed. The Windhawk renderer, icon, and adapted syntax grammar are bundled under GPLv3, with editable source, licenses, and attribution in [third-party notices](../THIRD-PARTY-NOTICES.md). Unaffiliated with Ramen Software or Windhawk.

## Windhawk compatibility

The Draft renderer is bundled and pinned to Windhawk 2.0.0-alpha.7. It does not load the installed UI files. WHAM uses a compatible native parser when available; otherwise its local parser previews metadata, Markdown, groups, arrays, options, and newer format, float, range, dynamic-select, and conditional annotations, including `#!` declarations. The fallback is for display; Windhawk still validates installed source. The renderer and parser use the same selected language, with English as a fallback. WHAM’s own controls remain in English.

Compile, Enabled, and installed-state queries use the installed CLI. CLI command probes accept alpha, beta, RC, and release version names; the CLI requires JSON schema 1. The optional parser bridge requires ABI 2 and exposes only stateless parsing/compiler flags. WHAM probes again when the selected CLI/core files change. An incompatible installation shows an upgrade notice when its controls are used. The Enabled switch reflects Windhawk’s configuration, not proof that injection succeeded.

Native integration requires local Windows x64 or ARM64. The x64 portable installation is tested; ARM64, standard/per-user installs, and permission-sensitive setups need additional testing. Remote, browser, virtual, and untrusted workspaces are unsupported. Source generation and recovery do not require Windhawk. Project setup currently requires Git; missing Git reports an error. Editor configuration currently targets x64. Verify and Test build follow the mod’s declared architectures.

## Integration boundaries

Generation and recovery use WHAM’s own engine. Source and include-path changes refresh only dependent mods. Opening a project reconstructs its dependencies and checks existing output against current inputs. Content hashes determine freshness; changing only a file's timestamp does not make its output stale. Draft Refresh does not poll installed mods.

Runtime actions and configuration reads use Windhawk’s CLI. After a successful WHAM compile, WHAM stores the submitted source hash and the compiler-owned library name in VS Code's local extension data. It compares future source with that snapshot only while Windhawk reports the same library. Saving source in Windhawk without compiling does not change this baseline. An existing build without a WHAM record, or a replacement built externally, shows a muted question-mark icon. Compile once through WHAM to establish a known baseline. Enabled state is independent of source freshness.

Installed state is polled on focus, installation changes, and after compilation. Enable/disable uses its single CLI response without generating or polling source. WHAM does not inspect private Windhawk storage or use editable saved source as evidence of a compiled DLL.

The optional core DLL connection has no session or installed-state access. It supplies source parsing and baseline compiler flags, probed separately. The packaged native helper also owns CLI/compiler process trees for cancellation and deadlines; runtime operations do not require the core DLL parser. The pinned renderer remains read-only and independent of the installed UI.

Fixed setup choices use button dialogs. Folder names and custom widths use text inputs; project, installation, and file lists remain searchable. Packaging rewrites relative README links and images for the GitHub main branch without changing the source README.

Single-mod commands skip the mod picker. With no detected Windhawk installation, Browse opens the folder dialog directly. Editor setup has one Skip action; the indentation dialog labels its dismiss action Skip editor setup. The unsaved-source Save Relevant Files prompt remains separate.
