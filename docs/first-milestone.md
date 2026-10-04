# First milestone

Build an offline layout editor that can save and reopen an exact arrangement.

## Layout contract

Define a versioned document containing canvas width and height, widget IDs, widget types, integer positions, integer sizes, and widget settings. Include a palette representation suitable for a preview.

Reject unsupported versions, duplicate IDs, non-integer geometry, non-positive sizes, and widgets outside the canvas. Import failures preserve the currently open document.

Use synthetic values and a bundled sample palette. The app must run without credentials, sensors, a Caelestia installation, or a USB device.

## Implementation steps

- [ ] Scaffold a TypeScript, React, and Vite app with one local preview command.
- [ ] Define the layout contract and validation outside the UI.
- [ ] Add a sample 1280 by 800 layout with metric and weather cards.
- [ ] Render a letterboxed canvas with selection and resize controls.
- [ ] Add drag movement, arrow-key nudges, and numeric geometry fields.
- [ ] Convert scaled pointer coordinates to integer document coordinates.
- [ ] Add JSON import and export, including an unsaved-changes indication.
- [ ] Document setup and verification commands once they exist.

## Acceptance checks

- Export and reimport preserve IDs, widget settings, and geometry.
- A one-pixel arrow-key nudge changes the document position by exactly one pixel at different preview scales.
- Dragging and resizing cannot save a widget outside the canvas.
- Invalid imports show an actionable error and preserve the current layout.
- Resizing the browser changes preview scale without changing the document.
- The entire editing flow works with network access disabled and no USB device.

The finish line is a saved layout that renders identically after reopening. Hardware uploads and changes to the running dashboard service belong to the integration milestone.
