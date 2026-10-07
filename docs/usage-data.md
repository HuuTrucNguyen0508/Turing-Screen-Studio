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
- `~/.t3/caches/codex-pro.json` and `claudeAgent.json` supply normalized subscription windows. The reader verifies provider identity, reads only the quota fields and does not invoke an authenticated probe.
- `~/.codex-pro/sessions/**/*.jsonl` supplies subscription quotas from timestamped `event_msg` / `token_count` events containing `payload.rate_limits`. Quota scanning uses this Pro home only. Its configured account is Pro. A session row requires an explicitly reported 300-minute window; missing or old telemetry alone cannot create one.
- `~/.t3/userdata/statev2.sqlite` supplies Claude exhaustion notices from `orchestration_v2_projection_turn_items`, with `type='system_notice'`. SQLite opens with `mode=ro` and connection-local `query_only`. Connections close after each refresh.
- `shutil.disk_usage('/')` supplies root storage; bounded `/proc/self/mountinfo` reads plus `shutil.disk_usage(mount)` supply `mountedStorage`. The collector does not walk directories to estimate storage.

Token totals describe the current UTC calendar day in the saved T3 cache. They include all locally cached sources assigned to each provider, including `~/.codex`, `~/.codex-pro` and `~/.claude`. They include other projects and agents. They are processed tokens across requests, not current context size. They do not measure subscription allowance. The default token cache can lag active sessions until T3 persists another scan.

Quota scope differs from token scope. Codex quotas refer to the configured Pro account, which has no five-hour limit. That account default remains inapplicable when telemetry is missing or stale. An explicitly reported five-hour window overrides it if the account changes. Claude's structured cache can provide actual five-hour and weekly percentages. The exhaustion notice is a stale fallback with an estimated reset. Unknown Claude windows stay visible as unavailable; an explicit unsupported observation can hide one until that evidence expires. Account-wide weekly windows are distinct from monthly and model-specific windows. The quota ledger displays usage left, calculated as 100 minus the observed used percentage. Its bars shrink as allowance is consumed. Unknown and expired reset observations remain unavailable, never an assumed full allowance. Raw quota telemetry retains both used and remaining percentages.

The additive `periods.last30days` object covers the exact inclusive rolling UTC interval `[now - 2592000, now]`. Its `scope` includes `startsAt`, `endsAt`, `timeZone`, `windowKind`, `durationSeconds` and `bounds`. Its providers include Codex, Claude and Cursor. Rows are decoded, deduplicated and priced once before the daily and rolling folds. Daily top-level totals retain their existing meaning.

Provider totals carry the requested interval when available. A failed refresh retains last-good totals with their original bounds and `observedScope`, and marks them stale. The summary caption includes the oldest contributing cache observation. Missing Cursor history stays null and makes the aggregate partial. T3 fetches Cursor history live but does not persist it in the inspected v5 cache. If recorded Cursor rows become available, these cards include them; a verified empty Cursor source can omit its row. See [the local T3 research](t3-usage-research.md).

The aggregate cards show known token and API-cost subtotals with `+` when a provider or price is unavailable. The cost card is an API-equivalent estimate, not a subscription invoice. Neither card substitutes the daily total when the rolling period is absent.

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
- `limits` is a list of `{id, label, usedPercent, remainingPercent, resetsAt, resetKind, observedAt, stale, source, windowMinutes}`. Percentages describe the last observation. Reset is nullable. Structured resets are `reported`; Claude notice resets are `notice_relative_estimate`. Structured limits include `kind`, `quotaAccount` and `accountWeekly`. `quotaWindows` records `supported`, `unsupported` or `unknown` for the five-hour and weekly account windows.
- `freshness` has separate `tokens`, `pricing` and `limits` objects. Each has `source`, `observedAt`, `readAt`, `stale`, `status` and `errors`. Status is `cached`, `stale` or `unavailable`. `cached` means a recent local observation, never a live account probe. Provider `source` identifies the token source; provider `errors` combines component error codes.

Unavailable token totals and record counts are `null`, with `perModel: []`. A readable provider cache with no records today can legitimately report zero tokens; its cost remains unavailable when there are no priced records. A failed refresh preserves last-good totals for the same UTC day, retaining the old observation timestamp and setting stale/error status. A new day never inherits yesterday's totals.

Consumers should map the fields directly into their own contracts. For example, `storage.usedPercent` feeds a percent gauge, `storage.freeGiB` a free-space metric, `codex.total` a token metric, and `codex.limits[].usedPercent` the matching quota gauge. Display a dash for nullable values. Include the period and freshness in accessible UI details. UI, source registration, renderers and server integration are owned separately from this collector.

