# Save a layout to the panel

The local Studio server renders previews and saves layouts. The existing `turzx-dashboard.service` reads the saved file and sends frames. Closing the editor or stopping the Studio server leaves the dashboard running.

## Start

This integration uses the existing installation at `~/Documents/dashboard`, its Python environment with Pillow, and the driver at `~/Documents/turing-smart-screen-python`. It does not modify their source files.

```bash
pnpm install --frozen-lockfile
pnpm studio
```

Open `http://127.0.0.1:5174`. The server binds only to loopback and serves the production build. It seeds a saved layout once, with live CPU, GPU, memory and weather sources and desktop colours. Existing saved files are preserved.

In another terminal, install the adapter into the existing service:

```bash
pnpm panel:install
```

This adds `~/.config/systemd/user/turzx-dashboard.service.d/turzx-studio.conf` and restarts that service. It preserves the original unit and other overrides. The installer records the previous configuration and saved layout under `~/.local/share/turzx-studio/backups/`.

Select a card, drag or resize it, then click **Save to panel**. Saving writes `~/.local/share/turzx-studio/layout.json` atomically. **Waiting for panel** means the document is saved but the runtime has not acknowledged its revision. **Panel accepted frame** requires a positive USB upload response for that exact revision. GPU throttling, reconnect backoff, or an active speedtest can delay it.

The canvas uses deterministic sample data through the same PIL renderer as the panel. Choose each card's live source in the inspector. CPU, GPU and memory charts use collected history on the panel. Missing readings appear as dashes; the current collector does not provide weather highs and lows. Imported layouts without sources retain sample values. **Follow desktop colours** uses the eight Caelestia roles in the layout contract; an invalid scheme keeps the last good palette and reports the error.

**View panel frame** shows a captured, acknowledged 1280 × 800 frame before the driver rotation. Captures update on a newly applied layout and at most once every ten seconds otherwise. It is not a video stream or a photograph of the display.

Concurrent saves use revision checks. A stale save leaves both the current saved file and your draft intact. Repeated retries keep the original revision until you confirm opening the saved layout. If you edit before the initial saved layout loads, opening it also requires confirmation. A successful save clears only the saved snapshot's unsaved state; edits made while saving remain unsaved.

## Runtime and rollback

The adapter preserves the existing polling, dirty skip, brightness, speedtest overlay, GPU slowdown, reconnect backoff, and 270° driver rotation to an 800 × 1280 wire frame. It keeps the service name used by the H.264 ownership checks. A process lock and a USB file-descriptor owner check prevent a second uploader. Renderer failures fall back to the original dashboard and report an error. An unrecognized nonempty upload reply keeps the connection open but cannot acknowledge a layout. Missing replies and transport exceptions use the existing reconnect path. Status records a bounded response hex string for diagnosis.

```bash
systemctl --user status turzx-dashboard.service
journalctl --user -u turzx-dashboard.service -n 60 --no-pager
pnpm panel:rollback
```

Rollback removes only the Studio override, reloads systemd, and restarts the original dashboard. It keeps saved layouts and backups. Preview routes and offline browser tests never open USB or stop services.

Runtime status and captures are stored in `$XDG_RUNTIME_DIR/turzx-studio/`, separate from the persistent document. The editor server is on demand; no second always-on service is installed. Host and Origin checks restrict browser requests to the same loopback origin. The API accepts fixed paths only and limits JSON to 1 MB. Panel saves require exactly 1280 × 800; offline documents can use other supported canvas dimensions.

## Verification

```bash
pnpm test
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e
PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -v
```

Python checks cover contract validation, rendering, last-good file watching, atomic saves, stale revisions, origin restrictions, runtime identity, and positive versus failed USB acknowledgements using fakes. Browser checks cover drag, save, delayed acknowledgement, and edits during an in-flight save. See [verification results](verification.md) for completed checks, resource measurements, and panel activation status.
