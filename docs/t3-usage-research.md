# T3 usage research

Inspected on 7 October 2026 in `the project checkout`, branch `main`. This is research for the system and usage dashboard changes. Totals must cover **Last 30 days**, with Codex, Claude and Cursor rows and the matching aggregate API cost beside them. Quota windows describe account allowance independently of that reporting period.

Only this document was written. Inspection used installed source and local caches. No provider API, credential file, keychain, raw transcript output, service change, install or T3 fork was needed. Repository reads included `AGENTS.md`, `README.md`, `docs/first-milestone.md`, `docs/usage-data.md` and the research skill. The requested research worker owns this document; root retains implementation ownership.

## Findings that change the implementation

1. The installed T3 build already persists structured Claude and Codex quota snapshots in `~/.t3/caches/<instanceId>.json`. Read these before falling back to transcript quota events or Claude exhaustion notices. Claude has actual five-hour and weekly percentages and reset times here. No T3 change is required for these quotas. [S1, S2, S3]
2. Codex Pro currently reports one weekly window. Its `primary` slot lasts 10,080 minutes. `primary` does not mean five hours. The collector must use the supplied duration and kind. Do not manufacture a Pro session bar. Other Codex instances or future reported windows require their own applicability evidence. [S1, S4]
3. The saved token cache groups by provider driver, not model vendor or provider instance. Codex totals include both configured Codex homes. Claude through Cursor belongs in the Cursor row. None of these totals is restricted to this project or current thread. [S5, S6]
4. Cursor account tokens and reported costs exist in T3's live summary path, but that path does not persist them to `usage-scan-cache-v5.json`. Adding `cursor` to the local collector's provider list cannot recover Cursor history. The inspected cache contains only Codex and Claude entries. Keep the Cursor row visible with unavailable data. [S1, S5, S6]
5. Preserve `snapshot.providers` and its existing UTC-today semantics. Add `snapshot.periods.last30days` and fold both periods in one bounded cache pass after deduplication. The Last 30 days token and cost cards must use that same period object. [R1, S7]
6. T3 calls costs API-equivalent estimates. Its totals sum known cost while counting unpriced records. Studio currently withholds complete `costUSD` when any record is unpriced. Expose a clearly labelled partial API estimate using `knownCostUSD`; do not discard the priced portion or silently make unknown records cost zero. [S8, R1]

## Source inventory

The active inspected package is `0.0.46-nightly.20261007.2761`. Its ASAR is `/tmp/.mount_T3-CodKJGbej/resources/app.asar`. The server member is `apps/server/dist/binCli-OVWRLisX.mjs`, SHA-256 `040f4a8e2005cb1c202a2451d2ebbed9dda4e62d379d4c94f021af509891233a`. ASAR members were read directly in memory. No extraction or install was performed. Compiled line numbers below refer to that exact member. Original module names come from its `//#region` markers.

A second mounted package, `/tmp/.mount_T3-CodzUeHJp/resources/app.asar`, reports `0.0.46-nightly.20261006.2735`. Findings below use the newer package. The older mount cited by `docs/usage-data.md` is not the current package. Mount names and generated member filenames change between launches; do not make a collector depend on them.

