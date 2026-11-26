# Windhawk renderer source

Pinned to Windhawk 2.0.0-alpha.8, commit `7413a57a3f964a6e0e11f491f388da103d947a5d`. The corresponding, unmodified VS Code webview bundle is in `media/windhawk-renderer`. WHAM's adapter limits it to the read-only Discover preview. [Upstream release](https://github.com/ramensoftware/windhawk/releases/tag/2.0.0-alpha.8)

The frontend and its sibling IPC contract package are provided here under GPLv3. To rebuild, keep the packages side by side in a scratch copy, then run these commands from their parent directory.

```powershell
$npmCache = 'C:\path\to\WHAM-VSCode\work\npm-cache'
$env:CYPRESS_INSTALL_BINARY = '0'
npm --prefix windhawk-webview-ipc-contract ci --cache $npmCache
npm --prefix windhawk-frontend ci --cache $npmCache
npm --prefix windhawk-frontend run build-ext --cache $npmCache
```

The contract installs first so its `prepare` script can use its pinned TypeScript. The Cypress binary is only needed for the upstream browser tests. Replace the contents of `media/windhawk-renderer` with the contents of `windhawk-frontend/dist/apps/windhawk-frontend` and the upstream GPL `LICENSE`. Regenerate `pin.json` with the version, commit, contract version, and SHA-256 of each asset and license. WHAM's adapter source is in `src/details.ts`, `media/details.js`, and `media/details.css`.