## Cost meaning

The estimate is API-equivalent cost calculated using T3's cached LiteLLM prices. It is not a subscription bill or measured subscription spend. Reported cost means a number present in the source record, which also does not prove an invoice amount.

Reported cost, including an explicit zero, takes priority. Otherwise the collector follows the verified T3 pricing functions. It normalizes exact model keys, removes bracketed variant suffixes, and aliases qualified names only when every qualified rate agrees. It never guesses a generation for bare `opus`, `sonnet`, `haiku` or `fable`, and does not price synthetic models. Missing input or output rates make a model unavailable. Missing cache-category rates fall back to that matched model's input rate, as T3's `readTokenRates` does. Cached fast multipliers or priority/ultrafast rates apply when provided; absent speed rates use the matched standard rate, as T3's `ratesAt` does. Reasoning is not charged again.

The collector uses the saved rate document. It does not read T3's user model aliases or pricing overrides. A manual T3 customization may therefore produce a different displayed estimate. Even zero-token unpriced synthetic records make complete cost unavailable; the coverage counts explain that case.

## Freshness and quota resets

Token freshness uses the scan-cache modification timestamp. Pricing uses `fetchedAtMs` and becomes stale after 24 hours. Limit freshness uses the actual telemetry timestamp, not the collector's read time. Token and limit observations become stale after five minutes. Future observations and source errors also mark a component stale.

Codex compares observation timestamps for each weekly window across the records it scans; file modification time only selects candidates. It searches changed files from the end in 128 KiB chunks. Finding a supported observation does not stop the scan. Every complete record within the permitted byte range can supply a newer timestamp, including records in earlier chunks. The collector does not assume chronological line order or claim to inspect every historical event.

Append scans resume at a complete-line boundary after checking file identity and hashes at the file head and resume boundary. Rotated, truncated or changed boundary data causes a bounded backward rescan. Incomplete final lines wait for completion. An identifiable partial quota record reports `codex_quota_incomplete_event`; partial tool output does not make a readable quota stale. Real quota errors persist across unchanged-file refreshes and appends without newer supported telemetry. A newer supported observation can clear the earlier error. These guards assume append-only transcripts; arbitrary interior edits are outside that source contract.

Claude parsing accepts only the exact T3 sentence `Claude usage limit reached. This turn is paused until the 5-hour limit resets in ...`. The notice's `startedAt` is the observation timestamp when present, with the row's `updated_at` as fallback. This avoids treating a later notice edit as a new quota observation. The rounded duration gives an approximate reset instant. The local notice at 17:55 UTC plus 3h 25m means about 21:20 UTC, or 23:20 Europe/Paris on 6 October 2026.

Passing a reset time marks the stored limit stale. It never changes used percentage to zero, changes remaining percentage to 100, or clears an exhausted limit. Source failures retain the last observation with stale/error status. A fresher supported quota record is required to replace it. With the Claude notice-only source, healthy usage after reset remains unknown.

## Storage semantics

`storage` has `mount: '/'`, `totalGiB`, `usedGiB`, `freeGiB`, `usedPercent`, `freeKind`, `observedAt`, `stale`, `source` and `errors`. GiB means bytes divided by `1024**3`. `usedPercent` is `used / total * 100`.

On this Linux runtime, `freeGiB` is space available to an unprivileged process. Reserved filesystem blocks can make `usedGiB + freeGiB` smaller than `totalGiB`. The percentage deliberately uses the total denominator, rather than `df`'s available-space denominator. Failure returns null measurements with stale/error status.

## Bounds and privacy

Each token or rate JSON document is limited to 8 MiB. Each provider quota cache is limited to 256 KiB and 32 windows, including retained windows. The scan cache allows at most 4,096 files, 100,000 rows, 1,024 model entries and 20,000 session entries. The rate document allows 20,000 entries. Invalid token rows or exceeded token-cache bounds make the scan unavailable rather than presenting partial totals as complete.

Codex enumeration visits at most 256 directories and 4,096 entries. It selects the 16 most recently modified candidates within that enumeration. Backward reads use chunks of at most 128 KiB, with at most 1 MiB per changed file and 2 MiB total per refresh. Both byte budgets include the head and resume guards. Quota JSON parsing is limited to complete lines of at most 64 KiB.

