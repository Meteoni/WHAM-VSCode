# Changes

## 1.5.5

- Split Project settings and Extension settings; keep Editor, Generation, and Git under Project settings.
- Remove the redundant Settings heading and show the project name only under Project settings.
- Use one Windhawk installation across projects and simplify the elevation labels.

## 1.5.4

- Separate computer preferences, local project overrides, and shared project configuration; migrate existing choices.
- Save local preferences independently from applying editor and formatting files.
- Add Windows sudo and gsudo for installed-mod writes, preserving streamed logs and cancellation.
- Reuse gsudo approval for the VS Code session and close only WHAM's process-scoped cache on unload.

## 1.5.3

- Apply editor settings directly; add optional Review changes without writing files.
- Combine recovery and replacement approval into one final action, with optional file review.
- Compare two recovery copies directly and skip mod pickers for single-mod commands.
- Browse directly when no Windhawk installation is detected.
- Use explicit Skip actions during editor setup, keeping unsaved-file and concurrent-edit protections.

## 1.5.2

- Rewrite relative README images and links to GitHub URLs when packaging; keep one source README.
- Use buttons for fixed setup choices: setup mode, new/recovery folder, editor setup, and indentation. Search stays available for project, installation, and file lists.

## 1.5.1

- Show compact filename lists on the Git page.
- Use Test build’s compiler options, mod defines, and architecture selection for Verify, without linking or installing.
- Set publisher to Meteoni and add the GitHub repository link and a 256px PNG listing icon. The extension ID is now Meteoni.windhawk-amalgamation.

## 1.5.0

- Preserve Enabled when compiling; keep new mods disabled until enabled.
- Add a compact Compile dropdown with Test build, Verify syntax, and Stop compilation. Test builds never install or load a mod.
- Add cancellation and deadlines for CLI/compiler processes.
- Preview newer settings annotations offline, with parser fixtures and independent capability checks.
- Move the log icon and Generate all beside the Mods heading.
- Hide pinned renderer controls with scoped styles rather than repeated DOM edits.

## 1.4.4

- Use small borderless Codicon indicators for compilation needed and unknown builds, with tooltips.

## 1.4.3

- Refresh only mods affected by changed source or include paths; reuse unchanged Draft expansions.
- Check existing output when opening projects instead of marking everything stale.
- Remember successful compile snapshots with Windhawk's library identity. Saved Windhawk source is not proof of a compiled build; external builds show an unknown status.
- Put Enabled/Disabled before the switch. Use a wrench-and-dot indicator for compilation, with tooltips on all status pills.

## 1.4.2

- Handle direct launch access failures through Windows ShellExecute, with a friendly failure message.

- Add a small Compile spinner. Keep navigation widths consistent between project and details by scrolling content below the tabs.
- Prefer windhawk-ui.exe on newer installations and fall back to windhawk.exe.

- Show Enabled/Disabled and separate toggle progress from Compiling. Enable/disable sends one CLI command and does not generate or poll source.
- Open Output only for build errors or warnings; successful builds log quietly.

- Separate source/Draft refresh from installed-mod polling. Source edits and preview Refresh use the cached installed source.
- Read installed configuration and source through the CLI; remove native session access.
- Make the native parser/compiler flags optional. Compile and enable/disable work without the bridge.
- Poll once after compilation; preserve source comparison across project changes using Windhawk’s stored source.

## 1.4.1

- Keep the sidebar width steady when opening mod details, and restore the project immediately when returning.
- Use an external-open glyph for Windhawk and add Open beside the project folder icon.
- Put preview actions on one compact toolbar, with a triangular More expander and hover backgrounds for icon buttons.
- Remove the outer inset so the preview card uses the full pane width.

## 1.4.0

- Pin the read-only Draft renderer and include its corresponding source; remove Installed mode. Preview legacy mods without a Windhawk installation.
- Add an Open Windhawk glyph beside Refresh. Keep Source and Output visible and move Generate under More.
- Probe CLI capabilities across alpha/beta/RC versions, recheck changed installations, and preserve Unicode across process output chunks.
- Use the same language for the source parser and renderer.

## 1.3.2

- Make Refresh icon-only, with a tooltip.
- Give the ellipsis menu the same border and sizing as the other toolbar buttons.
- Include sidebar styles in the initial page to avoid a layout flash when opening or leaving mod details.
- Mark changed source or builds with a dot on Refresh and an updated tooltip, instead of reloading details automatically. Refresh chooses Draft or Installed from the current build state.

## 1.3.1

- Open mod details in the sidebar, with a back arrow beside the mode switch.
- Show navigation and actions before loading Windhawk's renderer; use cached mod data and refresh in the background.
- Choose Draft for uncompiled source and Installed for a matching build, without discarding unsaved settings.
- Put Compare, Recover…, and Verify under an ellipsis menu beside Output. Place Refresh beside the mode switch.
- Move the project-folder button beside Active project and shorten the compilation pill to uncompiled.

## 1.3.0

- Add Compile and an enabled switch to mod cards. First builds install disabled; recompilation preserves the installed enabled state.
- Open Windhawk’s installed Details/Settings renderer in an editor pane, with Draft and Installed modes and live draft refresh.
- Use Windhawk’s Discover renderer for read-only Draft settings, with a single mode switch and tooltips. Delegate installed settings, compilation, and enable/disable to Windhawk’s CLI.
- Reuse the installed core parser and compiler flags; retain source locations and map compiler errors back to original files.
- Track draft changes separately from the installed build, preserve old builds after failures, and refresh runtime state when VS Code regains focus.
- Gate integration by available CLI/core capabilities. The embedded frontend currently supports the verified 2.0 alpha 7 bundle.

## 1.2.4

- Shorten mod button labels while keeping their explanatory tooltips and action groups.

## 1.2.3

- Clarify mod action labels, including Recover from output… and Check syntax.
- Add tooltips and group main actions above output comparison, recovery, and syntax checks.

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
