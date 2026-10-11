# Changes

## 1.2.2

- Use the same project list in the Active project dropdown and Setup picker, including recent projects and Browse.
- Remove the duplicate Open project button from the Project page.

## 1.2.1

- Keep the Active project dropdown visible when only one project is loaded.

## 1.2.0

- Open recent projects from Setup or the Project page, or browse for another source folder.
- Open existing WHAM projects without editor setup or review prompts.
- Show the active project name when only one project is loaded.
- Optionally create an initial Git commit for new and recovered projects when WHAM creates the repository. Preserve existing repositories and staged changes.

## 1.1.2

- Reserve vertical scrollbar space so the longer Generation settings screen does not shrink either navigation row.
- Check Editor, Generation, and Git tab positions and widths with visible VS Code-sized scrollbars at 240px and 380px sidebar widths.
- Adapt Windhawk's C++ injection grammar for theme-aware metadata fields, embedded README Markdown, and settings YAML, including alpha-editor `#!` annotations. Keep ordinary comments/strings in C++ and include GPLv3 source, attribution, and license.

## 1.1.1

- Follow GitHub Pull Requests and Issues' button treatment, including themed secondary borders for themes with transparent button backgrounds.
- Use native editor tab colors and a straight top border for both navigation rows.
- Verify button affordances and navigation against bundled Dark Modern, 2026 Dark, and 2026 Light palettes, plus high-contrast and missing-token fixtures.

## 1.1.0

- Use WHAM throughout the extension UI and remove the decorative sidebar header.
- Separate Setup, Project, Mod Details, and Settings screens; divide settings into Editor, Generation, and Git.
- Parse Windhawk metadata, README, and settings YAML, with source navigation and diagnostics.
- Ignore generated output and local editor/toolchain files while retaining portable project settings and formatting.
- Open configured projects after setup by default, with a checkbox and extension setting to opt out.
- Preserve editor preferences across workspaces and read existing applied settings, including JSONC comments/trailing commas.
- Use compact v2 include boundaries, readable directives in a recovery footer, and keep v1 recovery support.
- Bundle the original Windhawk icon with GPLv3 license and attribution.
- Retry brief Windows file locks during atomic replacement while preserving intervening disk edits.

## 1.0.0

Initial source amalgamation, reversible recovery, sidebar controls, project setup, Git and Windhawk editor integration.
