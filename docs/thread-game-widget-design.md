# Thread and game timer widgets: design

Design pass for two new read-only cards on the 1280 × 800 panel. Root implements the frontend, runtime and tests. This note sets geometry, type, colour, states and the editor dialog. It extends [the dashboard redesign](dashboard-redesign-design.md) and keeps its grid, palette roles and fonts.

Inputs: the clean drafts in `layouts/`, `runtime/turzx_studio/renderer.py` (`_usage_summary`, `_weather`, `_storage_card`), `storage_display.storage_geometry`, the partial `runtime/turzx_studio/activity.py`, and the live Caelestia scheme.

The user's latest correction stands: game resources use a **global timer**. Read that as one set of manual anchors (count + time) for the three games, stored once and shared by every dashboard. No HoYoLAB or account connection, no cookies and no invented live counts.

## Geometry (affirmed)

The recovered geometry is correct. Each new card takes the 270 × 344 bottom-left cell, under the clock, on both dashboards. The left column then means *things about you* on both dashboards: time and threads on AI usage, time and games on System overview. Weather and storage stay; they shift right on the existing 24 px grid.

### AI usage (`layouts/ai-usage-30d.json`)

```
 64        358              799            1216
 ┌───────┐ ┌──────────────┐ ┌──────────────┐  y 64
 │ 14:32 │ │Tokens        │ │API cost      │
 │mer. 07│ │…             │ │…             │
 └───────┘ └──────────────┘ └──────────────┘  y 368
 ┌───────┐ ┌──────────────────────────────┐   y 392
 │T3 thr.│ │Usage limits · Usage left     │
 │2 work…│ │Codex  Weekly ▓▓▓▓░░  59 % …  │
 │Studio…│ │Claude 5-hour ░░░░░░   —  …   │
 │…      │ │       Weekly ░░░░░░   —  …   │
 └───────┘ └──────────────────────────────┘   y 736
```

| id | type / source | x | y | w | h |
| --- | --- | --- | --- | --- | --- |
| `t3-threads` | metric / `t3-threads` | 64 | 392 | 270 | 344 |
| `usage-limits` | metric / `usage-limits` | 358 | 392 | 858 | 344 |

The limits card is already width-proportional (`width × .128 / .222 / .639 / .712 / .75`). At 858 px: window label x 109, bar 190 → 548 (358 px), percent `rs` 610, caption x 643 with 187 px of room. That fits about 24 characters at Roboto 14 ("resets 3d 2h · as of 09:29" truncates to "resets 3d 2h · as of 09…"). Truncation is acceptable because the reset time comes first. No interior change is needed.

### System overview (`layouts/system-overview-clean.json`)

```
 64        358       652                1216
 ┌───────┐ ┌───────┐ ┌───────┐ ┌───────┐  y 64
 │ 14:32 │ │CPU    │ │GPU    │ │Memory │
 └───────┘ └───────┘ └───────┘ └───────┘  y 368
 ┌───────┐ ┌───────┐ ┌─────────────────┐  y 392
 │Game t.│ │Weather│ │Storage          │
 │Genshin│ │  ☁︎    │ │SSD  …       69% │
 │Wuther…│ │ 17°C  │ │NVMe …       39%+│
 │Zenless│ │Partly │ │HDD  …       52%+│
 └───────┘ └───────┘ └─────────────────┘  y 736
```

| id | type / source | x | y | w | h |
| --- | --- | --- | --- | --- | --- |
| `game-resources` | metric / `game-resources` | 64 | 392 | 270 | 344 |
| `weather` | weather / `weather` | 358 | 392 | 270 | 344 (size unchanged) |
| `mounted-storage` | storage / `mounted-storage` | 652 | 392 | 564 | 344 |

Weather keeps its exact size, so its interior is unchanged. Storage `bars` capacity depends on height only: `(344 − 80 − 38) // 70 = 3` drives, as before. At 564 px the bar is 516 px wide and drive names allow `(516 − 50) // 8 = 58` characters. The fourth-drive fallback (`style: "table"`, `width ≥ 460`) still works.

The weather and gauge columns now line up: weather sits under CPU at x 358. That is a bonus, not a requirement.

## Shared rules

Same as the redesign, restated for these cards:

