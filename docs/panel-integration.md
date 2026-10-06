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

Every changed save also preserves the exact previous JSON in `~/.local/share/turzx-studio/older-config/`, with a dated folder and checksum manifest. If that archive cannot be written, the save fails and the previous panel layout stays in place. `pnpm layout history` lists older layouts; open their `layout.json` in Studio or use `pnpm layout restore ARCHIVE_ID --if-match CURRENT_REVISION`. Restore preserves the current layout before replacing it.

## Saved layouts and desktop shortcuts

Saved layouts keeps up to 12 document snapshots in `~/.local/share/turzx-studio/layouts.json`. The first four use Ctrl+F9 through Ctrl+F12. Switches replace the physical panel layout through the existing revision and archive transaction. The editor draft, including text that has not been committed, stays open. Choose Open saved layout to edit the new panel dashboard. Updating or removing a library entry archives its previous document before changing the list. Reordering entries changes the shortcut assignments and leaves documents intact; identical copies are rejected.

`pnpm shortcuts:install` installs the four bindings in a managed block in Caelestia's `~/.config/caelestia/hypr-user.lua`. Previous configuration files are retained under `~/.local/share/turzx-studio/backups/shortcuts-<timestamp>/`. Live bindings use Hyprland's Lua `eval` interface, and the installer checks that each key has exactly one binding. It does not issue a compositor reload or restart the dashboard service. Hyprland may automatically reread a changed configuration file.

The installer also enables `turzx-studio.service`, the loopback HTTP API, so shortcuts work without an open editor. Stop any manually launched Studio server before installing if port 5174 is already occupied. For later Studio updates, run `pnpm build` and `systemctl --user restart turzx-studio.service`. The dashboard runtime continues independently. To disable the desktop integration, remove the managed shortcut block and run `systemctl --user disable --now turzx-studio.service`; saved layouts, older configurations and the panel runtime remain intact.

Before installing the adapter, the installer saves the original Python dashboard source, USB driver, settings and service configuration once in `older-config/original-dashboard/`. Existing snapshots are retained. The initial source snapshot was created on 6 October before widget expansion, while the original source was still unchanged. Backups under `backups/` are also retained.

New widget types and explicit gauge styles require a runtime loaded from the matching Studio code. The runtime publishes its supported types and gauge styles; a save introducing a type or explicit style unknown to an already-running runtime fails before changing or archiving the saved layout. After updating code and passing checks, restart the dashboard service to load the new renderer. An offline runtime can still receive a saved layout, but cannot acknowledge it until it starts.

## Runtime and rollback

The adapter preserves the existing polling, dirty skip, brightness, speedtest overlay, GPU slowdown, reconnect backoff, and 270° driver rotation to an 800 × 1280 wire frame. It keeps the service name used by the H.264 ownership checks. A process lock serializes Studio launchers. USB admission queries Linux interface ownership and then atomically claims interface 0 on the same PyUSB device used for transfers. An open discovery handle, including Wine/Proton device enumeration, does not block the dashboard. A real userspace claim or bound kernel driver does. Unknown ownership-query errors fail closed. The adapter uses the existing active configuration, checks it again after claiming, and does not reset, reconfigure or detach another driver. Reconnect, shutdown and partial initialization failures explicitly dispose the claim. Adapter installation failure stops hardware startup; renderer failure can still use the original drawing path inside the safe adapter. Renderer failures fall back to the original dashboard and report an error. An unrecognized nonempty upload reply keeps the connection open but cannot acknowledge a layout. Missing replies and transport exceptions use the existing reconnect path. Status records a bounded response hex string for diagnosis.

```bash
systemctl --user status turzx-dashboard.service
journalctl --user -u turzx-dashboard.service -n 60 --no-pager
pnpm panel:rollback
```

Rollback removes only the Studio override, reloads systemd, and restarts the original dashboard. It keeps saved layouts and backups. Preview routes and offline browser tests never open USB or stop services.

Runtime status and captures are stored in `$XDG_RUNTIME_DIR/turzx-studio/`, separate from the persistent document. The editor server can run on demand. Installing desktop shortcuts also enables `turzx-studio.service` so switching remains available with the editor closed. Host and Origin checks restrict browser requests to the same loopback origin. The API accepts fixed paths only and limits JSON to 1 MB. Panel saves require exactly 1280 × 800; offline documents can use other supported canvas dimensions.

## Verification

```bash
pnpm test
pnpm build
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:e2e
PYTHONPATH=runtime ~/Documents/dashboard/.venv/bin/python -m unittest discover -s runtime/tests -v
```

Python checks cover contract validation, rendering, last-good file watching, atomic saves, stale revisions, origin restrictions, runtime identity, and positive versus failed USB acknowledgements using fakes. Browser checks cover drag, save, delayed acknowledgement, and edits during an in-flight save. See [verification results](verification.md) for completed checks, resource measurements, and panel activation status.
