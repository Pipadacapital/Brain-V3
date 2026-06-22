# C4b — Unbounded-table partitioning decisions

DB-AUDIT C4b RANGE-partitions the unbounded, append-only Postgres tables so retention/archival is an
O(1) partition DROP and time-bounded reads prune. Every conversion uses the same prod-safe **twin-swap**
template (build a partitioned twin → copy → recreate indexes/RLS/grants/triggers → atomic rename),
verified by a row-count + relkind guard inside the migration.

## Partitioned (done)

| Table | Migration | Partition key | Dedup handling |
|-------|-----------|---------------|----------------|
| `billing.realized_revenue_ledger` | 0073 | `RANGE(occurred_date)` (app-set, CHECK-pinned date) | dedup + PK widened with `occurred_date`; refund PK ON CONFLICT widened |
| `audit.dq_check_result` | 0072 | `RANGE(checked_at)` | surrogate PK widened |
| `billing.ad_spend_ledger` | 0074 | `RANGE(stat_date)` | dedup key **already** contained `stat_date` — no writer change; PK widened |
| `audit.identity_audit` | 0075 | `RANGE(occurred_at)` | surrogate PK widened; plain append (no ON CONFLICT) |
| `audit.decision_log` | 0076 | `RANGE(created_at)` | surrogate PK widened; plain append |
| `audit.send_log` | 0077 | `RANGE(created_at)` | surrogate PK widened; plain append; UPDATE grant retained (status transition) |
| `billing.tax_ledger` | 0078 | `RANGE(created_at)` | surrogate PK widened; writes via SECURITY DEFINER fns |

Lifecycle: `public.maintain_time_partitions(ahead_months, retention_months)` (migration 0080) creates
current+N months ahead on every partitioned table and optionally drops aged-out partitions (never the
DEFAULT). Invoked by `apps/stream-worker/src/jobs/partition-maintenance.ts` (Argo CronJob in prod;
pg_partman/pg_cron are not installed here). The `*_legacy` twin-swap leftovers are dropped by 0081.

## Deliberately NOT RANGE-partitioned (architectural finding, not a skip)

These tables are unbounded but their dedup/idempotency key is **logical/content-based and independent of
time** — a re-arrival at a different wall-clock time must still collapse to one row. A partitioned
UNIQUE index must include the partition key, so adding a time column to the dedup key would let a retry
on a different day create a duplicate (silent double-count). Partitioning them by time is therefore
**incorrect**, not merely deferred:

| Table | Why time-partitioning breaks dedup |
|-------|-----------------------------------|
| `audit.audit_log` | global `idempotency_key` UNIQUE — must dedup across all time |
| `billing.attribution_credit_ledger` | logical credit key `(order_id, brain_anon_id, touch_seq, model_id, row_kind, reversed_of)` — re-credit must collapse regardless of recompute time |
| `audit.capi_passback_log` | per-`(brand_id, event_id)` dedup — a re-passback of the same event must not duplicate |
| `audit.capi_deletion_log` | `(brand_id, subject_hash, platform, source_event_id)` dedup — retry-stable, time-independent |
| `connectors.connector_webhook_raw_archive` | `(brand_id, topic, body_sha256)` content-hash dedup |
| `identity.identity_merge_event` | deterministic `merge_id` PK (D-4 replay idempotency) — a replayed merge must collapse |

Other unbounded tables already have a bounded lifecycle and need no partitioning:
- `data_plane.collector_spool` — transient spool with a retention reaper (M6 / migration 0069).
- `data_plane.bronze_events` — retired (C4; PG bronze writer off, `0070` drop staged).
- `billing.gmv_meter_snapshot` — bounded (one upserted row per brand × billing_period), not append-only.

If any of the logical-dedup tables later needs partitioning, the correct path is a **HASH** partition on
the tenant/key (not RANGE on time) or a separate time-bucketed archive with the logical key preserved.
