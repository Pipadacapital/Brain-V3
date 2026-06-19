# Pass 12: Scalability Audit (scalability)

## Board Verdict

Brain's event-ingest pipeline (Collector → spool → Redpanda → stream-worker) is architecturally sound at low brand counts: the single-partition order-backfill topic caps storm risk, the 12-partition live topic provides adequate parallel throughput, and dedup layers (Redis NX + Postgres PK) are stateless per-tenant. However, five concrete ceilings were identified that become load-bearing between 100 and 10 k active brands. The most critical is the unbounded, housekeeping-free `collector_spool` Postgres table: it is append-only by design (no DELETE grant, no cleanup job) with a partial index only on `status = 'pending'`, so at high throughput the table bloats indefinitely and the sequential drainer scan will degrade as the "drained" tail grows. The second tier concerns the revenue-finalization and DQ-check jobs, which iterate over every brand serially inside a single process with a fixed small connection pool (max: 3–5), giving a linear time-to-complete that becomes a SLA breach at 500+ brands. Third, the `ingest-scheduler` runs every connector for every brand sequentially every 45 seconds inside a single stream-worker pod; at 1 k brands × 4 connectors per brand the tick will take longer than the interval, but the `inFlight` guard serializes ticks rather than shedding them — the scheduler silently falls behind. Fourth, the completeness and KPI-summary queries do full-table `COUNT(*)` scans on `bronze_events` and `realized_revenue_ledger` under a partial-predicate index that only filters by `brand_id`, no time window; these degrade from O(brand rows) to O(total rows) as tenant history accumulates. Fifth, the RDS module declares a single `db.t4g.medium` instance with no read replica; all eight consumer groups in the stream-worker process plus the analytics API and cron jobs contend on one writer, and the Terraform config has no `replica_count` variable.

**Severity distribution: 1 Critical · 2 High · 1 Medium · 1 Low**

---

## Finding SCALE-1

**Title:** `collector_spool` has no housekeeping — table grows unboundedly with "drained" rows, degrading the drainer's poll path

**Severity:** Critical

**Category:** DB Bottlenecks

**evidenceRef:** `db/migrations/0015_collector_spool.sql:13,31-33` — the migration comment explicitly says "No DELETE — spool rows are append-only; archival is a future housekeeping job"; the partial index `idx_collector_spool_pending` covers only `WHERE status = 'pending'`; brain_app is granted `SELECT, INSERT, UPDATE` but not `DELETE`. The drainer polls via `SELECT … WHERE status = 'pending' ORDER BY id LIMIT $1` (apps/collector/src/infrastructure/pg-spool.repository.ts:51-57), which uses the partial index for the pending subset, but as the "drained" segment grows the table file itself balloons, increasing heap scan costs for VACUUM and WAL volume.

**Impact:** At high event rates (e.g., 500 brands × 1 000 events/day), spool rows accumulate at the rate of inserts. The table is never pruned. After 90 days at 1 M events/day, the table holds ~90 M rows, the vast majority in status='drained'. Postgres VACUUM must traverse all pages to reclaim dead tuples, and at large dead-row counts index bloat on the partial index itself increases. The drainer's `pollPending` scan stays fast (partial index), but the surrounding table file bloat increases I/O for every Postgres checkpoint and backup, eventually causing autovacuum contention with the live ingest path. On RDS gp3 storage at `allocated_storage: 100` GB this also triggers a storage ceiling before hitting a brand count ceiling.

**Root Cause:** The migration acknowledges the gap ("archival is a future housekeeping job") but no such job exists in the codebase. The brain_app role is intentionally denied DELETE to protect the spool as a durability anchor, but no separate maintenance role or TRUNCATE-partition strategy is implemented.

**Fix:** (1) Add a time-based partition on `collector_spool.received_at` (weekly or monthly) so old partitions can be detached and dropped by a maintenance job without touching live rows. (2) Alternatively, create a separate DB maintenance role with DELETE privilege on drained rows older than 30 days and wire it to an Argo CronJob that runs `DELETE FROM collector_spool WHERE status = 'drained' AND drained_at < NOW() - INTERVAL '30 days'`. (3) Add a `collector_spool_row_count` Prometheus gauge split by status so the growth rate is observable before it becomes a storage incident.