- **Fonts:** Roboto Regular for words and JetBrains Mono Regular for numbers and provider tags, through the `summary-` font family path (vendored `public/fonts/`). No new weights.
- **Fitting:** shared helper, Mono 0.6 em per character, Roboto 0.55 em, ending in `…` (`storage_short`). Never measure in the browser.
- **Anchors:** all y values below are alphabetic baselines from the card top. `ls` = SVG `start`, `rs` = SVG `end`.
- **Inset:** 28 px left and right. Content width at 270 px is 214 px (x 28 → 242).
- **Rectangles:** SVG (x, y, w, h) maps to PIL `(x, y, x+w−1, y+h−1)`. Fill width = `floor(available × fraction + 0.5)`.
- **Unknown is `—` in `muted`.** A missing reading is never shown as 0.

### Colour roles

The layout stores roles; the panel resolves them from the live scheme (`src/domain/layout.ts` mapping). Today's values:

| Role | Caelestia key | Live now (`~/.local/state/caelestia/scheme.json`) | Bundled snapshot in drafts |
| --- | --- | --- | --- |
| background | background | `#110d11` | `#0a0f0f` |
| surface (card) | surfaceContainer | `#1d181e` | `#131b1b` |
| text | onSurface | `#efe2ec` | `#dce8e7` |
| muted | onSurfaceVariant | `#b3a8b2` | `#a2adad` |
| primary | primary | `#dfbbe2` | `#9bd0d1` |
| secondary | secondary | `#d6c0d6` | `#b0cccc` |
| outline | outlineVariant | `#4e454e` | `#3f4a4a` |

Role meaning in these cards:

- `primary`: an **observed** live value. The thread count and the running-status dot.
- `secondary`: a **derived estimate**. Game counts and their bars. This extends the redesign's "secondary = proportions" to "secondary = computed, not read".
- `text`: names (thread titles, game names).
- `muted`: labels, captions, caps, units, waiting dots and every `—`.
- `outline`: dividers and bar tracks.

In the live scheme primary and secondary are close (`#dfbbe2` vs `#d6c0d6`). Colour alone will not tell an estimate from a reading, so words do that job: the game card header always says "Estimated" and caps stay muted. Do not add a new colour to force the distinction.

## Card 1: T3 threads (`t3-threads`, 270 × 344)

### Collector contract

From `ActivityCollector.snapshot()`:

```
{ status: "ok" | "stale" | "unavailable",
  working: int | null,          // exact only when status == "ok"
  items: [{ title, provider, status }],   // ≤ 5, running first
  observedAt: ISO | null, errors: [code] }
```

Item `status` is `running`, `waiting_approval`, `waiting_input` or `waiting`. One addition for the card: return **`active`**, the item count before the `MAX_ITEMS` cut, so the overflow line is honest. Until then, show overflow only when `len(items) == MAX_ITEMS` and phrase it as "More may be active".

### Interior

```
28                                242
│T3 threads                         │  40  label
│2 working                          │  98  hero
│1 waiting · as of 09:29            │ 124  caption
│───────────────────────────────────│ 140  divider
│Studio improvements and…           │ 168  row 1 title
│● Working               Codex Pro  │ 186  row 1 meta
│Thread/game widget des…            │ 214
│● Working                  Claude  │ 232
│Context compaction stuck           │ 260
│○ Needs input           Codex Pro  │ 278
│                                   │ 306  row 4 (or overflow line)
│                                   │ 324
```

| Element | Geometry | Font | Colour |
| --- | --- | --- | --- |
| Label "T3 threads" | x 28 `ls`, y 40 | Roboto 15 | muted |
| Hero count | x 28 `ls`, y 98 | Mono 48 | primary; `—` muted |
| Hero unit "working" | x 28 + countWidth + 8 `ls`, y 98 | Roboto 20 | muted; omitted with `—` |
| Caption | x 28 `ls`, y 124, ≤ 214 px | Roboto 13 | muted |
| Divider | x 28 → 242, y 140, 1 px | | outline |
| Row i title | x 28 `ls`, y 168 + 46·i, ≤ 214 px (24 chars) | Roboto 16 | text |
| Row i status dot | centre (32, title+14), r 3 | | running: filled primary; waiting: 1 px ring muted |
| Row i status word | x 42 `ls`, y title+18 | Roboto 13 | muted |
| Row i provider tag | x 242 `rs`, y title+18, ≤ 9 chars | Mono 12 | secondary |

