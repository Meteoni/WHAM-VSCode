# Reference decisions

The attached implementation plan and linked design conversation supplied the initial contract: independent `.cpp` mods, textual branch retention, reversible readable regions, output ownership protection, and entry-specific recovery.

The user's existing `.vscode/c_cpp_properties.json` supplied the working Windhawk compiler configuration: bundled Clang, C++23, x64 MinGW, forced `windhawk_api.h`, `WH_MOD`/`WH_EDITING`, and Windows version macros. Their `.clang-format` used Chromium with metadata comment protection.

[GabrielHoy/WindhawkUtilities](https://github.com/GabrielHoy/WindhawkUtilities) was reviewed as a reference. Relevant ideas incorporated through independently written TypeScript are:

- Install discovery through `WINDHAWK_HOME`, both registry views, and conventional locations, validating candidates before use.
- Windhawk's Chromium formatting base and protection for metadata comments; WHAM also protects recovery records.
- Generated-output exclusion from search and clangd background indexing.
- Using Windhawk's bundled language server and compiler flags to keep editor analysis aligned with the toolchain.

No PowerShell scripts, vendored executable, daemon, or source libraries from that repository are bundled. Its metadata/readme/settings externalization and `#line` mappings remain future work because they require additional reversible transformations. Installation, elevated build daemons, hooks, and hot reload are outside this release's source-generation scope. The reference repository is MIT licensed; its author is Gabriel Hoy.

Primary platform references:

- [Windhawk's editor syntax grammar](https://github.com/ramensoftware/windhawk/blob/main/src/windhawk-vscode/syntaxes/cpp.injection.json): adapted directly for metadata, Markdown, and YAML highlighting, including alpha-editor `#!` settings annotations. GPLv3 source and attribution are included. [VS Code grammar injection and embedded languages](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide) keep the existing C++ language and theme integration.
- [GitHub Pull Requests and Issues button styles](https://github.com/microsoft/vscode-pull-request-github/blob/main/webviews/common/common.css): primary/secondary colors, secondary borders, compact padding, focus treatment, and corner radius. WHAM keeps its existing markup and behavior; navigation uses native [editor tab theme tokens](https://code.visualstudio.com/api/references/theme-color#editor-groups--tabs).
- [Windhawk mod layout and metadata](https://github.com/ramensoftware/windhawk/wiki/Creating-a-new-mod)
- [VS Code API](https://code.visualstudio.com/api/references/vscode-api)
- [Microsoft C/C++ configuration reference](https://code.visualstudio.com/docs/cpp/customize-cpp-settings)
- [clangd project configuration](https://clangd.llvm.org/config)
- [GCC include guards](https://gcc.gnu.org/onlinedocs/cpp/Once-Only-Headers.html)
