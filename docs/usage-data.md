# Local usage and storage data

`runtime/turzx_studio/usage.py` provides a read-only collector. It needs only Python's standard library. Reuse one `UsageCollector` instance in the runtime and call `snapshot()` when preparing live data. Each call returns a detached JSON-safe dictionary. It creates no worker, starts no process, and makes no network request.

```python
from turzx_studio.usage import UsageCollector

collector = UsageCollector()
snapshot = collector.snapshot()
codex = snapshot["providers"]["codex"]
claude = snapshot["providers"]["claude"]
storage = snapshot["storage"]
```

`home=Path(...)` overrides the user's home for fixtures. `clock=...` must return Unix seconds. A lock serializes concurrent calls. Collection refreshes at most once per 60 seconds, except when the UTC day changes or the clock moves backwards. Staleness and elapsed resets are reevaluated even during that cache interval.

## Sources and scope

- `~/.t3/userdata/usage-scan-cache-v5.json` supplies token records, model names and optional reported cost. Only version 5 is accepted. Both complete records in `r` and separate tail records in `t` contribute.
- `~/.t3/userdata/usage-model-rates.json` supplies cached LiteLLM rates and `fetchedAtMs`. The collector never downloads rates.
- `~/.codex-pro/sessions/**/*.jsonl` supplies subscription quotas from timestamped `event_msg` / `token_count` events containing `payload.rate_limits`. Quota scanning uses this Pro home only. It never publishes a session limit; primary and optional secondary windows must last at least 10,080 minutes.
- `~/.t3/userdata/statev2.sqlite` supplies Claude exhaustion notices from `orchestration_v2_projection_turn_items`, with `type='system_notice'`. SQLite opens with `mode=ro` and connection-local `query_only`. Connections close after each refresh.
- `shutil.disk_usage('/')` supplies root storage; bounded `/proc/self/mountinfo` reads plus `shutil.disk_usage(mount)` supply `mountedStorage`. The collector does not walk directories to estimate storage.

Token totals describe the current UTC calendar day in the saved T3 cache. They include all locally cached sources assigned to each provider, including `~/.codex`, `~/.codex-pro` and `~/.claude`. They include other projects and agents. They are processed tokens across requests, not current context size. They do not measure subscription allowance. The default token cache can lag active sessions until T3 persists another scan.

Quota scope differs from token scope. Codex quotas refer to the Pro account. The inspected local T3 provider-session and runtime rows exposed no structured Claude quota windows. The collector therefore supports only the exact cached Claude five-hour exhaustion notice available here. It cannot supply Claude weekly usage or intermediate five-hour percentages. Missing limits are an empty list with unavailable freshness and an error code, never a fabricated zero-percent bar.

## Verified tuple mapping

The mapping was verified directly in the installed T3 bundle, not inferred from sample numbers. The inspected app is `0.0.46-nightly.20261005.2702`. Its bundle is `/tmp/.mount_T3-Cod7oEOXH/resources/app.asar`, member `apps/server/dist/binCli-zI1ELhjp.mjs`. SHA-256 of that member is `19d989b8ab4a3984a4b83d61dead767d29a784b2994fc53a46521aacb443ce6e`. The mount path is temporary; the collector does not depend on it.

The bundle contains the original module markers `src/usage/usageScanCache.ts`, `src/usage/usageAggregation.ts`, `src/usage/usagePricing.ts` and `src/usage/UsageService.ts`. `serializeFile` and `decodeScanCache` establish this eleven-field order:

```text
0 timestampMs
1 models[] index
2 sessions[] index
3 uncachedInputTokens
4 cachedInputTokens
5 cacheCreationTokens
6 outputTokens
7 reasoningTokens
8 dedupeKey or null
9 reportedCostUsd or null
10 speed index: standard=0, fast=1, ultrafast=2
```

`UsageService.readFileRecords` combines `r` and `t`. Claude records deduplicate globally by provider and message/request key. Codex copied rollouts deduplicate by session, timestamp, model, token fields and within-file occurrence number. This preserves separate identical occurrences in an original file while dropping matching occurrences in its copies. No session IDs or dedupe keys leave the collector.

## Mapping contract

The snapshot has `contractVersion: 1`, `readAt`, `servedAt`, `cached`, `scope`, `providers`, `storage` and `mountedStorage`. `scope` states `period: 'today'`, the ISO UTC `day`, `timeZone: 'UTC'`, `accounts: 'all_local_t3_cached_sources'` and `quotaAccount: 'codex-pro'`.