Row baselines: titles 168, 214, 260, 306; meta 186, 232, 278, 324. The last glyph ends at about 327, leaving 17 px, close to the 20 px used by the limits footnote.

Status words: `running` → "Working", `waiting_approval` → "Needs approval", `waiting_input` → "Needs input", `waiting` → "Waiting". The longest ends at x ≈ 142, and the widest tag starts at x ≈ 177.

Provider tags by `provider_instance_id`: `codex-pro` → "Codex Pro", `codex` → "Codex", `claudeAgent` → "Claude", `cursor` → "Cursor". Anything else shows its instance ID cut to 9 characters. Tags are plain mono text with no pill. The fixed-advance face makes the right edge read as a column without extra chrome.

The dot is drawn as a shape, not a glyph, because Roboto's `●` coverage differs between PIL and the browser. SVG: `<circle cx=32 cy=title+14 r=3>`; PIL: `ellipse((29, title+11, 35, title+17))`.

The card's one distinctive device is this status dot: filled `primary` for a turn that is running now, hollow `muted` for one that is waiting on you. Everything else stays quiet.

### States

| Collector state | Hero | Caption | Rows |
| --- | --- | --- | --- |
| `ok`, some running | `working` primary | "1 waiting · as of 09:29" or "None waiting · as of 09:29" | items, running first |
| `ok`, none active | `0` primary | "No active threads · as of 09:29" | empty; no placeholder rows |
| `ok`, more than fit | as above | as above | slot 4 becomes "+N more · M waiting" Roboto 13 muted at y 306 |
| `stale` | `—` muted | "Stale · " + reason | none (collector returns none) |
| `unavailable` | `—` muted | reason | none |
| editor sample | sample `2` primary | "Sample threads" | three sample rows |

Error-code captions (first code wins):

| Code | Caption |
| --- | --- |
| `runtime_missing`, `runtime_dead` | "T3 is not running" |
| `runtime_unverified`, `runtime_invalid` | "Can't confirm T3 is running" |
| `database_missing` | "No T3 data on this machine" |
| `database_busy` | "T3 data busy · retrying" |
| `database_unreadable`, `unknown_schema`, `invalid_state` | "Can't read this T3 version" |
| `projection_behind`, `source_stale`, `inconsistent_state`, `provider_unverified` | "Stale · T3 state is catching up" |
| `read_bound`, `partial` | "Stale · too many threads to count" |

"Working" means only verified running turns. Waiting threads are listed but never counted in the hero. A partial read is never shown as a smaller total.

Deterministic sample (editor and `pnpm layout preview`): working 2; rows "Studio improvements and next goal" / `codex-pro` / running, "Thread and game widget design" / `claudeAgent` / running, "Context compaction stuck" / `codex-pro` / waiting_input; caption "Sample threads".

### Small and large cards

- Row capacity = `max(0, floor((h − 150) / 46))`, capped at 5. At h 344 that is 4.
- If capacity is 0 (h < 196): label, hero and caption only.
- If h < 132: compact. Label at y 25, hero Mono 36 at y 76, caption hidden.
- Title characters = `floor((w − 56) / 8.8)`. If w < 230, drop the provider tag and let the status word take the line.
- Wider cards only lengthen titles. The layout does not reflow into columns.

## Card 2: Game timers (`game-resources`, 270 × 344)

### Model

A global, server-held state file, not layout settings. Suggested path `~/.local/share/turzx-studio/game-timers.json`, separate from `layout.json`, the library and archives:

```
{ version: 1,
  games: { genshin:  { count: 137, observedAt: "2026-10-07T08:12:00Z" } | null,
           wuwa:     null,
           zzz:      null } }
```

Estimate = `min(cap, count + floor((now − observedAt) / interval))` while `count < cap`. A count at or above cap stays as entered (games stop regenerating at cap). Rules are constants in one shared table in TS and Python:

| Key | Display | Resource | Cap | Interval |
| --- | --- | --- | --- | --- |
| `genshin` | Genshin | Original Resin | 200 | 8 min |
| `wuwa` | Wuthering Waves | Waveplates | 240 | 6 min |
| `zzz` | Zenless | Battery Charge | 240 | 6 min |

