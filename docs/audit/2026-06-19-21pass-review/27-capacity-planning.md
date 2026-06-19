# Capacity Planning Recommendations (2026-06-19)

**Date:** 2026-06-19
**Board:** Capacity Planning / Scalability Economics
**Scope:** Scaling thresholds and actions across 100 / 500 / 1k / 5k / 10k brands. Each bottleneck below is anchored to a real path/line/config in the repo. The scale at which it bites, the symptom, and the action (index / partition / shard / cache / autoscale / queue) are specified per item. Cost inflection points cross-reference `docs/audit/19-cost.md`.

---

## Headline Verdict

**The system is architecturally able to reach ~1k brands on the current code, but four checked-in design choices become hard walls before 5k–10k, and three cost defects inflate OpEx super-linearly from the very first production deploy.** The two structural ceilings that bite earliest and hardest:

1. **Per-request transaction-scoped RLS (`SET LOCAL app.current_brand_id`, `packages/db/src/index.ts:67,96`) forces a transaction wrapper on every brand-scoped query and is incompatible with PgBouncer statement pooling** — at ~1k–5k concurrent brands the Postgres connection ceiling (`createPool` default `max:10`, `packages/db/src/index.ts:181`) on a `db.t4g.medium` (`infra/terraform/modules/rds/main.tf:56`) becomes the binding constraint.
2. **The collector durability anchor is a single-drainer Postgres-table spool with no `FOR UPDATE SKIP LOCKED`** (`apps/collector/src/infrastructure/pg-spool.repository.ts:53-58`) — it cannot be horizontally scaled without double-publishing, so collector drain throughput is pinned to one worker's `LIMIT`-batch loop regardless of brand count.

Headline number: **the live-event ingest lane caps at 12 consumer instances (`infra/redpanda/topics.yml:11`, `partitions: 12`)** — this is the global ceiling on real-time event-processing parallelism and must be raised (re-partition) before ~5k brands at peak.

---

## Capacity Bottleneck Register

### CAP-1 — Transaction-scoped RLS GUC blocks connection pooling; Postgres connection ceiling

**Evidence:** `packages/db/src/index.ts:67` (`BRAND_ID_GUC = 'app.current_brand_id'`), `:96` (`SET LOCAL ${gucName} = '${value}'`), `:181` (`max: config.maxConnections ?? 10`); RLS policy form confirmed in `packages/db/src/rls.test.ts:141` (`USING (brand_id = current_setting('app.current_brand_id', true)::uuid)`); RDS default `infra/terraform/modules/rds/main.tf:56` (`db.t4g.medium`), `:64` (`multi_az` default true but `infra/terraform/envs/staging/main.tf:181` shows `create = false` — RDS not actually provisioned).

**Why it bites:** `SET LOCAL` scopes the GUC to the current transaction (comment `packages/db/src/index.ts:88`). Every brand-scoped read/write must run inside a transaction so the GUC is set then auto-reset. This makes **PgBouncer transaction-pooling the *only* viable pooling mode** (statement pooling would leak the GUC across tenants — a P0 isolation break). Each in-flight brand request therefore holds a real backend connection for the transaction's duration.

| Scale | Symptom | Action |
|---|---|---|
| 100 | None. `db.t4g.medium` handles it. | — |
| 500 | Pool saturation under burst; `core` `rawPgPool max:5` (`apps/core/src/main.ts:352`) + default `max:10` pools contend. | Raise `maxConnections`, front Postgres with PgBouncer in **transaction** mode (never statement). |
| 1k | `db.t4g.medium` (~2 vCPU/4 GB) `max_connections` becomes the wall; connection-wait latency spikes. | **Vertical:** `db.r6g.xlarge`+. Add read replica for Analytics-API read path. |
| 5k | Single primary cannot hold the working set / connection fan-out for write + read + RLS-transaction overhead. | **Shard** Postgres by `brand_id` (tenant-range or hash) OR move read traffic fully to StarRocks/Silver and keep OLTP for control-plane only. Mandatory PgBouncer pool-per-shard. |
| 10k | Single-writer Postgres is structurally insufficient for OLTP at this tenant count. | **Horizontal shard** of OLTP + dedicated control-plane vs. data-plane DB split. |