| Citation | Owning source and exact functions | Compiled location |
| --- | --- | --- |
| S1 | Actual files `~/.t3/caches/codex-pro.json`, `claudeAgent.json`, `cursor.json`; `~/.t3/userdata/usage-scan-cache-v5.json` | Local allowlisted field inspection, not a provider request |
| S2 | `packages/contracts/src/providerUsageLimits.ts`: `ServerProviderUsageWindow`, `ServerProviderUsageLimits`, `ProviderUsageLimitsUpdate` | Lines 27776–27841 |
| S3 | `src/provider/ClaudeProvider.ts`: `probeClaudeCapabilities`, `checkClaudeProviderStatus`; `src/provider/claudeUsageLimits.ts`: `claudeUsageResponseToLimits`, `claudeRateLimitEventToUpdate`, `recordClaudeUsageResponse`, `scopedWindow` | Lines 152379–152418, 152535–152566, 147272–147387 |
| S4 | `src/provider/codexUsageLimits.ts`: `codexRateLimitsToWindows`, `codexRateLimitsToLimits`, `mergeCodexRateLimits`; `src/provider/CodexProvider.ts`: `probeCodexAppServerProvider` | Lines 175407–175518, 175746–175772 |
| S5 | `src/usage/UsageService.ts`: `resolveTranscriptDirs`, `collectDirs`, `scanSummary`, `readSummary`, `persistScanCache`, `readFileRecords`, `sharedCodexSessions` | Lines 258179–258198, 258300–258385, 258404–258729 |
| S6 | `src/usage/cursorUsageReader.ts`: `readCursorAccountUsage`, `cursorRateModel`, `boundaryOverlap`; `src/usage/usageScanCache.ts`: `serializeFile`, `decodeScanCache`, `makeScanCacheWriter` | Lines 256975–257162, 257905–258127 |
| S7 | `src/usage/usageAggregation.ts`: `UsageAggregator.add`, `makeDayFormatter`; `packages/contracts/src/usage.ts` contracts containing `UsageSummaryInput` | Lines 257383–257518, 46602–46629 |
| S8 | `src/usage/usagePricing.ts`: `priceUsage`, `costByCategory`, `resolveRate`; `src/usage/usageAggregation.ts`: `resolveCostSource`; `UsageBucket` contract | Lines 257317–257370, 257613–257621, 46500–46540 |
| S9 | `src/provider/providerStatusCache.ts`: `resolveProviderStatusCachePath`, `readProviderStatusCache`, `writeProviderStatusCache`, `isCachedProviderCorrelated`; `src/provider/ProviderRegistry.ts`: `persistProvider`, `upsertProviders` | Lines 218253–218332, 218489–218530, 218548–218567 |
| S10 | `src/provider/providerUsageLimits.ts`: `applyUsageLimitsUpdate`, `resolveUsageLimitsAfterProbe`; `src/provider/makeManagedServerProvider.ts`: `applySnapshotBase`, `applyUsageLimits`, `getRefreshInterval`, `hasProviderStatusDemand` | Lines 132638–132724, 132775–132852 |
| S11 | Client ASAR members `apps/server/dist/client/assets/usageFormat-B70bcQVE.js`, `usageShortcuts-BNx9ABfM.js`, `usage-kkZT3sbw.js`, `runtime-Dss4TYSe.js` | `usageFormat` function `v`, exported as `f`; usage module functions `ft`, `ht`, `ut`; runtime `usageSummary` resource |
| S12 | `src/provider/cursorUsageLimits.ts`: `readCursorUsageLimits`, `cursorUsageResponseToLimits`; `src/usage/UsageLimitSources.ts` | Lines 185650–185734, 259399–259435 |
| R1 | [runtime/turzx_studio/usage.py](../runtime/turzx_studio/usage.py): `UsageCollector.snapshot`, `_collect`, `_tokens`, `_codex_event`, `_claude_limits`, `_price`, `_finish` | Existing collector at inspection start |
| R2 | [docs/usage-data.md](usage-data.md), [runtime/turzx_studio/integration.py](../runtime/turzx_studio/integration.py), [runtime/server.py](../runtime/server.py), [runtime/turzx_studio/usage_display.py](../runtime/turzx_studio/usage_display.py) | Existing integration and display boundaries; root is changing display code concurrently |

The client bundle has no packaged source maps for the inspected usage members. Minified client function names above are therefore build-specific. The server's original module names and function names provide the more durable references.

## Actual quota source and sanitized shapes

