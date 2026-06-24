# ADR-0005 — StarRocks entity-mart partitioning policy

Status: Accepted (2026-06-24)
Supersedes the partial/parse-only attempt in the architecture-compliance Wave-1 (which used
`dynamic_partition` and did not build).

## Context

Audit finding PF-1 (Critical, scale): the StarRocks Silver/Gold marts were unpartitioned, so
date-filtered KPIs full-scanned every brand's full history and there was no TTL → unbounded growth at
1000 brands. The naive remedy ("partition every event-time mart by `occurred_at`") is wrong for two
reasons:

1. **PRIMARY KEY constraint.** A StarRocks PRIMARY/UNIQUE-key (upsert) table requires the partition
   column to be part of the key. Adding `occurred_at` to a `(brand_id, order_id)` / `(brand_id, event_id)`
   key changes the dedup grain and breaks idempotent upsert (I-E02 replay safety).
2. **`dynamic_partition` + full-rebuild CTAS deadlock.** Dynamic partitions are created asynchronously
   by the FE scheduler, so a `CREATE TABLE … AS SELECT` that inserts immediately fails with
   "data cannot be inserted into table with empty partition." (This is why the Wave-1 attempt only
   `dbt parse`-validated and never built.)

## Decision

Partition **by table CLASS, not blanket**, and use **StarRocks expression partitioning**
(`partition_type='Expr'`, `partition_by=["date_trunc('<unit>', <ts>)"]`), which auto-creates a partition
per value **on insert** (works with full-rebuild CTAS — no async scheduler, no empty-partition error).

### Class A — event-grain APPEND marts → partition + TTL
One row per event, full-rebuild `table`, the key is only for dedup (the SQL already dedups). Convert
`PRIMARY` → `DUPLICATE` (no storage upsert needed) and add expression partitioning:

| Mart | partition expr | retention |
|---|---|---|
| `silver_touchpoint` | `date_trunc('day', occurred_at)` | 400-day WHERE window (behavioral, high-volume — TTL is the point) |
| `silver_checkout_signal` | `date_trunc('day', occurred_at)` | 400-day WHERE window |
| `gold_revenue_ledger` | `date_trunc('month', occurred_at)` | keep-all (financial; month partitions are few) |
| `silver_marketing_spend` | `date_trunc('month', stat_date)` | keep-all |
| `gold_attribution_paths` | `date_trunc('month', path_end_at)` | keep-all |

Behavioral marts carry a `WHERE <ts> >= date_sub(now(), interval 400 day)` so the full rebuild stays
within the retention window (this IS the bounded-growth TTL). Financial marts keep full history (pruning,
not TTL). The partition expression column is asserted NOT NULL (StarRocks expr partitioning rejects NULL).

Snapshot/feature marts (`snap_order_state`, `snap_attribution_credit`, `feature_customer_daily`) stay
`PRIMARY` (their `snapshot_date` IS in the key) but use `Expr` partitioning + `partition_live_number`
(rolling ~400-day TTL) — fixing the Wave-1 `dynamic_partition` build break.

### Class B — entity CURRENT-STATE marts → NOT date-partitioned
One row per ENTITY (latest state), incremental upsert: `silver_order_state`, `silver_order_line`,
`silver_shipment`, `gold_customer_360`, `gold_customer_scores`, `gold_executive_metrics`. These are
**deliberately not date-partitioned**: their size is bounded by entity count (orders/customers), not
event count; they are already `DISTRIBUTED BY HASH(brand_id…)` + brand-leading sort key (brand pruning);
and date-partitioning would force `occurred_at` into the upsert key, breaking the `(brand_id, entity_id)`
latest-state grain (I-E02). Their growth is naturally bounded — no TTL needed.

### Read side
Date predicates must be SARGABLE to use the new partitions — `CAST(occurred_at AS DATE) <= x` defeats
pruning. Fixed in `kpi-summary` (`occurred_at < x+1day`); the same rule applies to all readers (audit H4).

## Consequences

- Date-filtered KPIs prune to the relevant partitions; behavioral marts have a bounded 13-month window.
- Class-A marts are `DUPLICATE` (no storage dedup) — uniqueness is the SQL's responsibility (full-rebuild
  deterministic models already guarantee it; dbt uniqueness tests guard).
- Verified building against live StarRocks (touchpoint daily partitions; revenue/attribution/spend month;
  snapshots day) — see the refactor commit.

See [[0002-iceberg-bronze-spark-streaming]].
