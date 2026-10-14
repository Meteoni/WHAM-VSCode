## 1.5.3 — 2026-10-14

- All 41 regression tests passed. Expanded workflow coverage checks direct editor Apply, non-writing optional Review, dirty-editor protection, direct comparison of two recovery copies, single-mod commands, and no-installation folder browsing. Recovery uses one final replacement action and rejects destination changes made during confirmation.
- Browser checks passed optional Review submission and existing theme/narrow-layout regressions. A separate VS Code host passed activation, commands, generation, save handling, and output protection. Actual editor setup, indentation, recovery warning, and diff controls were captured in an isolated development window.

## 1.5.1 — 2026-10-14

- All 41 regression tests passed. Compiler fixtures confirm Verify shares per-mod flags and x64/ARM64 targets with Test build, does not link or produce a DLL, and retains cleanup and cancellation.
- Real Windhawk compiler checks passed syntax-only x86, x64, and ARM64 with a required metadata-defined macro and an unresolved external symbol. Full DLL link tests still pass and reject unresolved symbols. No mod was installed or loaded.
- Browser checks passed the compact Git lists, narrow widths, and five existing themes. The PNG listing icon is 256×256 and has an editable SVG source.

## 1.5.0 — 2026-10-13

- All 41 Node regression tests passed. Runtime fixtures cover Enabled preservation, temporary build isolation, Stop for all three build actions, successful-build proof, and older CLI gating. Compiler fixtures cover UTF-16 paths, target selection, quoted flags, output redirects, and cleanup on failure.
- Native x64 checks passed against Windhawk 2.0.0-alpha.7: modern annotation descriptors match the fallback, Windows argv and UTF-8 survive the managed process, cancellation closes the owned child tree, deadlines work, and a temporary DLL links successfully. An unresolved external symbol fails the link. These tests do not install or load a mod.
- Browser checks cover split-button size/corners/colors, menu actions, Escape and outside click, running Stop, stable tab widths, and five themes. The pinned read-only Draft renders the offline float fixture and retains its async shell, refresh indicator, and narrow layouts.
- An isolated VS Code development host passed activation, registered commands/sidebar, generation, document-save regeneration, and output-edit protection.

## 1.4.3 freshness checks

The adapter regressions cover independent .cpp edits, shared and nested headers, timestamp-only touches, content edits with preserved timestamps, missing-header creation, manual generation, reopening, and output protection. Runtime tests keep successful compile snapshots separate from Windhawk saved source and detect replacement library identities. Browser checks cover the wrench-and-dot indicator, tooltips, and text-before-switch layout across bundled themes.

# Validation

## 1.4.2 — 2026-10-13

- Toggle tests confirm one enable/disable command with no generation, parsing, source polling, or compilation. Duplicate actions are blocked and failures preserve the confirmed state. Labels reflect Enabled/Disabled and pending toggle operations.
- Successful builds do not open Output; warnings and errors do. Compile shows a spinner only for its own operation.
- Browser checks confirm equal 12px navigation insets for the project list and details, with content scrolling below the tabs. Loading and toggle states pass the theme and narrow-width checks.
- Launcher tests cover windhawk-ui.exe preference, legacy fallback, and direct EACCES failures handled through Windows ShellExecute. Launches/UAC are mocked.

- All 39 Node regression tests passed after separating Draft preparation and runtime polling. Focused checks cover preview/source refresh without installed-state reads, compile/enable without the native parser, scoped source export, missing versus denied configuration reads, and UTF-8 transport.
- The pinned-renderer browser checks and isolated real VS Code host passed with the existing compact toolbar.
- Windhawk 2.0.0-alpha.7 passed actual CLI configuration reads and the scoped source-export format. The rebuilt bridge passed stateless parsing and rejects installed-state commands. No installed mods were changed.
- Both x64 and ARM64 bridges compiled; ARM64 execution remains untested.


## 1.4.1 — 2026-10-13

- All 39 Node regression tests passed, including cached project state embedded before returning from details.
- Browser checks include VS Code's injected body padding and confirm the toolbar keeps its position and width as renderer styles load. At 240px and 340px, controls share one row and height, menus stay in view, and the preview fills the pane directly below the toolbar.
- Project and Settings restore before any host reply, without showing Setup. The folder Open button passed the existing theme and narrow-layout checks.

## 1.4.0 — 2026-10-13

- All 39 Node regression tests passed, including offline localized settings, older Windhawk previews, beta/RC CLI probes, split UTF-8 output, and mocked application launching.
- Headless Chromium passed the bundled Draft renderer without an installed Windhawk UI/core: immediate toolbar, Source/Output/More, read-only settings, blocked mutation requests, source refresh, English/Chinese, light/dark themes, and widths down to 240px. Sidebar checks passed with VS Code’s dark/light themes, high contrast, and visible scrollbars.
- An isolated VS Code Extension Development Host passed activation, generation, save handling, output-edit protection, the native parser, and the bundled Discover renderer in a real webview.
- Windhawk 2.0.0-alpha.7 passed the actual CLI help probes and native Chinese metadata/settings parsing. No installed mods were written or activated; the launcher was mocked.
- Both x64 and ARM64 bridges compiled. ARM64 execution and non-portable installation permissions remain untested.

Git-related tests create scratch projects in the system temporary directory, outside the source checkout. The older reports below describe their respective releases.


The 36 regression tests cover generation/recovery, project setup, and runtime controls. Runtime tests use a simulated Windhawk backend to check first-install disabling, preservation of enabled builds, fixed compile snapshots during edits, failure recovery, source-mapped compiler errors, and older-version notices.

