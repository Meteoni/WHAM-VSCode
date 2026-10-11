# Validation for version 1.1.2

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