**Cost inflection:** RDS step-up `medium → r6g.xlarge → sharded fleet` is the steepest OLTP cost curve. Defer it by routing all analytical reads to StarRocks (already the design intent, `apps/core/src/main.ts:361` Silver read pool).

---

### CAP-2 — Collector spool is a single-drainer Postgres table, not horizontally scalable

**Evidence:** `apps/collector/src/infrastructure/pg-spool.repository.ts:53-58` — drain query is `SELECT … FROM collector_spool WHERE status='pending' ORDER BY id LIMIT $1` with **no `FOR UPDATE SKIP LOCKED`**; `apps/collector/src/application/accept-event.usecase.ts` makes the spool INSERT the durability anchor (returns HTTP 500 if it throws — see ARC-3 verdict); spool pool `max:10` (`apps/collector/src/infrastructure/pg-spool.repository.ts:26`); table def `db/migrations/0015_collector_spool.sql:21-32`, index `idx_collector_spool_pending ON collector_spool(id) WHERE status='pending'`.

**Why it bites:** Because the drain query has no row-lock claim semantics, running two drainer instances against the same spool would re-read and double-publish the same pending rows. Drain throughput is therefore pinned to **one worker** iterating `LIMIT`-sized batches. Accept-path durability also depends entirely on Postgres availability (ARC-3) — diverging from ADR-003's disk-WAL design (`docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:946`).

| Scale | Symptom | Action |
|---|---|---|
| 100–500 | Fine; single drainer keeps `spool_pending_count` near zero. | Alert on `spool_pending_count` growth + `pg_pool_errors_total`. |
| 1k | Peak-event bursts (BFCM/Diwali) outrun a single drainer → spool backlog, drain lag. | Add `FOR UPDATE SKIP LOCKED` to `pollPending` so N drainers can claim disjoint batches; **queue** semantics on the table. |
| 5k | Postgres write contention on `collector_spool` (every accept = one INSERT) competes with OLTP. | Move spool off the OLTP primary to a dedicated spool DB instance, or honor ADR-003 disk-WAL per collector pod (EBS/NVMe PVC). |
| 10k | Single shared spool table is an ingest single-point-of-failure; a Postgres failover drops accept for *all* brands simultaneously (ARC-3 tenant impact). | Per-pod disk-WAL (ADR-003) OR partition the spool table by ingest shard; multi-drainer with SKIP-LOCKED is prerequisite. |

**Cost inflection:** Low until the dedicated spool instance at ~5k. The bigger cost is *risk* — a peak-day Postgres blip is a platform-wide accept outage with no per-tenant mitigation.

---

### CAP-3 — Live ingest lane fixed at 12 partitions = hard parallelism ceiling

**Evidence:** `infra/redpanda/topics.yml:11` (`partitions: 12`) on the live collector topic; same for order-backfill DLQ family (`:54,:64`). Partition key is the tenant key (Kafka design). Consumer concurrency cannot exceed partition count.

**Why it bites:** A Kafka/Redpanda consumer group can have at most one active consumer per partition. 12 partitions → at most **12 concurrent stream-worker instances** processing the live lane. Beyond that, adding pods yields zero throughput gain; lag grows monotonically under load.

| Scale | Symptom | Action |
|---|---|---|
| 100–1k | 12 partitions ample. | Monitor consumer-group lag per partition. |
| 5k | At peak event rate, 12 consumers saturate; consumer lag climbs; real-time identity/attribution falls behind. | **Re-partition** live topic to 24–48 (partition increase is online but reshuffles tenant→partition mapping; plan key stability). Autoscale stream-worker to partition count. |
| 10k | 12 is structurally insufficient for peak-day throughput. | Pre-provision 48–96 partitions; co-scale stream-worker HPA to match. Consider per-region topic sharding. |

**Cost inflection:** Redpanda Cloud charges per partition + per GB. Re-partitioning is cheap; the dominant Redpanda cost is the **104× live-lane retention overrun** (`infra/terraform/modules/redpanda/main.tf:89-91`, 730 days vs `topics.yml:14` 7 days — COST-1, Critical). **Fix COST-1 before any partition scaling** or storage cost compounds with partition count.

---