These are observations, not demo values. At task start the local Pro cache reported weekly usage **0%**, checked at `2026-10-07T09:30:52.497Z`, resetting at `2026-10-14T09:06:14.000Z`. It is below the 98% pause threshold. `/status` was not invoked through a shell; the evidence is T3's persisted provider quota snapshot. The existing collector found a similarly timed quota event but marked its overall scan stale because it hit byte and line bounds. The small structured cache avoids that transcript scan for the normal path. [S1, S9, R1]

Allowlisted cache examples, with unrelated provider fields removed:

```json
{
  "instanceId": "codex-pro",
  "driver": "codex",
  "enabled": true,
  "installed": true,
  "status": "ready",
  "checkedAt": "2026-10-07T09:30:52.497Z",
  "usageLimits": {
    "checkedAt": "2026-10-07T09:30:52.497Z",
    "windows": [{
      "id": "primary", "kind": "weekly", "label": "Weekly",
      "usedPercent": 0, "windowDurationMins": 10080,
      "resetsAt": "2026-10-14T09:06:14.000Z"
    }]
  }
}
```

```json
{
  "instanceId": "claudeAgent",
  "driver": "claudeAgent",
  "enabled": true,
  "installed": true,
  "status": "ready",
  "checkedAt": "2026-10-07T09:30:52.556Z",
  "usageLimits": {
    "checkedAt": "2026-10-07T09:30:52.556Z",
    "windows": [
      {
        "id": "five_hour", "kind": "session", "label": "Session",
        "windowDurationMins": 300, "usedPercent": 10,
        "resetsAt": "2026-10-07T14:00:00.177Z"
      },
      {
        "id": "seven_day", "kind": "weekly", "label": "Weekly",
        "windowDurationMins": 10080, "usedPercent": 45,
        "resetsAt": "2026-10-10T20:00:00.177Z"
      }
    ]
  }
}
```

These snapshots identify the Codex and Claude CLI versions as `0.160.1` and `2.1.292`. The Cursor provider cache identifies `instanceId: cursor`, `driver: cursor`, `enabled: false`, `installed: false`, `status: disabled`, and has no `usageLimits`. Disabled Cursor today says nothing about historical Cursor consumption. [S1]

### How T3 obtains these values

Claude's `probeClaudeCapabilities` initializes an Agent SDK query without sending a user message, then calls `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})`. Its initialization comment says no model request is started; the added usage call is still an account-usage operation. The collector should consume its cache, not launch this probe itself. ClaudeDriver caches capability probes for five minutes. The response's `rate_limits_available` and `rate_limits` determine supported quota reporting. `five_hour` and `seven_day` utilization values are already percentages. Model-scoped weekly buckets are also supported and must not be confused with the account-wide weekly bucket. [S3, server lines 152619, 152692–152698]

During Claude turns, `rate_limit_event.rate_limit_info` produces sparse updates. Its `utilization` is a 0–1 fraction, multiplied by 100, and `resetsAt` is epoch seconds. This differs from the full probe response's percentage and ISO `resets_at`. Studio reads the normalized cache, where these differences have already been resolved. [S3, server lines 150458–150467]

Codex's full probe calls app-server `account/rateLimits/read`. It uses the `codex` bucket in `rateLimitsByLimitId` when supplied, otherwise the legacy snapshot. Windows are classified by `windowDurationMins`; the mapper only falls back to plan-specific durations when a reported window lacks its duration. It does not fabricate a missing primary or secondary window. Runtime notifications use `account/rateLimits/updated` and merge sparsely. Use the normalized cache rather than reimplementing the probe or assuming `primary=session`. [S4]

`ProviderRegistry.persistProvider` writes machine snapshots to `~/.t3/caches/<instanceId>.json` through an atomic file writer. They contain `instanceId` and `driver`; T3 checks both when hydrating. The Studio reader should do the same. Read only selected non-sensitive fields. These are provider snapshots, not quota-only files. [S9]

