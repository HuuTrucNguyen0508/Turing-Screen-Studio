## Community release, 7 October 2026

Added a canvas-size dialog with resolution presets, custom dimensions, uniform card fitting, keep-position and empty-canvas modes. Resize maps integer edges with one aspect-preserving scale; one Undo restores the original document. Portrait layouts export without changing the panel. Non-1280 × 800 drafts cannot be saved to the existing panel or its library.

`pnpm build` and all 281 domain tests passed. The Python suite passed 452 tests with one skip in an isolated environment containing only the pinned Pillow dependency. An isolated local API started without the legacy dashboard and rendered a 320 × 480 PNG. A clean temporary package installation passed with `pnpm install --frozen-lockfile`.

The full browser run passed 91 cases and caught a locator ambiguity in the new connected-size check. After restricting that locator to the visible message, all four canvas-size cases passed, covering integer export, single-step Undo, empty canvas, mobile layout, cancellation and panel/library write protection. The mobile dialog screenshot was inspected. The collaborative browser opened, but its snapshot timed out; visual evidence comes from the existing project browser tests.

Review also checked 3,000 resize cases and all catalog widgets on canvases down to 1 × 1. The Python suite passed in an empty home directory with two expected font-related skips. The panel-size notice now appears near Save, and the size dialog can explicitly hide the fixed header and footer. Build and all four canvas-size browser checks passed after these changes. A pre-existing shortcut-test race was fixed by waiting for switch completion before sending the next key; the four-slot shortcut case passed five consecutive runs.

The first public release supports offline design at other canvas sizes. USB output remains limited to the tested 8-inch 1280 × 800 adapter. No live layout, library, service or USB state was changed during release preparation.

## Updated shortcut slots, 7 October 2026

At the user's request, saved the revised AI usage dashboard in slot 1, Ctrl+F9, and revised System overview in slot 2, Ctrl+F10. The library update used its current revision through `/api/layouts`; both replaced documents were archived by the server. Slots 3 and 4 and all existing archive bytes are unchanged. The current physical panel layout was not switched. Readback matches both draft documents. Evidence is in `artifacts/f9-f10-library-before.json` and `artifacts/f9-f10-library-after.json`.

## T3 threads and shared game timers, 7 October 2026

The final independent review found no remaining P1/P2 findings. Reloaded `turzx-studio.service` and `turzx-dashboard.service` after the checks passed. The panel is connected, has accepted its original revision `672a0c01e5007b643ebed5c54191736996041a296a37c39d1d327481e3a30828`, and reports no error with a positive `66c8` reply. All 57 saved configuration/archive files match the pre-reload hashes. The library revision is unchanged. No draft was applied and no game counts were initialized. Activation evidence is `artifacts/thread-game-activation.json`.

The production activity API reports live verified work. All three game rows are not configured. Both draft live previews were rendered through the API and inspected, without saving a layout. They are `artifacts/ai-usage-30d-thread-game-live.png` and `artifacts/system-overview-clean-thread-game-live.png`. After the reload, native browser evaluation also timed out; this does not affect the passed fixture browser checks or API preview captures.

Added `t3-threads` and `game-resources` metric sources, catalog templates and matching SVG/PIL renderers. The clean AI usage draft puts working threads at bottom left; system overview puts shared timers there while retaining weather and storage. Both validate for the panel with no overlaps. Samples remain deterministic, and live values never enter exported layouts.

The metadata-only activity collector follows the installed T3 version-2 thread event journal. It reports verified working totals, separates waiting rows, and hides incomplete or unverifiable evidence. Long silent turns keep their verified state because event timestamps are not heartbeats. Complete idle projections survive a server restart; active evidence from a previous server remains unknown.

Game timers use manual current counts and one revision-checked shared anchor file. Atomic locked writes preserve concurrent edits and invalid state. A future saved time affects only its game and can be reanchored or cleared. Browser checks cover zero counts, clear, typed counts in other rows, conflicts, malformed responses, keyboard focus, clock warnings, offline controls and 360-pixel layouts.

`pnpm build` passed, including both TypeScript checks. All 276 domain tests passed. The final Python suite ran 450 tests with one skip and no failures. The full browser suite passed 86 cases before review fixes; all six focused timer cases passed afterward. The initial full Python failures came from a test selecting the last card rather than the quota card's stable ID. The catalog assertion was updated for the shared summary-source error message. `git diff --check` passed.

