# Verification

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