The cache has one quota `checkedAt`, not a timestamp for every window. Sparse updates retain omitted windows and their duration/reset metadata, while advancing that shared timestamp when data changes. Do not claim every window was freshly probed at that instant. Provider-status demand and configured refresh intervals control background probes. A headless panel reader cannot guarantee new observations while T3 is closed or idle. [S10]

### Applicability and missing data

| Evidence | Collector state | Display behavior |
| --- | --- | --- |
| Valid reported window | Available, or stale after age/reset checks | Show reported percentage and reset, including a genuine zero |
| `usageLimits.unavailable.reason == "unsupported"` | Unsupported reporting | Omit unsupported bars; retain a provider-level unavailable explanation when relevant |
| `usageLimits.unavailable.reason == "probeFailed"` | Temporarily unavailable | Preserve last-good windows as stale; do not turn them into zeros or hide them as inapplicable |
| Missing file, invalid identity/schema, missing `usageLimits`, unknown duration | Unknown or unavailable | Keep an unavailable state; absence alone does not prove no allowance applies |
| Sparse update omits a previously known window | Unchanged observation | Preserve it, following T3's merge contract |
| Successful full probe omits an account window | No reported applicable window in that full inventory | Render the reported inventory; do not add a placeholder bar for the omitted window |
| Reset has elapsed without another observation | Stale | Say reset time passed; do not infer 0% used or 100% remaining |

T3 preserves the previous supported snapshot when a full probe fails and replaces it when reporting is explicitly unsupported. A later cache reader may see retained old data without a failure reason; age remains necessary. `unsupported` means this source/account cannot report the windows. It is not a universal statement that the provider has no quota. API-key, Bedrock and some managed subscription-sharing routes illustrate that difference. [S2, S3, S10; server lines 185234–185244]

The current cache does not persist a formal full-versus-sparse inventory flag. Equality of provider and quota `checkedAt` matches the inspected full probe path, but treat this as supporting evidence, not a new guaranteed API contract. Codex Pro's session window is confirmed inapplicable by the user's account constraint and the current weekly-only snapshot. Do not use missing telemetry to mark Claude weekly unsupported. Preserve `kind`, `id` and duration so future supported windows can appear dynamically. [S1, S4, S10]

## Tokens, periods and costs

### Cache contents and attribution

The token cache was 1,278,118 bytes, modified at `2026-10-07T01:02:34.028949Z`. It had version 5, 9 interned model strings, 405 interned session strings and 436 file entries: 275 Codex and 161 Claude. There were 10,924 Codex serialized rows and 4,447 Claude serialized rows before cross-file deduplication. There were no Cursor entries. These are cache counts, not usage totals. [S1]

The inspected rows span 5 September through 7 October for Codex and 29 September through 7 October for Claude. T3 prunes retained transcript entries by a 90-day cutoff, but the persisted cache contains no completed-scan coverage bounds or source-error inventory. Earliest/latest record dates do not prove complete 30-day history. Label totals as locally cached usage, retain stale/partial coverage and never treat a missing account source as a verified empty period. [S1, S5]

Sanitized schema notation, without source paths, model lists, identifiers or actual row values:

```text
root: {sources, version: 5, models: string[], sessions: string[], files: object}
file: {s, m, p, r: row[], t: row[], o, gl, gh, cs}
row: [timestampMs, modelIndex, sessionIndex,
      uncachedInputTokens, cachedInputTokens, cacheCreationTokens,
      outputTokens, reasoningTokens, dedupeKey|null,
      reportedCostUsd|null, speedIndex]
speedIndex: 0=standard, 1=fast, 2=ultrafast
```

`p` supplies provider attribution. T3's v5 decoder accepts `claude`, `codex` and `grok` for this transcript cache. `r` and `t` both contribute. `resolveTranscriptDirs` resolves configured provider instances and homes, maps driver `claudeAgent` to usage provider `claude`, and deduplicates shared directories. The serialized rows do not retain provider-instance identity. Keep all-local-account token scope separate from the Pro-only quota scope. [S5, S6]