Two review rounds checked counts, privacy, timestamp recovery, conflicts and renderer parity. Source timing in this local run was 2.71 ms median and 140.33 ms maximum over five uncached activity reads; cached reads averaged 3.77 microseconds. The game snapshot took 0.098 ms. These are read timings, not a full panel resource comparison. Display-source exceptions cannot interrupt the panel loop. The existing PIL renderer and USB lifecycle are retained.

The sample previews use the current Caelestia palette. The HTML comparison at 360 and 728 pixels has no horizontal overflow, with full-size card details for phone readers. Native T3 DOM inspection works, but its screenshot call timed out. Logs and images use the `artifacts/thread-game-*` prefix, plus `ai-usage-30d-threads-caelestia.png` and `system-overview-game-timers-caelestia.png`. Source behavior and evidence are documented in [thread and timer data](thread-game-data.md).

# Verification

## Quota usage left, 7 October 2026

Changed the new quota ledger's percentages and bars to show remaining allowance, `100 - usedPercent`, with a Usage left heading. Raw collector telemetry and saved demo readings keep their original meaning. Unknown values and expired reset observations remain unavailable. The browser and PIL renderers agree at zero, full and partial usage.

`pnpm build` passed. Three focused domain checks, 44 Python formatter/renderer checks and three browser regressions passed. The browser check also confirms the remaining percentage drives the bar length. Refreshed sample, live and HTML comparison previews show usage left; the 360-pixel HTML preview reports no horizontal overflow. Logs are `artifacts/usage-left-{build,domain,runtime,browser}.log`. Dashboard application still awaits the user's instruction.

## Clean dashboard drafts and rolling usage, 7 October 2026

Added `layouts/system-overview-clean.json` and `layouts/ai-usage-30d.json`. Both validate for the 1280 by 800 panel with no overlaps. The system draft aligns six cards; the usage draft pairs rolling 30-day tokens and API-equivalent cost above account quota rows. These are drafts, awaiting the user's instruction to apply them.

The collector reads identity-checked T3 provider caches for actual Claude and Codex limits. It retains exact rolling interval bounds on failed refreshes. Missing Cursor history remains unavailable and makes totals partial. Codex Pro's five-hour row stays hidden unless an actual 300-minute window is reported. Sparse and newest-first reads preserve each window's observation time without renewing unsupported evidence. Monthly and model-specific windows cannot replace the account weekly row.

`pnpm build` passed, including both TypeScript checks. All 272 domain tests passed; the final catalog check passed 19 tests after catalog ordering changed. The Python suite ran 345 tests with one skip. A subsequent formatter check passed 39 tests after adding a daily model billions regression. All 24 selected browser cases passed across the broad run and corrected catalog rerun. Browser checks include source cards, import/export without applying, expired resets, clean chrome, mobile scrolling, manual editing and absence of Ask AI. Legacy pixel hashes remain unchanged. Three Claude review rounds identified quota applicability, caption, geometry and reverse-read issues; the implementation owner fixed them with regressions.

Sample and captured-live PIL previews are `artifacts/system-overview-clean*.png` and `artifacts/ai-usage-30d*.png`. The interactive comparison is `artifacts/dashboard-redesign.html`; native HTML previews at 360 and 728 pixels report no horizontal overflow. The new summary fonts include their licences and do not alter legacy renderer fallback. Evidence logs are `artifacts/redesign-build.log`, `redesign-domain.log`, `redesign-catalog-domain.log`, `redesign-runtime-full.log`, `redesign-final-formatter.log`, `redesign-browser.log` and `redesign-browser-rerun.log`.

No panel, saved-library, custom-widget or archive writes were made. The active panel and saved library still match `artifacts/redesign-origin.json`, with revisions `672a0c01e5007b643ebed5c54191736996041a296a37c39d1d327481e3a30828` and `3978d22db1d72fe04c2cf3231d25e724459f500b2d6b68d41cfecaf65ab920f4`. No services restarted. T3's Studio tab navigated successfully but its native snapshot timed out; live embedded editor inspection remains unverified. The fixture browser tests and native HTML comparison previews passed independently.

## Physical drives and custom partitions, 7 October 2026

New mounted-storage cards show SSD, NVMe and HDD as physical drives with whole-device capacity and usage bars. Usage sums distinct mounted filesystems once, including shared Btrfs mounts. A `+` marks mounted usage when unmounted partitions prevent a complete reading. Existing documents without a storage grouping retain their filesystem view. The inspector can switch views and select ordered absolute mount paths.

