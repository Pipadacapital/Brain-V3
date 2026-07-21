# ADR-0018 — Durable Bronze maintenance (dedup convergence) + pre-baked operational-read marts

- **Status:** Accepted (2026-07-22) — owner-ratified. Implemented flag-gated, staging-first (month-scoped dedup + bronze-hot lane + pre-baked operational marts).
- **Builds on:** ADR-0010 (Kafka-Connect Iceberg sink is the SOLE Bronze landing writer), ADR-0012 (idempotent ingest / no-duplicate-events), ADR-0015 (Bronze stays append-fast, converges to zero-duplicate via COMPACTION-TIME dedup keep-latest on `(brand_id, event_id)`), ADR-0016 (near-real-time serving; the transform tick already folds Silver hot-table maintenance under its lock), ADR-0017 (identity folded into the tick / cheap-metadata doctrine)
- **Deciders:** Owner + platform (principal data architect)
- **Goal:** make Bronze maintenance (dedup + compaction) *actually converge* within 4–8 Gi, on the correct owner and cadence, so `collector_events_connect` stays append-fast AND small-and-deduped; and remove the last single-query-ceiling violation on the operational-read endpoints by serving them from a small pre-baked mart instead of scanning a growing keystone.

## Context (MEASURED, prod, 2026-07-22 — all verified)

Bronze landing is the Kafka-Connect Iceberg sink (ADR-0010) writing `brain_bronze.collector_events_connect`, the sole Bronze writer. ADR-0015's design contract (D2b) is: Bronze writes stay append-fast and the table **converges to zero-duplicate within each maintenance cycle** via compaction-time dedup keep-latest on `(brand_id, event_id)` (`db/iceberg/duckdb/maintenance/bronze_dedup.py`); the Silver `MERGE` on `(brand_id, event_id)` is the backstop. That contract is currently **unfulfilled in production**, for three compounding reasons, plus a fourth on the read side.

**F1 — dedup OOM/SIGTERMs on the backlog and never converges (maintenance-side, primary).**
- `collector_events_connect`: ~1.38M rows, was **1,544 live data files** (Kafka-Connect 30s-commit churn × `tasks.max=2` ⇒ ~2 files / 30s ⇒ ~5,760 files/day). Manually compacted to **7 files** as a STOPGAP — it re-fragments continuously; the stopgap is a hack.
- The `bronze-maintenance` Argo cron has FAILED for ~2 days. Its `bronze_dedup.py` step reports `666493 rows across duplicated keys; deleting 582401 loser rows by (kafka_partition,kafka_offset)` then SIGTERMs/OOMs mid-run. It deletes in 62 batches of 10k and is killed before finishing. `bronze_maintenance.py`'s optimize (whole-table COW) also OOMKilled at 4Gi.
- Root cause in code:
  - `bronze_dedup.py:230` materializes the ENTIRE ~582k `(kafka_partition, kafka_offset)` loser set into a Python list before deleting anything; `loser_file_bytes()` (`:236`) then re-scans all 1,544 file-metric rows × all 582k coords.
  - Each of the 62 `mb.delete()` batches (`:258`) issues a COW `tbl.delete(In("kafka_offset", [10k offsets]))`. Because offsets are **interleaved across all files** (nothing scopes the delete to a partition), a 10k-offset IN-list overlaps essentially every data file's metric bounds ⇒ each batch rewrites a large fraction of the table into arrow (`_maintenance_base.py:460` `fetch_arrow_table` + `:467` schema cast copy), ×62 commits, ×PyIceberg manifest churn — well past 4Gi.
  - The memory valve `BRONZE_DEDUP_MAX_REWRITE_BYTES` (default 2Gi, `:242`) bounds *affected-file bytes*, not the delete loop's actual working set; files without usable `kafka_offset` metrics are counted conservatively, so the valve under-bounds the real pressure.
  - The job is **all-or-nothing and non-resumable**: `:260` rechecks for ZERO remaining dupes and exits 1 on any remainder. A run killed at batch 15/62 leaves the deletes it committed but no checkpoint; the next run (days later) re-scans the full 1.38M table, finds the same ~432k remaining + any fresh dupes, and attempts the full set again. The backlog never shrinks; it only grows if Connect churn outpaces dedup's completion rate.

