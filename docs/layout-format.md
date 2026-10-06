# Layout format

Version 1 is a JSON document with these required fields. Unknown fields are rejected. [sample-layout.json](../public/sample-layout.json) is a complete example.

| Field | Meaning |
| --- | --- |
| `version` | Integer `1`. Other versions are rejected before validating their contents. |
| `name` | Nonempty layout name. |
| `canvas.width`, `canvas.height` | Positive safe integers up to 16384. The sample is 1280 by 800. |
| `palette` | A name and eight preview color roles, each a six-digit `#rrggbb` string. |
| `widgets` | Array of metric, weather, clock, text, gauge or storage cards. Array order is paint order, and overlaps are allowed. |

Every widget has a unique nonempty `id`, a `type`, integer `x`, `y`, `width`, `height`, and type-specific `settings`. Positions are nonnegative, sizes are positive, and `x + width` and `y + height` must fit within the canvas. A one-pixel card is valid even when its content is too small to read.

Widget settings are required unless marked optional. Unknown settings are rejected.

| Type | Settings |
| --- | --- |
| `metric` | String `label`, `value`, `unit`, `detail`; optional metric `source`. |
| `weather` | String `location`, `temperature`, `unit`, `condition`, `high`, `low`; optional `source` of `sample` or `weather`. |
| `clock` | String `label`, `time`, `date`; `format` of `24h` or `12h`; boolean `showDate`; optional `source` of `sample` or `clock`. Use `HH:MM` for sample time. |
| `text` | String `label`, `text`. Newlines are preserved and text wraps inside the card. No live source. |
| `storage` | String `label`; `style` of `bars` or `table`; optional `source` of `sample` or `mounted-storage`. Mount readings are transient and never saved in settings. |
| `gauge` | String `label`, `unit`, `detail`; finite numbers `value`, `min`, `max`; optional metric `source` and `style` of `arc`, `ring`, `bar`, `segments`, `thermometer` or `number`. Require `min < max` and `min <= value <= max`. |

A gauge without `style` keeps the original arc. The editor can switch styles while retaining geometry, settings, source and range. The renderer uses the same clamped progress for arcs, rings, bars, segments and thermometers. The number style shows the reading without a chart. Explicit style fields remain present after export/reopen; omitted fields stay omitted.

Metric sources are `sample`, `cpu`, `gpu`, `memory`, `disk`, `network-down`, `network-up`, `cpu-temperature` and `gpu-temperature`. Omission means sample. Preview values are deterministic; live sources use the existing collector only on the panel. Gauges use percentage values for CPU, GPU, memory and disk, degrees Celsius for temperatures, and a fixed KB/s scale for network traffic. A memory metric uses GB. Live readings can exceed a gauge's configured range; the progress is clamped and the actual reading remains visible. Missing readings do not reuse sample data.

Clocks use minute precision from the existing collector. Their sample `time` and `date` remain deterministic offline. A layout with a clock widget hides the fixed header clock to avoid showing time twice. Existing layouts without a clock keep the original header.

Optional top-level `paletteMode` is `saved` or `live`; omission means saved. Live mode follows Caelestia through the local server and runtime. The stored palette remains the fallback. These optional fields keep existing version 1 files valid and remain omitted when absent.

Palette roles are `background`, `surface`, `surfaceRaised`, `text`, `muted`, `primary`, `secondary`, and `outline`. Caelestia import reads `colours.background`, `surfaceContainer`, `surfaceContainerHigh`, `onSurface`, `onSurfaceVariant`, `primary`, `secondary`, and `outlineVariant`, respectively. Bare hex values gain a `#`. Missing or malformed colors reject the import; the bundled scheme provides the initial offline fallback.

The independent module in `src/domain/layout.ts` validates unknown input, returns detached documents, serializes in canonical key order with two-space indentation and a trailing newline, and applies immutable geometry edits. Numeric fields reject invalid integers or out-of-bounds values. Pointer operations round displacement from the start of each gesture and clamp edits at the canvas boundaries. They never accumulate rounded deltas.

The UI limits imported files to 1 MB. A failed import leaves the current document unchanged. Offline exports request a download; reopening confirms the saved file. With the local server, Save to panel persists atomically with a revision precondition and clears the saved snapshot's unsaved warning. Every changed save archives the exact previous document in `~/.local/share/turzx-studio/older-config/` first; an archive failure prevents replacement. Opening resets transient field drafts and gestures. A download request alone cannot confirm that a file reached disk.

[layout.schema.json](../public/layout.schema.json) describes the machine-readable structure. [widget-catalog.json](../public/widget-catalog.json) supplies 98 deterministic widget choices with catalog-only families, groups and descriptions, and [layout-presets.json](../public/layout-presets.json) contains complete designed layouts. See [the agent workflow](ai-layouts.md) for generation, previews and restore commands.

This contract contains document coordinates and preview colors. It has no React state, browser scale, USB orientation, service configuration, or transport settings. Runtime integration must preserve the documented 270-degree rotation and exclusive USB ownership independently.

Usage metric and gauge sources also accept `codex-tokens`, `codex-cost`, `codex-weekly`, `codex-reset`, `codex-models`, `claude-tokens`, `claude-cost`, `claude-session`, `claude-weekly`, `claude-reset`, `claude-models` and `storage`. Tokens and costs cover the current UTC day from T3's saved cache. Cost estimates are API equivalents, not subscription bills. Quotas are separate provider observations with cache/stale labels; an elapsed reset does not imply a fresh allowance. Storage measures `/` and reports available free space in GiB. See [the data contract](usage-data.md). New sources require a runtime advertising `supportedUsageSources` before a changed save can succeed.

Storage cards show all mounted local persistent filesystems, including `/mnt` drives. The default bar card (352 × 480) and wide table (564 × 384) fit five filesystem rows. Smaller cards show a count of hidden rows; increase height for more. Duplicate mounts on the same filesystem share a row with alias paths. Editor samples come from `public/storage-sample.json`; live failures show unavailable readings. See [mounted storage data](usage-data.md#mounted-storage).
