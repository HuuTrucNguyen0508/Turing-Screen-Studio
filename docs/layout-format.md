# Layout format

Version 1 is a JSON document with these required fields. Unknown fields are rejected. [sample-layout.json](../public/sample-layout.json) is a complete example.

| Field | Meaning |
| --- | --- |
| `version` | Integer `1`. Other versions are rejected before validating their contents. |
| `name` | Nonempty layout name. |
| `canvas.width`, `canvas.height` | Positive safe integers up to 16384. The sample is 1280 by 800. |
| `palette` | A name and eight preview color roles, each a six-digit `#rrggbb` string. |
| `widgets` | Array of metric or weather cards. Array order is paint order, and overlaps are allowed. |

Every widget has a unique nonempty `id`, a `type`, integer `x`, `y`, `width`, `height`, and type-specific `settings`. Positions are nonnegative, sizes are positive, and `x + width` and `y + height` must fit within the canvas. A one-pixel card is valid even when its content is too small to read.

Metric settings require string fields `label`, `value`, `unit`, and `detail`. Weather settings require string fields `location`, `temperature`, `unit`, `condition`, `high`, and `low`. These are deterministic preview values. Optional metric `settings.source` is `sample`, `cpu`, `gpu`, `memory`, `disk`, `network-down`, or `network-up`; weather sources are `sample` or `weather`. Omission means sample. Live sources use the existing collector only on the panel.

Optional top-level `paletteMode` is `saved` or `live`; omission means saved. Live mode follows Caelestia through the local server and runtime. The stored palette remains the fallback. These optional fields keep existing version 1 files valid and remain omitted when absent.

Palette roles are `background`, `surface`, `surfaceRaised`, `text`, `muted`, `primary`, `secondary`, and `outline`. Caelestia import reads `colours.background`, `surfaceContainer`, `surfaceContainerHigh`, `onSurface`, `onSurfaceVariant`, `primary`, `secondary`, and `outlineVariant`, respectively. Bare hex values gain a `#`. Missing or malformed colors reject the import; the bundled scheme provides the initial offline fallback.

The independent module in `src/domain/layout.ts` validates unknown input, returns detached documents, serializes in canonical key order with two-space indentation and a trailing newline, and applies immutable geometry edits. Numeric fields reject invalid integers or out-of-bounds values. Pointer operations round displacement from the start of each gesture and clamp edits at the canvas boundaries. They never accumulate rounded deltas.

The UI limits imported files to 1 MB. A failed import leaves the current document unchanged. Offline exports request a download; reopening confirms the saved file. With the local server, Save to panel persists atomically with a revision precondition and clears the saved snapshot's unsaved warning. Opening resets transient field drafts and gestures. A download request alone cannot confirm that a file reached disk.

This contract contains document coordinates and preview colors. It has no React state, browser scale, USB orientation, service configuration, or transport settings. Runtime integration must preserve the documented 270-degree rotation and exclusive USB ownership independently.