**F2 — the partition transform exists but the compaction/dedup path does not exploit it.**
`collector_events_connect` **is** partitioned `month(kafka_timestamp)` (`infra/kafka-connect/iceberg-bronze-collector.json:27`, `infra/helm/kafka-connect/values.yaml:143`; a `timestamptz` source, transform kind `tstz`), sized for month() to keep partitions <100MB (AUD-IMPL-025, was `day()` and floored ~700 daily partitions). `_maintenance_base._rewrite_units` (`:291`) already knows how to chunk a `MonthTransform` on a timestamp source into per-month rewrite units (`:380–390`) — but its own docstring (`:299`) still calls this table "unpartitioned … a single whole-table unit" (stale since the AUD-IMPL-025 repartition). Whether the whole-table OOM is because that stale assumption is realized in behavior, or because `dedup` never scopes to a month at all, the fix is the same: **the unit of work must be one month-partition, hot-months-only.** 99%+ of dupes are in the current (hot) month — Kafka-Connect at-least-once redelivery lands the redelivered copy seconds-to-minutes after the original, always the same month; frozen months are already deduped and must never be re-touched.

**F3 — ownership is orphaned (wrong cadence).**
Bronze is written by Kafka-Connect, NOT the transform tick. ADR-0016 folded *Silver* hot-table maintenance into the tick under its lock, but nothing keeps pace with Connect's continuous Bronze fragmentation — Bronze maintenance lives ONLY in the daily `bronze-maintenance` cron, which is exactly the broken one. A table fragmenting at ~5,760 files/day cannot be maintained by a once-daily job even when dedup works.

**F4 — the operational-read endpoints still full-scan a growing keystone (read-side).**
The three Bronze-reading dashboard endpoints (`get-recent-events.ts`, `get-data-health.ts`, `get-tracking-health.ts`) were **already repointed** off the raw `collector_events_connect_lifted` lift view to `brain_serving.mv_silver_collector_event` on 2026-07-20 (`_bronze-source.ts` header). That fixed the per-row JSON-lift of the raw envelope, but **moved the doctrine violation one tier over** — `mv_silver_collector_event` is a thin passthrough over `iceberg.brain_silver.silver_collector_event`, a large, growing, MERGE-churned keystone:
  - `get-recent-events`: `... ORDER BY occurred_at DESC LIMIT 50` + per-row `json_extract` of `payload.properties/brain_anon_id/hashed_session_id/consent_flags`. `occurred_at` has no sort order in the mart and the table is partitioned on `kafka_timestamp` (month), so DuckDB **full-scans + global top-N sorts the entire keystone** per cache-miss — the single-query-ceiling violation.
  - `get-data-health` / `get-tracking-health`: `COUNT(*)`, `MAX(occurred_at)`, and a 30-day `date_trunc('day', occurred_at)` GROUP BY — full scans with no prunable predicate on `occurred_at`; `get-tracking-health` does five sequential scans.
  - `serving-ttl.ts:63–70` masks this with the 5-min `executive` TTL and its own comment flags it as an interim bound, not the fix ("AUD-IMPL-025's partition spec … is the longer-term pruning fix"). A cache-miss still runs the full scan and can 504.

The correct posture already exists in the codebase: `get-medallion-journey.ts`'s **CHEAP-METADATA DOCTRINE** — freshness/state from the tiny `silver_job_watermark` side-table, counts best-effort from manifest stats, never a full column scan. The operational reads must adopt the same posture: read a small, pre-baked, sorted/aggregated mart, never the raw growing keystone.

Every fault here is fixed overhead on tiny logical data — a bounded month of hot rows, a top-50 list, a 30-day histogram — none of it scaling with total Bronze volume. This mirrors ADR-0016's core finding: attack the fixed cost, don't reverse the architecture.

## Decision

Two coordinated fixes shipped as one plan — a maintenance-side (write) fix that makes ADR-0015's convergence promise hold within 4–8 Gi, and a read-side fix that removes the last keystone full-scan. All changes are flag-gated with safe defaults, additive/reversible, and delete-what-they-replace. No streaming Bronze sink, no DB spool, no dropped unique event (ADR-0015 preserved). No StarRocks/Trino/Spark/dbt reintroduced (v4-naming-guard preserved).

### Maintenance-side (write) — make dedup + compaction month-scoped, bounded, resumable, on the right owner