### CAP-4 — Backfill lane is deliberately single-partition (throughput cap by design)

**Evidence:** `infra/redpanda/topics.yml:40,44` — order-backfill lane `partitions: 1`, described as "Single partition = natural throughput cap (ADR-BF-7 / D-3)"; overlap-lock via `FOR UPDATE SKIP LOCKED` (`apps/core/src/modules/connector/backfill/infrastructure/PgBackfillJobRepository.ts:64`).

**Why it bites:** This is a *correct* design choice (prevents backfill storms from lagging the live path) but it means **historical backfill throughput does not scale with brand count.** At 5k–10k brands onboarding concurrently (e.g., a cohort launch), backfill becomes a serialized queue.

| Scale | Symptom | Action |
|---|---|---|
| ≤1k | Acceptable; onboarding backfills complete within SLO. | Track backfill queue depth + age. |
| 5k | New-brand onboarding backfill latency grows; "data still loading" UX for days. | Add a **bounded** second backfill partition/lane OR per-tenant backfill rate-limit + clear ETA UX. Keep the live-lane isolation invariant. |
| 10k | Cohort onboarding waits behind a single-partition queue. | Sharded backfill lanes keyed by onboarding cohort, each isolated from live. |

**Cost inflection:** Negligible infra cost; the cost is **onboarding time-to-value** (a revenue/churn lever, not an OpEx line).

---

### CAP-5 — Per-brand identity salt resolved from one env var per brand

**Evidence:** `packages/identity-core/src/resolve-salt-hex.test.ts:19` — env key is `IDENTITY_SALT_${BRAND.replace(/-/g,'').toUpperCase()}`; resolution order (`:8-16`) is explicit env → dev-derive → prod env; hard-crash on miss (`apps/core/src/main.ts` D-2 guard `getCoreSaltHex`).

**Why it bites:** One environment variable per brand. At 100 brands this is 100 env vars across collector/core/stream-worker pods. At 10k brands it is **10,000 env vars per pod** — well past practical Kubernetes env/ConfigMap and process-environment limits, and a slow pod-startup tax.

| Scale | Symptom | Action |
|---|---|---|
| 100 | Manageable but already smells. | — |
| 500 | ConfigMap/Secret bloat; noisy deploys. | Move salts to a **Secrets-Manager/KMS-backed lookup** keyed by `brand_id`, fetched + cached (TTL) at runtime instead of injected as env. |
| 1k+ | Env-var count approaches K8s/process limits; pod startup slows; per-brand onboarding requires a redeploy. | **Cache** salt fetch in Redis/in-process LRU; resolve lazily on first use per brand. Removes the redeploy-per-onboard coupling. |
| 5k–10k | Env injection is structurally infeasible. | Mandatory KMS/Secrets-Manager + cache; no env-var path in prod. |

**Cost inflection:** Per-brand Secrets Manager entries (~$0.40/secret/month) — at 10k brands ~$4k/month if naively one-secret-per-brand. Use a single keyed secret store (DynamoDB+KMS or one Secrets Manager bundle) to avoid linear secret cost.

---

### CAP-6 — Silver/StarRocks read pool fixed at connectionLimit 5

**Evidence:** `apps/core/src/main.ts:361,366` — `mysql.createPool({ …, connectionLimit: 5 })` for the StarRocks Silver read path (brand predicate injected at `withSilverBrand`, `packages/metric-engine/src/silver-deps.ts`).

**Why it bites:** As OLTP read traffic is (correctly) pushed onto StarRocks/Silver to relieve CAP-1, a 5-connection pool becomes the new chokepoint for the Analytics-API read path.

| Scale | Symptom | Action |
|---|---|---|
| ≤1k | 5 connections sufficient for current Analytics-API volume. | — |
| 5k | Analytics/NLQ read concurrency queues behind 5 connections; dashboard p95 latency rises. | Raise `connectionLimit`, add per-instance pool autoscaling; **cache** hot metric reads (Redis cache-aside, tenant-scoped key). |
| 10k | StarRocks frontend connection fan-out + query concurrency limits bind. | Scale StarRocks BE/FE nodes; materialized-view pre-aggregation for top dashboards; query gateway with admission control. |

