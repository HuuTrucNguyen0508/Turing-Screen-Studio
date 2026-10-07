# Turing Screen Studio

Design smart-screen dashboards in your browser. Arrange widgets with exact pixel geometry, try a different canvas size, preview with sample data, and export a layout as JSON.

This project was vibecoded with AI coding assistants. Tests and reviews are recorded in the [verification notes](docs/verification.md).

The offline editor runs on Windows, macOS and Linux with Node.js and pnpm. It needs no screen, Python, sensors, credentials or Caelestia installation. After installing dependencies and building, it can run without internet access on a local preview server.

USB support is experimental and specific to one existing Linux installation. This repository does not yet include a standalone hardware transport or a general screen installer. Other canvas sizes support design, export and preview; their USB output is untested. See [screen sizes](docs/screen-sizes.md).

## Quick start

Install Node.js 22.12 or newer and pnpm 11.28.3, then run:

```bash
git clone https://github.com/HuuTrucNguyen0508/Turing-Screen-Studio.git
cd Turing-Screen-Studio
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173`. The server listens on loopback only. For a production build:

```bash
pnpm build
pnpm preview
```

Open `http://127.0.0.1:4173`. Keep that local server running when using the editor offline. Fonts and sample data are bundled.

## Make a layout

Use Create layout for a designed starting point, open [the sample layout](public/sample-layout.json), or add widgets from the searchable catalog. It includes metric, weather, clock, text, storage and gauge cards, plus AI usage summaries, T3 threads and game timers. Gauge designs include arc, ring, bar, segmented meter, thermometer and number. Browser previews use deterministic samples.

Select a card and drag to move it, or use its lower-right handle to resize. Arrow keys nudge one document pixel; Shift moves ten. Numeric fields commit on Enter or when you leave the field. Invalid values leave the document unchanged. Escape cancels an unfinished drag or field edit.

Shift-click to select several cards. Ctrl+A selects all outside text fields. Move groups, align or distribute cards, change their layers, or match the selected reference card's width, height or size. Matching leaves the selection unchanged if it would put any card outside the canvas.