**Priority:** P0

**Tenant Impact:** Single shared spool table; affects all brands indiscriminately. A table-lock during VACUUM or a storage-full event halts the ingest path for every tenant simultaneously — maximum blast radius.

**Detection:** No alert exists. Surfaces as storage-capacity warning on RDS CloudWatch, spike in autovacuum duration in performance_insights (enabled in `infra/terraform/modules/rds/main.tf:152`), or as drainer throughput drop visible in the missing `collector_spool_row_count` metric.

---

## Finding SCALE-2

**Title:** Revenue-finalization and DQ-check jobs iterate brands serially with a fixed pool of 3 connections — linear wall-clock time makes SLA unachievable at 500+ brands

**Severity:** High

**Category:** Event-Processing Bottlenecks / Infra Bottlenecks

**evidenceRef:** `apps/stream-worker/src/jobs/revenue-finalization.ts:79` — `new Pool({ connectionString: DB_URL, max: 3 })`; the main loop at line 109 is a `for (const brand of brandsRes.rows)` with sequential `await client.query(...)` calls — every brand is fully processed before the next starts. `apps/stream-worker/src/jobs/dq/run.ts:84-96` — `tick()` iterates brands with a sequential `for (const brandId of brands)` loop using a `max: 3` pool (main.ts:263 `new PgPool({ connectionString: dbUrl, max: 3 })`).

**Impact:** At 100 brands with an average of 50 qualifying provisionals each, the finalization job processes roughly 100 × (1 round-trip for query + N inserts) = O(100 × N) sequential DB operations. At 500 brands this becomes 5× slower, and at 1 000 brands it is 10× slower. If each brand takes 200 ms (conservative for a non-trivial query + 50 inserts), 1 000 brands = 200 seconds per job run. If the Argo CronJob is scheduled nightly, this budget is fine; but there is no circuit-breaker if a brand takes 5 s (timeout mis-set, large provisionals batch). The DQ check is wired as a stream-worker interval loop (default 300 s), so a 1 000-brand tick that takes > 300 s causes the `inFlight` guard to block the next tick indefinitely — DQ grades go stale.

**Root Cause:** The sequential-brand loop is deliberate (rate-limit-safe, fail-isolated per brand), but the pool size (3) caps the degree of parallelism even if the loop were to be parallelized. No concurrency boundary (e.g., `pLimit`) exists. The job was designed for a small brand count and has no mention of scaling mode in the comments.

**Fix:** (1) For revenue-finalization: run brands in parallel batches of N (e.g., 10) using `Promise.allSettled`, bounded by the pool size (increase `max` proportionally). (2) For DQ checks: split the tick into a chunked fan-out with `pLimit(20)` and increase the DQ pool to match. (3) Add a `revenue_finalization_duration_seconds` histogram and alert if the 95th percentile exceeds 80% of the CronJob's `activeDeadlineSeconds`.

**Priority:** P1

**Tenant Impact:** If the job exceeds its run window, brands that appear later in `list_active_brand_ids()` (ORDER BY created_at ASC — confirmed in migration 0019:64) may not be finalized in the current cycle, causing provisional revenue to persist one extra period. This silently under-reports realized GMV for those brands.

**Detection:** No job-duration metric exists. Surfaces as provisionals that never finalize, discoverable only by a brand-level audit query. Add `job_duration_seconds` gauge to the revenue-finalization entry point.

---

## Finding SCALE-3

**Title:** The ingest-scheduler runs every connector for every brand sequentially every 45 s in a single stream-worker pod — at 1 k brands × 4 connectors, tick duration exceeds interval

**Severity:** High

**Category:** Event-Processing Bottlenecks / Infra Bottlenecks

**evidenceRef:** `apps/stream-worker/src/jobs/ingest-scheduler/run.ts:63-83` — the tick dispatches connectors with a `for (const connector of connectors)` loop, explicitly sequential: "SEQUENTIAL dispatch (never Promise.all) — rate-limit-safe; one provider at a time." The `inFlight` guard at line 127 (`if (!inFlight)`) silently skips any tick that fires while a previous tick is still running. The default interval is `DEFAULT_INTERVAL_MS = 45_000` (45 s), floor at 15 s.

