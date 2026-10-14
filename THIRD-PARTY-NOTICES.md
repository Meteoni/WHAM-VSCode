# Windhawk icon

`media/windhawk.svg` is the unmodified Windhawk tab icon from Ramen Software's Windhawk project:
https://github.com/ramensoftware/windhawk/blob/main/src/windhawk-vscode/assets/tab-icon-white.svg

It is distributed under the GNU General Public License, version 3; see `media/WINDHAWK-ICON-LICENSE.txt`. The editable SVG source is included in the extension package and source archive. `media/wham-icon.svg` and its 256px PNG listing icon adapt that artwork with a blue background and WHAM label, and are distributed under the same GPLv3 license. WHAM is an independent extension; use of the icon does not imply endorsement by Windhawk or Ramen Software.

# Windhawk syntax grammar

`syntaxes/windhawk.injection.json` is adapted from Ramen Software's Windhawk C++ injection grammar:
https://github.com/ramensoftware/windhawk/blob/main/src/windhawk-vscode/syntaxes/cpp.injection.json

It is distributed under the GNU General Public License, version 3; see `syntaxes/WINDHAWK-GRAMMAR-LICENSE.txt`. Changes made for WHAM on 2026-10-11 give the grammar a distinct scope, exclude C++ strings/comments and embedded regions from injection, and accept indented wrapper markers. The editable grammar is included in the extension package and source archive. WHAM's independently authored source remains MIT licensed.

# Windhawk Draft renderer

`media/windhawk-renderer` contains the unmodified VS Code webview assets from Windhawk **2.0.0-alpha.7**, commit **0cfc358**, using IPC contract **1.26.0**. Copyright Ramen Software and Windhawk contributors. The frontend is GPLv3; its license and dependency notices are included beside the assets. Corresponding source and build instructions are included under `vendor/windhawk` in the repository, source archive, and VSIX. WHAM restricts the renderer through its independently written adapter; the upstream assets are unchanged. The file `pin.json` records their hashes.

Windhawk integration separately loads the user-installed `windhawk-core.dll` and invokes its CLI. WHAM does not redistribute Windhawk’s core DLL, engine, or compiler. WHAM’s native bridge and adapter source are included in this repository.