Deduplicate before either period filter. Claude keys identify repeated message/request records across files. Codex moved or copied sessions require provider, session, timestamp, model, token fields and within-file occurrence count. Identical legitimate occurrences within one original file remain counted. Both windows must fold the same surviving records; do not deduplicate independently after selecting a period. Never return the internal keys or session strings. [S5, S6, R1]

Token total is `uncachedInput + cacheRead + cacheCreation + output`. Reasoning is already included in output, and combined cache is a subtotal. Adding either again inflates totals. This is processed request usage, not context size or subscription percentage. [S8, S11, R1]

### Last 30 days

T3's `30 days` selector uses **30 local calendar days including today**. Client `usageFormat` function `v` derives today's date in the browser's IANA timezone, then subtracts 29 date days. `sinceDay` and `untilDay` are inclusive. T3's Past 24h selector instead uses exact hourly bounds, rounded to a minute. Its hourly server path refuses spans over 24 hours, so that path cannot supply an exact rolling 30-day report. [S7, S11]

For Studio, the agreed additive design can use either explicitly labelled policy. Prefer `windowKind: rolling`, `durationSeconds: 2592000`, and `[sinceAt, untilAt)` where `untilAt` is the collector's observation cut-off. Label it `Last 30 days`, with accessible details saying `Rolling 30 × 24 hours`. Do not claim exact parity with T3's calendar-day selector. To match T3 instead, use `windowKind: calendar`, timezone `Europe/Paris` or a configured IANA zone, and today plus the preceding 29 dates. Expose inclusive date bounds in `scope`; do not approximate local days with UTC subtraction across DST.

Keep `snapshot.scope.period == "today"` and `snapshot.providers` unchanged for old widgets. Add `snapshot.periods.last30days.scope` and `.providers`. Load the cache once, validate all supported rows within the existing bounds, deduplicate once and price a surviving row at most once when either period needs it. Fold into daily and 30-day accumulators. Keep per-model details under each period if existing consumers need them. [R1]

For rolling reports, aggregate expiry cannot be postponed merely because the source file is unchanged. Cache decoded records or time buckets in memory and refold on the normal 60-second refresh. A last-good rolling aggregate must retain its original bounds and become stale on a failed refresh. Do not stamp new bounds on old totals, which would pretend expired records had been removed. Daily last-good values remain restricted to their original UTC day. [R1 and proposed interface]

### Cursor inclusion and the precise gap

`readCursorAccountUsage` reads authenticated account history from `https://cursor.com/api/dashboard/get-filtered-usage-events`. The source code supports pagination, exact suffix/prefix overlap removal and duplicate occurrence counts. It includes headless agents. A model such as Claude is still assigned `provider: "cursor"` because the request ran through Cursor. It maps fresh input, cache read, cache write and output separately; `tokenUsage.totalCents / 100` supplies optional provider-reported USD cost, including explicit zero. [S6]

That reader requires CLI credentials or, on some Macs, keychain access. The research did not read credentials or invoke it. `collectDirs` passes account records directly to `scanSummary` as a synthetic account source. Only transcript `readFileRecords` updates `fileCache`; `persistScanCache` saves that map. Cursor account history is therefore absent from the on-disk v5 cache by design, not merely discarded by Studio. The current client summary is cached in its runtime resource with a 60-second stale interval, but the inspected Usage client module supplies no local persisted summary export. Browser internals were not scraped. [S5, S6, S11]

The source also supports separate Cursor monthly quota pools through `readCursorUsageLimits`. These are subscription percentages, not token counts or cost history. `cursor.json` cannot substitute for the account-history response, and disabled Cursor must not erase a Last 30 days history row. Cursor quota bars are outside this request's Codex/Claude quota section. [S12, S1]

