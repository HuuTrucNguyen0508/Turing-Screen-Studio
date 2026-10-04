# TURZX Studio

A visual editor for USB smart-screen dashboards.

Arrange cards on a canvas, resize them, adjust integer pixel offsets, and preview a layout before sending it to the panel. Layouts should follow the desktop's live Caelestia palette and run with a small always-on CPU cost.

The first target is the existing 1280 by 800 dashboard on a TURZX 8-inch screen. The editor runs when opened; the dashboard runtime runs independently.

## Current status

The first offline editor is implemented. It includes a deterministic sample dashboard, card selection, drag movement, corner resizing, integer geometry fields, keyboard nudges, palette import, and JSON export/reopen. The connected editor uses the same PIL renderer for previews and saves directly to the existing dashboard runtime. See [panel setup and rollback](docs/panel-integration.md).

Start with [the first milestone](docs/first-milestone.md).

## Run locally

Use Node.js 22.12 or newer and pnpm 11.28.3. The app follows the [Vite setup requirements](https://vite.dev/guide/).

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:5173`. The development server listens on loopback only.

```bash
pnpm test
pnpm build
pnpm preview
```

`pnpm test` checks the layout contract, round trips, geometry bounds, pointer conversion, and palettes. `pnpm build` checks the app and separately checks the domain module without browser types, then builds `dist/`. `pnpm preview` serves that build locally on port 4173.

Installation needs network access once. The offline production editor uses local assets and fixed sample values. The connected editor uses only its local Studio API. For offline verification, build first, disconnect internet access, keep the local preview server running, and follow the [manual acceptance steps](docs/first-milestone.md#manual-verification).

Browser acceptance tests use [Playwright](https://playwright.dev/docs/test-webserver). Install its Chromium browser once, then run them against a production build:

```bash
pnpm exec playwright install chromium
pnpm build
pnpm test:e2e
```

The test runner starts and stops its own loopback server on port 4175. It checks real pointer movement, resize bounds, keyboard scaling, numeric-field commits, invalid imports, and offline export/reopen. To use an installed Chromium instead, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. On this machine, `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` works.

## Edit and reopen

Select a card in the widget list or on the canvas. Drag its body to move it, or its lower-right handle to resize it. Focus a card and press an arrow key for one document pixel, or hold Shift for ten. Focus the resize handle to change its size with those same keys. Escape, loss of pointer capture, window blur, or a viewport resize cancels an unfinished drag.

The inspector accepts whole pixel values within the displayed bounds. Enter or leaving a field commits the value. Invalid values show an error and leave the layout unchanged. Escape restores the field's current document value.

Export JSON requests a browser download. Reopen that saved file with Open layout to confirm it. An export request keeps the unsaved warning until reopening because the browser cannot report whether you cancelled its save dialog. Opening another layout prompts before replacing unsaved changes. Invalid imports preserve the open layout.

Use Import scheme.json to select Caelestia's current `~/.local/state/caelestia/scheme.json`. The app reads only the file you choose. It starts with a bundled snapshot of the local `dynamic` scheme and stores the imported preview colors in exported layouts.

See [the layout contract](docs/layout-format.md) and [the sample JSON](public/sample-layout.json). Sample content is read-only in this milestone; existing widget settings survive export and import. Editor previews reproduce the saved arrangement. The connected editor uses the panel's PIL renderer and offers live data sources and Save to panel.

## First usable version

Load a small layout containing metric and weather cards. Select, move, and resize a card with drag controls and numeric fields. Save the layout, reopen it, and reproduce the same positions.

Preview uses deterministic sample data and an imported palette. It works without USB access or a running dashboard service. Run `pnpm studio` and install the adapter with `pnpm panel:install` to save arrangements to the panel.

## Implementation direction

Use TypeScript, React, and Vite for the initial local editor. Define a versioned JSON layout with integer geometry, explicit canvas dimensions, and widget identifiers. Keep layout validation and editing operations independent of React.

Reuse the existing lightweight PIL runtime for the first hardware integration. Evaluate a native renderer only after measuring the integration's CPU and memory use.

## Hardware constraints

- Draw the landscape dashboard at 1280 by 800. The existing JPEG library path rotates it 270 degrees for an 800 by 1280 wire frame.
- Use integer pixel nudges and letterbox scaling. Browser zoom must not change saved geometry.
- Read Caelestia's live scheme, with an explicit fallback when unavailable.
- Preserve the roughly 1 Hz idle refresh, dirty skip, reconnect handling, and slowdown under GPU load.
- Give one runtime ownership of USB. Preview must never open the panel.
- Keep H.264 an opt-in experiment until stability and resource use have been measured.

## Later milestones

1. Expand widget configuration and reusable layouts.
2. Add recorded-data playback.
3. Package the editor as a desktop app if that improves the workflow.
4. Compare rendering and transport implementations with repeatable measurements.

## Background

See the [TURZX diary](https://github.com/HuuTrucNguyen0508/Hyprland_Diary/tree/main/TURZX-SCREEN) for orientation, USB stability, and refresh experiments.

The original runtime lives at `~/Documents/dashboard`. Read it as a reference before integration; the Studio adapter preserves its source and replaces only the service entry point through a separate, reversible override.
