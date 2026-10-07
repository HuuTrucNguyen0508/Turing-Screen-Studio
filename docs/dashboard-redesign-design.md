# Dashboard redesign: System overview and AI usage

Design pass for the 1280 × 800 physical panel. The design is defined here; Codex implements it. It replaces the current active System overview (revision `672a0c01…`) and the AI usage library entry. The design uses the live Caelestia roles and the Roboto and JetBrains Mono files in `~/Documents/turing-smart-screen-python/res/fonts/`.

## Principles

1. **One grid for both dashboards.** Four 270 px columns with 24 px gutters inside 64 px margins: x = 64, 358, 652, 946. Two rows: y = 64 (h 304) and y = 392 (h 344). The right three columns can split into two 417 px halves (x = 358, 799). Every position and size is an integer.
2. **The time stays in one place.** Both dashboards put the same clock card at x 64, y 64, 270 × 304. Switching with Ctrl+F9–F12 changes everything except where the time is.
3. **Primary colour marks measurements.** `primary` is used only for live measured values (gauge arcs and numbers, storage and quota fills, hero totals). The clock uses `text`. Labels, units and captions use `muted`. Proportions use `secondary`. Borders, tracks and dividers use `outline`. No other colours, no warning reds and no threshold colour changes. The numbers carry the meaning.
4. **Two typefaces, Regular only.** JetBrains Mono Regular for every number and Roboto Regular for every word. Hierarchy comes from size and colour. No new weights, so PIL needs no new font plumbing.
5. **No decorative chrome.** No header, no footer and no kicker text. Each card has one label. Every caption states a period, a freshness or a limitation.
6. **Unknown values show "—".** Missing or elapsed readings never appear as 0 % or 100 %, and a partial total carries a visible `+`.

### Type scale

| Size | Face | Colour | Use |
| --- | --- | --- | --- |
| 72 | Mono | text | Clock time |
| 56 | Mono | primary | Aggregate hero value |
| 24 | Mono | primary | Quota percentage |
| 18 | Mono | text | Provider row values |
| 22 | Roboto | muted | Hero unit |
| 18 | Roboto | muted | Clock date |
| 17 | Roboto | text | Provider names |
| 15 | Roboto | muted | Card labels, period labels, window labels (existing renderer size) |
| 14 | Roboto | muted | Captions, reset/freshness |
| 12 | Roboto | muted | Footnote |

Inset for new cards: 28 px left and right. Existing gauge, weather and storage interiors stay unchanged.

## Render precondition: remove the footer on panel frames

`LayoutRenderer.render` draws "Live dashboard" and "1280 / 800" at y 731, on top of the cards. That text is chrome, and it collides with cards that end at 736. Omit it when `stats is not None` (panel frames). The editor can keep its "Deterministic preview" notice outside the canvas.

If the footer must stay, use the fallback: shift both rows up 24 px (y = 40 and y = 368, ending at 712). All other numbers stay the same.

The renderer chooses the header heading from `codex-`/`claude-` source prefixes. Both designs include a clock widget, so the header is hidden. Still, add the `usage-` prefix to the AI usage heading check so that a clockless usage layout isn't titled "System overview".

## Dashboard 1: System overview

```
 64        358       652       946      1216
 ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐   y 64
 │       │ │CPU    │ │GPU    │ │Memory │
 │ 14:32 │ │ ╭───╮ │ │ ╭───╮ │ │ ╭───╮ │
 │mer. 07│ │  24 % │ │  18 % │ │  39 % │
 │       │ │42 °C… │ │VRAM…  │ │8.4/30 │
 └───────┘ └───────┘ └───────┘ └───────┘   y 368
 ┌───────┐ ┌─────────────────────────────┐ y 392
 │Weather│ │Storage   3 drives · live    │
 │  ☁︎    │ │SSD  643.2 GiB / 931.5  69% │
 │  17°C │ │▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░        │
 │Partly │ │NVMe …                  39%+ │
 │cloudy │ │HDD  …                  52%+ │
 └───────┘ └─────────────────────────────┘ y 736
```

The left column holds ambient information (time and outside weather). The right zone holds the machine (load gauges above, drives below).