Each `providers.codex` / `providers.claude` object has these fields:

- `input` is uncached input. `cacheRead` and `cacheWrite` are separate input categories. `cache = cacheRead + cacheWrite`. `output` includes reasoning; `reasoning` is a subset for display. `total = input + cacheRead + cacheWrite + output`. Do not add cache or reasoning again.
- `records` counts contributing records. `perModel` is a list of objects with `model` and the same token, record and cost fields. `latestRecordAt` is the latest contributing usage event today. `duplicatesDropped` counts discarded copies throughout the bounded cache scan, before the day filter.
- `costUSD` is the complete cost only when every contributing record is priced. `costKind` is `reported`, `estimate` or `unavailable`. `knownCostUSD` is the sum of priced records. `reportedRecords`, `estimatedRecords` and `unpricedRecords` expose coverage. Unknown complete cost is `null`; show partial known cost only with an explicit partial-estimate label.
- `limits` is a list of `{id, label, usedPercent, remainingPercent, resetsAt, resetKind, observedAt, stale, source, windowMinutes}`. Percentages describe the last observation. Reset is nullable. Codex resets are `reported`. Claude resets are `notice_relative_estimate`.
- `freshness` has separate `tokens`, `pricing` and `limits` objects. Each has `source`, `observedAt`, `readAt`, `stale`, `status` and `errors`. Status is `cached`, `stale` or `unavailable`. `cached` means a recent local observation, never a live account probe. Provider `source` identifies the token source; provider `errors` combines component error codes.

Unavailable token totals and record counts are `null`, with `perModel: []`. A readable provider cache with no records today can legitimately report zero tokens; its cost remains unavailable when there are no priced records. A failed refresh preserves last-good totals for the same UTC day, retaining the old observation timestamp and setting stale/error status. A new day never inherits yesterday's totals.

Consumers should map the fields directly into their own contracts. For example, `storage.usedPercent` feeds a percent gauge, `storage.freeGiB` a free-space metric, `codex.total` a token metric, and `codex.limits[].usedPercent` the matching quota gauge. Display a dash for nullable values. Include the period and freshness in accessible UI details. UI, source registration, renderers and server integration are owned separately from this collector.

## Cost meaning

The estimate is API-equivalent cost calculated using T3's cached LiteLLM prices. It is not a subscription bill or measured subscription spend. Reported cost means a number present in the source record, which also does not prove an invoice amount.

Reported cost, including an explicit zero, takes priority. Otherwise the collector follows the verified T3 pricing functions. It normalizes exact model keys, removes bracketed variant suffixes, and aliases qualified names only when every qualified rate agrees. It never guesses a generation for bare `opus`, `sonnet`, `haiku` or `fable`, and does not price synthetic models. Missing input or output rates make a model unavailable. Missing cache-category rates fall back to that matched model's input rate, as T3's `readTokenRates` does. Cached fast multipliers or priority/ultrafast rates apply when provided; absent speed rates use the matched standard rate, as T3's `ratesAt` does. Reasoning is not charged again.

The collector uses the saved rate document. It does not read T3's user model aliases or pricing overrides. A manual T3 customization may therefore produce a different displayed estimate. Even zero-token unpriced synthetic records make complete cost unavailable; the coverage counts explain that case.

## Freshness and quota resets

Token freshness uses the scan-cache modification timestamp. Pricing uses `fetchedAtMs` and becomes stale after 24 hours. Limit freshness uses the actual telemetry timestamp, not the collector's read time. Token and limit observations become stale after five minutes. Future observations and source errors also mark a component stale.

Codex selects the newest observed timestamp for each weekly window across recent files; file modification time only selects candidates. Append scans resume at a complete-line boundary after checking file identity and hashes at the file head and resume boundary. Rotated, truncated or changed boundary data causes a bounded tail rescan. Incomplete final lines wait for completion. These guards assume append-only transcripts; arbitrary interior edits are outside that source contract.

Claude parsing accepts only the exact T3 sentence `Claude usage limit reached. This turn is paused until the 5-hour limit resets in ...`. The notice's `startedAt` is the observation timestamp when present, with the row's `updated_at` as fallback. This avoids treating a later notice edit as a new quota observation. The rounded duration gives an approximate reset instant. The local notice at 17:55 UTC plus 3h 25m means about 21:20 UTC, or 23:20 Europe/Paris on 6 October 2026.

