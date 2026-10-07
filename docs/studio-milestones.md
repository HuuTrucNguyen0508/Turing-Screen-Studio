# Studio editor milestones

The five milestones expand the existing editor without replacing the PIL renderer or changing the active dashboard document during implementation.

1. **Recoverable editing.** Committed edits have undo/redo with a 100-edit limit. Pointer gestures form one edit and cancellation restores the original. Each tab keeps a bounded browser backup. Recovery preserves the draft's original revision and save conflicts show both layouts before explicit replacement.
2. **Library and history.** Edit a library entry as a draft, duplicate or rename it, and confirm replacement or removal. Library saves and panel saves are separate operations with revision checks. Archived layouts can be opened as drafts or downloaded while preserving every archive ID.
3. **Widget design and copies.** Clock time, date and label support alignment, integer offsets, sizes, palette colors and visibility. Save any placed widget as an independent custom copy. Templates support rename, replacement, removal and additive import/export. Machine and browser stores remain accessible separately. Existing placed cards keep their own settings.
4. **Canvas arrangement.** Shift-select, select all, group movement, alignment, distribution, size matching, snapping and paint layers use integer document coordinates. Same width, height or size uses the selected reference without moving cards. Snapping starts enabled, remembers the browser preference and works when moving or resizing. Zoom, pan and Fit affect the view. Bounded overlap and small-card notes allow intentional compositions.
5. **Live readings and trends.** Sample/Live preview renders the draft without applying it. Runtime identity and freshness checks reject stopped or stale publishers. Source diagnostics show unknown readings and observed quota times. Eight trend templates use bounded real histories with gaps; demos stay deterministic. Quota scanning finds recent Pro telemetry behind large unrelated transcript records while retaining read bounds.

The clock example is [m3-clock-centered.json](../layouts/m3-clock-centered.json). It keeps the current layout's card geometry and centers the compact clock's time and date. Its [offline preview](../artifacts/m3-clock-centered.png) is a draft, not a panel save.

## Runtime behavior

The existing dashboard collector remains the only sensor collector. The adapter samples its supplied stats at most once per second, keeps 120 observations per source in memory and publishes a small runtime JSON file at most once every two seconds. It never opens another USB connection. GPU throttling and dirty skipping stay in the existing loop. Histories are observation counts, not a promise of two elapsed minutes.

The loopback API checks the publisher PID and process-start identity. Readings older than 15 seconds or from the future cannot render as live. Previewing does not write `layout.json`, `layouts.json` or archives. Provider collection remains read-only and quotas remain cached observations.

An already running process loads Python changes after restarting its local service. Existing runtime capability checks reject saving designed clocks or trends to an older adapter. A current Studio server is also needed for machine custom widgets and live preview.

## Resource checks

`runtime/measure_preview.py` measures sample/live requests and telemetry publication in an isolated temporary directory. It opens neither sensors nor USB:

```bash
~/Documents/dashboard/.venv/bin/python runtime/measure_preview.py --iterations 30 --output artifacts/m5-preview-resources.json
~/Documents/dashboard/.venv/bin/python runtime/measure_runtime.py --seconds 60 --output artifacts/m5-runtime-running-baseline.json
```

The offline run measured about 16 ms per sample preview and 15 ms per live preview. Observed resident memory increased by about 2 MiB. Publishing the 5.9 KB fixture snapshot used about 0.07 ms of CPU per write. These measurements retain PIL; they do not justify replacing it. RSS sampling occurs between requests and does not measure every temporary allocation.

The first 60-second service comparison measured 3.67% CPU and 44.40 MiB RSS before restart, then 4.57% CPU and 76.20 MiB RSS after activation. CPU passed, but the 31.80 MiB RSS increase exceeded the 25 MiB limit. This result is retained in `artifacts/m5-runtime-running-baseline.json` and `artifacts/m5-runtime-activated.json`.

To investigate the memory increase, separate fresh processes loaded the old and updated adapter with identical legacy imports, the saved layout and captured readings. Each rendered and encoded 120 frames using temporary state without sensors or USB. Observed RSS increased by 6.09 MiB, from 44.62 to 50.71 MiB. This check does not include the live collector or transport. Evidence is in `artifacts/m5-controlled-adapter-resources.json`.

The physical-runtime comparison was then repeated with both versions freshly started, using the same saved dashboard and 60-second windows. The old adapter measured 4.68% CPU and 72.26 MiB RSS; the updated adapter measured 4.10% CPU and 71.96 MiB RSS. Changes of -0.58 CPU percentage points and -0.30 MiB RSS passed both limits. These short windows establish the budget for this layout and workload, not a sustained speedup. See `artifacts/m5-runtime-fresh-baseline.json` and `artifacts/m5-runtime-fresh-updated.json`.

The previous adapter ran from a temporary checkout during that comparison. Its temporary service override was removed, and the updated adapter was restored. Final status confirms a connected panel, fresh live readings and acknowledgement of the unchanged saved layout. Layout and library checksums and the existing archive inventory match their pre-activation snapshot. Refresh Studio to load the new editor; the centered clock example remains an unapplied draft.
