# Generate a dashboard from a description

You can ask an agent to design a dashboard, for example:

> Make a calm dashboard with a large clock, weather, CPU and GPU gauges, and a short focus note. Use my desktop colours. Show me a preview before putting it on the panel.

The agent can use the designed presets and widget templates rather than starting from an empty canvas. No AI service, API key or cloud connection is needed inside Studio. The agent produces ordinary layout JSON that you can reopen and edit.

## Agent workflow

Read [layout.schema.json](../public/layout.schema.json), [widget-catalog.json](../public/widget-catalog.json) and [the layout contract](layout-format.md). The schema describes fields and settings; the runtime validator also checks unique IDs, nonblank names, geometry bounds and gauge ranges. Preserve the user's current layout unless they ask to replace it.

List the presets and create a draft:

```bash
pnpm layout presets
pnpm layout catalog
pnpm layout catalog --search gauge --group gauge
pnpm layout generate --preset system-overview --output layouts/my-dashboard.json
pnpm layout validate layouts/my-dashboard.json --panel
pnpm layout preview layouts/my-dashboard.json --output artifacts/my-dashboard.png
```

`generate`, `validate` and `preview` work offline. They never save to the panel, collect sensors, stop services or open USB. A preview uses deterministic sample content. Live sources appear on the panel after saving. Review the PNG and adjust the draft's geometry and settings, then validate and preview it again. Readable labels, clear hierarchy and a small number of cards usually work better than filling every pixel.

The preset IDs are `system-overview`, `focus`, `classic`, `ai-usage` and `gauge-designs`. Presets use 1280 by 800 document pixels, 64-pixel outer margins and 24-pixel gutters. The clock in the overview replaces the fixed header clock. The classic preset is the original Studio sample arrangement; the original pre-Studio dashboard source is preserved separately under `older-config/original-dashboard/`.

## Saved dashboards and shortcuts

The connected editor's Saved layouts list stores validated document snapshots separately from the active panel layout. The initial order starts with the current dashboard, then three other presets chosen from System overview, AI usage and Focus, with Gauge designs as a replacement when the current layout already uses a named preset. Ctrl+F9 through Ctrl+F12 select the first four entries immediately on the physical panel. Adding or updating a snapshot only changes the list. Switching uses the same revision, runtime capability and archive checks as Save to panel.

```bash
pnpm layout saved
pnpm layout slot 3
pnpm layout use ai-usage
pnpm layout next
pnpm layout previous
```

These connected commands use the loopback Studio API. A switch reads the latest panel revision and submits it as If-Match; a concurrent change fails without replacing the other writer's layout. Use `--if-match REVISION` on a switching command when your workflow requires a specific revision.

`GET /api/layouts` returns `entries`, a library `revision`, and the matching `activeId`. `POST /api/layouts` accepts `{ "entries": [...] }` with the **library** revision in If-Match. Each entry has `id`, `name`, and a complete `document`. `POST /api/layouts/switch` accepts exactly one of `{ "slot": 3 }`, `{ "id": "ai-usage" }`, or `{ "direction": "next" }`, with the **panel layout** revision in If-Match. Previous direction is `previous`. Never overwrite `layout.json` directly.

## Browse the widget library

Studio’s **Add widget** library supports scrolling, search and category filters. The local catalog contains 107 ready-made choices: standard and wide metric cards, source-specific arc, ring, bar, segmented, thermometer and number designs, standard/compact/large/12-hour clocks, regular/slim weather, and standard/compact/large notes. It is the same catalog used by the editor and the agent commands.

Gauge settings can include `style`: `arc`, `ring`, `bar`, `segments`, `thermometer` or `number`. Omitting it preserves the original arc. A style changes the drawing; sources and ranges keep their meaning. Wide and compact variants describe geometry. They are not separate drawing styles.

Each template has a stable `id`, `family`, `variant`, `group`, description, size and settings. Choose its exact ID in a spec. For example, `cpu` is a standard metric, `cpu-wide` is a wider metric, and `cpu-gauge` is an arc gauge. `cpu-ring`, `cpu-bar`, `cpu-segments` and `cpu-number` render the same CPU reading in different forms. `cpu-temperature-thermometer` uses a vertical thermometer. `clock-compact` fits a header; `clock-large` gives the time more space.

```bash
pnpm layout catalog --search cpu
pnpm layout catalog --group clock
pnpm layout catalog --search wide --group network
```

Groups are `system`, `network`, `temperature`, `gauge`, `clock`, `weather`, `text`, `ai-usage` and `storage`. Combining search and group narrows the result. All browsing works offline. To extend the library using an existing widget type, add a template to `public/widget-catalog.json`, validate it and rebuild the editor. The saved layout contains only the chosen widget’s settings and geometry; catalog descriptions and categories stay outside the layout contract.