**Impact:** At 1 000 brands × 4 connectors = 4 000 dispatches per tick. Each `run(connectorInstanceId)` makes at least one Shopify/Meta/Google/Razorpay API call. Even at a generous 50 ms average per connector (no rate-limit sleep), the tick takes 200 s — more than 4× the 45 s interval. The `inFlight` guard means only one tick runs at a time; the scheduler silently runs at ~1/4 frequency, making the "near-real-time polling" claim from architecture §3.3 untrue at scale. The per-connector `REPULL_PAGE_SLEEP_MS` sleep makes this worse in practice.

**Root Cause:** Sequential dispatch was chosen deliberately to avoid API rate-limit burst. However, the design assumes each dispatch takes a negligible fraction of the interval. No brand count budget or adaptive backoff is documented. The `inFlight` guard prevents queue buildup but also hides the falling-behind problem — there is no alert.

**Fix:** (1) Add a `ingest_scheduler_tick_duration_seconds` histogram and a `ingest_scheduler_overrun_total` counter (incremented when a tick is skipped because `inFlight = true`). (2) Shard the scheduler by provider: one interval loop per connector family (shopify, razorpay, meta/google_ads) so each provider's rate-limit is isolated and ticks can overlap across providers. (3) Or partition brands across stream-worker replica pods (e.g., by brand_id hash bucket) so the connector list per pod is proportionally smaller.

**Priority:** P1

**Tenant Impact:** All brands behind the sequential waterfall in the tick receive stale data. Brands earlier in the enumeration order are consistently fresher than brands later in the list — a non-obvious, brand-count-dependent freshness disparity with no observable signal to the tenant.

**Detection:** Missing. Surfaces as connector_sync_status.last_sync_at drifting further behind wall-clock as brand count grows. The DQ freshness check (freshness-check.ts:99-103) for `connector_sync_status` will grade late brands as D, but only if the DQ check itself is not also behind (SCALE-2).

---

## Finding SCALE-4

**Title:** Completeness and KPI-summary queries issue full-table `COUNT(*)` scans on `bronze_events` and `realized_revenue_ledger` with no time-window bound

**Severity:** Medium

**Category:** DB Bottlenecks / OLAP Query Bottlenecks

**evidenceRef:**
- `apps/stream-worker/src/jobs/dq/completeness-check.ts:68-74` — `SELECT COUNT(*) … FROM ${t.table} WHERE brand_id = $1` with no `occurred_at` or `created_at` filter. The table `bronze_events` has only `idx_bronze_events_brand_type ON bronze_events (brand_id, event_type, occurred_at DESC)` (migration 0016:58-59); a bare `COUNT(*)` with `brand_id = $1` will use an index scan over all brand rows regardless of age.
- `packages/metric-engine/src/kpi-summary.ts:51-106` — the `all_orders` CTE does `SELECT DISTINCT order_id … WHERE brand_id = $1 AND occurred_at::date <= $2::date` with no lower-bound on `occurred_at`; at 3 years of brand history this scans from epoch.
- `packages/metric-engine/src/revenue-timeseries.ts:70-117` — the realized/provisional CTEs filter `occurred_at::date BETWEEN $2::date AND $4::date` which is correctly bounded, but the `kpi-summary` as-of queries are not.

**Impact:** For a brand operational for 3 years at 500 orders/day, `realized_revenue_ledger` accumulates ~550 000 rows. The `kpi-summary` `all_orders` CTE performs a `COUNT(DISTINCT order_id)` over all of them on every dashboard load. At 1 000 brands × 550 000 rows = 550 M rows of aggregate potential if concurrent sessions hit the ledger. The RDS instance is a single-node `db.t4g.medium` (2 vCPU, 4 GB RAM) with no read replica per the Terraform module.

**Root Cause:** The `kpi-summary` query was written for M1 where brand history is days or weeks. No `occurred_at >= NOW() - INTERVAL '...'` lower bound was imposed because "as of date" is the only filter. The index `idx_rrl_asof ON realized_revenue_ledger (brand_id, economic_effective_at) WHERE event_type <> 'provisional_recognition'` covers the partial-scan for `realized_gmv_as_of()` but the `all_orders` CTE in kpi-summary does not use `economic_effective_at` — it uses `occurred_at::date` which is not covered by `idx_rrl_asof`.

