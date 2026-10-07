# Screen sizes

The offline editor works with custom pixel canvases. A canvas size defines the saved layout and preview, and does not identify a screen model or guarantee USB compatibility.

| Use | Size support |
| --- | --- |
| Browser design and JSON export | Custom canvas dimensions |
| Browser and optional Linux PIL preview | Custom dimensions within preview limits |
| Active panel layout and saved dashboard library | 1280 × 800 only |
| Existing USB adapter | Documented 1280 × 800 landscape installation only |
| Other USB screens or resolutions | Untested |

## Choose a canvas

Click the pixel dimensions beside the Canvas heading. Choose a generic resolution preset or enter width and height in pixels. Each dimension must be a whole number from 1 to 16384. The size control accepts at most 16,000,000 pixels in total, matching the image-preview limit. For example, 3840 × 2160 fits; 7680 × 4320 exceeds that limit.

Presets are starting points for design. Screen diagonal measurements such as 3.5 inches or 8 inches do not determine resolution, orientation or transport protocol. Check the actual device specifications before preparing a layout.

The default 1280 × 800 canvas retains the existing panel workflow. Export JSON also works for other accepted canvas sizes. Keep custom-size layouts as exported files or browser drafts; the existing active panel layout and saved dashboard library reject them.

## Resize an existing layout

Choose what happens to the cards when applying a new size:

- Fit cards uses one scale factor for both axes and centers the old canvas inside the new one. It preserves proportions and adds letterbox space when the aspect ratio changes. Card geometry rounds to integer pixels and stays within the new canvas.
- Keep positions changes only the canvas. It preserves every card's position and dimensions if all cards still fit. Otherwise, it leaves the draft unchanged and asks you to fit or move the cards first.
- Clear and resize removes the cards and starts an empty canvas at the chosen size.

For small screens, turn off Show header and footer to free the canvas from the fixed 1280 × 800 dashboard headings. The result preview shows this choice before you apply it.

Each applied change is one Undo step. Canvas resizing preserves widget settings and explicit text font sizes when keeping or fitting cards. Check readability after shrinking, because smaller cards can clip text or overlap after pixel rounding.

All saved card edges use integer document coordinates. Browser resizing, zoom, pan and Fit change only the preview view. They do not resize the document or change an exported layout.

## Existing hardware orientation

The legacy adapter draws a 1280 × 800 landscape image and rotates it 270° through the existing JPEG driver, producing an 800 × 1280 wire frame. That rotation belongs to this adapter and must not be inferred for other screens.

The repository does not yet provide standalone hardware transport. Physical output depends on the separate Linux dashboard and driver described in [panel integration](panel-integration.md). Preview and generation never open USB; the always-on runtime owns the device exclusively.

To prepare a layout for that installation, validate it with `pnpm layout validate layouts/my-dashboard.json --panel`. Other sizes can use validation without `--panel` and `pnpm layout preview` after the [optional Python setup](../README.md#optional-linux-studio-api).
