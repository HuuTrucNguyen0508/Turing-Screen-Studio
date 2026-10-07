# TURZX Studio

A visual editor for USB smart-screen dashboards.

Arrange cards on a canvas, resize them, adjust integer pixel offsets, and preview a layout before sending it to the panel. Layouts should follow the desktop's live Caelestia palette and run with a small always-on CPU cost.

The first target is the existing 1280 by 800 dashboard on a TURZX 8-inch screen. The editor runs when opened; the dashboard runtime runs independently.

## Current status

The offline and connected editors include recoverable drafts, undo/redo, library editing, archived layout history, custom widget copies, internal clock design and canvas arrangement tools. Optional live preview reuses the running dashboard's readings. See [the five editor milestones](docs/studio-milestones.md), [verification results](docs/verification.md) and [panel setup and rollback](docs/panel-integration.md).

Start with [the first milestone](docs/first-milestone.md).

Studio currently expects the custom Python dashboard at `~/Documents/dashboard`, the USB library at `~/Documents/turing-smart-screen-python`, and an existing `turzx-dashboard.service` for physical-panel use. The offline editor works without them. A complete fresh-machine installer is not included yet.

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

Shift-click cards or rows to select a group. Ctrl+A selects all cards outside text fields. Dragging and arrow keys move the group within the canvas while preserving its spacing. Align, Distribute and Layer act on the selection; the widget list shows the front layer first.

Use **Same width**, **Same height** or **Same size** to match the selected reference card. The reference name and dimensions appear below the tools. Click or focus another selected card to change it. Matching preserves positions and counts as one undoable edit. If a size would extend beyond the canvas, the operation leaves every card unchanged and shows an error.

**Snapping** starts enabled and remembers your choice in this browser. Moving snaps to card edges, centers and 24 px gutters. Resizing snaps the right and bottom edges to other edges, matching dimensions and gutters. Guides appear while dragging; turn snapping off for free pointer adjustments. Numeric fields and keyboard nudges remain precise. Zoom and Space-drag or middle-button pan change only your view; Fit resets it. Overlap and small-card notes help with readability and allow saving.

Sample preview uses fixed values. Live preview renders your draft with readings from the existing dashboard process every two seconds. Data sources shows sensor availability, observation times and cached provider quotas. Missing or stale readings stay labelled; live preview falls back to sample when the runtime cannot supply fresh data. Trend cards retain the last 120 readings, break lines at unavailable observations and use explicit demo data in sample preview.

The inspector accepts whole pixel values within the displayed bounds. Enter or leaving a field commits the value. Invalid values show an error and leave the layout unchanged. Escape restores the field's current document value.

Undo and Redo beside the layout name cover committed edits, including movement, resizing, settings, adding and removing widgets, and preset creation. Ctrl+Z undoes and Ctrl+Shift+Z or Ctrl+Y redoes when focus is outside a text field. Text fields keep the browser's own text undo. A completed drag counts as one edit; a cancelled drag counts as none. Opening a file or panel layout starts a new history of up to 100 edits.

Open **Library** to edit an entry as a draft, duplicate it, rename its library label, or confirm replacement and removal. **Save to library** updates that entry and archives its previous document. **Save to panel** applies the draft separately. Library changes use their own revision check; a conflicting save keeps both versions and offers a comparison or a new entry. Ctrl+F9 through Ctrl+F12 still select the first four library entries.

**History** groups identical archived layouts while keeping every archive ID visible. Open an archive as a draft or download its JSON. Opening it does not change the panel. The original dashboard program backup is separate from these layout archives.

For a clock, open **Design** in the inspector to align the time and date, adjust offsets and font sizes, select palette colors, or hide elements. **Save as custom widget** keeps any selected card as a reusable copy. Find copies in Add widget under Custom widgets; **Manage custom widgets** has rename, replacement, removal and import/export. Existing placed cards keep their own design. Connected templates are saved on this machine; offline templates are labelled Saved in this browser.

Unfinished drafts are backed up in this browser shortly after each committed edit. Reloading offers Restore draft, Export backup and Discard draft. Recover drafts opens the same list later. Each tab has its own backup; restoring a draft open elsewhere makes a copy. Uncommitted text and unfinished pointer gestures are not backed up. Browser storage failures leave the last good backup intact and show an error; export JSON to keep a separate copy.

Recovered drafts keep the panel revision they started from. If a shortcut or another editor changes the panel, Review panel changes shows the current dashboard beside your draft. Replace panel with draft saves against the exact revision shown and archives the current dashboard first. A second change rejects the replacement again. Switching dashboards does not silently change the draft's save revision.