**D1 — Month-partition-scoped, checkpointed dedup (`bronze_dedup.py`).**
Add `BRONZE_DEDUP_PARTITION_SCOPED` (default **ON**) and `BRONZE_DEDUP_MONTHS_BACK` (default **1** = current + previous month; covers a redelivery straddling a month boundary).
- Enumerate month-partitions from `tbl.inspect.files()` (the `month` partition value already rides each file row, same access `_rewrite_units` uses at `:354`); pick the newest N months.
- For **each month independently**: add the partition predicate `kafka_timestamp >= TIMESTAMPTZ '<month_start>' AND < '<month_end>'` to the dup-count / loser SQL guard, delete that month's losers with the same batched offset IN-list COW delete **plus** the month predicate on the delete expression (`And(monthRange, EqualTo(kafka_partition, p), In(kafka_offset, offsets))`) — so the COW rewrite is scoped to files in that one month and the valve bounds a real, small set. **Recheck-and-commit that month before moving to the next.** A finished month is durable progress: an OOM/SIGTERM in month K leaves months <K deduped (the per-month recheck is the checkpoint). Next run re-scans only the hot months, finds them already clean, fast no-op.
- Escape hatch: `BRONZE_DEDUP_PARTITION_SCOPED=0` = today's whole-table behavior, for a deliberate full-history backfill on a big pod with `BRONZE_DEDUP_FORCE=1`.
- This makes ADR-0015 D2b hold: the hot month is deduped every cycle and stays small; frozen months are cleaned once and never re-touched.

**D2 — Confirm + correct month-partition chunking for compaction (`_maintenance_base._rewrite_units`, `bronze_maintenance.py`).**
`_rewrite_units` already handles `MonthTransform` on a `timestamptz` source; the one gap is the stale "unpartitioned collector table" assumption in its docstring (`:299`) — verify the `tstz` `MonthTransform` int-value → `[start,end)` branch fires for this table so `optimize()` compacts it **one month at a time**, each a bounded COW rewrite under the valve (no whole-table arrow read, no OOM). This is a fix to already-intended behavior, not new machinery. Fix the docstring to match reality.

**D3 — A dedicated `bronze-hot` maintenance lane at Connect-churn cadence (correct owner + cadence).**
Bronze cannot ride the transform tick (Connect writes it, not the tick), and the daily cron is too slow for continuous fragmentation. Mirror the proven Silver-hot lane pattern: add a `bronze-hot` CronWorkflow lane in `bronze-maintenance.yaml`, gated by `sparkBronze.hot.enabled` (default **true**), running **every 2h** (`bronze_dedup.py` month-scoped → `bronze_maintenance.py` optimize month-scoped → expire), `concurrencyPolicy: Forbid`. It only ever touches the hot month(s), so it is bounded and fast. The daily `bronze-maintenance` cron stays (frozen-month sweep + snapshot expiry + `bronze-raw-retention`), now a no-op on already-hot-deduped months. Both fit the current prod pod (8Gi; a month-scoped unit is well within it — no pod resize required, and the whole-table OOM class is eliminated regardless).

### Read-side — pre-baked operational marts (cheap-metadata doctrine)

**D4 — `iceberg.brain_gold.gold_recent_events` — the top-N ring.**
A new Gold builder `db/iceberg/duckdb/gold/gold_recent_events.py` (framework `run_job`/`merge_on_pk`/`ensure_table`, same shape as `gold_repeat_latency.py`, glob-discovered by `run_all.py gold`). It does the expensive `ROW_NUMBER() OVER (PARTITION BY brand_id ORDER BY occurred_at DESC) <= 200` **once per tick in the transform tier**, JSON-lifts the whitelisted, PII-safe `properties` (the `safeDetails` whitelist computed in SQL; PII keys dropped in the builder), precomputes `is_pixel = event_type IN (PIXEL_EVENT_TYPES)`, and `overwrite`s the tiny result (a few thousand rows total across all brands, one small file). Columns: `brand_id, event_id, event_type, occurred_at, ingested_at, anon_id, session_id, has_consent, details_json, is_pixel`.
- **200 not 50**: the endpoint caps at 50 but filters pixel-only *after* the read; 200/brand guarantees ≥50 pixel rows survive. Still trivially small.
- Writes its own `silver_job_watermark` row (`gold-recent-events`) via `write_watermark`, so medallion-journey observability sees it. Full recompute of a bounded window ⇒ replay-safe + idempotent. Rides the existing `*/5` tick that already rebuilds Gold.