**Fix:** (1) Add a composite index `ON realized_revenue_ledger (brand_id, occurred_at DESC, order_id)` to cover the `all_orders` and `rto_orders` CTEs. (2) For the completeness check, add a `TABLESAMPLE BERNOULLI(1)` or impose a `created_at > NOW() - INTERVAL '7 days'` window to make the check representative without a full scan. (3) Add a read replica in the RDS module (`replica_count` variable) and route metric-engine reads to the replica endpoint.

**Priority:** P2

**Tenant Impact:** Per-brand query degradation: a long-tenured high-volume brand's dashboard loads are slow, but isolation is enforced by RLS so no cross-brand read occurs. However, on a single RDS instance, a slow query for one brand holds a connection and can starve pool connections for other brands.

**Detection:** `log_min_duration_statement = 1000` ms is set in `infra/terraform/modules/rds/main.tf:103`; slow queries will appear in CloudWatch Logs. However, no alert is wired in `infra/observe/prometheus.yml` (scrape targets are otel-collector, collector, stream-worker only; RDS slow-query log is not forwarded to Prometheus).

---

## Finding SCALE-5

**Title:** Single-node RDS `db.t4g.medium` with no read replica — all 8 consumer groups plus analytics API contend on one writer

**Severity:** Low

**Category:** Infra Bottlenecks / Cost Inflection Points

**evidenceRef:** `infra/terraform/modules/rds/main.tf:54-58` — `variable "instance_class" { default = "db.t4g.medium" }` and `variable "allocated_storage" { default = 100 }`. No `aws_db_instance_read_replica` resource or `replica_count` variable exists in the module. `apps/stream-worker/src/main.ts:103,167,188,199,214,228,243,263,294` — the main.ts wires 8 Kafka consumers (CollectorEventConsumer, IdentityBridgeConsumer, ConsentSuppressorConsumer, CapiDeletionConsumer, BackfillOrderConsumer, LiveLedgerBridgeConsumer, SettlementLedgerConsumer, SpendLedgerConsumer, GokwikAwbLedgerConsumer) each with their own `Pool` connected to the same `dbUrl`, plus the DQ pool, sync-claimer pool, and ingest-scheduler pool — all pointed at the single writer.

**Impact:** `db.t4g.medium` has 2 vCPU and 4 GB RAM. The stream-worker alone opens up to 9 pools × max 5 connections = 45 writer connections; the collector opens 10; apps/core opens an unaudited number. At 100 brands with moderate throughput, total active connections can saturate `db.t4g.medium`'s default `max_connections` (~170 for this instance class). At 500 brands, writes per second on `bronze_events` and `realized_revenue_ledger` exceed what a t4g.medium can sustain without replication lag risk on the standby (Multi-AZ is configured, so the standby is a hot-standby write receiver that adds latency under heavy write load).

**Root Cause:** The RDS module was intentionally under-specified at the infrastructure-declaration stage (EC10 comment: "dev=real compute; staging/prod=0"). No read-replica variable or HPA-aware connection-pool sizing has been modelled for production traffic.

**Fix:** (1) Add a `replica_count` variable and `aws_db_instance` read replica resource to the RDS module; route metric-engine and analytics API reads to the reader endpoint. (2) Add PgBouncer (transaction-mode) in front of the writer to multiplex the 45+ application connections into a smaller set of server connections. (3) Upgrade to `db.r8g.large` (2 vCPU, 16 GB) for production launch, with autoscaling storage enabled.

**Priority:** P3

**Tenant Impact:** Connection exhaustion on the single writer affects all tenants simultaneously. A pool starvation event in one consumer group can cascade to block other groups' writes (they share the same Postgres server), creating cross-tenant latency spikes with no per-tenant isolation at the DB connection layer.

**Detection:** RDS CloudWatch `DatabaseConnections` metric (Performance Insights is enabled per `infra/terraform/modules/rds/main.tf:152`) will show saturation. No alert threshold is wired in `infra/observe/prometheus.yml`.