Export JSON requests a browser download. Reopen that saved file with Open layout to confirm it. An export request keeps the unsaved warning until reopening because the browser cannot report whether you cancelled its save dialog. Opening another layout prompts before replacing unsaved changes. Invalid imports preserve the open layout.

Use Import scheme.json to select Caelestia's current `~/.local/state/caelestia/scheme.json`. The app reads only the file you choose. It starts with a bundled snapshot of the local `dynamic` scheme and stores the imported preview colors in exported layouts.

See [the layout contract](docs/layout-format.md) and [the sample JSON](public/sample-layout.json). Browse and scroll through 107 widget choices in Add widget, narrow them with search or category filters, then edit, duplicate or remove cards. Metric and weather cards are joined by clocks, text cards and six gauge designs: arc, ring, bar, segmented meter, thermometer and number. Disk usage, network upload/download and CPU/GPU temperatures use the existing live collector. Editor previews reproduce the saved arrangement. The connected editor uses the panel's PIL renderer and offers live data sources and Save to panel.

Use Create layout for a designed starting point. System overview, Focus, Classic layout, AI usage and Gauge designs change the editor draft; the panel changes when you choose Save to panel. Every changed save first archives the older layout under `~/.local/share/turzx-studio/older-config/`. The original dashboard's source and configuration are preserved there in `original-dashboard/`.

Use **Saved layouts** to keep dashboards ready for the panel. The initial list contains your current dashboard and three other presets. It prefers System overview, AI usage and Focus; if your current dashboard already uses one of those, Gauge designs fills the spare slot. **Ctrl+F9**, **Ctrl+F10**, **Ctrl+F11** and **Ctrl+F12** switch the physical panel directly to the first, second, third and fourth layouts. Each changed switch archives the previous configuration. Unsaved editor drafts remain intact.

Add the current draft or a preset to the list, update an entry with your draft, or reorder and remove entries. Reordering changes the shortcut assignments. Updating or removing an entry archives its previous document; identical copies are rejected. The list supports 12 dashboards; Previous and Next reach the full list. Saving this list alone does not switch the panel. It lives in `~/.local/share/turzx-studio/layouts.json`, separately from the active dashboard and older configurations.

On this Hyprland setup, install the desktop shortcuts and the local Studio API service with `pnpm shortcuts:install`. This keeps switching available when the editor window is closed and after login. The installer preserves existing configuration files, adds a managed block to Caelestia's `hypr-user.lua`, and installs `turzx-studio.service`. It adds the four live bindings without reloading the compositor. Stop a manually launched Studio server first if it already occupies port 5174. The panel runtime keeps running independently.

## Ask an agent to design a dashboard

Describe what you want to see and ask for a preview. The agent can use the widget catalog, JSON schema and layout commands to generate a complete dashboard without manual positioning. See [the agent workflow](docs/ai-layouts.md).

```bash
pnpm layout presets
pnpm layout generate --preset system-overview --output layouts/my-dashboard.json
pnpm layout validate layouts/my-dashboard.json --panel
pnpm layout preview layouts/my-dashboard.json --output artifacts/my-dashboard.png
pnpm layout history
pnpm layout saved
pnpm layout slot 3
```

Generation and preview work offline and never open USB. Applying a layout uses the local Studio API with the saved revision and preserves the previous layout first.

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

1. Add more widget types and user-defined presets.
2. Add recorded-data playback.
3. Package the editor as a desktop app if that improves the workflow.
4. Compare rendering and transport implementations with repeatable measurements.

## Background

See the [TURZX diary](https://github.com/HuuTrucNguyen0508/Hyprland_Diary/tree/main/TURZX-SCREEN) for orientation, USB stability, and refresh experiments.

The original runtime lives at `~/Documents/dashboard`. Read it as a reference before integration; the Studio adapter preserves its source and replaces only the service entry point through a separate, reversible override.

Create layout → AI usage opens a complete Claude/Codex dashboard draft. It has daily tokens, API cost estimates, cached provider limits, reset countdowns and per-model tokens/costs. Add widget → Storage offers physical-drive cards with used/total capacity alongside root filesystem gauges. Storage view can switch to Partitions, with one selected mount path per line. Save as custom widget preserves that selection. Shared filesystems are counted once. A `+` marks drive usage that excludes unmounted or unreadable partitions. Editor values are samples; the panel uses local observations after Save to panel. T3 cache values can be stale and unpriced models leave complete costs unavailable. See [usage data](docs/usage-data.md) and [design references](docs/widget-design-references.md).
