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

### Phase 0 — incremental foundation (this PR, flag-gated, default OFF)
- Add opt-in `SILVER_INCREMENTAL=1` + `FULL_REFRESH=1` escape hatch to `_base.py`
  (`incremental_window()`), and make `run_job` advance the watermark against the
  **correct source table** (per-job, not always the gated keystone).
- Convert the **keystone** `silver_collector_event` to incremental (per-event; single
  biggest full-scan — reads all of `collector_events_connect` every run).
- Default OFF → byte-identical to today. Ship inert. Flip on prod after verifying the
  keystone on one run (row-count + money reconcile unchanged).

### Phase 0b — remaining per-event jobs (follow-up PR)
Convert the per-event/`*_normalize` jobs to windowed reads. Verify each with an
idempotent re-run (same rows).

### Phase 0c — entity-fold jobs (follow-up PR)
Apply the entity-incremental pattern (changed-entity id set → full re-fold of those
entities) to the fold jobs. Reuse the pattern already proven for `silver_order_state` /
`silver_touchpoint` (Spark era).

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