**D5 — `iceberg.brain_gold.gold_event_health_daily` — the health histogram.**
A new builder `db/iceberg/duckdb/gold/gold_event_health_daily.py`, grain `(brand_id, event_day, is_pixel)` → `event_count, consent_total, consent_granted, dropped_count, max_occurred_at, max_ingested_at`, bounded to the last ~35 days at build time (30-day window + slack). Collapses all five of `get-tracking-health`'s scans and both of `get-data-health`'s into a read of one tiny daily-grain table (a few hundred rows). Own watermark `gold-event-health-daily`.

**D6 — Serving views + endpoint repoint (contracts byte-identical).**
Two thin projection views `db/iceberg/duckdb/views/mv_gold_recent_events.sql` and `mv_gold_event_health_daily.sql` (applied by the existing `views.py` glob applier, `${BRAND_PREDICATE}` seam identical — both carry `brand_id`). `_bronze-source.ts` gains two view constants and a **flag-gated source selector** `RECENT_EVENTS_FROM_MART` (default **ON**): ON ⇒ endpoints read the pre-baked marts with bounded queries (`SELECT … WHERE ${BRAND_PREDICATE} [AND is_pixel] ORDER BY occurred_at DESC LIMIT n` over ≤200 rows/brand; sums/maxes over the daily table); OFF ⇒ today's keystone-scan behavior (rollback). The `RecentEventsResult` / `DataHealthResult` / `TrackingHealthResult` contracts stay byte-identical — only the SQL and source constant change; `safeDetails` moves to the builder but the wire shape is unchanged. `serving-ttl.ts` keeps the 5-min TTL (now backed by a cheap read; the interim-bound comment is updated to note the mart is the pruning fix).

## Options considered

1. **Bigger pod for whole-table dedup (rejected).** Already partly done (4Gi→8Gi). It buys headroom for one run but does nothing about non-convergence, non-resumability, or the daily-cadence-vs-continuous-fragmentation mismatch; the backlog still grows and re-OOMs at the next volume step. Not durable.
2. **MoR delete-file dedup instead of COW (rejected).** Violates the ADR-0015 erasure/maintenance posture (the maintenance tier never issues MoR DELETEs — `maintenance_capability_probe.py` gate 3) and pushes read-time merge cost onto serving. Wrong tier.
3. **Retire Bronze dedup, rely only on the Silver MERGE backstop (rejected).** Violates the owner's ADR-0015 requirement of no duplicates in ANY queried store *including Bronze*; Bronze is SoR and is read by maintenance/transform jobs directly. The backstop is a backstop, not the primary.
4. **Reduce Connect commit churn (interval up / tasks down) instead of maintenance (rejected as the fix, kept as a knob).** Raising `iceberg.control.commit.interval-ms` or lowering `tasks.max` reduces file count but increases end-to-end landing latency (against ADR-0016/0017 freshness goals) and does not touch the at-least-once **duplicate** problem at all. It is a complementary tuning lever, not the convergence fix.
5. **Fold Bronze maintenance into the transform tick (rejected).** Bronze is Connect-written, not tick-written; the tick's lock/owner is wrong for it (F3). The dedicated `bronze-hot` lane is the correct owner at the correct cadence.
6. **Serve recent-events from the raw lift view with an added index/sort (rejected).** Iceberg has no secondary index; the raw table is unprunable on `occurred_at`/`ingested_at` and grows unbounded. A pre-baked bounded mart is the only shape consistent with the single-query-ceiling doctrine and the existing cheap-metadata reference.
7. **Materialize recent-events as a Redis structure from a stream consumer (rejected).** Reintroduces a stream consumer / operational-state path the architecture forbids (ADR-0015 R8 posture; no new stream consumers). The Gold-mart-on-tick path reuses existing machinery.

## Consequences