Therefore a strict cache-only release must show Cursor tokens and cost as unavailable, and label the aggregate partial when Cursor coverage is unknown. An empty cache row list is not proof of zero Cursor requests. A complete, explicitly successful source observation with no records in the selected period can prove zero; missing sources cannot.

If real Cursor totals are required immediately, the smallest additional source is a **sanitized summary export from T3**, not a second dashboard credential client. T3 already owns the authenticated reader. A future bounded export could persist provider/day buckets, numeric totals, cost quality, period bounds, source-status codes and observation time after a successful `scanSummary`. Strip source fingerprints, raw paths, account hashes, session IDs, prompt text and free-form error messages. Preserve failed-source status and last-good timestamps. T3 calendar buckets can support the calendar 30-day policy; an exact rolling policy needs finer time buckets or an export built with exact bounds. Such an export would require a separate authorized T3 change. This research establishes that need but does not modify or fork T3.

### Cost coverage

`priceUsage` applies provider-reported cost when finite unless a user price override takes precedence. Otherwise it uses model rates, cache category rates and the request speed. An unpriced record contributes tokens and an `unpricedRecords` count, not a defensible complete cost. T3's bucket contract calls `costUsd` API-equivalent cost rather than subscription spend. Studio does not currently read T3's user model aliases or price overrides, so cached-rate estimates can differ from T3 when customized. Preserve that limitation instead of copying arbitrary settings. [S8, R1]

For Last 30 days, sum the same provider rows into both totals:

```text
knownTokens = sum(provider.total for providers with an observation)
tokensComplete = every requested provider has valid source coverage
knownCostUSD = sum(priced portions from those same provider/period observations)
costComplete = tokensComplete and no included record is unpriced
```

Return `null` for complete totals when coverage is unknown, retain known portions separately and say `Partial` or `Partial API estimate` beside their display. Keep `reportedRecords`, `estimatedRecords` and `unpricedRecords`. A provider row with no cost observation stays unavailable; do not coerce `None`, a missing Cursor source, or an unknown model to zero. A real reported zero remains zero. The API cost card and token card must display the same bounds and provider coverage. [S8, R1]

## Recommended bounded collector interface

This is an additive recommendation, not an implemented contract:

```text
snapshot.providers: existing UTC-today provider objects
snapshot.scope: existing UTC-today scope
snapshot.periods.last30days:
  scope: {period, windowKind, durationSeconds?, sinceAt, untilAt,
          timeZone, label, accounts}
  providers: {codex, claude, cursor}
  totals: {total, knownTotal, costUSD, knownCostUSD,
           tokenCoverage, costCoverage, missingProviders}

provider token/cost fields: existing accounting fields and freshness
provider coverage: available | missing | partial | unavailable
provider quotaWindows:
  five_hour: available | unsupported | unknown
  weekly: available | unsupported | unknown
provider limits[]:
  existing fields plus kind and quotaAccount
provider freshness.limits:
  source, observedAt, readAt, stale, status, errors
```

`unsupported` in `quotaWindows` is an explicit applicability/reporting decision, not a synonym for a missing percentage. Freshness failures preserve available-but-stale observations; unknown means no defensible observation or applicability determination. Keep full inventory replacement separate from sparse event merging. Account-wide and model-scoped weekly windows must retain separate IDs. Existing source IDs can stay compatible while `usage-tokens-30d`, `usage-cost-30d` and `usage-limits` consume the additive objects. [S2, S3, S10, R1]

Retain the existing 8 MiB JSON, 4,096 file, 100,000 row, 1,024 model and 20,000 session limits. Read only explicitly configured provider-cache files, initially `codex-pro.json` and `claudeAgent.json`. A 256 KiB per-provider file cap and at most 32 windows per cache are enough for the inspected 47,596-byte Codex and 49,398-byte Claude snapshots. Treat these as implementation bounds, not an upstream schema promise. Fail a malformed/bound-exceeded component as unavailable or stale last-good, never as a complete partial scan. [S1, R1]