A 512-byte envelope check recognizes ordinary timestamp/type/payload headers, including the live format's optional `ordinal`. Oversized response items, session metadata, turn context and recognized non-quota message events are skipped without a quota error. Their text is never parsed as quota data. Oversized quota records or unclassified oversized rows report `codex_quota_line_bound_reached`. A search that exhausts its byte budget before finding supported telemetry reports `codex_quota_byte_bound_reached`. Exhausting the total budget before scanning another changed candidate also reports that error, even if an earlier candidate supplied telemetry. These errors keep the last good observation stale. A bounded tail containing supported telemetry does not report a byte error merely because older history remains outside the selected range. Invalid or incomplete quota records inside the scanned range still report errors. Recent-file selection is intentionally limited; it cannot guarantee discovery of every older session. Enumeration, byte and relevant line bounds report sanitized error codes.

The Claude query selects at most 256 matching system notices, each no larger than 16 KiB, with a 250 ms query deadline and a 100 ms lock timeout. It never queries prompt, assistant or tool rows. A size bound filters oversized notices before retrieval.

The collector reads no auth file, keychain, credential or environment secret. Transcript tails can contain unrelated text in memory, but only recognized quota records are parsed. Returned objects contain aggregate numbers, model names, source codes and timestamps. They exclude paths, session IDs, message/request keys, database payloads and transcript text. Errors contain fixed codes rather than exception contents. Nothing is written by collection, including T3 caches, database rows or saved layouts.

## Verification

```bash
PYTHONPATH=runtime python -m unittest runtime.tests.test_usage -v
```

The focused suite covers the verified schema, cache accounting, cross-file deduplication, unknown and reported costs, pricing provenance, UTC scope, cache failures, quota timestamps and resets, read-only notice extraction, resource bounds, incremental scanning, root storage, detached JSON results and concurrent caching. Quota regressions include fresh telemetry before huge irrelevant records, live ordinal headers, malformed and oversized quota records, persistent errors, partial writes, rotation, chunk boundaries and byte budgets including guard reads. Out-of-order timestamps separated by a 384 KiB tool row retain the newest observation on cold, cached, unchanged-file and incremental scans. Bound tests distinguish supported telemetry in a selected tail from unread candidates after total-budget exhaustion. The earlier local snapshot and collection timing are recorded in `artifacts/usage-collector-20261006.md`.

## Mounted storage

`mountedStorage` contains `mounts`, `drives`, `observedAt`, `stale` and sanitized `errors`. Mount rows contain `mount`, other mount-path `aliases`, `device`, `filesystem`, `totalGiB`, `usedGiB`, `freeGiB`, `usedPercent`, `freeKind`, `observedAt`, `stale` and `errors`. Resolved rows add `driveKind` and `driveDevice`. Device and mount paths are necessary display data; provider records remain aggregated. Root `storage` is unchanged.

Drive rows use the actual parent block device from `/sys/class/block`. Hardware capacity uses its sector count; used and available capacity sum distinct mounted filesystem readings. `partitionMounts` lists the contributing paths and aliases. `partial` marks unmounted partitions, unknown readings or incomplete enumeration. A known subtotal stays visible with `+`; completely unknown usage stays null. Unknown capacity does not hide known usage, and unknown usage does not hide known capacity. Unmounted space is never claimed as free. ZFS, device mapper, virtual/removable devices and unsupported multi-device Btrfs are not assigned invented physical totals.

Metadata reads share a budget of 2,048 operations, 256 entries in the block listing, 64 Btrfs filesystem entries, 256 bytes per scalar and eight symlink hops. The existing collector cache owns refresh timing. No subprocess, sensor collector, network request or USB access is added.

Linux mountinfo is decoded for escaped spaces, tabs, newlines and backslashes. Local `/dev/...` filesystems (including NTFS `fuseblk`) and ZFS datasets are included. Pseudo filesystems, temporary/AppImage mounts, application overlays and network filesystems are excluded. Shared sources and filesystem types are grouped, so root and home Btrfs subvolumes share capacity and list both paths. This reports filesystem capacity rather than partition inventory or directory size.

Each refresh reads at most two 1 MiB mount tables, 4,096 records per table, and probes at most 128 unique filesystems. Additional rows carry unknown measurements. Failures affect the relevant row; other storage remains available. A second table check rejects readings from mounts that disappeared or were replaced during probing. Network mounts are excluded because a size probe can wait on a remote server. A local filesystem beneath a network, autofs or non-device FUSE parent is listed with unknown capacity and is not probed, since reaching its path can also block. Faulty local-device kernel probes may still block; work counts and bytes are bounded, not kernel latency. The existing 60-second collector cache also caches the mount list. Free space is available to this unprivileged process, with the same reserved-block semantics as root storage.

On this machine the collector returns `/` (alias `/home`), `/boot`, `/mnt/games`, `/mnt/hdd` and `/mnt/nvme`. Failed live readings never reuse the bundled editor samples.