`pnpm build` passed, including both TypeScript checks. All 268 domain tests and 23 selected browser tests passed. The final Python suite ran 295 tests with one font-related skip. Browser checks cover drive defaults, partition filters, validation, Undo and Redo, export and reopening, and reusable custom copies. Two independent review rounds found and cleared missing-capacity text and a schema mismatch. `git diff --check` passed. Evidence is in `artifacts/storage-build.log`, `artifacts/storage-domain-checks.log`, `artifacts/storage-browser-rerun.log` and `artifacts/storage-runtime-final.log`.

Restarted the Studio and dashboard services to load the storage collector, renderer and advertised view support. Applied `layouts/storage-physical-drives.json` through the revision-checked CLI. The panel accepted revision `672a0c01e5007b643ebed5c54191736996041a296a37c39d1d327481e3a30828`, is connected and returned a positive `66c8` response without an error. Storage grouping is the only panel document change. The original document is preserved exactly in archive `20261007T005244949507Z-2250be13b0ad`; all other 59 previously saved files retain their bytes.

Saved the custom widget "SSD, NVMe and Games partitions" through the widget API with its library revision. It selects `/`, `/mnt/nvme` and `/mnt/games` in that order and is available from Custom widgets. The custom card was verified with current readings through the live preview API. Ask AI removal remains intact. Activation evidence is in `artifacts/storage-before-activation.json`, `artifacts/storage-after-activation.json`, `artifacts/storage-apply.log`, `artifacts/storage-custom-widget-saved.json` and `artifacts/storage-applied-panel.png`.

T3 reports the Studio preview tab available but not visible; a native snapshot timed out. Embedded preview visibility remains unverified. The local Studio responds at `http://127.0.0.1:5174`.

## Ask AI removal, 7 October 2026

Removed Ask AI from the editor and deleted its proposal UI, stylesheet, domain helpers, model runner and dedicated tests. The local server no longer starts an AI service or serves its status, submission, polling or cancellation endpoints. The README no longer describes the feature. Provider usage widgets, presets and the layout CLI remain available.

The production build and both TypeScript checks passed. The domain run passed 266 tests. The final Python run completed 294 tests with one skip. All 44 selected browser cases passed across the initial run and the corrected AI-removal regression rerun. The new regression checks that manual editing and Undo work without AI controls or requests. Server checks cover GET, HEAD and POST returning JSON 404 responses without changing saved layouts. `git diff --check` passed. Claude review hit a rate limit; Codex completed the review under the documented fallback.

Restarted only `turzx-studio.service`. Live API checks confirm the removed endpoints return 404, and T3 browser inspection confirms the Ask AI control is absent. All 60 saved configuration and archive files retain their original bytes. The dashboard process remained PID 3309431, connected, with matching requested and applied revision `2250be13b0adbe3503a3b57afb30a50051997b5a7b315807c80522a1efd507ae`. Evidence is in `artifacts/remove-ai-before.json`, `artifacts/remove-ai-after.json` and the `artifacts/remove-ai-*.log` files.

## Ask AI, 7 October 2026, historical

This feature was later removed at the user's request. The following records its earlier verification.

Ask AI was active in the connected Studio at `http://127.0.0.1:5174`. The production API reports the signed-in `codex-pro` account and `gpt-6.1-sol`. A real model request moved CPU from X=64 to X=74 and preserved every other field. It used an isolated sample draft and did not save a panel layout.

The production build and both TypeScript checks passed. All 269 domain tests passed. The full browser run passed 83 cases; a new test used the wrong saved-status label. After correcting that assertion and adding the original-revision regression, all eight focused Ask AI cases passed. These runs cover 85 distinct browser cases. The full Python run completed 300 tests with one font-related skip. After tightening the quota guard, all 27 AI domain and HTTP checks passed, including the additional quota regression. `git diff --check` passed.

Browser checks cover one Undo step, reusable copies, newer edits, identical replacement drafts, cancellation without another submission, malformed output, unavailable authentication, manual Apply and direct-save conflicts. Two independent review rounds identified and then cleared the quota-expiry and original-revision findings. A known quota block survives stale observations and elapsed resets until fresh lower readings verify that it has cleared.

Only `turzx-studio.service` was restarted. The existing dashboard stayed connected at revision `959c5251f2e984a1080542e20d2a8d8107110d9f1711fbd2470f3f44a30d9af4`. The saved layout, library, all 49 archive paths and their contents stayed unchanged. Evidence is in `artifacts/ask-ai-real-proposal.json`, `artifacts/ask-ai-activation.json`, `artifacts/ask-ai-browser-rerun.log`, `artifacts/ask-ai-runtime-tests.log` and `artifacts/ask-ai-runtime-rerun.log`.

## Widget sizing and snapping, 7 October 2026