Refresh the local collector at most once per 60 seconds. Recompute age and reset expiry on every served snapshot. Use `usageLimits.checkedAt`, not file mtime or the read time, as quota observation time. Validate finite 0–100 percentages, bounded IDs/labels, ISO timestamps and nonnegative durations. Return fixed error codes. Only `instanceId`, `driver`, needed provider-state flags and `usageLimits` fields enter the normalizer; never return other cache fields. [S2, S9, R1]

Prefer structured provider cache data. Retain Pro token-count parsing only as a bounded fallback when the structured source is unreadable, unavailable or too old to be useful. Compare observations by timestamp; do not let an older structured snapshot replace a fresher event. A notice can provide an exhausted Claude five-hour fallback, with an estimated reset, but cannot provide Claude weekly usage. Explicit unsupported reporting must not be overridden by a guessed transcript fallback. [S10, R1]

## Smallest implementation changes for root

1. In `runtime/turzx_studio/usage.py`, add identity-checked provider-cache quota normalization. Map duration 300 to a five-hour display label and duration 10,080 plus account-wide identity to weekly. Keep other/model-scoped windows distinct. Stop hardcoding all Codex `primary` windows as sessions or dropping actual supplied windows by position.
2. Refactor `_tokens` to validate and deduplicate once, then fold UTC today and the chosen explicit 30-day policy. Keep independent last-good period bounds/freshness. Add Cursor as an unavailable row until a real cached source exists. Do not advertise it as collected merely because the provider tuple now includes it.
3. Add aggregate token and API cost coverage to `periods.last30days`. Preserve the known priced portion while complete cost stays nullable. Keep all three provider rows visible, including unavailable Cursor.
4. Wire only `usage-tokens-30d`, `usage-cost-30d` and `usage-limits` to the new objects in the display layer, deterministic samples, catalog/schema and presets. Use the same data in React and PIL. Existing daily widgets retain their meaning. System layout cleanup and visual design remain root's work. [R2]
5. Replace obsolete claims in `docs/usage-data.md` that the inspected installation has no structured Claude quota windows. Record provider-cache provenance, account scope, 30-day bounds, partial costs and Cursor's missing source honestly.
6. Add collector fixtures for a weekly `primary`, both Claude windows, sparse updates, unsupported versus probe failure, invalid cache identity, true zero versus missing, rolling expiry, day rollover, copied records, cache bounds and partial cost. Add display checks that unknown Cursor remains a row and that unsupported session windows disappear without hiding temporarily unavailable Claude weekly data.

A collector-only change can deliver actual quota windows and useful 30-day Codex/Claude totals now. It cannot truthfully deliver complete Cursor-inclusive totals from the inspected persisted files. If the user requires complete Cursor history, root should pursue the bounded T3 export described above as a separate change; do not claim completion based on invented zeros.

## Verification and limits of this research

Verified the active ASAR version/hash, exact source functions, normalized cache shapes, current quota values, token-cache provider/row counts, serialized field order, period behavior and Cursor persistence gap. No application tests, build, provider refresh, service restart or dashboard apply was run. Root is implementing concurrently; this note describes the evidence and recommended boundaries, not a review of its unfinished changes.

Provider caches are observations owned by T3 and can become stale. The installed code proves which integrations exist and how they normalize data, not a guarantee that the upstream APIs will stay unchanged. The Claude SDK method explicitly warns that its interface is experimental. External `UsageLimitSources` such as CLIProxyAPI are live server state and are not persisted by that service, so they are outside the proposed local-only reader. [S3, S12]

Final quota recheck at `2026-10-07T09:38:35Z` found the Pro weekly cache at **1%**, checked at `2026-10-07T09:33:57.501Z`, with the same reported reset and no `unavailable` reason. No quota pause was triggered. The document passed a whitespace check; implementation tests remain root's responsibility.
