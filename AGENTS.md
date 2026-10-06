# Working in this repository

- Read `README.md` and `docs/first-milestone.md` before implementing.
- Build the offline editor first. Keep the saved layout contract independent of React.
- Use integer document coordinates, integer nudges, and letterbox preview scaling.
- Follow the live Caelestia scheme. Keep sample preview data deterministic.
- Keep the editor separate from the always-on runtime. Measure resource use before replacing the existing PIL renderer.
- Hardware integration must preserve the documented orientation and exclusive USB ownership.
- Keep the first milestone offline. It must not stop services, open USB, or overwrite the existing dashboard.
- Read the live runtime and diary before implementing hardware integration. Diary snapshots can drift.
- Keep prose plain and concise. Apply the unslop skill when available.

# Claude quota fallback

- If Claude hits a usage or rate limit, Codex may take over its unfinished work immediately without asking for approval or waiting for the reset. A Claude-only limit must not pause Codex or leave design or review work blocked. This exception overrides requirements for a Claude design pass, Claude review or a 70/30 provider split while Claude is unavailable.
- Codex must still check its own authoritative quota and obey its own 98% pause rule. Do not retry Claude or switch Claude accounts to evade its limit.
- Before taking over frontend work, read and follow `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md`. Preserve completed findings and establish one writer per file before continuing.

# Generating dashboards for the user

- Read `docs/ai-layouts.md`, `docs/layout-format.md`, `public/widget-catalog.json` and `public/layout.schema.json` before creating a layout.
- Start with `pnpm layout presets` and a designed preset. Use `pnpm layout catalog --search <term>` or `--group <group-id>` to find widget variants; use their stable template IDs for additional widgets. Keep positions and sizes integer, and use 24-pixel gutters where space allows.
- Keep generated drafts in `layouts/`. Run `pnpm layout validate <file> --panel` and `pnpm layout preview <file> --output artifacts/<name>.png`. Inspect the preview and correct unreadable text or unintended overlaps before presenting it.
- A request to generate or design a dashboard authorizes a draft and preview. Apply it when the user asks to use it. Read `pnpm layout current` before modifying an existing dashboard, retain its revision, and use `pnpm layout apply <file> --if-match <revision>`.
- Preserve the original dashboard and every replaced saved layout in `~/.local/share/turzx-studio/older-config/`. Never bypass the server's archive or revision checks, delete old configurations, or overwrite `layout.json` directly.
- Use `pnpm layout history` and `pnpm layout restore <archive-id> --if-match <current-revision>` to restore an older layout. Restore must preserve the current layout first.
