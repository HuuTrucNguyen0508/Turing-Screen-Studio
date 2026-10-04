# Verification

Checked on 4 October 2026 in the local installation.

## Editor and runtime checks

| Check | Result |
| --- | --- |
| `pnpm build` | Passed, including app and browser-independent domain type checks. |
| `pnpm test` | 90 tests passed. |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e` | 10 tests passed. |
| `PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -v` | 69 tests passed, using temporary files and fake uploads. |
| `git diff --check` | Passed. |

Browser checks cover actual pointer dragging and resizing, integer keyboard nudges at different scales, offline export and reopening, invalid imports, save conflicts, edits during a save, missing acknowledgements, delayed status responses, edits before the initial saved layout loads, and prevention of a save while opening the saved layout.

The independent final review found no code blocker to activation. Its two remaining UI findings were addressed and the browser checks rerun. First activation must still confirm upload response bytes and watch for reconnect loops after swallowed transport errors.

The connected editor at `http://127.0.0.1:5174` loaded a 1280 by 800 PIL preview. Changing the CPU card's X coordinate from 64 to 74 and clicking Save to panel persisted the layout through the real local API. The editor cleared its unsaved indication, and readback returned the saved coordinate and revision.

The Studio development and connected-editor servers were stopped at the user's request after verification. Restart the connected editor with `pnpm studio`, or the offline development editor with `pnpm dev`.

## Panel activation

Activation is deferred at the user's request. The original `turzx-dashboard.service` remains active, and the Studio override has not been installed. A preflight found both the dashboard and Wine's `winedevice.exe` holding the panel USB device. The adapter refuses to open USB while another process holds it. No Wine process was stopped.

After the competing handle is released, run `pnpm panel:install`, confirm `/api/status` acknowledges the saved revision, and exercise a save from the connected editor. The driver must keep its 270-degree rotation to an 800 by 1280 wire frame. A captured frame confirms what was acknowledged by transport; it does not photograph the display.

## Resource measurement

A fresh 60-second sample of the original service averaged 4.27% CPU and peaked at 80.34 MiB RSS. The earlier sample was 3.37% CPU and 80.34 MiB RSS. These short samples vary with collector activity and system load.

The adapter comparison has not run. Acceptance allows at most two additional CPU percentage points and 25 MiB additional RSS against the fresh baseline. Run after activation and startup settles:

```bash
~/Documents/dashboard/.venv/bin/python runtime/measure_runtime.py --seconds 60 --baseline artifacts/runtime-before.json --output artifacts/runtime-after.json
```

See [panel setup and rollback](panel-integration.md) for activation and recovery commands.