- **Bronze converges within 4–8 Gi, every cycle.** The month-scoped, checkpointed dedup + month-scoped compaction bound every rewrite unit to one hot month; the OOM class is eliminated and partial progress is durable. ADR-0015 D2b holds in production for the first time.
- **File count stays bounded** at Connect-churn cadence via the 2h `bronze-hot` lane; the 7-file stopgap becomes the steady state instead of a hack that decays.
- **Operational reads drop from full-keystone-scan to a few-thousand-row / few-hundred-row read**, cheap on the serving node; cache-miss 504s on these three endpoints go away. Doctrine restored (heavy compute in the transform tier, serving reads pre-baked marts).
- **Two new Gold marts + two views** rebuild on the existing `*/5` tick (no new schedule) — trivial added tick cost (bounded windows), observable via their own watermarks.
- **Cost:** no new pod (8Gi sufficient); `bronze-hot` adds a small 2h job on the existing brain-duckdb image. Negligible.
- **New failure mode to watch:** if a redelivery straddles more than `BRONZE_DEDUP_MONTHS_BACK` months (should never happen under EOS transport — dupes land seconds apart), those dupes wait for the daily whole-history-eligible sweep (`PARTITION_SCOPED=0` / `FORCE=1`) rather than the hot lane. Alertable via the existing bronze-dedup tier counter + the post-recheck.

## Invariants preserved

- **No event loss / Bronze is SoR / append-fast (ADR-0015):** dedup only ever deletes **loser** copies of a duplicated `(brand_id, event_id)` keeping the latest delivery; unique events are never touched; malformed (missing-key) rows are never candidates (Silver-quarantine material). Writes stay Connect-append-only; no streaming sink, no DB spool reintroduced.
- **Convergence contract (ADR-0015 D2b):** now actually delivered.
- **Money:** untouched (bigint minor + `currency_code`; these paths carry no money).
- **Tenant isolation:** `brand_id`-first on every new mart row/key; every serving read goes through `${BRAND_PREDICATE}` via the `withSilverBrand`/`withServingBrand` seam (both new views carry `brand_id`).
- **v4-naming-guard (`tools/lint/v4-naming-guard.sh`):** no retired-DB refs, no dbt, no feature-precompute, no new StarRocks/Spark/Trino coupling, no stream-tier identity coupling. Serving reads stay on `brain_serving.mv_*`; maintenance/transform read the rest-Iceberg catalog directly, as allowed.
- **Single-query-ceiling doctrine:** heavy compute (ROW_NUMBER top-N, month COW rewrite, daily histogram) lives in the transform/maintenance tier; serving reads pre-baked marts.

## Kill-switches (all default to the new, safe behavior; flip to revert)

| Flag | Default | OFF = |
| --- | --- | --- |
| `BRONZE_DEDUP_PARTITION_SCOPED` | ON | whole-table dedup (today's behavior) |
| `BRONZE_DEDUP_MONTHS_BACK` | `1` | wider/narrower hot-month window |
| `BRONZE_DEDUP_FORCE` | OFF | (existing) bypass the memory valve for a deliberate backlog clear |
| `sparkBronze.hot.enabled` (Helm) | true | no 2h `bronze-hot` lane (daily cron only) |
| `RECENT_EVENTS_FROM_MART` (`_bronze-source.ts`) | ON | endpoints scan `mv_silver_collector_event` keystone (today's behavior) |

## Rollout (staged, staging-first, reversible at every step)

1. **Staging — dedup convergence.** Deploy `bronze_dedup.py` month-scoped + `_rewrite_units` docstring/behavior verification. Run one manual `bronze_dedup.py` (PARTITION_SCOPED=ON) against staging `collector_events_connect`; confirm each month commits-then-rechecks, peak RSS < 4Gi, and the post-run count is zero-dupe on hot months. Verify a killed run (SIGTERM mid-second-month) leaves the first month deduped and the re-run is a fast no-op on it.
2. **Staging — read marts.** Land `gold_recent_events.py` + `gold_event_health_daily.py` + the two views; run a tick; flip `RECENT_EVENTS_FROM_MART=ON`; confirm the three endpoints return byte-identical contract shapes and read the marts (serving trace shows the `mv_gold_*` view, not the keystone), cache-miss latency < 1s.
3. **Staging — hot lane.** Enable `sparkBronze.hot.enabled`; watch the 2h lane hold file count bounded across several Connect-churn cycles; confirm the daily cron is a no-op on hot months.
4. **Prod — one-off backlog clear.** With the fixed month-scoped dedup, run the current ~582k backlog on the 8Gi pod (month-by-month, checkpointed — no `FORCE` needed now that units are bounded); confirm zero-dupe convergence.
5. **Prod — promote via `release → master`.** Owner-gated promotion (per branching doctrine): the durable design ships behind the flags above with safe defaults; each side is independently revertible by flipping its flag.