Added Same width, Same height and Same size using the selected reference card. Matching preserves positions and rejects a group operation atomically if a target cannot fit. Resize handles now snap to matching dimensions, edges and 24 px gutters. Snapping starts enabled and remembers the browser preference; keyboard and numeric adjustments remain precise.

`pnpm build` and all 266 domain tests passed. The full browser run passed 76 of 77 tests. The cancellation test still assumed snapping was disabled, so its setup was corrected to turn snapping off explicitly; that focused rerun passed. All four new browser checks passed, covering size matching, boundary errors, resize snapping at different zoom levels, undo/redo and stationary gestures. Independent review found no remaining actionable P1/P2 findings. `git diff --check` passed.

The Studio service serves the updated production assets without a restart. The saved dashboard and library checksums remain unchanged, and the panel is connected with matching requested and applied revisions and no error. No Python runtime or hardware changes were needed.

T3 accepted the initial preview-open request but reported `visible: false`; snapshot and navigation commands timed out. The local website responds at `http://127.0.0.1:5174`. Embedded preview visibility could not be verified. Test evidence is in `artifacts/size-snap-browser-tests.log`, `artifacts/size-snap-browser-rerun.log`, `artifacts/size-matching-tools.png` and `artifacts/size-snap-review-r1.md`.

## Five editor milestones, 7 October 2026

The [five milestones](studio-milestones.md) are implemented. Final checks used the production build and isolated fixture storage for saves, recovery, custom widgets and archive operations.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed, including both TypeScript checks. |
| `pnpm test --testTimeout=15000` | 246 tests passed. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | 73 browser tests passed. |
| `PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -q` | 274 tests ran, with 273 passing and one font-related skip. |
| `git diff --check` | Passed. |

Checks cover recovery ownership, complete undo/redo, delayed saves, library conflicts, custom-widget revisions and imports, clock design parity, group gestures and cancellation, integer snapping, layers, live-preview freshness and mode changes, bounded histories and quota scanning. Final independent reviews found no remaining P1/P2 issue. Claude hit its rate limit during the third milestone; Codex completed the remaining work and reviews under the documented fallback.

The local Studio and dashboard services were restarted after the checks passed. The panel acknowledged the existing saved revision `959c5251f2e984a1080542e20d2a8d8107110d9f1711fbd2470f3f44a30d9af4`, with a positive `66c8` reply and no runtime error. Layout and library checksums and all 49 existing archive files stayed unchanged. No generated draft was applied.

The centered clock draft validates without overlaps and renders with both deterministic sample data and current live readings. Evidence is in `artifacts/m3-clock-centered.png` and `artifacts/m5-clock-centered-live.png`. Native T3 browser snapshots timed out, so these images came from the CLI and API. Browser regression checks used their owned fixture server, and the user's draft tab was preserved.

