# Windhawk renderer source

Pinned to Windhawk 2.0.0-alpha.7, commit 0cfc358. The corresponding, unmodified VS Code webview bundle is in `media/windhawk-renderer`. WHAM's adapter limits it to the read-only Discover preview. The installed Windhawk UI is not loaded.

The frontend and its sibling IPC contract package are provided here under GPLv3. The bundle retains its third-party license notices. To rebuild, run `npm ci`, `npm run build-css`, and `npm run build-ext` inside `src/windhawk-frontend`; the output is `dist/apps/windhawk-frontend`. Keep the sibling contract package in place. WHAM's own adapter source is in `src/details.ts` and `media/details.js`.
