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

### Phase 1 — raise cadence + compaction (after Phase 0 verified)
Once reads are incremental, per-run work is O(new events) not O(all history):
- `silver` `:05` hourly → every ~5 min; `gold` triggered off silver (or every ~5 min).
- Bump `v4-maintenance` compaction cadence to match the higher write rate (small,
  frequent compactions instead of one daily catch-up).
- `recommendation-detectors` daily → every ~15 min (or fold into Phase 2).
- Watch per-run wall-time + S3 GET/PUT to confirm no fragmentation regression.

### Phase 2 — request-time detector serving (true per-request freshness)
Even a 5-min Silver cadence has a floor. For the numbers/predictions that must be
live-to-the-second, compute **on demand in the serving path** from fresh Silver via
Trino, Redis-cached with a short TTL + event-driven invalidation
(`gold.rewritten.v1` already exists as an invalidation signal). The detector logic
moves off the cron into the BFF/metric-engine read path so a request reflects Silver as
of *now*, not as of the last cron.

## Invariants preserved
- Bronze append-only; dedup lives in Silver. No event loss (windowing is `[lo, hi)`
  half-open on `ingested_at` with the watermark advanced only after commit).
- Money = bigint minor units + currency_code; idempotent MERGE on PK unchanged.
- `brand_id`-first; `${BRAND_PREDICATE}` seam unchanged.
- Every change additive + flag-gated + reversible (git revert / flag flip).