Read [resource checks](studio-milestones.md#resource-checks) for the separate runtime and preview measurements. Refresh `http://127.0.0.1:5174` to load the updated editor.

The final comparison used freshly started old and updated adapters with the same saved layout. Over 60 seconds, CPU changed from 4.68% to 4.10% and peak RSS from 72.26 to 71.96 MiB, passing both overhead limits. The first comparison against the long-running process failed the memory limit and remains documented. The temporary baseline override was removed, and final readback verifies that the updated adapter is running with fresh live data and the original saved revision.

## Earlier verification

Checked on 6 October 2026 in the local installation. The first editor and API verification ran on 4 October; the checks below passed again before panel activation on 6 October.

## Editor and runtime checks

| Check | Result |
| --- | --- |
| `pnpm build` | Passed, including app and browser-independent domain type checks. |
| `pnpm test` | 90 tests passed. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | 10 tests passed. |
| `PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -v` | 69 tests passed, using temporary files and fake uploads. |
| `git diff --check` | Passed. |

Browser checks cover actual pointer dragging and resizing, integer keyboard nudges at different scales, offline export and reopening, invalid imports, save conflicts, edits during a save, missing acknowledgements, delayed status responses, edits before the initial saved layout loads, and prevention of a save while opening the saved layout.

The independent final review on 4 October found no code blocker to activation. Its two remaining UI findings were addressed and the browser checks rerun.

The connected editor at `http://127.0.0.1:5174` loaded a 1280 by 800 PIL preview. Changing the CPU card's X coordinate from 64 to 74 and clicking Save to panel persisted the layout through the real local API. The editor cleared its unsaved indication, and readback returned the saved coordinate and revision.

The servers were stopped at the user's request on 4 October. The connected editor was restarted for activation on 6 October and is available at `http://127.0.0.1:5174`. Start it later with `pnpm studio`, or use `pnpm dev` for the offline editor.

## Panel activation

Activated on 6 October at 18:45 CEST with `pnpm panel:install`. The earlier Wine USB handle was gone before activation, so no Wine process needed stopping. The installer backed up the original service configuration and saved layout to `~/.local/share/turzx-studio/backups/20261006T164524918419Z/` and installed the separate `turzx-studio.conf` override. The original dashboard and driver source files were not changed.

The service ran through `runtime/launch_dashboard.py` with one USB owner and zero automatic service restarts during verification. The journal showed `SEND: (800, 1280)` with `LANDSCAPE` orientation. `/api/status` reported a running, connected runtime without an error, and matching requested, applied, and captured revisions.

The focused activation review found no blocker. The installer's `is-active` check confirms process startup only; the status, upload acknowledgements, ownership scan and journal checks above confirmed the adapter was actually working. No reconnect loop or transport error appeared during the observation window.

In the real connected browser, the CPU card moved from X=74 to X=75 and was saved to the panel. Its new revision was acknowledged. A second browser save restored X=74 and the original revision. Both saves showed `Panel accepted frame` with no unsaved changes. The panel returned 512-byte replies beginning `66c8`; byte 1 was the driver's positive `0xc8` acknowledgement. The captured frame was 1280 by 800 before the unchanged driver rotation. This confirms transport acceptance; physical display appearance still needs direct observation.

Local evidence is in the ignored `artifacts/` directory: `panel-save-75-20261006.json`, `panel-restored-20261006.json`, `panel-acknowledged-20261006.png`, and `activation-state-20261006.json`. Use `pnpm panel:rollback` to restore the original service entry point while retaining saved layouts and backups.

## Resource measurement

A fresh 60-second sample of the original service before activation averaged 12.13% CPU and peaked at 81.43 MiB RSS. After activation and startup settled, a 60-second adapter sample averaged 5.90% CPU and peaked at 69.98 MiB RSS. The measured changes were -6.23 CPU percentage points and -11.45 MiB RSS. This passed the limits of at most two additional CPU percentage points and 25 MiB additional RSS.

The results are in `artifacts/runtime-before-20261006.json` and `artifacts/runtime-after-20261006.json`. Short samples vary with collector activity and system load; this comparison confirms the overhead limit for these windows, rather than a sustained speedup. The 4 October baseline was 4.27% CPU and 80.34 MiB RSS.

Repeat the adapter sample against the activation baseline:

```bash
~/Documents/dashboard/.venv/bin/python runtime/measure_runtime.py --seconds 60 --baseline artifacts/runtime-before-20261006.json --output artifacts/runtime-after-repeat.json
```

See [panel setup and rollback](panel-integration.md) for activation and recovery commands.


## Widget expansion and archives

Checked again on 6 October after adding clocks, text cards, gauges, disk and network templates, CPU/GPU temperature sources, and editable content.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed, including app and browser-independent domain typechecks. |
| `pnpm test` | 100 tests passed, including TypeScript/Python catalog and gauge parity. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | 14 tests passed after resolving the final review finding. |
| `PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests` | 91 tests passed. |
| `git diff --check` | Passed. |

New browser checks cover adding, editing, duplicating, removing and undoing widgets, export/reopen, gauge bounds, clock format/date, dirty-draft protection, palette preservation and blank/preset layouts. Preset creation makes no automatic save request. The previous renderer and the expanded renderer produce identical RGB bytes for existing metric/weather layouts with both sample and supplied live readings.

All designed presets validate without overlaps. Offline PIL previews show the compact clock, arc gauges, wrapped text and weather cards. A connected browser test on a separate server and state directory saved System overview, verified the prior layout archive, then restored it through the CLI. Restore archived the replacement too. No preset was applied to the real panel.

Archive checks cover exact previous bytes, failed-save preservation, stale revisions, unchanged saves, concurrent servers, archive checksums, invalid archive paths and the one-time original-dashboard snapshot. The real original source and service configuration are saved under `~/.local/share/turzx-studio/older-config/original-dashboard/`. The current Studio layout was also archived before this work began.

The editor and adapter were refreshed at 19:12 CEST. The real saved layout SHA256 stayed `3388537b324f3377d34a8cf22bf1af70ed314b59ef9ee5862fa4845a7ca71dab`. The updated runtime advertises all five widget types, acknowledges that exact revision, has one USB handle, and reports no error. The journal retains landscape orientation with an 800 by 1280 wire frame. The service is active with zero automatic restarts. Local evidence is in `artifacts/widget-before-refresh-20261006.json` and `artifacts/widget-after-refresh-20261006.json`.

A fresh 60-second sample after the refresh averaged 6.02% CPU and peaked at 69.84 MiB RSS, passing the existing overhead limits against the original service baseline. This uses the unchanged current layout. Results are in `artifacts/widget-runtime-after-20261006.json`. Renderer-only offline samples for the new presets averaged 10.77 ms CPU per frame for System overview and 6.22 ms for Focus; these are not total runtime measurements of those presets.

Claude’s final independent review confirmed the archive, restore, contract and rendering behavior. Its one medium finding was resolved: the editor now displays the runtime-update message for a capability block instead of a stale-revision message. The rebuilt editor and all 14 browser tests passed, including the new blocked-save regression and existing revision-conflict tests.


## Browsable widget variants

The shared local catalog now contains 34 templates in seven categories, including multiple versions of the same content. The editor and agent CLI use this single catalog. `pnpm layout catalog --search <term> --group <group>` narrows the available templates offline. The full Python suite passed 92 tests after this addition, including expansion of every template, combined catalog search and category selection, and archive/restore checks. Twelve representative variants were also rendered offline and compact clocks, temperature gauges and compact notes were inspected for clipping. The unchanged runtime needs no new collectors or transport changes for these variants.

Final library verification passed 104 domain tests, the production build and all 20 Chromium browser tests. Checks cover all choices, category/search combinations, empty results, keyboard focus, scrolling at 1024 and 390 pixels, offline variant export/reopen and prevention of automatic panel saves. Codex reviewed Claude’s component and styles with no blocking findings. Desktop/mobile native T3 preview checks and the connected editor on port5174 show the completed library. The final panel status still acknowledges the unchanged saved layout, recorded in `artifacts/widget-library-final-status-20261006.json`. Temporary verification servers were stopped; the main editor and panel runtime remain running.


## Distinct designs, storage and AI usage

Verified and redeployed on 6 October 2026. Studio and the adapter were restarted at 21:55 CEST and refreshed again after a final storage-footer formatting fix.

| Check | Result |
| --- | --- |
| `pnpm build` | Passed app and browser-independent domain typechecks and production build. |
| `pnpm test` | 108 tests passed. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | All 23 tests passed. |
| `PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -q` | All 145 tests passed. |
| `git diff --check` | Passed. |

The shared catalog has 95 templates in nine categories and five dashboard presets. Six CPU instruments render distinct PIL hashes at identical geometry/readings. The original omitted-style arc and existing sample dashboard retain their exact RGB hashes. Changing gauge styles preserves sources, readings, ranges, IDs and geometry. Library scrolling, keyboard focus, export/reopen and explicit panel saves passed browser checks.

The AI usage preset validates with 12 widgets and no overlaps. It includes Codex weekly, Claude five-hour and Claude weekly limits, daily UTC tokens, API costs, reset countdowns and per-model token/cost rows. Editor demos are explicit. Missing live readings remain unavailable; cached observations show timestamps and stale labels. API estimates are not subscription bills. Storage gauges report root filesystem used percentage and used/free/total capacity. Offline and observed-data PIL previews were inspected for text clipping. The read-only collector uses cached T3 data and local Codex quota observations; it does not request provider credentials or query provider accounts.

An independent Codex review found three P2 display issues. All were fixed and tested: secondary weekly reset selection, pricing/cache freshness, and raw token gauge units. No P0/P1 issue was found. Claude was unavailable due to its own quota, so Codex followed the authorized fallback and read the required local frontend-design skill.

Studio was restarted at http://127.0.0.1:5174 with the current production build. The runtime was restarted through `systemctl --user restart turzx-dashboard.service` and advertises all five widget types, six styles and 12 usage sources. GET `/api/usage`, the 95-entry catalog and all five presets succeed. Native T3 preview inspection confirms the updated AI preset and storage category. The saved layout SHA256 remains `3388537b324f3377d34a8cf22bf1af70ed314b59ef9ee5862fa4845a7ca71dab`; no new preset was saved to the panel. Prior layout and original-dashboard archives remain intact. Temporary verification servers were stopped, and the user's separate draft tab was preserved.

Panel acknowledgement after restart is pending. Genshin Impact's Wine/Proton device process, PID 2621996, opened `/dev/bus/usb/001/004` at 21:30. The runtime's existing exclusive-ownership guard prevents opening it concurrently. The user explicitly chose to leave the game running and reconnect later. The service remains active with zero automatic restarts and retries the connection; no Wine or game process was stopped. Therefore no connected-runtime resource sample or positive USB acknowledgement is claimed for this deployment. Evidence is in `artifacts/usage-before-refresh-20261006.json` and `artifacts/usage-after-refresh-20261006.json`.

The earlier unchanged-layout idle runtime sample remains 6.02% CPU and 69.84 MiB RSS. The 12-card AI preset averaged 11.26 ms CPU per render over 100 warm offline renders. New gauge drawings and this preset were measured offline only; see `artifacts/ai-usage-render-measure-20261006.json`. These renderer timings do not replace a connected-runtime resource check.

After the game releases USB, check `/api/status` for `connected: true`, no error, matching requested/applied/frame revisions and a positive `66c8` response. Then repeat the 60-second resource sample against `artifacts/widget-runtime-after-20261006.json`:

```bash
~/Documents/dashboard/.venv/bin/python runtime/measure_runtime.py --seconds 60 --baseline artifacts/widget-runtime-after-20261006.json --output artifacts/usage-runtime-after-20261006.json
```


## Wine/Proton USB coexistence

Fixed and restarted the runtime on 6 October 2026 at 22:18 CEST while Genshin Impact stayed running. No Wine, Proton or game process was stopped. The earlier post-redeployment USB block is resolved.

The old descriptor scan rejected Wine's USB discovery handle. A Linux GETDRIVER query reported ENODATA for interface 0 while that handle was open, proving the interface was unclaimed at the observation. The updated guard passed that same case. Admission now queries interface ownership and then acquires an atomic PyUSB claim before screen initialization. The same claimed device reaches the existing transport. The adapter uses the active configuration, checks it again after acquisition, and avoids configuration changes, resets and driver detachment. It disposes claims on reconnect, normal shutdown and partial initialization failures. Adapter installation failure stops hardware startup; rendering fallback remains available inside the safe adapter.

All 158 runtime tests passed, including 13 new ownership/acquisition/cleanup/startup checks. Whitespace checks passed. The independent planning and final code reviews found no remaining P0/P1/P2 issue. No frontend files changed, so the earlier successful build, domain and browser checks remain applicable.

Live verification returned connected=true, no error, matching requested/applied/frame revisions, and a 512-byte positive response beginning 66c8. Wine and the dashboard both have discovery/device descriptors, but only the dashboard holds the transfer interface. A separate PyUSB claim attempt was refused with errno 16, Resource busy; its own handle was disposed without sending commands. The ownership query also refused the live claimed interface as usbfs. The journal retains LANDSCAPE and an 800 by 1280 wire frame. The service is active with zero automatic restarts. Before this successful start, systemd ended the old blocked process after its stop timeout; that process had no screen handle and was sleeping in reconnect backoff.

The saved layout SHA256 remains 3388537b324f3377d34a8cf22bf1af70ed314b59ef9ee5862fa4845a7ca71dab. No layout save was made. Original live dashboard and driver source files were not edited. The new module is runtime/turzx_studio/usb_ownership.py; integration and launcher changes remain within Studio.

Evidence: artifacts/usb-claim-before-20261006.json, artifacts/usb-claim-after-20261006.json, artifacts/usb-claim-design-review-20261006.md and artifacts/usb-claim-code-review-20261006.md. The connected resource sample is artifacts/usb-claim-runtime-after-20261006.json. It was recorded with the game running; those conditions differ from the earlier idle baseline.

The 60-second connected sample passed the existing overhead thresholds: 3.88% CPU and 70.76 MiB peak RSS. Changes against the earlier sample were -2.13 CPU percentage points and +0.93 MiB. Game/GPU load differs, so this confirms the thresholds for the measured window without claiming an idle performance improvement.

## Saved layouts and shortcuts, 6 October 2026

Implemented and deployed the ordered saved-layout library, editor management dialog, guarded switch API and CLI, and four Hyprland desktop shortcuts. The installed assignments are Ctrl+F9 for the user's edited AI usage dashboard, Ctrl+F10 for System overview, Ctrl+F11 for Focus and Ctrl+F12 for Gauge designs. The first slot retains the existing document, including its clock-position edit. Initialization did not change the panel. Updating or removing saved entries now archives their older documents; archive failure preserves the list. Identical document copies are rejected. Switching keeps committed and uncommitted editor input intact.

Production build and typechecks passed. All 108 domain checks passed with `pnpm test --testTimeout 15000`; the initial five-second timeout was too short for the existing catalog test's repeated Python subprocesses under concurrent load. The full browser suite passed 28 checks, followed by six focused shortcut checks after adding delayed, uncommitted inspector-input coverage. Together these cover 29 distinct browser cases. The final Python discovery passed all 189 checks in 4.334 seconds. Two independent Codex review rounds ran under the authorized Claude quota fallback; all three first-round findings were fixed, and the second round found no remaining P0/P1/P2 blocker.

The first installer invocation revealed that `hyprctl keyword` is unsupported by this Lua configuration and can report failure with exit status zero. The installer now uses `hyprctl eval`, checks its response, recognizes its own managed Lua bindings, and confirms exactly one live binding per shortcut. Five installer checks passed, and reinstallation succeeded. The new `turzx-studio.service` is enabled and running as PID 2861450 with zero restarts. Existing configuration backups are under `backups/shortcuts-20261006T204337598864Z/` and `backups/shortcuts-20261006T204448524913Z/`.

Live verification ran the same guarded CLI commands used by the shortcuts for slots 1, 2, 3, 4 and back to 1. Every slot received matching requested, applied and frame revisions with no runtime error. Each changed selection archived its predecessor. The final saved file matches its exact pre-verification bytes, revision `4f8107d4dca04363a6a3f9413bc9feec1fa96883b5ffc918d9d2ea49df83c220`. Dashboard PID 2774099 stayed running and connected throughout; Genshin PID 2622225 stayed alive. The always-on renderer and USB ownership code were unchanged for this feature.

Browser DOM inspection confirmed all four named entries and shortcut badges, with no horizontal overflow at 1280 pixels. Native T3 screenshot snapshots failed on the preview client; no screenshot claim is made. The user draft tab was preserved. The main preview shows Saved layouts; the isolated verification tab and server were closed.

Evidence: `artifacts/layout-shortcuts-live-verification.json`, `artifacts/layout-shortcuts-installed.json`, `artifacts/layout-shortcuts-final-state.json`, and the two `layout-shortcuts-review-20261006` review artifacts. Full Python output is `/tmp/turzx-layout-shortcuts-final-tests.log`.

## Mounted storage widget, 6 October 2026

Added three Storage templates: standard and wide usage bars, plus a capacity table. Each uses the new v1 `storage` widget with `sample` or `mounted-storage` source. Saved files contain label, style and source, never observed drive values. SVG and PIL share deterministic sample data and geometry; small cards count hidden rows. Previous Disk/root-storage sources are retained.

The cached collector discovers local device filesystems and ZFS datasets from mountinfo. It includes NTFS `fuseblk`, groups root/home Btrfs capacity, and excludes pseudo, application-overlay, temporary/AppImage and network mounts. It verifies mount IDs, parent relationships and visible ancestors after probing, so disappeared/replaced/overmounted filesystems cannot be reported with parent-drive capacity. Individual failures remain unknown while other rows retain readings. A local drive beneath a network/autofs/non-device FUSE ancestor is also marked unknown without probing its path. Reads are bounded to two 1 MiB tables, 4,096 records and 128 unique probes per refresh; kernel probes on faulty local devices can still block.

Checks passed: 111 domain tests, 224 Python tests, production build, compile checks and diff whitespace checks. All 30 unique browser checks passed: 27 in the full run and the three initially failing checks after correcting the search role and ordering new catalog variants by displayed size. Browser coverage includes adding, changing style, exporting/reopening and no automatic panel save. CLI generation, panel validation and PNG preview passed for both new designs.

Live collection returns `/` (alias `/home`), `/boot`, `/mnt/games`, `/mnt/hdd` and `/mnt/nvme`, with no errors. A post-fix direct collection took 2.03 ms. New-widget API previews return PNGs. Studio and dashboard services were restarted with the new code. Runtime advertises the `storage` widget type and retains positive frame acceptance for the existing System overview layout. Its saved bytes and the four-layout library bytes match their pre-deployment hashes. No new layout was applied, no game was stopped, and original dashboard/driver files were not edited.

Evidence: `artifacts/mounted-storage-before-deploy.json`, `mounted-storage-deployed.json`, `mounted-storage-live-data.json`, `mounted-storage-collection-cost.json`, and sample/live/API PNGs. Full Python log: `/tmp/turzx-mounted-storage-final-python.log`; browser logs: `/tmp/turzx-mounted-storage-browser.log` and `/tmp/turzx-mounted-storage-browser-recheck.log`.

Independent review findings were resolved: parent overmount visibility, unsafe network/FUSE ancestors, and omitted plain-FUSE/cluster-network types. Additional rendering coverage verifies mount paths and labels containing escaped control characters. All delegated tasks are terminal. An alternate safe alias is not selected when the canonical mount path is beneath a remote ancestor; that row remains unknown without probing it. Native preview snapshot/click calls failed on the local T3 client; native navigation and evaluation verified the updated catalog.