**Confirm cap and interval from each game's official source before shipping**, as the handover requires. These figures are my working values, not verified for this pass.

### Interior

```
28                                242
│Game timers               Estimated│  40
│Genshin                    137/200 │  92  name + count
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░│ 102–105 bar
│Full in 8h 24m          set 2h ago │ 124  meta
│Wuthering Waves            240/240 │ 182
│▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓│ 192–195
│Full for 2h 5m         set 26h ago │ 214
│Zenless                      —/240 │ 272
│░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ 282–285
│Not set · use Game timers in Studio│ 304
```

Rows are fixed in order Genshin, Wuthering Waves, Zenless. Row tops 58 + 90·i.

| Element | Geometry | Font | Colour |
| --- | --- | --- | --- |
| Label "Game timers" | x 28 `ls`, y 40 | Roboto 15 | muted |
| Header state | x 242 `rs`, y 40 | Roboto 13 | muted: "Estimated", or "Sample" in the editor |
| Game name | x 28 `ls`, y top+34, ≤ 214 − slashWidth − countWidth − 12 | Roboto 16 | text |
| Cap "/200" | x 242 `rs`, y top+34 | Mono 14 | muted |
| Count | x 242 − capWidth − 2 `rs`, y top+34 | Mono 24 | secondary; `—` muted |
| Bar | x 28 → 242 (214 px), y top+44 → top+47 (4 px), radius 2 | | track outline, fill secondary |
| Meta left | x 28 `ls`, y top+66 | Roboto 13 | muted |
| Anchor age | x 242 `rs`, y top+66 | Roboto 12 | muted |

Baselines: names 92 / 182 / 272, bars 102 / 192 / 282, meta 124 / 214 / 304.

Fit check at 270 px: "Wuthering Waves" ≈ 124 px, plus 12, plus "240/240" (Mono 24 × 3 = 43, Mono 14 × 4 = 34, gap 2) = 215. That is 1 px over the 214 px estimate. Real Roboto advance is narrower than 0.55 em, so give the name the remainder and let the helper truncate if needed. Don't shorten the default name by hand.

The anchor age stays visible because the estimate is only right if the user hasn't spent resources since setting it. "set 26h ago" tells them when to distrust it. This is the card's honesty device; don't hide it to save space.

### Row states

| State | Count | Bar | Meta left | Anchor age |
| --- | --- | --- | --- | --- |
| Not set | `—` muted, cap muted | track | "Not set · use Game timers in Studio" (full width, no age) | — |
| Regenerating | estimate | fill = estimate ÷ cap | "Full in 8h 24m" (`42m` under an hour, `1d 2h` from 24 h) | "set 2h ago" |
| Reached cap | cap | full | "Full for 2h 5m" | "set 26h ago" |
| Entered above cap | entered count | full | "Above cap · not regenerating" | "set …" |
| Anchor in the future (clock change) | `—` muted | track | "Check timer · set time is ahead" | — |
| State file unreadable | `—` muted | track | "Timers unreadable" on every row | — |
| Editor sample | sample values | sample | as computed from the sample | sample |

Ages: "set just now" under a minute, then `Nm`, `Nh`, `Nd` ("set 3d ago"). Don't add a staleness colour. The age is the signal.

Deterministic sample (fixed `now`): Genshin 137, set 2 h ago → "Full in 8h 24m" (`(200 − 137) × 8 = 504 min`); Wuthering Waves at cap, full for 2h 5m, set 26 h ago; Zenless not set. Showing one row of each kind makes the sample also document the states.

### Small and large cards

- Stride = `min(90, floor((h − 58 − 16) / 3))`.
- Stride ≥ 72: full rows as above, offsets scaled from the top.
- 44 ≤ stride < 72: drop the meta line (name, count, bar only). The header changes to "Estimated · open card for times" only if width allows; otherwise "Estimated".
- Stride < 44 (h < 206): label plus "Enlarge card to show timers" Roboto 13 muted, matching storage's "enlarge card" wording.
- Name characters follow width; bar spans `w − 56`. Wider cards gain no extra columns.

## Editor: Game timers dialog

