# Layout format

Version 1 is a JSON document with these required fields. Unknown fields are rejected. [sample-layout.json](../public/sample-layout.json) is a complete example.

| Field | Meaning |
| --- | --- |
| `version` | Integer `1`. Other versions are rejected before validating their contents. |
| `name` | Nonempty layout name. |
| `canvas.width`, `canvas.height` | Positive safe integers up to 16384. The sample is 1280 by 800. |
| `palette` | A name and eight preview color roles, each a six-digit `#rrggbb` string. |
| `widgets` | Array of metric, weather, clock, text, gauge, storage, image, list, graph or calendar widgets. Array order is paint order, and overlaps are allowed. |

Every widget has a unique nonempty `id`, a `type`, integer `x`, `y`, `width`, `height`, and type-specific `settings`. Positions are nonnegative, sizes are positive, and `x + width` and `y + height` must fit within the canvas. A one-pixel card is valid even when its content is too small to read.

Widget settings are required unless marked optional. Unknown settings are rejected.

| Type | Settings |
| --- | --- |
| `metric` | String `label`, `value`, `unit`, `detail`; optional metric `source`. |
| `weather` | String `location`, `temperature`, `unit`, `condition`, `high`, `low`; optional `source` of `sample` or `weather`. |
| `clock` | String `label`, `time`, `date`; `format` of `24h` or `12h`; boolean `showDate`; optional `source` of `sample` or `clock`. Use `HH:MM` for sample time. |
| `text` | String `label`, `text`. Newlines are preserved and text wraps inside the card. No live source. |
| `storage` | String `label`; `style` of `bars` or `table`; optional `source` of `sample` or `mounted-storage`, `grouping` of `drives` or `partitions`, and `mounts` with 1 to 32 unique absolute paths for the partitions view. Readings are transient. |
| `gauge` | String `label`, `unit`, `detail`; finite numbers `value`, `min`, `max`; optional metric `source` and `style` of `arc`, `ring`, `bar`, `segments`, `thermometer` or `number`. Require `min < max` and `min <= value <= max`. |
| `image` | String `label`; `data` containing an embedded static PNG data URI; `fit` of `contain`, `cover` or `stretch`; integer `opacity` from 0 to 100. No live source or internal design. |
| `list` | String `label` of at most 64 characters; `rows` with 1 to 6 objects, each with a sensor `source`, a `label` of at most 32 characters, a sample `value` of at most 16 and a `unit` of at most 8; boolean `bars`. Row sources must differ. |
| `graph` | String `label` of at most 64 characters; `style` of `area` or `line`; `sources` with one or two different sensor sources. |
| `calendar` | String `label` of at most 64 characters; `source` of `sample` or `clock`; `weekStart` of `monday` or `sunday`. |

A gauge without `style` keeps the original arc. The editor can switch styles while retaining geometry, settings, source and range. The renderer uses the same clamped progress for arcs, rings, bars, segments and thermometers. The number style shows the reading without a chart. Explicit style fields remain present after export/reopen; omitted fields stay omitted.

Metric sources are `sample`, `cpu`, `gpu`, `memory`, `disk`, `network-down`, `network-up`, `cpu-temperature` and `gpu-temperature`. Omission means sample. Preview values are deterministic; live sources use the existing collector only on the panel. Gauges use percentage values for CPU, GPU, memory and disk, degrees Celsius for temperatures, and a fixed KB/s scale for network traffic. A memory metric uses GB. Live readings can exceed a gauge's configured range; the progress is clamped and the actual reading remains visible. Missing readings do not reuse sample data.

Clocks use minute precision from the existing collector. Their sample `time` and `date` remain deterministic offline. A layout with a clock widget hides the fixed header clock to avoid showing time twice. Existing layouts without a clock keep the original header.

Optional top-level `paletteMode` is `saved` or `live`; omission means saved. Live mode follows Caelestia through the local server and runtime. The stored palette remains the fallback. These optional fields keep existing version 1 files valid and remain omitted when absent.

Optional top-level `chrome` is `standard` or `none`. Omission retains the original header and footer. `none` leaves the canvas to the widgets, as in the clean dashboard drafts. A running panel must advertise `supportedChrome: true` before saving an explicit choice. This check happens before archiving or replacing a layout.