**Cost inflection:** StarRocks compute scales with node count. The cheaper lever is **caching** (`engineering-os:caching-strategy`: cached read = an OLAP query not paid) — pin Redis cache-aside on the metric registry read path before scaling BE nodes.

---

### CAP-7 — NLQ resolver on frontier model with no per-brand budget cap (cost, not throughput)

**Evidence:** `packages/ai-gateway-client/src/client.ts:31` (`DEFAULT_RESOLVER_MODEL = 'claude-opus-4-8'` — should be Haiku per `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2217`, COST-2 High); no per-brand budget counter (`packages/ai-gateway-client/src/client.ts:70-102`, COST-5 Medium); gen_ai cost spans no-op (`packages/observability/src/index.ts:7`).

**Why it bites:** This is the steepest *super-linear* cost curve. Per `docs/audit/19-cost.md` COST-2:

| Scale | LLM resolver spend (Opus, current) | After fix (Haiku) |
|---|---|---|
| 100 | ~$650/month | ~$11/month |
| 10k | **~$65k/month** | ~$1.1k/month |

| Scale | Symptom | Action |
|---|---|---|
| Any | Per-call ~60–75× overspend on a schema-constrained 256-token task. | **Route down** to Haiku (cheapest-sufficient tier, `engineering-os:cost-routing-paradigms`). |
| 500+ | A single whale/abusive brand can exhaust gateway quota with no circuit breaker (COST-5). | Add `budget:{brand_id}:{period}` Redis counter + atomic Lua check-and-reserve; deterministic fallback on exhaustion. **Cache** prompt prefixes. |

**Cost inflection (HARD):** model-call spend is the dominant variable OpEx at scale. The 100→10k curve is ~$650→$65k/month *unfixed* vs ~$11→$1.1k/month *fixed* — a ~$64k/month delta at 10k brands. This is the single largest capacity-cost lever in the system.

---

## Cost Inflection Summary (cross-ref `docs/audit/19-cost.md`)

| Inflection | Trigger scale | Driver | Monthly delta if unaddressed |
|---|---|---|---|
| LLM resolver tier (COST-2) | From brand #1, scales linearly | Opus vs Haiku on NLQ | ~$64k/mo @ 10k |
| Redpanda live retention (COST-1) | From first prod deploy | 730d vs 7d, ×104, ×partition count | tens of $k/mo @ 10k |
| S3 Bronze COMPLIANCE lock (COST-3) | Month ~24 onward | 7yr vs 24mo, no lifecycle delete | ~$13.8k/mo by month 84 @ 10k |
| NAT data-processing (COST-4) | Proportional to event ingest | No VPC endpoints | scales with S3 write GB |
| RDS step-up (CAP-1) | ~1k → 5k brands | `t4g.medium` → `r6g.xlarge` → shard fleet | steepest OLTP curve |
| Per-brand secrets (CAP-5) | ~5k brands | one secret/brand naïvely | ~$4k/mo @ 10k if mismodeled |

---

## Prioritized Capacity Actions (in bite-order)

1. **Now (pre-prod):** Fix COST-1 (Redpanda 730d→7d) and COST-3 (Bronze COMPLIANCE→GOVERNANCE) — both are *immutable once provisioned*. Re-tier NLQ to Haiku (COST-2).
2. **Before 1k:** PgBouncer transaction-mode in front of Postgres (CAP-1); add `FOR UPDATE SKIP LOCKED` to spool drain (CAP-2); per-brand LLM budget counter (COST-5/CAP-7); VPC endpoints (COST-4).
3. **Before 5k:** RDS vertical step + read replica; re-partition live lane to 24–48 (CAP-3); move salt resolution to KMS/cache (CAP-5); Redis cache-aside on metric reads (CAP-6).
4. **Before 10k:** Shard OLTP by brand_id or split control-plane/data-plane DBs (CAP-1); dedicated/disk-WAL spool (CAP-2/ADR-003); sharded backfill lanes (CAP-4); StarRocks BE/FE scale-out (CAP-6).

---

*Note: per-pass reports `01-…26` referenced in the audit harness are not all materialized on disk; only `docs/audit/19-cost.md` exists. All thresholds above are anchored to source/config actually opened during this pass, not to those reports.*