Entry point: a **Game timers** button in the main toolbar beside History and Library. It also opens from the game card's inspector ("Set game timers…"). Use the existing `HistoryDialog` modal pattern: native `<dialog>`, focus trap, Escape closes, focus returns to the opener.

```
┌ Game timers ─────────────────────────────────── ✕ ┐
│ Enter what each game shows now. The panel counts  │
│ up from there on every dashboard.                 │
│                                                   │
│ Genshin Impact · Original Resin      1 per 8 min  │
│ [ 137 ] / 200   Save count   Clear                │
│ Now about 152 · set 09:12, 2h ago                 │
│ ───────────────────────────────────────────────── │
│ Wuthering Waves · Waveplates         1 per 6 min  │
│ [     ] / 240   Save count   Clear                │
│ Not set                                           │
│ ───────────────────────────────────────────────── │
│ Zenless Zone Zero · Battery Charge   1 per 6 min  │
│ …                                                 │
│                                          [Close]  │
└───────────────────────────────────────────────────┘
```

Behaviour:

- **Save count** stores `{count, observedAt: server now}` for that row only. Enter in the input does the same. The status line updates to "Saved · set just now". Other rows are untouched.
- **Clear** removes that row's anchor. The status line reads "Cleared · not set". No confirmation is needed because re-entering a number restores it.
- The input is empty when unset, or prefilled with the current *estimate*, not the stale anchor. Saving without edits then re-anchors to the estimate (an explicit "it's still right").
- Input: `type="text" inputmode="numeric" pattern="[0-9]*"`, integers 0–999. Errors appear inline under the row: "Enter a whole number from 0 to 999." Nothing is saved on error. Counts above cap are allowed.
- Labels: each input has a visible `<label>` ("Genshin Impact resin count"), and the "/ 200" suffix is `aria-hidden` with the cap included in `aria-describedby`.
- Status lines use `aria-live="polite"`.
- Tab order per row: input → Save count → Clear, then the next row. Visible focus ring uses `primary` with a 2 px outline.
- **Offline editor** (no Studio server): rows render read-only with "Game timers are stored by the Studio server. Run `pnpm studio` to set them." Do not fall back to browser storage, because it would split the global timer.
- **Server error:** "Genshin count not saved: Studio server not reachable." The input keeps the typed value.
- Saving timers never changes the layout, library, panel revision or undo history, and never opens USB. The runtime picks up the file on its next read (the same cadence as other cached sources is fine).

Mobile (< 600 px): the dialog becomes a full-width sheet. Each row stacks as name line, then the input at full width, then Save count and Clear side by side. Buttons are at least 44 px tall. Use no horizontal scrolling.

Copy stays consistent: the button is "Save count", the confirmation is "Saved", and the card says "set 2h ago".

## Implementation notes for root

- Follow the usage-summary pattern: `type: "metric"`, specialised rendering by `settings.source`, with `rendered_content` filling `detail` lines from the collector or timer file. The layout contract stays React-independent and stores only the source. Timer state never enters the layout.
- Catalog: `t3-threads` in the `ai-usage` group; `game-resources` in a new `games` group, both 270 × 344 by default.
- The renderer heading check already maps `usage-` sources; add `t3-` there. Both drafts use `chrome: none`, so it rarely matters.
- PIL and SVG must call the same fit and format helpers (count formatting, duration "8h 24m", age "2h ago", truncation).
- Verify by previewing both drafts and checking: no text crosses x 242 or y 330; the sample shows each game row state; thread titles truncate with `…`; and the limits caption at 858 px truncates rather than clips.

## Open points

1. Confirm caps and intervals from official sources (above).
2. Add `active` to the collector snapshot for an honest overflow count.
3. "Global timer" is read here as shared manual anchors. If the user meant something else, such as a daily reset countdown, the card geometry still holds; only the row meta line changes.

## Implemented contract

The implementation uses `T3Activity.snapshot()` with `{working, threads, observedAt, status, note}`. It follows the installed version-2 thread event journal. Working is a verified total; listed rows are capped at five. Overflow says More threads in T3 rather than inventing a hidden-row count. Game inputs accept whole counts from 0 to 10000, including counts above cap. A full timer says Full. Details, source evidence and the HTTP contract are in [thread and timer data](thread-game-data.md).