Palette roles are `background`, `surface`, `surfaceRaised`, `text`, `muted`, `primary`, `secondary`, and `outline`. Caelestia import reads `colours.background`, `surfaceContainer`, `surfaceContainerHigh`, `onSurface`, `onSurfaceVariant`, `primary`, `secondary`, and `outlineVariant`, respectively. Bare hex values gain a `#`. Missing or malformed colors reject the import; the bundled scheme provides the initial offline fallback.

Every widget accepts optional `colors`, a partial object of those eight roles with six-digit `#rrggbb` values. Unknown keys, malformed values and empty objects are rejected. Overrides apply only to that card, after choosing the saved or live palette. Unspecified roles keep the current palette; the canvas, header, footer and other cards keep their own colors. Resetting a role removes its key, and resetting the last role removes `colors`. Validation detaches the object and serialization orders its keys as listed above. Old version 1 layouts omit this field and retain their saved bytes.

For example, `"colors": {"surface": "#112233", "primary": "#ff6633"}` changes the card background and primary ink. Roles affect the parts already painted with them; they do not add new content. Image widgets stay transparent and borderless unless `surface` or `outline` is explicitly overridden. An image's `surface` adds a rectangular background beneath its pixels, and `outline` adds a one-pixel rectangular border above them. Each works independently. Image opacity applies to the image pixels, while the explicit background and border remain opaque.

The independent module in `src/domain/layout.ts` validates unknown input, returns detached documents, serializes in canonical key order with two-space indentation and a trailing newline, and applies immutable geometry edits. Numeric fields reject invalid integers or out-of-bounds values. Pointer operations round displacement from the start of each gesture and clamp edits at the canvas boundaries. They never accumulate rounded deltas.

The UI limits imported files to 1 MB. A failed import leaves the current document unchanged. Offline exports request a download; reopening confirms the saved file. With the local server, Save to panel persists atomically with a revision precondition and clears the saved snapshot's unsaved warning. Every changed save archives the exact previous document in `~/.local/share/turzx-studio/older-config/` first; an archive failure prevents replacement. Opening resets transient field drafts and gestures. A download request alone cannot confirm that a file reached disk.

Each image data URI is at most 512 KiB and must use canonical PNG base64. PNG dimensions are at most 4096 per side and 16 million pixels. Structure checks reject malformed chunks, checksums and animation; Pillow additionally verifies decoded pixels. Images contain no external paths or URLs. The UI normalizes selected PNG, JPEG and WebP files to PNG. Contain centers the complete image; cover crops to fill; stretch changes its aspect ratio. Transparent pixels and opacity preserve underlying layers. Browser and PIL exports enforce the complete 1 MiB JSON limit. The PIL decode cache holds at most four images and 16 MiB of pixels.

[layout.schema.json](../public/layout.schema.json) describes the machine-readable structure. [widget-catalog.json](../public/widget-catalog.json) supplies 121 deterministic widget choices with catalog-only families, groups and descriptions, and [layout-presets.json](../public/layout-presets.json) contains complete designed layouts. See [the agent workflow](ai-layouts.md) for generation, previews and restore commands.

This contract contains document coordinates and preview colors. It has no React state, browser scale, USB orientation, service configuration, or transport settings. Runtime integration must preserve the documented 270-degree rotation and exclusive USB ownership independently.

Usage metric and gauge sources also accept `codex-tokens`, `codex-cost`, `codex-weekly`, `codex-reset`, `codex-models`, `claude-tokens`, `claude-cost`, `claude-session`, `claude-weekly`, `claude-reset`, `claude-models` and `storage`. Tokens and costs cover the current UTC day from T3's saved cache. Cost estimates are API equivalents, not subscription bills. Quotas are separate provider observations with cache/stale labels; an elapsed reset does not imply a fresh allowance. Storage measures `/` and reports available free space in GiB. See [the data contract](usage-data.md). New sources require a runtime advertising `supportedUsageSources` before a changed save can succeed.

Metric cards additionally accept `usage-tokens-30d`, `usage-cost-30d` and `usage-limits`. Gauges reject these aggregate sources. The first two show rolling 30-day totals and provider rows; limits show applicable account windows. Unknown amounts remain unavailable, and incomplete totals have `+`. Samples stay in the document; live readings do not change exported JSON. The clean drafts are [system-overview-clean.json](../layouts/system-overview-clean.json) and [ai-usage-30d.json](../layouts/ai-usage-30d.json).