Snapping helps align edges, centers and 24-pixel gutters. Numeric fields and keyboard nudges remain precise. Zoom, pan and Fit change the view without changing saved geometry. Use Canvas size for a preset or custom dimensions, then choose Fit cards, Keep positions or Clear and resize. See [how resizing works](docs/screen-sizes.md#resize-an-existing-layout).

Undo and Redo cover committed edits, including canvas resizing. Use Ctrl+Z and Ctrl+Shift+Z or Ctrl+Y outside text fields. A completed drag counts as one edit. Opening a layout starts a new history of up to 100 edits.

Open Design in the inspector to adjust clock text alignment, offsets, font sizes, palette colors and visibility. Save as custom widget keeps a reusable copy. Add widget lists these under Custom widgets; Manage custom widgets supports rename, replacement, removal and import/export. Offline copies are saved in this browser.

Export JSON saves your draft at its chosen canvas size. Open layout reopens it with the same geometry and settings. Invalid imports preserve your draft. Export keeps the unsaved warning until you reopen the file because the browser cannot tell whether you cancelled the download.

Draft recovery backs up committed edits in this browser. Reloading offers Restore draft, Export backup and Discard draft; Recover drafts opens that list later. Each tab has its own backup. Uncommitted text and unfinished drags are not backed up. Keep a separate JSON export for layouts you want to retain.

Import scheme.json can read a Caelestia palette file you select, such as `~/.local/state/caelestia/scheme.json`. The editor starts with a bundled palette and preserves imported preview colors in exports.

The clean drafts in [system-overview-clean.json](layouts/system-overview-clean.json) and [ai-usage-30d.json](layouts/ai-usage-30d.json) omit the fixed header and footer. Usage cards separate tokens, API cost estimates and cached provider quotas. Missing history, stale observations and unpriced models remain visible. See [usage data](docs/usage-data.md), [thread and timer data](docs/thread-game-data.md) and [widget design references](docs/widget-design-references.md).

## Optional Linux Studio API

The local Python API provides PIL previews and saved-layout tools. It is currently supported on Linux with Python 3.10 or newer and Pillow. It can run without the legacy dashboard or a USB device, but live sensor readings and panel acknowledgements require the existing runtime.

From the repository root, after the JavaScript setup:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
pnpm studio
```

Open `http://127.0.0.1:5174`. Studio builds the editor and serves it with a loopback API. The launcher prefers the project's `.venv` over the legacy dashboard environment. To select a different interpreter explicitly:

```bash
TURZX_PYTHON=/absolute/path/to/python pnpm studio
```

The API keeps local state under `~/.local/share/turzx-studio/`. Its active panel layout and saved dashboard library accept only 1280 × 800. Custom sizes remain editor drafts for export and preview.

Connected features include live preview, Data sources, Library, History and custom widget storage. Live preview uses the existing runtime's readings and falls back to samples when fresh data is unavailable. Library edits and panel saves use separate revision checks. A conflict keeps your draft and offers a comparison. Every changed panel save, library replacement or removal archives the previous document under `older-config/`. History can reopen an archive as a draft or download its JSON.

Saved layouts supports up to 12 dashboards. Previous and Next reach the full list; Ctrl+F9 through Ctrl+F12 select the first four when the legacy desktop shortcuts are installed. Reordering changes those assignments. Saving the library alone does not switch the panel, and switching leaves an unsaved editor draft intact.

## Generate layouts with an agent

Describe the dashboard you want and ask for a preview. The [agent workflow](docs/ai-layouts.md) uses stable widget template IDs, [the layout contract](docs/layout-format.md), [the catalog](public/widget-catalog.json) and [the schema](public/layout.schema.json). The CLI needs the Python setup above.

```bash
pnpm layout presets
pnpm layout generate --preset system-overview --output layouts/my-dashboard.json
pnpm layout validate layouts/my-dashboard.json
pnpm layout preview layouts/my-dashboard.json --output artifacts/my-dashboard.png
```

Generation, validation and preview never open USB. Add `--panel` to validation when preparing a 1280 × 800 layout for the existing adapter. The API commands `pnpm layout current`, `pnpm layout history` and `pnpm layout saved` inspect local state. Apply and restore require the current revision and archive the replaced layout first. `pnpm layout slot 3` switches to a saved dashboard through the API.

## Experimental legacy USB integration

The existing adapter expects the custom dashboard at `~/Documents/dashboard`, its Python environment, the separately installed driver at `~/Documents/turing-smart-screen-python`, and `turzx-dashboard.service`. These dependencies are not included here. A fresh clone cannot send frames to a screen by itself.

The documented machine renders a 1280 × 800 landscape dashboard. Its JPEG transport rotates the image 270° into an 800 × 1280 wire frame. Resolution presets describe canvases, not compatibility with a screen model or diagonal size. Other resolutions and USB devices have not been verified.

Read [panel setup and rollback](docs/panel-integration.md) before using these commands on that existing installation:

```bash
pnpm panel:install
pnpm panel:rollback
pnpm shortcuts:install
```

The panel installer backs up the original dashboard and adds a separate systemd override, then restarts its service. Rollback removes the override and restarts the original runtime. The shortcut installer changes Caelestia/Hyprland configuration and enables the local Studio API service. These are machine-specific integration commands, not part of the offline quick start.

Save to panel writes a guarded layout; Panel accepted frame requires an acknowledged USB upload for that revision. The editor and preview server never own USB. The independent runtime retains exclusive USB ownership, reconnect handling, dirty-frame skipping and its roughly 1 Hz idle refresh. H.264 remains an opt-in experiment. See the [TURZX diary](https://github.com/HuuTrucNguyen0508/Hyprland_Diary/tree/main/TURZX-SCREEN) for orientation and transport experiments.

## Checks and contributing

The complete test suite runs on Linux and needs the Python setup above. Activate that environment so the cross-language domain tests find Pillow:

```bash
source .venv/bin/activate
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

Domain tests check the layout contract and editing operations. Build also checks the domain module without browser types. Playwright starts its own loopback server on port 4175 and checks editing, import/export and offline use against `dist/`. On Linux, `pnpm exec playwright install --with-deps chromium` also installs required browser libraries. To use an existing Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path.

With the Python environment installed, run `PYTHONPATH=runtime .venv/bin/python -m unittest discover -s runtime/tests`. CI runs these checks without the private dashboard installation or hardware.

See [CONTRIBUTING.md](CONTRIBUTING.md), [the first milestone](docs/first-milestone.md), [editor milestones](docs/studio-milestones.md) and [verification notes](docs/verification.md). Bundled font notices and the separately licensed external driver are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Roadmap

The next hardware milestone is a standalone runtime with explicit device profiles for resolution, orientation and transport. It needs per-model USB testing and exclusive device ownership before other screens can be listed as supported. Small-screen presets and round-display masking can then build on the existing canvas contract.

## License

Studio's own code is available under the [MIT license](LICENSE). Bundled fonts and the external driver retain their licenses in [third-party notices](THIRD_PARTY_NOTICES.md). This project is not affiliated with Turing or TURZX.
