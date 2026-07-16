# Realtime analytics & predictions — phased rearchitecture

**Principle:** serve live realtime analytics and predictions to customers.
**Status:** Phase 0 foundation in progress (flag-gated, default OFF — inert on prod until flipped).

## The problem: incremental lag

Today the freshness floor of every dashboard number and every recommendation is the
**batch transform cadence**:

| Stage | Cron | Cadence |
|---|---|---|
| `v4-silver` (45 DuckDB jobs) | `sparkV4.silverSchedule` | hourly `:05` |
| `v4-gold` (45 DuckDB jobs) | `sparkV4.goldSchedule` | hourly `:25` |
| `recommendation-detectors` | cronworkflows | daily `06:00` IST |
| `semantic-preagg-refresh` | cronworkflows | hourly `:40` |

A customer event that lands in Bronze at `:06` is not in Silver until the next `:05`
run, not in Gold until `:25`, and not reflected in recommendations until the **next
morning**. That is the lag.

## Why "just bump the cron" is wrong (and dangerous)

Measured ground truth (2026-07-16):

1. **All 45 Silver jobs are full-scan.** Not one reads `silver_job_watermark` — every
   run re-reads the *entire* Bronze/Silver history and MERGEs it. The incremental
   machinery already exists in `db/iceberg/duckdb/_base.py` (`read_watermark`,
   `read_gated_events_sql(lo, hi)`) but no job opts in.