The preview test runs the user's actual Windhawk 2.0 alpha 7 core parser and frontend. It deliberately holds all Windhawk assets while verifying that sidebar navigation and Source work first, then checks that loading native styles does not resize the controls. It also checks the More menu, pending-refresh dot and tooltip, preservation of open settings without extra renderer requests, Draft/Installed selection on refresh, and narrow/light layouts. Adapter tests check sidebar-first opening without additional core reads, restoring navigation, and ignoring late preview messages. Writes are simulated; no real mod is installed, enabled, or reconfigured. Browser checks also cover the sidebar across VS Code themes and narrow widths.

The packaged extension is checked in an isolated real VS Code Extension Host, including native parser invocation and the embedded Discover page's IPC handshake. The native bridge is built for x64 and ARM64; execution is verified on x64. ARM64 execution and actual process injection are not tested here.

## Version 1.1.2

The scrollbar regression was reproduced before the fix with visible browser scrollbars: the Generation screen narrowed both tab rows. After reserving the scrollbar gutter, measured button widths and positions are identical across Editor, Generation, and Git at 240px and 380px widths. The test explicitly confirms Generation overflows vertically and uses VS Code's 10px injected scrollbar dimensions. Existing sidebar workflows and theme assertions also pass with scrollbars enabled.

`test/grammar-validation.cjs` uses the installed VS Code Electron Node runtime, TextMate and Oniguruma, native C++/Markdown/YAML grammars, and Dark Modern theme. It validates the contributed injection and embedded-language mapping: metadata/localized fields, Markdown headings/bold, YAML booleans and alpha-editor `#!` annotations. Markers inside raw strings and ordinary comments stay in C++; highlighting resumes in C++ after the blocks. `syntax-highlighting-1.1.2.png` previews the actual theme-colored tokens, not a native-editor screenshot. The exact packaged grammar and isolated Extension Development Host are checked before delivery. The generation engine is unchanged.

## Version 1.1.1 styling checks

Version 1.1.1 changes sidebar CSS and documentation only. Its Chromium checks reran the existing sidebar workflows and added visible action-border, square-tab, straight active-indicator, keyboard-focus, and 240px layout assertions. The test loads installed Dark Modern and 2026 Dark/Light palettes with theme inheritance. Dark Modern's transparent secondary background is explicitly checked. High contrast and missing optional tokens use deliberate fixtures. Screenshots are provided as `sidebar-{setup,project,metadata,settings,git}-1.1.1.png` using Dark Modern. These are browser previews, not captures of the native editor. The exact packaged VSIX also passed the isolated Extension Development Host smoke test.

The unchanged engine and compiler checks below were completed for 1.1.0; they were not repeated for the styling patch.

## Version 1.1.0 baseline

Validated on Windows using VS Code 1.141.0, Node.js 24.20.0, and the user's installed Windhawk toolchain, Clang 20.1.3.

## Automated checks

`npm test`: 33 tests passing. Coverage includes independently constructed v1 and v2 format fixtures; byte-identical v2 generation, restoration and regeneration; legacy recovery; compact-boundary validation; nested includes; traditional guards and leading pragma-once; inactive branches; repeatable headers; include search ordering; lexical context and continuations; mixed newlines and BOMs; missing final newlines; independent shared-header mods; output mapping collisions; nested edits; divergent repeated copies; malformed containers; invalid paths; UTF-8 rejection; changing inputs; staged restore refusal on conflicts; serialized project save queues; dirty and edited output protection; unresolved include retry; stale-output ownership; Git setup and local-versus-shared ignore rules; editor JSONC preservation and readback; cross-workspace preference persistence; setup finishing before opening a folder; custom indentation; multiple-container recovery; metadata/README/YAML parsing and source-line warnings; fake metadata inside C++ strings/comments; brief Windows file-lock retries with intervening-edit protection; canonical-alias rejection; and destination-junction containment. The junction test requires Windows filesystem permission and was run outside the restricted sandbox.

`test/run-host.cjs`: isolated real VS Code Extension Development Host passed activation, command registration, sidebar registration, manual generation, actual document-save regeneration, and preservation of manually edited output. It uses dedicated user-data and extension directories; the user's normal editor configuration is unchanged.

`test/browser.cjs`: real headless Chromium passed separate Setup, Project, Mod Details, and Settings screens; direct setup choices and opening-folder preference; metadata labels and source navigation; plain-text preview safety; generation/recovery messages; preserved unapplied settings during progress updates and navigation; blocked-output discard actions; restored navigation state; and layout at 240px width. Screenshots are provided as `sidebar-setup-1.1.0.png`, `sidebar-project-1.1.0.png`, `sidebar-metadata-1.1.0.png`, and `sidebar-settings-1.1.0.png`. Native theme tokens are simulated for these screenshots.

`test/compiler-validation.cjs`: the bundled Windhawk Clang compiled original and generated sources for both demo entries with `WHAM_EXTRA=0` and `WHAM_EXTRA=1`. These are syntax checks using the actual API/header configuration, including `WH_MOD` and `WH_EDITING`. Generated `.clangd` configuration also passed Windhawk clangd's `--check` with no errors. All recovered files matched original source bytes.

Windhawk's `windhawk-cli source meta` accepted `examples/demo/output/demo.wh.cpp` and returned the expected ID, name, version, author, and process include metadata. No mod was installed or activated during validation.

## Practical limits

This validation does not claim compatibility with arbitrary compiler preprocessing, every existing mod, or runtime process injection. The included examples are original small representative mods, not a deployment test. Remote/virtual workspaces and unsupported lexical/preprocessing constructs are outside the release contract. Recovery requires intact generated structure; provenance hashes are not security signatures.

Optional validation scripts take executable/module paths as arguments, allowing the checks to be repeated on other installations. Git tests use Git on `PATH` or `WHAM_TEST_GIT`. Core tests use temporary directories under `work/` and make no changes to installed Windhawk mods.