## Short template specs

To avoid writing every widget setting, use a spec containing catalog IDs, integer geometry and any settings you want to change:

```json
{
  "name": "My focus dashboard",
  "paletteMode": "live",
  "widgets": [
    { "template": "clock", "x": 64, "y": 144, "width": 564, "height": 224 },
    { "template": "weather", "x": 652, "y": 144, "width": 564, "height": 552 },
    { "template": "text", "x": 64, "y": 392, "width": 564, "height": 304,
      "settings": { "label": "Today", "text": "Finish one useful thing.\nThen take a break." } }
  ]
}
```

Save this as `layouts/focus.spec.json`, then expand it:

```bash
pnpm layout generate --spec layouts/focus.spec.json --output layouts/focus.json
pnpm layout validate layouts/focus.json --panel
pnpm layout preview layouts/focus.json --output artifacts/focus.png
```

Each widget accepts `template`, an optional `id`, `x`, `y`, `width`, `height` and partial `settings`. The template supplies missing settings and sizes. Omitting geometry uses a simple row arrangement; use explicit positions for designed dashboards. Specs also accept a name, canvas, palette and paletteMode. Generation rejects unknown fields and invalid settings. Validation reports overlapping card pairs so the agent can correct unintended overlaps.

## Apply only when requested

Start the connected editor with `pnpm studio`. Before editing an existing dashboard, read its document and revision:

```bash
pnpm layout current --output artifacts/current-layout.json
```

Keep the returned revision with the draft. Once the user asks to use that dashboard, apply it with that revision:

```bash
pnpm layout apply layouts/my-dashboard.json --if-match REVISION_FROM_CURRENT
```

The server archives the current saved document before replacing it. A stale revision or failed archive leaves the panel layout intact. If someone changed the dashboard while the agent was designing it, read the current layout again and resolve the change with the user instead of blindly substituting a new revision.

The command waits up to 15 seconds for a positive panel acknowledgement of the exact saved revision. Its JSON result includes `revision`, `archive` and `accepted`. Exit code 0 means the command completed; exit code 1 means validation, connection or save failed. Exit code 2 from apply or restore means the layout was saved but panel acceptance is still pending. Inspect status before retrying, since the saved layout has already changed. Use `--wait 0` to save without waiting or `--wait 60` for a longer acknowledgement window. Connected commands accept only HTTP loopback origins; `--url` goes before the command.

## Older configurations and restore

Every changed panel save creates a private folder under `~/.local/share/turzx-studio/older-config/`, containing the exact previous `layout.json` and a manifest with its name, revision, date, reason and checksum. Unchanged saves create no duplicates. Archives have no automatic expiry. Restore verifies the checksum and validates the document before saving it.

```bash
pnpm layout history
pnpm layout current
pnpm layout restore ARCHIVE_ID --if-match CURRENT_REVISION
```

Restore also archives the current layout, so it can be undone by restoring that newer archive. The editor’s History dialog also opens an archive as a draft or downloads its JSON. Inspect the draft and choose Save to panel to apply it through the guarded save flow. Opening an archive leaves the panel unchanged.

The original dashboard snapshot includes the Python source, requirements, startup script, USB driver, user settings when present, and the original service and non-Studio overrides. It reuses the Python environment at `~/Documents/dashboard/.venv/`. `pnpm panel:rollback` restores the original service entry point. It keeps the source snapshot, Studio layouts and history.

## Mounted storage widget

Templates `mounted-storage`, `mounted-storage-wide` and `mounted-storage-table` show physical drives with used/total capacity. `grouping: "drives"` combines mounted partitions against each drive's hardware capacity. `grouping: "partitions"` keeps filesystem rows separate; optional `mounts` selects absolute paths in order. For example, `["/", "/mnt/nvme", "/mnt/games"]` shows the system SSD, NVMe partition and Games partition. Save that card as a custom widget to reuse the selection. Bar variants fit five rows at height 480; the wide table fits five at height 384. Increase height for more rows. The inspector can switch views and display styles.

For example, a generation spec widget can be:

```json
{"template":"mounted-storage-wide","x":64,"y":160,"settings":{"label":"My disks","source":"mounted-storage"}}
```

This discovers local mount paths automatically. Do not hardcode the user's device list or put measurements in the saved document. Preview is deterministic and never probes disks. Applying still requires the user's request and archives the old configuration first.


To center a compact clock, use template `clock-centered`, or set widget-level `design.elements.time.align` and `design.elements.date.align` to `center`. These change internal placement without moving the card. Offset, font size, visibility and palette-role color overrides are described in [the layout format](layout-format.md). Custom templates use separate `/api/widgets` revision checks and never apply a dashboard.
