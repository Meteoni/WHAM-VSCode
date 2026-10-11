# WHAM

Windhawk Source Amalgamation for VS Code.

Write a Windhawk mod across several C++ files, then generate a single `.wh.cpp` to use in Windhawk. The output also keeps the information needed to recover those source files later.

![WHAM's project sidebar beside a Windhawk mod with Markdown syntax highlighting](docs/images/wham-project.png)

## Getting started

1. Install the WHAM `.vsix` through **Extensions: Install from VSIX…** in VS Code.
2. Open **WHAM** in the activity bar. Choose **New project**, **Existing project**, or **Recover mods**.
3. For new or recovered projects, select your Windhawk installation and indentation. You can change these under **Settings → Editor**.

**Open project** remembers recent folders and opens existing WHAM projects without setup prompts. Browse to select another source folder.

Keep each mod's entry `.cpp` and its local headers under `src/`. WHAM follows the includes and writes one `.wh.cpp` per entry to `output/`.

```text
src/mod.cpp + included headers → output/mod.wh.cpp
```

Output updates when you save. Use **Generate** for a single mod or **Generate all** for the project. **Settings** controls generation, compiler integration, indentation, and Git ignore rules.

New projects get `src/`, `output/`, configuration, and Git setup. Generated output and local compiler settings are ignored. **Create initial Git commit** is optional for new or recovered repositories; it uses your existing Git identity.

## Recovery

**Recover mods** rebuilds a source tree from one or more WHAM-generated files. Keep the `WHAM` boundary comments and recovery footer intact. Ordinary `.wh.cpp` files cannot recover their former project layout.

If you edit generated output, WHAM pauses regeneration so your changes aren't overwritten. Restore those edits to source or explicitly discard them before generating again.

WHAM bundles includes; it doesn't install or activate mods. See the [user guide](docs/guide.md) for configuration, CLI commands, and supported C++ constructs.

## Building

Use Node.js 20 or newer and Git.

```sh
npm ci
npm test
npm run package
```

Packaging creates a `.vsix` in this folder. Press **F5** in VS Code to launch a development host.

## License

WHAM's own code is [MIT licensed](LICENSE). The Windhawk icon and adapted syntax grammar are GPLv3; see [third-party notices](THIRD-PARTY-NOTICES.md). WHAM is an independent project.