| id | type / source | x | y | w | h | Settings and notes |
| --- | --- | --- | --- | --- | --- | --- |
| `clock` | clock / `clock` | 64 | 64 | 270 | 304 | 24h, showDate. Design: label hidden; time align center, size 72, colour `text`, baseline at card y 158; date align center, size 18, colour `muted`, baseline at card y 202. Default large-clock baselines are 124 and h−29 = 275, so dy ≈ +34 and −73. Check against `resolve_elements`. |
| `cpu` | gauge arc / `cpu` | 358 | 64 | 270 | 304 | Label "CPU load". Radius 101, value size 48 (from `gauge_geometry`). |
| `gpu` | gauge arc / `gpu` | 652 | 64 | 270 | 304 | Label "GPU load". |
| `memory` | gauge arc / `memory` | 946 | 64 | 270 | 304 | Label "Memory". |
| `weather` | weather / `weather` | 64 | 392 | 270 | 344 | Unchanged renderer. Icon, temperature (76) and condition (20, ends at y 316) fit with 28 px below. High/Low (y 352) and the "Live weather" caption fall entirely outside the card, so nothing is partly clipped. |
| `mounted-storage` | storage / `mounted-storage` | 358 | 392 | 858 | 344 | Label "Storage", style `bars`, grouping `drives`, no `mounts` (auto-discovers SSD, NVMe and HDD). Bars capacity = (344−118)//70 = 3, rows at 80/150/220, footer at 325. |

Changes from the active layout: the off-grid placements (clock at 52/40, storage at 193/161, gauges at 633/938) move onto the grid. The order becomes CPU, GPU, Memory, left to right. The active layout had GPU before CPU, which looked accidental. The weather card gains height (282 → 344), so its condition line is now visible.

