# TURZX Studio

A visual editor for USB smart-screen dashboards.

Arrange cards on a canvas, resize them, adjust integer pixel offsets, and preview a layout before sending it to the panel. Layouts should follow the desktop's live Caelestia palette and run with a small always-on CPU cost.

The first target is the existing 1280 by 800 dashboard on a TURZX 8-inch screen. The editor runs when opened; the dashboard runtime runs independently.

## Current status

Project brief and implementation plan only. The editor, layout format, and runtime integration have not been implemented.

Start with [the first milestone](docs/first-milestone.md).

## First usable version

Load a small layout containing metric and weather cards. Select, move, and resize a card with drag controls and numeric fields. Save the layout, reopen it, and reproduce the same positions.

Preview uses deterministic sample data and an imported palette. It works without USB access or a running dashboard service. A later step lets the existing dashboard load the saved layout.

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

1. Render saved layouts through the existing dashboard with a preview-only mode first.
2. Add widget configuration, reusable layouts, and recorded-data playback.
3. Package the editor as a desktop app if that improves the workflow.
4. Compare rendering and transport implementations with repeatable measurements.

## Background

See the [TURZX diary](https://github.com/HuuTrucNguyen0508/Hyprland_Diary/tree/main/TURZX-SCREEN) for orientation, USB stability, and refresh experiments.

The original runtime lives at `~/Documents/dashboard`. Read it as a reference before integration; this repository does not copy or replace it during setup.