New storage templates show physical drives. Their total capacity comes from the whole block device; usage combines its distinct mounted filesystems. A `+` marks incomplete coverage when partitions are unmounted or unreadable. Those partitions are never counted as free. Switch to Partitions to show filesystems separately, or use `mounts` to select paths in display order. Aliases share a row; a missing selected mount remains unavailable. Paths are bounded to 256 characters and exclude control characters. Omitting grouping retains the previous filesystem view and serialized layout bytes. Duplicate mounts on the same filesystem share a row with alias paths. Editor samples come from `public/storage-sample.json`; live failures show unavailable readings. See [mounted storage data](usage-data.md#mounted-storage).


Clock cards accept optional widget-level `design` after `settings`, followed by `colors` when present. `padding` is side padding from 0 to 64 px. `elements` accepts `label`, `time` and `date`, each with optional `hidden`, `align` of `start`, `center` or `end`, integer `dx`/`dy` from -512 to 512, integer font `size` from 8 to 160, and `color` of `text`, `muted`, `primary`, `secondary` or a literal six-digit `#rrggbb` value. Named roles use the card's effective palette. Literal colors stay fixed across palette changes. A literal time color also colors its AM/PM suffix; named time colors retain the muted suffix. Empty design objects are rejected; reset removes overrides. Designed text uses a shared anchor and baseline in the browser and PIL, and clips inside the card. Existing cards without design retain their rendering and serialized bytes. Other types currently keep their built-in internal design.

Custom widget files use `{version: 1, widgets: [{id, name, widget}]}`. The unplaced `widget` includes type, width, height, settings and optional design. It omits layout ID and position. At most 64 copies fit in 256 KB. Placed cards retain independent settings and design after a template is changed or removed. The Studio API saves `widgets.json` using its own revision and preserves replaced bytes under `older-config/custom-widgets/`. Offline templates are saved separately in the browser. Import adds copies and skips identical content.

Metric settings accept optional `trend: boolean`. `true` replaces the decorative sparkline with a chart of up to 120 readings. Null observations retain their slot and break the line. CPU, GPU, memory and disk ranges are 0 to 100 percent; network and temperature charts scale to the observed range. Sample mode uses deterministic demo readings; live mode uses runtime history. An empty live history shows "No history yet". Omitting `trend` preserves existing JSON and rendering. A running runtime must advertise `supportedTrendWidgets` before a changed layout with trends can be saved.

Multi-selection, snap guides, canvas zoom and pan are editor state. They never add fields to saved documents. Layer order is the existing order of `widgets`, with later entries drawn in front.

Metric cards also accept `t3-threads` and `game-resources`. These sources reject `trend: true`, and gauges reject them. `settings.detail` contains bounded JSON display rows for deterministic samples. Live rows are transient and never change exported layouts. The runtime must advertise `supportedDashboardSources` before a changed layout using these sources can be saved. Shared game anchors are independent of the saved document. See [thread and timer data](thread-game-data.md).

List, graph and calendar cards use the sensor sources `cpu`, `gpu`, `memory`, `disk`, `network-down`, `network-up`, `cpu-temperature` and `gpu-temperature`. Character limits count Unicode code points. A list row shows its label, value and unit. On the panel, each row's value and unit come from the live reading. Memory is shown as a percentage. Network speeds switch from KB/s to MB/s at 1024 KB/s. With `bars`, percentage rows draw a bar from 0 to 100 % and temperature rows from 0 to 100 °C; network rows have no bar. Rows that do not fit the card's height are left out.

A graph plots the last 120 readings of one or two sources, like a trend metric. Two sources with the same unit share one scale; otherwise each series has its own range. The first series uses the primary color, and `area` style fills under it. The second series is a dashed line in the secondary color, because many palettes make the two colors nearly equal. The editor and offline previews use the deterministic demo history.

A calendar shows one month with today highlighted. Offline, and with `source: "sample"`, it shows 6 October 2026, the same date as the clock sample. With `source: "clock"`, the panel takes the day and month from its clock and chooses the nearest year. If the clock cannot be read, the card shows "Date unavailable".

These three types need a runtime that lists them in `supportedWidgetTypes`. A layout using them cannot be saved to the panel until `turzx-dashboard.service` restarts with the current Studio adapter.

## Text and JSON rules

Both parsers reject duplicate object keys, including escaped spellings of the same key. Blank required text uses the shared code-point list in `public/text-contract.json`, which includes U+0085 and U+FEFF. Length limits count Unicode code points, matching the existing list and graph label contract. Mount paths use the same rule, so `/` followed by 128 emoji is 129 characters in both validators.