Storage capacity: bars hold exactly three drives. A fourth drive shows the existing "+1 drives · enlarge card" footer. If a fourth drive becomes normal, switch to `style: "table"`, which holds four at this size ((344−134)//46).

Optional follow-up, not required for this pass: storage row percentages are Roboto 14, which is weak next to the gauges. A later renderer change could set them in Mono 20 `primary`. A compact weather mode could also join High/Low onto the condition line when h < 380.

## Dashboard 2: AI usage

```
 64        358              799            1216
 ┌───────┐ ┌──────────────┐ ┌──────────────┐  y 64
 │       │ │Tokens  Last30│ │API cost Last30│
 │ 14:32 │ │412.6 M tokens│ │184.20 USD     │
 │mer. 07│ │Processed …   │ │API-equivalent…│
 │       │ │Codex ▬▬▬ 398M│ │Codex ▬▬▬142.37│
 │       │ │Claude ▬  14M │ │Claude ▬  41.83│
 └───────┘ └──────────────┘ └──────────────┘  y 368
 ┌─────────────────────────────────────────┐  y 392
 │Usage limits                             │
 │Codex   Weekly  ▓▓▓▓░░░░░░░  44 %  Resets…│
 │─────────────────────────────────────────│
 │Claude  5-hour  ░░░░░░░░░░░   —    Reset…│
 │        Weekly  ░░░░░░░░░░░   —    No lo…│
 │Percent at last reading. Missing data …  │
 └─────────────────────────────────────────┘  y 736
```

| id | source | x | y | w | h |
| --- | --- | --- | --- | --- | --- |
| `clock` | `clock` | 64 | 64 | 270 | 304 (identical to System overview, including design) |
| `usage-tokens` | `usage-tokens-30d` | 358 | 64 | 417 | 304 |
| `usage-cost` | `usage-cost-30d` | 799 | 64 | 417 | 304 |
| `usage-limits` | `usage-limits` | 64 | 392 | 1152 | 344 |

The quota card spans the full width, so rows read as one ledger. It is not split into provider halves under Tokens and Cost: that alignment would suggest that Codex belongs to Tokens.

### Aggregate card interior (417 × 304, shared by tokens and cost)

All y values are baselines measured from the card top. Anchors use PIL `ls`/`rs`, which map to SVG `text-anchor="start"`/`"end"` on the alphabetic baseline.

| Element | x | y | Font | Colour | Content |
| --- | --- | --- | --- | --- | --- |
| Label | 28 `ls` | 40 | Roboto 15 | muted | "Tokens" / "API cost" |
| Period | 389 `rs` | 40 | Roboto 15 | muted | "Last 30 days" (always shown) |
| Hero value | 28 `ls` | 112 | Mono 56 | primary | `412.6` / `184.20`; partial adds `+`; unknown is `—` in muted |
| Hero unit | 28 + valueWidth + 8 `ls` | 112 | Roboto 22 | muted | "M tokens" (K/M/B) / "USD"; omitted when the value is `—` |
| Caption | 28 `ls` | 142 | Roboto 14 | muted | See the state table |
| Divider | 28 → 389 | 166 | 1 px | outline | |
| Provider rows | | 202, 238, 274 (stride 36) | | | Fixed order: Codex, Claude, Cursor |
| · name | 28 `ls` | row | Roboto 17 | text | "Codex" |
| · share bar | 120 → 277 (157 px) | row−9 to row−5 (4 px), radius 2 | | track outline, fill secondary | provider ÷ known total; track only when the total is unknown or zero |
| · value | 389 `rs` | row | Mono 18 | text | `398.1M` / `142.37`; `+` if partial; `—` muted if unknown |

Hero fit: `size = min(56, floor((361 − unitWidth − 8) / (0.6 × chars)))`. Mono advance is exactly 0.6 em, so PIL and SVG produce the same size. "1,234.5 M tokens" still fits at 56.

Number formats: tokens use one decimal with K/M/B (`842`, `842.1K`, `412.6M`, `1.2B`). Cost uses two decimals below 10,000 and none from 10,000 up, with thousands separators (`1,184.20`, `12,480`).

Row rules: Codex and Claude rows are always present. A provider whose source is unreadable shows `—`. A Cursor row appears only when Cursor has recorded usage in the window. With two rows the third slot stays empty; rows never re-centre.

| State | Hero | Caption (tokens / cost) |
| --- | --- | --- |
| Complete, fresh | value | "Processed tokens · updated 09:29" / "API-equivalent estimate · not a bill" |
| Stale cache | value (last good, same window) | "Stale · as of 01:02" |
| Provider unreadable | known sum + `+` | "Partial · Claude unavailable" |
| Unpriced records | known sum + `+` | "Partial estimate · 8 unpriced records" |
| Nothing readable | `—` muted | "No local usage cache" / "No priced usage" |
| Readable, zero usage | `0` / `—` | Normal caption / "No priced usage" |

Period semantics belong to Codex. The label must match the data exactly. If the window is 30 rolling days ending at the read time, "Last 30 days" needs no time zone. If it is 30 UTC calendar days, the caption must say "UTC days". If the T3 scan cache doesn't reach back 30 days, mark the total partial with `+` and the caption "Partial · history from 12 Sep".

Data recommendation: zero-token `<synthetic>` records cost zero whatever the rate. Treat them as priced at 0 instead of making the whole cost total permanently partial. This is the known handover issue. If Codex keeps the stricter rule, the `+` state above still displays it honestly.

### Quota card interior (1152 × 344)

| Element | Geometry | Font | Colour |
| --- | --- | --- | --- |
| Label "Usage limits" | x 28 `ls`, y 40 | Roboto 15 | muted |
| Rows | top = 64 + 60·i (64, 124, 184, 244), at most 4 | | |
| · provider name | x 28 `ls`, top+38; first row of its group only; ≤ 104 px | Roboto 17 | text |
| · window label | x 148 `ls`, top+37; from `limits[].label` ("Weekly", "5-hour") | Roboto 15 | muted |
| · bar | x 256 → 736 (480 px), y top+27 → top+35 (8 px), radius 4 | | track outline, fill primary |
| · percent | x 820 `rs`, top+40 | Mono 24 | primary; `—` muted when unknown |
| · "%" | x 824 `ls`, top+40; omitted with `—` | Roboto 14 | muted |
| · caption | x 864 `ls`, top+37, ≤ 260 px (about 36 characters) | Roboto 14 | muted |
| Group divider | 1 px outline, x 28 → 1124, at the top of each provider group after the first | | |
| Footnote | x 28 `ls`, y 324 | Roboto 12 | muted: "Percent at last reading. Missing data is not zero." |

Rows are dynamic and generated from data, in provider order Codex then Claude:

- **Codex (Pro account):** one row for each reported window. Weekly is the only window known to apply, so with no telemetry show a single "Weekly" row with `—`. Never add a Codex 5-hour row unless telemetry reports one, and never caption it as "no limit". The footnote covers what isn't shown.
- **Claude:** "5-hour" and "Weekly" rows always appear, because both windows apply to the subscription. Local data supplies only an exhaustion notice, so most of the time both read `—`.
- More than 4 windows: show the first 4 and change the footnote to "+N more windows · enlarge card".

| Row state | Percent | Bar | Caption |
| --- | --- | --- | --- |
| Reading, reset in the future | `44` | fill | "Resets Wed 11:06 · as of 09:29" (time only when within 24 h: "Resets 14:20") |
| Estimated reset (Claude notice) | `100` | fill | "Resets ~02:20 · notice 00:50" |
| Reset time has passed | `—` | track | "Reset 02:20 passed · no new reading" |
| No local source | `—` | track | "No local reading" |
| Source error, last good still in window | value | fill | "Read error · as of 09:29" |

Hide the stored percentage once its reset has passed. The collector keeps the old value (correctly), but showing a pre-reset 100 % as current would mislead. Every bar fill uses the same clamped fraction as the number. Times use local time in 24h format, matching the clock card.

## PIL / SVG parity rules

- **Fonts:** the browser currently falls back to DejaVu for usage cards, while PIL uses Roboto and JetBrains Mono. Vendor `Roboto-Regular.ttf` and `JetBrainsMono-Regular.ttf` into the app (both licenses permit it) with `@font-face`, and use those families in the new card CSS. Widths then match, and truncation and fit decisions agree.
- **Fitting and truncation:** don't measure in the browser. Use a shared domain helper (TS, mirrored in Python) with Mono at 0.6 em per character and Roboto capacity estimated at 0.55 em per character, ending in `…`. This is the same approach as the existing `storage_short`.
- **Rounding:** fill width = `floor(available × fraction + 0.5)`. Percent text = `floor(p + 0.5)`. Both renderers call the same helper.
- **Rectangles:** PIL boxes include both endpoints. For an SVG rect at (x, y, w, h), draw PIL `(x, y, x+w−1, y+h−1)`. Bars use radius 4 (quota) and radius 2 (share).
- **Clipping:** every element above sits within its card bounds, so no glyph relies on clipping. Long captions must be truncated, not clipped.

## Out of scope

- The removed Ask AI assistant feature stays removed. These are read-only display cards.
- Don't save or apply anything without the user's request. Apply goes through `pnpm layout current`, then `pnpm layout apply <file> --if-match <revision>`. Both layouts are drafts in `layouts/` until then, and the AI usage library entry is replaced through the library API with its own revision.
- Gauge, weather and storage interiors stay unchanged apart from the optional follow-ups noted above.


## Implementation decisions

The clean drafts use optional `chrome: none`; omitted chrome preserves existing version 1 rendering. The designed clock uses the actual 110-pixel time baseline with `dy: 48`, and date baseline 275 with `dy: -73`. New summary cards ship licensed Roboto and JetBrains Mono fonts without changing legacy renderer fallback. The quota catalog card is 344 pixels high so four rows fit.

Codex Pro's five-hour window is inapplicable by default. Explicitly reported five-hour telemetry can override that default if the account changes. Unknown Claude windows stay visible. Only account-wide seven-day windows enter the weekly row. Expired reset observations remain stored but their percentages disappear from the displayed allowance.

Totals use exact rolling 30-day UTC bounds, include a cache observation timestamp, and mark unknown Cursor or incomplete pricing as partial. Zero-token synthetic records without prices remain unpriced. This avoids inventing costs. Token formatting supports billions. Two caption lines keep source gaps and freshness readable on the 417-pixel draft cards.

The user revised the quota display to usage left. The ledger bars and percentages show `100 - usedPercent`, with a "Usage left" heading. Demo rows retain the same recorded usage values, and both renderers convert them at display time. Unknown values and observations whose reset has passed stay unavailable.