2. Running full-scan MERGEs every ~5 min instead of hourly is **12–20× the Iceberg
   write amplification** → data-file fragmentation → the exact 390s/job slowdown that
   blew the transform deadline earlier (fixed via the Trino `s3:DeleteObject` grant +
   daily `v4-maintenance` compaction, PR #182). A cadence bump *without* incremental
   reads walks straight back into that failure.
3. **~16–23 of the 45 jobs are entity-fold grain** (`GROUP BY` / window folds:
   `silver_order_state`, `silver_customer`, `silver_touchpoint`, `silver_sessions`,
   `silver_journey`, identity marts…). Naive windowing **silently drops history below
   the watermark** — the documented entity-incremental FULL_REFRESH gotcha. Money and
   LTV would go wrong.

So the work is: incrementalize **correctly, by grain class** first; only then is a
higher cadence cheap and safe.

## Grain classes (the crux)

| Class | Shape | Jobs (examples) | Incremental strategy |
|---|---|---|---|
| **Per-event / per-row** | 1 source row → 0..1 target row, idempotent MERGE on a stable PK | keystone `silver_collector_event`, most `*_normalize`, `silver_product`, `silver_refund` | **Window** on `[watermark, hi)` of source `ingested_at`. Safe: a row's output depends only on that row. Biggest win, lowest risk. |
| **Entity-fold** | many events → 1 entity row (aggregate/sessionize) | `silver_order_state`, `silver_customer`, `silver_touchpoint`, `silver_sessions`, `silver_journey`, identity marts | **Entity-incremental**: window to find *changed entity ids*, then re-fold each changed entity's **full** history. Never drops below-watermark rows. |
| **Global** | reads whole corpus by design | data-driven attribution (Markov), some campaign rollups | Stay full-scan; not on the hot path. Keep on the slower cron. |

## The plan

### Phase 0 — incremental foundation + keystone (PR #193, MERGED, flag-gated, default OFF)
- Opt-in `SILVER_INCREMENTAL=1` + `FULL_REFRESH=1` escape in `_base.py`
  (`incremental_window()`); `run_job` advances the watermark against the **correct
  source table** (per-job). Keystone `silver_collector_event` windows its Bronze read on
  `kafka_timestamp`.

### Phase 0b/0c — ALL remaining Silver jobs (this PR, flag-gated, default OFF)
Applied the incremental read across all 44 non-keystone Silver jobs, classified by grain
(a 37-agent read-only classification workflow + adversarial money-safety audit):

- **24 per-event** → window the source read directly. Gated jobs thread `lo/hi` into
  `read_gated_events_sql`; the 7 `*_normalize` jobs use the new `_normalize_base` helpers
  (`lane_window`/`lane_window_predicate`/`advance_lane_watermark`) with **per-(job,lane)
  `kafka_timestamp` sub-watermarks** so a multi-lane job (ad-spend = meta+google) tracks
  each lane independently.
- **14 entity-fold** → **changed-entity refold**: a windowed read discovers the set of
  changed entity keys; the fold reads the FULL, unwindowed source semi-joined to that set,
  so only changed entities re-fold over their complete history (guarded on `lo is not
  None` → default-OFF is byte-identical). `order_state` unions both driver lanes (order +
  AWB); the 4 `silver_table`-sourced folds (customer/product/sessions/shipment) re-key off
  their upstream mart's watermark.
- **6 global** (identity/Neo4j/PG-sourced: `silver_identity_{alias,map,unmerge}`,
  `silver_customer_identity`, `silver_probabilistic_stitch`, `silver_session_identity`) →
  **left full-scan** (no event clock / whole-corpus by design).

**The hard invariant** (adversarially verified per job): `lo is None ⟺ hi is None ⟺ a
full scan` — the default-OFF path emits NO window predicate and is byte-identical to
today. `incremental_window` returns `(None, None)` (not `(None, hi)`) when off/first-run,
so no bound leaks (the fix for the sole issue the adversarial pass caught in the Phase-0
foundation).

**Residual to validate before flipping ON:** the 4 `silver_table`-sourced folds drive
their changed-set off the *primary* upstream only — an identity-only change with no
upstream-mart touch could be missed for one cycle. Mitigations: (a) run these with a
periodic `FULL_REFRESH=1` (e.g. nightly) even after the flip; (b) validate row-count +
money parity (incremental vs `FULL_REFRESH`) on prod before enabling. This is why the
whole tier ships **inert**.

### Phase 1 — raise cadence + compaction (values-only; enables incremental)
Once reads are incremental, per-run work is O(new events) not O(all history). Changes
(`infra/helm/cronworkflows/values.yaml`):
- **`SILVER_INCREMENTAL=1`** + `WATERMARK_LOOKBACK_SECONDS=600` in `sparkV4.env` — activates
  the flag-gated incremental reads from #193/#194. **The FIRST run is a full-scan bootstrap
  (~75 min, the old runtime) that seeds the watermark**; keep `activeDeadlineSeconds: 9000`
  so it completes. After that, runs finish in minutes.
- `silver` hourly `:05` → **`*/5`** (every 5 min). `gold` hourly `:25` → **`*/5`** (Gold is
  still full-scan — correct, just more compute — and `concurrencyPolicy: Forbid`
  self-throttles it, never overlapping).
- `v4-maintenance` compaction daily → **every 2h** (`0 */2 * * *`) — keeps optimize()/
  expire_snapshots ahead of the ~12× commit rate on both namespaces (else the 2026-07-15
  fragmentation incident recurs).
- `recommendation-detectors` daily `06:00` → **`*/15`** (interim; Phase 2 makes it request-time).

**Why `Forbid` makes `*/5` safe:** a long run just skips the next tick, never overlaps —
freshness degrades gracefully to whatever each tier sustains.

**PROMOTION GATE (owner) — validate at the release→master promotion:**
1. Let the bootstrap run complete once (watch `brain_transform_workflow_duration_seconds`
   drop from ~4500s to low-minutes on the second run).
2. **Money parity:** compare an incremental Silver→Gold run vs a `FULL_REFRESH=1` run —
   `gold_revenue_ledger` / `customer_360` totals must be byte-identical. If the 4
   `silver_table` folds drift (identity-only change missed for a cycle), run a periodic
   `FULL_REFRESH=1` pass to correct it.
3. Confirm S3 GET/PUT + per-job wall-time stay flat (no fragmentation regression).

**Cost:** ~288 silver+gold runs/day vs 24, but each incremental run is tiny (only new
events) — marginal cost is extra short pod-runs on the existing streaming pool, not 12×
compute. Gold stays full-scan (incrementalizing Gold is a future Phase 1b, gated on Silver
parity being proven).

### Phase 1b — incremental Gold (this PR; flag-gated `GOLD_INCREMENTAL`, default OFF)
Gold marts full-scan Silver/Gold every `*/5` run (Phase 1 kept them full-scan). Phase 1b
makes the safe subset incremental. **Independent gate** `GOLD_INCREMENTAL` (an `enabled=`
override on `incremental_window`) so Gold flips separately from Silver.

**The Gold clock is heterogeneous** (the crux): the changed-set/window needs an
ARRIVAL/WRITE clock on the *source* mart, not a business clock. Per-event Silver marts
carry `ingested_at`; entity Silver marts + 43/45 Gold marts carry a NOW-stamped
`updated_at`; a few carry only `occurred_at`. Each implementer derives the source's real
clock (`ingested_at` → else `updated_at` → else leave full-scan) — verified by an
adversarial pass that rejects a non-existent or business clock.

Outcome (45 jobs, 84-agent implement+verify):
- **29 incremental** — per-event window or changed-entity refold, keyed off the correct
  clock (incl. gold→gold deps like `gold_order_economics` → `gold_revenue_ledger.ingested_at`).
- **13 left full-scan** (money-safety, documented) — **multi-source folds** whose output
  depends on TWO upstream sources (e.g. `gold_contribution_margin` = order_state ⊕
  marketing_spend, `gold_revenue_ledger`, `gold_ai_features`, `gold_funnel_user`…): a
  correct refold needs the UNION of changed keys from both sources, but `run_job`/
  `incremental_window` track a SINGLE source clock — windowing the second source by the
  first's `hi` would permanently skip newer rows → wrong money. Deferred to **Phase 1c**
  (multi-source changed-set union).
- **3 global** by design — `gold_attribution_credit` (Markov trains on the whole corpus),
  `gold_journey_events_reversion` (self-mutation), `gold_product_costs` (PG dimension).

Ships inert. **Promotion gate:** validate `gold_*` money parity (incremental vs
`FULL_REFRESH=1`) per brand before flipping `GOLD_INCREMENTAL=1`; the 13 full-scan jobs
keep running full every `*/5` (correct, just not yet cheap).

### Phase 2 — request-time detector serving (DONE; flag-gated, default OFF)
Even a 5-min Silver cadence has a floor. `GET /api/v1/recommendations` now computes the
detector set **at request time** from the freshest Silver/Gold (Trino) when the per-brand
flag `recommendations.request_time` is ON, so the Morning Brief reflects the medallion as
of *now*, not the last cron tick. Default OFF → the stored (cron-fed) path, unchanged.

Implementation (`apps/core/src/modules/recommendation`):
- `getRecommendationsLive` — fronted by the `ServingCacheReader` (Redis): brand-leading key,
  stampede-guarded `getOrSet`, fail-soft. So the expensive compute (4 detectors × Trino
  reads) runs at most **once per brand per invalidation window**; concurrent requests share
  the in-flight compute.
- **Event-driven invalidation is free:** the cache key leads with `brand_id`, and the
  existing `AnalyticsCacheInvalidateConsumer` busts `${brandId}:*` on `gold.rewritten.v1` —
  so the moment a brand's Gold marts are rewritten (~5 min), the next request recomputes.
  A 5-min `executive` TTL tier is the quiet-period backstop.
- `compute()` reuses `generateRecommendations` (idempotent upsert + append-only
  `decision_log`), so the persisted set + audit + outcome-measurement inputs stay intact —
  a request-time *refresh*, not a parallel unpersisted computation.
- The confidence gate is applied **after** the cache against CURRENT trust (only raw
  detector findings are cached), so a trust change reflects immediately without a bust.
- `get-recommendations.ts` split into `readOpenRecommendationsRaw` + `applyGateToRawRecs`
  (shared by both paths). Response contract is UNCHANGED → no UI change.

The `recommendation-detectors` cron stays (outcome measurement + the flag-OFF/no-traffic
path). Tests: `get-recommendations-live.test.ts` (routing, gate-at-serve, no_data, safe-off
compute).

## Invariants preserved
- Bronze append-only; dedup lives in Silver. No event loss (windowing is `[lo, hi)`
  half-open on `ingested_at` with the watermark advanced only after commit).
- Money = bigint minor units + currency_code; idempotent MERGE on PK unchanged.
- `brand_id`-first; `${BRAND_PREDICATE}` seam unchanged.
- Every change additive + flag-gated + reversible (git revert / flag flip).
