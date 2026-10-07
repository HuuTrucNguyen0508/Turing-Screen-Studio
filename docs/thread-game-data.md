# Threads and shared game timers

The `t3-threads` card counts working threads in the local T3 instance. Waiting threads appear in the list but do not increase that count. The card shows up to five sanitized titles and provider names. A verified idle server shows zero. Missing, stale, incomplete or unsupported local evidence shows unavailable.

The collector reads execution metadata from T3's local SQLite projection and server runtime marker. It checks process identity, the current version-2 thread event cursor and matching provider turns. Event times are not heartbeats, so a silent tool call keeps its verified working state. Active evidence from before the current server start stays unknown; a complete idle projection can still show zero. It does not read messages, prompts, event payloads, tokens or credentials. Reads are bounded and cached for five seconds. This is durable local execution evidence, not an independent health check of every provider process.

The `game-resources` card estimates regeneration from a count you enter in **Game timers**. Enter the count currently shown in each game. Saving starts its timer from that count and the server's current time. Update it after spending or refilling. Clear removes that game's anchor. Unset and unreadable timers show unavailable rather than sample values in Live preview.

| Game | Resource | Normal cap | One point every |
| --- | --- | --- | --- |
| Genshin Impact | Original Resin | 200 | 8 minutes |
| Wuthering Waves | Waveplates | 240 | 6 minutes |
| Zenless Zone Zero | Battery Charge | 240 | 6 minutes |

These are estimates. They do not include reserve resources, spending, purchases or account synchronization. The first regeneration point is assumed to arrive one full interval after saving. A count above the normal cap stays unchanged and displays Above cap.

The Genshin cap comes from [HoYoverse's version 4.7 announcement](https://www.hoyoverse.com/en-us/news/124031), and the ZZZ cap from [HoYoLAB's version 1.2 notice](https://www.hoyolab.com/article/33610162). Rates and the WuWa cap were checked against [Genshin game-screen timers](https://img.game8.jp/6283764/dd12de3a4009bffe680db11931f5e19b.png/original), [WuWa game-screen timers](https://resource.supercheats.com/library/supercheats/740w/2024/1720986268wuwawaveplates1.webp) and [reproduced ZZZ item text](https://zzz.honeyhunterworld.com/501-item/?lang=EN). The regeneration evidence is hosted by third parties. Current publisher-hosted rate documentation was not found.

Anchors are shared in `~/.local/share/turzx-studio/game-timers.json`, outside every layout and library entry. Switching or restoring a dashboard keeps the same timers. The connected editor and runtime read this file through `GameResources`. The offline editor shows deterministic samples and cannot save anchors.

`GET /api/games` returns fixed-order game rows and an anchor revision. `POST /api/games` accepts exactly `{game, count}` or `{game, clear: true}` and requires that revision in `If-Match`. Counts are integers from 0 to 10000. Conflicts return 409, and a missing precondition returns 428. Estimates advancing with time do not change the anchor revision. Writes are locked and atomic, with private file permissions. Invalid existing state is preserved instead of overwritten. If the system clock moves back, an anchor ahead of the clock makes only its game unavailable. Set a new count or clear that row to recover it. Other games keep working.

`GET /api/activity` returns `{working, threads, observedAt, status, note}` without writing state. Live display settings are transient. Neither endpoint applies a dashboard, changes the saved layout, or opens USB.

The clean drafts use the same integer geometry and 24-pixel gutters as the designed presets. Their new cards sit at x64, y392, width270, height344. The AI quota card uses the remaining width. System overview keeps its weather card and places storage to its right. The renderer remains PIL, and editor SVGs use the same display mapping and geometry.
