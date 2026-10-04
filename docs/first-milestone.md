# First milestone

Build an offline layout editor that can save and reopen an exact arrangement.

## Layout contract

Define a versioned document containing canvas width and height, widget IDs, widget types, integer positions, integer sizes, and widget settings. Include a palette representation suitable for a preview.

Reject unsupported versions, duplicate IDs, non-integer geometry, non-positive sizes, and widgets outside the canvas. Import failures preserve the currently open document.

Use synthetic values and a bundled sample palette. The app must run without credentials, sensors, a Caelestia installation, or a USB device.

## Implementation steps

- [x] Scaffold a TypeScript, React, and Vite app with one local preview command.
- [x] Define the layout contract and validation outside the UI.
- [x] Add a sample 1280 by 800 layout with metric and weather cards.
- [x] Render a letterboxed canvas with selection and resize controls.
- [x] Add drag movement, arrow-key nudges, and numeric geometry fields.
- [x] Convert scaled pointer coordinates to integer document coordinates.
- [x] Add JSON import and export, including an unsaved-changes indication.
- [x] Document setup and verification commands once they exist.

## Acceptance checks

- Export and reimport preserve IDs, widget settings, and geometry.
- A one-pixel arrow-key nudge changes the document position by exactly one pixel at different preview scales.
- Dragging and resizing cannot save a widget outside the canvas.
- Invalid imports show an actionable error and preserve the current layout.
- Resizing the browser changes preview scale without changing the document.
- The entire editing flow works with network access disabled and no USB device.

The finish line is a saved layout that renders identically after reopening. Hardware uploads and changes to the running dashboard service belong to the integration milestone.

## Manual verification

Run `pnpm dev`, or `pnpm build` followed by `pnpm preview` for a production check.

1. Select CPU load on the canvas. Press Right and confirm X changes from 64 to 65. Resize the browser, then press Right again and confirm 66. Browser size alone must not change any geometry.
2. Type a valid X value without pressing Enter, then click the same card or another card. The value must commit and remain in the document. Repeat with a resize handle.
3. Drag a card beyond each canvas edge. Its numeric position must stay in bounds. Resize toward the right and bottom edges, then inward. Width and height must stay positive and inside the canvas. Cancel a drag with Escape and confirm its original geometry returns.
4. Enter `1.5`, a negative position, or an oversized width in the inspector. Confirm a field error appears and the card stays unchanged.
5. Export JSON, move a card, then open the downloaded JSON. Choose Keep editing once to confirm the edit remains. Open it again and discard changes. Confirm every position, size, setting, ID, and palette matches the exported file. Export again and compare the files.
6. Open malformed JSON, an unsupported version, or a layout with duplicate IDs. Confirm the error names the problem and the current layout remains intact.
7. Import a Caelestia scheme and confirm the palette changes without changing geometry. Export and reopen to confirm those colors survive.
8. Repeat the editing and save/reopen flow with internet disconnected, using the built app on the local preview server. No USB device, sensors, credentials, or dashboard service are needed.