Passing a reset time marks the stored limit stale. It never changes used percentage to zero, changes remaining percentage to 100, or clears an exhausted limit. Source failures retain the last observation with stale/error status. A fresher supported quota record is required to replace it. With the Claude notice-only source, healthy usage after reset remains unknown.

## Storage semantics

`storage` has `mount: '/'`, `totalGiB`, `usedGiB`, `freeGiB`, `usedPercent`, `freeKind`, `observedAt`, `stale`, `source` and `errors`. GiB means bytes divided by `1024**3`. `usedPercent` is `used / total * 100`.

On this Linux runtime, `freeGiB` is space available to an unprivileged process. Reserved filesystem blocks can make `usedGiB + freeGiB` smaller than `totalGiB`. The percentage deliberately uses the total denominator, rather than `df`'s available-space denominator. Failure returns null measurements with stale/error status.

## Bounds and privacy

Each JSON document is limited to 8 MiB. The scan cache allows at most 4,096 files, 100,000 rows, 1,024 model entries and 20,000 session entries. The rate document allows 20,000 entries. Invalid token rows or exceeded token-cache bounds make the scan unavailable rather than presenting partial totals as complete.

Codex enumeration visits at most 256 directories and 4,096 entries. It selects the 16 most recently modified candidates within that enumeration, reads at most 128 KiB of tail data per changed file and 2 MiB total per refresh, including the head and resume guards. Quota JSON lines are limited to 64 KiB. Recent-file selection is intentionally limited; it cannot guarantee discovery of every older session. Enumeration, byte and line truncation report sanitized error codes.

The Claude query selects at most 256 matching system notices, each no larger than 16 KiB, with a 250 ms query deadline and a 100 ms lock timeout. It never queries prompt, assistant or tool rows. A size bound filters oversized notices before retrieval.

The collector reads no auth file, keychain, credential or environment secret. Transcript tails can contain unrelated text in memory, but only recognized quota records are parsed. Returned objects contain aggregate numbers, model names, source codes and timestamps. They exclude paths, session IDs, message/request keys, database payloads and transcript text. Errors contain fixed codes rather than exception contents. Nothing is written by collection, including T3 caches, database rows or saved layouts.

## Verification

```bash
PYTHONPATH=runtime python -m unittest runtime.tests.test_usage -v
```

The focused suite covers the verified schema, cache accounting, cross-file deduplication, unknown and reported costs, pricing provenance, UTC scope, cache failures, quota timestamps and resets, read-only notice extraction, resource bounds, incremental scanning, root storage, detached JSON results and concurrent caching. The observed local snapshot and collection timing are recorded in `artifacts/usage-collector-20261006.md`.

## Mounted storage

`mountedStorage` contains `mounts`, `observedAt`, `stale` and sanitized `errors`. Each row contains `mount`, other mount-path `aliases`, `device`, `filesystem`, `totalGiB`, `usedGiB`, `freeGiB`, `usedPercent`, `freeKind`, `observedAt`, `stale` and `errors`. Device and mount paths are necessary display data; provider records remain aggregated. Root `storage` is unchanged.

Linux mountinfo is decoded for escaped spaces, tabs, newlines and backslashes. Local `/dev/...` filesystems (including NTFS `fuseblk`) and ZFS datasets are included. Pseudo filesystems, temporary/AppImage mounts, application overlays and network filesystems are excluded. Shared sources and filesystem types are grouped, so root and home Btrfs subvolumes share capacity and list both paths. This reports filesystem capacity rather than partition inventory or directory size.

Each refresh reads at most two 1 MiB mount tables, 4,096 records per table, and probes at most 128 unique filesystems. Additional rows carry unknown measurements. Failures affect the relevant row; other storage remains available. A second table check rejects readings from mounts that disappeared or were replaced during probing. Network mounts are excluded because a size probe can wait on a remote server. A local filesystem beneath a network, autofs or non-device FUSE parent is listed with unknown capacity and is not probed, since reaching its path can also block. Faulty local-device kernel probes may still block; work counts and bytes are bounded, not kernel latency. The existing 60-second collector cache also caches the mount list. Free space is available to this unprivileged process, with the same reserved-block semantics as root storage.

On this machine the collector returns `/` (alias `/home`), `/boot`, `/mnt/games`, `/mnt/hdd` and `/mnt/nvme`. Failed live readings never reuse the bundled editor samples.
