# Brain Engineering Excellence Audit — Scalability & Cost (PASS 12 + PASS 19)

**Reviewer:** Independent principal-level reviewer (no codebase attachment)
**Domain:** Scalability behavior at 100 / 500 / 1k / 5k / 10k brands + cost inflection points
**Repo root:** `/Users/rishabhporwal/Desktop/Brain V3/worktrees/audit`
**Date:** 2026-06-19

---

## Executive summary

The **first and dominant bottleneck is the continuous ingest scheduler** (`apps/stream-worker/src/jobs/ingest-scheduler/run.ts`). It is a single-instance, fully-sequential interval loop that, every 45s, enumerates *every connected connector across every brand* and then calls a per-connector `run()` that (a) opens a brand-new `pg.Pool` + Kafka producer per connector, (b) re-enumerates ALL connectors again, and (c) performs a live HTTP re-pull against the upstream provider (Shopify/Meta/Google/Razorpay). This design is O(total connectors) of *external API work serialized inside one tick*, so it cannot complete a 45s cycle past low-hundreds of connectors — and the architecture doc itself states continuous reconciliation is "premature <100 brands" (`docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:347`). The scheduler ships the premature continuous design without the horizontal-scaling primitives (claim/lease, sharding, work queue) that would make it survive growth.

Secondary bottlenecks: (1) **8 Kafka consumer groups each independently re-reading the same live topic** in one stream-worker process; (2) **bronze_events + ledgers accumulating unbounded in Postgres OLTP** (the Iceberg sink was deferred), making Postgres the cost driver as event volume grows; (3) **2× Postgres round-trips per query** from the GUC-set-before-every-query middleware; (4) tiny fixed connection pools (`max: 3`) that don't scale and per-`run()` pool churn that can exhaust `max_connections`.

**Cost trajectory:** Below ~100 brands, current footprint (single Postgres, single Redpanda, StarRocks allin1) is fine. The **first cost inflection is Postgres** — it is simultaneously OLTP, the Bronze event lake, and every ledger, growing with total event volume and never tiering to Iceberg. The **second is the scheduler's compute + provider-API egress**, which scales linearly with connectors and will force a re-architecture (not a rightsizing) well before 1k brands.

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 4 |
| Low | 2 |

---

## CRITICAL

### C1 — Continuous ingest scheduler is single-instance, fully sequential, and re-pulls every connector every tick; cannot scale past low hundreds of connectors
**Severity:** Critical | **Category:** Scalability — first bottleneck | **Priority:** P0

**Evidence:** `apps/stream-worker/src/jobs/ingest-scheduler/run.ts`
- L56-93 `tick()`: `enumerateConnectedConnectors(pool)` returns EVERY connected connector across ALL brands, then a **plain sequential `for` loop** dispatches `run(connector.connector_instance_id)` one at a time. Comment L64: "SEQUENTIAL dispatch (never Promise.all)".
- L112-150 `startIngestScheduler`: one `setTimeout` loop, `inFlight` guard means a tick that takes longer than the interval simply **never overlaps the next** — i.e. the effective cycle time silently degrades to `tick_duration`, not 45s.
- L48 `DEFAULT_INTERVAL_MS = 45_000`; wired in `apps/stream-worker/src/main.ts:294-301` as a **single** `startIngestScheduler(...)` call — one instance, no sharding key, no partitioning across worker replicas.

Each `run()` is a **live external API re-pull** (see `apps/stream-worker/src/jobs/shopify-repull/run.ts:81-305`): connect Kafka producer, enumerate connectors AGAIN (L100, `enumerateConnectors`), acquire lock, fetch token, fetch salt, then a **multi-page HTTP loop against Shopify** (L217-292) with optional `REPULL_PAGE_SLEEP_MS` throttle. A single Shopify re-pull is seconds of wall-clock; serialized across N connectors, the tick duration ≈ Σ(per-connector HTTP time).

**Impact (production):** At ~100 connectors with ~3s average re-pull, a single tick is ~300s — **7× over the 45s target**; the `inFlight` guard means the "near-real-time" SLA silently collapses to ~5-minute reconciliation and worsens linearly. At 1k brands (≥1k connectors) a single tick is tens of minutes; at 10k it never completes. There is **no second worker replica that can help** — the loop has no claim/lease/shard, so running two stream-workers just doubles the redundant work (both enumerate all, both dispatch all; only the per-connector `FOR UPDATE SKIP LOCKED` in `run()` prevents double-execution, at the cost of wasted enumeration + lock contention). The doc explicitly says continuous reconciliation is "premature <100 brands" (`docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:347`) yet this ships continuous-for-all.

**Root cause:** The scheduler reuses the on-demand claimer's "enumerate ALL → dispatch" primitive for a *continuous all-brands* workload without introducing horizontal partitioning. It conflates "same code path as on-demand" with "same scaling envelope."

**Recommended fix:** Replace whole-fleet enumeration with a **due-work queue**: a `connector_sync_schedule(brand_id, connector_instance_id, next_due_at)` table; each tick `SELECT ... WHERE next_due_at <= now() FOR UPDATE SKIP LOCKED LIMIT batch` so N worker replicas shard the fleet by claim. Bound per-tick concurrency (a small worker pool, not Promise.all-all and not strictly-sequential). Stagger `next_due_at` so the fleet is spread across the interval rather than stampeded each tick. Gate continuous mode behind a brand-count/feature flag per the doc's own "<100 brands" guidance.

**Tenant impact:** Multi-tenant blast radius — one slow/erroring brand's connector inflates tick duration for ALL brands (freshness regression is fleet-wide, not isolated despite the per-connector try/catch). **Detection:** scheduler log `tick done dispatched=X/Y` timestamps drifting; `connector_sync_status.last_sync_at` age climbing across all brands; no existing alert wired on tick duration.

---

### C2 — Per-connector `run()` constructs a new Pool + Kafka producer per dispatch; at fleet scale this exhausts Postgres connections and churns Kafka clients
**Severity:** Critical | **Category:** Scalability / resource exhaustion | **Priority:** P0

**Evidence:**
- `apps/stream-worker/src/jobs/shopify-repull/run.ts:82-83`: every `run()` call does `new Pool({ ..., max: 3 })` + `new Kafka(...)` + `producer.connect()`, and at the end `pool.end()` + `producer.disconnect()` (L117-120). The scheduler calls `run()` **once per connector per tick** (`ingest-scheduler/run.ts:82`).
- Same pattern in `shopify-backfill/run.ts:82-83`, `meta-spend-repull/run.ts`, `google-ads-spend-repull/run.ts`, `razorpay-settlement-repull/run.ts` — each `run()` owns its own pool/producer lifecycle.
- Within a single re-pull, work uses many short-lived `pool.connect()`/`BEGIN`/`COMMIT` cycles each setting GUCs (`shopify-repull/run.ts:318-374`, `383-405`, `407-436`, `447-482`) — a pool of `max:3` is repeatedly acquired/released per page.

**Impact (production):** Although the scheduler is sequential (so pools are nominally created/destroyed one at a time), each `run()` does a full TCP+TLS connect to Postgres AND a full Kafka client bootstrap (metadata fetch, producer connect) **for a single connector's work**, then tears it down. This is enormous per-connector fixed overhead — connection setup can dwarf the actual sync for a connector with no new orders. If the scheduler is ever made concurrent (the obvious scaling fix), `max:3 × concurrency` pools collide with Postgres `max_connections` (no `max_connections` tuning found anywhere in `infra/` or `docker-compose.yml`). Kafka producer connect/disconnect churn also defeats batching and adds broker-side connection load.

**Root cause:** `run()` was designed as a standalone CLI job (`node dist/jobs/.../run.js`, see entrypoint L486-495) and is reused as an in-process library call without separating "owns its own infra" (CLI mode) from "borrows shared infra" (scheduler mode).

**Recommended fix:** Inject a shared Pool + shared long-lived Kafka producer into `run()` (the scheduler already holds `ingestSchedulerPool`). Keep the CLI entrypoint constructing its own only when invoked directly. Centralize one producer per stream-worker process.

**Tenant impact:** Multi-tenant — connection exhaustion is a process-wide failure affecting all brands the worker serves. **Detection:** Postgres `too many connections` errors; Kafka broker connection-count spikes; latency of first query after each `run()` (connect cost) in traces.

---

## HIGH

### H1 — Eight Kafka consumer groups in one process each re-read the entire live topic and filter in-app; consumer fan-out cost scales with topic volume × 8
**Severity:** High | **Category:** Event-processing scalability / cost | **Priority:** P1

**Evidence:** `apps/stream-worker/src/main.ts:54-216` declares 8 consumer groups, most on the **same live topic** (`topic`):
- `stream-worker-live` (L54), `identity-bridge-live` (L55/132), `consent-suppressor` (L61/143), `capi-deletion` (L68/159), `live-ledger-bridge` (L73/190), `settlement-ledger` (L77/206), `spend-ledger` (L82/210), `gokwik-awb-ledger` (L88). Comments repeatedly say "Same live topic, separate consumer group" (L136, L147, L194, L210).
- Several consumers then **filter by event type in application code** (L210 "Filters spend.live.v1") — meaning each group deserializes every message on the topic only to discard most.

**Impact (production):** Every event published to the live topic is delivered to and deserialized by ~6 consumer groups, only one of which usually acts on it. CPU + network for consumption is ~6× the raw event rate. The live topic has 12 partitions (`infra/redpanda/topics.yml:11,22,54,64`), so per-group parallelism is capped at 12 consumers; all 8 groups run **inside one stream-worker process**, so a single process is doing 8 groups' worth of fetch+deserialize+filter. As event volume grows (more brands × more orders), this process becomes CPU-bound on redundant deserialization long before partition count is the limiter.

**Root cause:** "No new topic, no new deployable" guidance (I-E05, cited L64) was applied uniformly, collapsing 8 logically-independent consumers into one process and one topic with in-app filtering instead of routed sub-topics.

**Recommended fix:** Where filtering discards most messages (spend, settlement, gokwik-awb), route to dedicated sub-topics at produce time so consumers read only their slice. Split the heaviest consumer groups into separate deployables so they scale independently (the "graduate when load demands" path). Measure per-group `KafkaConsumerLag` separately.

**Tenant impact:** Multi-tenant — a single hot brand's event burst inflates CPU for all 8 groups, risking lag on the billable live path. **Detection:** stream-worker CPU saturation; per-group consumer lag; the doc's own `kafka-consumer-lag` monitor (observability skill) if wired per-group.

---

### H2 — bronze_events + ledgers accumulate unbounded in Postgres OLTP (Iceberg sink deferred); Postgres is the first cost inflection and has no partitioning/retention
**Severity:** High | **Category:** Cost trajectory / storage | **Priority:** P1

**Evidence:**
- `db/migrations/0016_bronze_events.sql:1-5,9`: "Phase-3 → Iceberg (STACK.md:46). This table is the M1 Bronze sink… no production-grade TS Iceberg writer" — so **all ingested events land in a Postgres table** as the current sink.
- No `PARTITION BY`, no retention/TTL, no archival: `grep PARTITION|retention|TTL|DROP` on the file finds only the rollback `DROP TABLE` comment (L19-20). No `PARTITION BY` exists in any of the 37 migrations (`grep "PARTITION BY" db/migrations/*.sql` → none).
- Realized-revenue ledger same story: `db/migrations/0018_realized_revenue_ledger.sql` — a growing Postgres ledger, no partitioning.

**Impact (production):** Bronze events are the highest-cardinality, fastest-growing data in the system (every order/checkout/event across every brand) and they sit in the OLTP Postgres that also serves auth, workspace, connector, and BFF reads. With no partitioning, table + index bloat degrades autovacuum and every brand-scoped scan; with no retention, storage grows monotonically. **Postgres becomes the first cost inflection** — you pay OLTP-grade storage/IOPS for what should be cheap object-store/Iceberg data, and the single instance's IOPS budget is shared between hot transactional traffic and the event firehose. At 1k+ brands this forces a costly migration under load rather than a planned tier.

**Root cause:** Iceberg Bronze sink was deferred to Phase-3 (a documented, reasonable M1 cut) but **no interim guardrail** (partitioning, retention window, or a separate Postgres instance/tablespace for Bronze) was added to bound the cost until Iceberg lands.

**Recommended fix:** As an interim: range-partition `bronze_events` by `occurred_at` (monthly) so old partitions can be detached/dropped/archived cheaply; set a retention window for Bronze in Postgres (it is explicitly "NOT yet an immutable SoR", L20); consider a dedicated instance/tablespace so the firehose doesn't share IOPS with OLTP. Prioritize the Iceberg writer graduation trigger.

**Tenant impact:** Multi-tenant — shared-instance bloat/IOPS contention degrades every tenant's queries. **Detection:** Postgres table/index size growth; autovacuum lag; rising p95 on tenant mutations (the `PostgresQueryDuration` metric).

---

### H3 — Every RLS-scoped query incurs an extra Postgres round-trip (GUC SET before every query); 2× statement count to Postgres
**Severity:** High | **Category:** DB scalability / latency | **Priority:** P1

**Evidence:** `packages/db/src/index.ts:194-211`: the `query()` wrapper issues `buildContextGucSql(ctx)` as a **separate `rawClient.query(gucSql)`** call (L201-204) before every real query (L209). `buildContextGucSql` (L118-134) emits up to 3 `SET LOCAL` statements. Additionally, **every checkout** runs `buildResetAllGucsSql()` — 3 `RESET` statements — as another round-trip (L192).

**Impact (production):** Each logical read/write is ≥2 network round-trips to Postgres (GUC SET, then query), plus 1 reset round-trip per pool checkout. At the BFF dashboard fan-out (`apps/core/src/modules/frontend-api/internal/bff.routes.ts:777-878` issues multiple `Promise.all` queries per request), this doubles Postgres statement throughput requirements and adds latency. As brand count and request rate grow, Postgres statement-per-second capacity is consumed by GUC plumbing, not useful work — effectively halving DB headroom.

**Note (correctness-adjacent, flagged for the security/DB board):** `SET LOCAL` only persists within a transaction; the wrapper sets it as a standalone statement before the query without a surrounding `BEGIN` (L201-209), so unless callers wrap in a txn the GUC may not survive to the query. The hot-path workers avoid the wrapper and use explicit `BEGIN…SET LOCAL…COMMIT` instead (e.g. `shopify-repull/run.ts:325-333`), which is why this hasn't surfaced — but it indicates the wrapper's per-query SET is both costly and fragile.

**Root cause:** GUC-per-query was chosen for RLS safety without batching the SET into the same wire round-trip as the query (e.g. a multi-statement string or a prepared-transaction-scoped set).

**Recommended fix:** Combine the GUC SET and the query into one round-trip (single multi-statement send, or `query(\`SET LOCAL ...; <sql>\`)` within an explicit transaction), and SET GUCs once per transaction rather than per statement. Avoid the per-checkout RESET when the next SET overwrites anyway (the SET is authoritative).

**Tenant impact:** Multi-tenant — DB throughput ceiling hit sooner for all tenants. **Detection:** Postgres `statements/sec` ~2× request rate; `PostgresQueryDuration` includes GUC overhead; pg_stat_statements showing `SET LOCAL` / `RESET` among top calls.

---

### H4 — Fixed tiny connection pools (max:3 / max:5 / connectionLimit:5) with no tuning or env-override; no headroom and no `max_connections` plan
**Severity:** High | **Category:** DB scalability | **Priority:** P1

**Evidence:**
- stream-worker pools all hardcoded `max: 3`: `apps/stream-worker/src/main.ts:103,199,243,263,294`.
- core transactional sub-pool `max: 5` (`apps/core/src/main.ts:351-352`); StarRocks `connectionLimit: 5` (`apps/core/src/main.ts:361-367`); primary core pool defaults to `max ?? 10` (`packages/db/src/index.ts:181`, no override passed at `apps/core/src/main.ts:371`).
- No `max_connections`, PgBouncer, or pooler config anywhere in `infra/` or `docker-compose.yml` (grep found none).

**Impact (production):** A core instance has only ~10 primary + 5 raw + 5 StarRocks connections. Under concurrent BFF dashboard load (each request fans out to several queries, each holding a connection through 2 round-trips per H3), the pool saturates and requests queue → latency spikes / timeouts. There is no documented mapping of (replicas × pool max) to Postgres `max_connections`, so horizontally scaling core will exhaust Postgres connections with no pooler in between. The hardcoded `max:3` worker pools also can't be raised without a code change.

**Root cause:** Pools sized for dev single-instance and never parameterized or fronted by a pooler for production fan-out.

**Recommended fix:** Make pool sizes env-driven; introduce a connection pooler (PgBouncer/RDS Proxy) before scaling core replicas; document `replicas × max ≤ max_connections − headroom`. Raise worker pools or share one pool per process (ties to C2).

**Tenant impact:** Multi-tenant — pool saturation on a shared core instance stalls all tenants' requests. **Detection:** pool wait-time / `pool exhausted` logs; Postgres connection count near `max_connections`; BFF p99 latency spikes under concurrency.

---

## MEDIUM

### M1 — `enumerateConnectedConnectors` runs three full-table SECURITY DEFINER scans per tick AND each `run()` re-enumerates; redundant whole-fleet scans every 45s
**Severity:** Medium | **Category:** DB query cost | **Priority:** P2

**Evidence:** `apps/stream-worker/src/jobs/sync-request-claimer/run.ts:69-94` — `enumerateConnectedConnectors` runs 3 queries (`list_connectors_for_repull()`, `list_razorpay_connectors_for_settlement_repull()`, `list_ad_connectors_for_spend_repull()`), each a SECURITY-DEFINER full scan of `connector_instance` filtered by `provider`/`status` (`db/migrations/0026_live_connector_security_definer_fns.sql:46-67` — `SELECT … FROM connector_instance WHERE provider='shopify' AND status='connected' ORDER BY created_at`). The ingest scheduler calls this every tick (`ingest-scheduler/run.ts:57`), AND each dispatched `run()` calls `enumerateConnectors` *again* (`shopify-repull/run.ts:100`, with a `WHERE connector_instance_id=$1` filter applied **client-side after** fetching all rows — L132-145 only filters when a target id is passed; the scheduler passes a specific id so it's filtered, but still re-runs the full SECURITY-DEFINER scan).

**Impact:** 3 full-ish scans of `connector_instance` every 45s regardless of how many connectors are actually due for work, plus a redundant scan per dispatched connector. No index-backed "due" predicate. Scan cost grows with total connector rows. Wasteful but bounded until connector_instance is large.

**Root cause:** Enumeration is "all connected" with no due-time filter; the same fn is reused inside `run()` for security/brand-authority reasons.

**Recommended fix:** Add a due-work index/predicate (ties to C1); pass already-resolved connector metadata into `run()` instead of re-enumerating.

**Tenant impact:** Multi-tenant — shared scan cost. **Detection:** pg_stat_statements top-N showing the three list fns; CPU on connector_instance scans.

### M2 — Backfill lane is single-partition by design; a multi-brand onboarding wave serializes through one partition
**Severity:** Medium | **Category:** Throughput cap | **Priority:** P2

**Evidence:** `infra/redpanda/topics.yml:40-44,83`: backfill topic `partitions: 1` — "Single partition = natural throughput cap (ADR-BF-7 / D-3)". Backfill consumer is one group (`apps/stream-worker/src/main.ts:92,177`).

**Impact:** Deliberate isolation so backfill storms can't lag the live path — good. But it caps backfill throughput to one partition's worth regardless of how many brands onboard simultaneously. At 100+ brands onboarding in a cohort (24-month history each, `shopify-backfill/run.ts:59`), backfills queue and complete slowly, delaying time-to-value. Scaling backfill requires re-partitioning + re-keying, not just more consumers.

**Root cause:** Throughput cap chosen for live-path safety without a graduation path for backfill parallelism.

**Recommended fix:** Make backfill partition count configurable; key by brand_id so per-brand ordering holds while cross-brand parallelism scales. Document the onboarding-cohort throughput.

**Tenant impact:** Cross-tenant queueing — many brands share one backfill partition. **Detection:** backfill consumer lag; `backfill_job` rows stuck in `queued` during onboarding waves.

### M3 — Per-brand salt + token fetches inside hot re-pull loop with no caching; secret-store calls scale with connectors × ticks
**Severity:** Medium | **Category:** Cost / external-call amplification | **Priority:** P2

**Evidence:** `apps/stream-worker/src/jobs/shopify-repull/run.ts:179` (`workerSecrets.getShopifyToken`) and L187 (`saltProvider.saltHexForBrand`) are called **per connector per `run()`**, i.e. per tick per connector. No memoization across ticks visible in the run path.

**Impact:** Every 45s tick re-fetches every connector's token + salt from the secret store. At 1k connectors that's ~2k secret-store reads per tick → ~2,667/min sustained, which on a managed secrets manager (e.g. AWS Secrets Manager / KMS) is a direct per-request cost and rate-limit pressure.

**Root cause:** Secrets fetched fresh each run for correctness/rotation safety, without a short-TTL cache.

**Recommended fix:** Short-TTL in-memory cache for salt (rarely rotates) and token (invalidate on auth-error), keyed by brand/secret_ref.

**Tenant impact:** Multi-tenant — secret-store rate limits affect all brands. **Detection:** secrets-manager request count / throttling metrics.

### M4 — No statement_timeout on hot pools; a slow tenant query holds a scarce connection indefinitely
**Severity:** Medium | **Category:** DB resilience under load | **Priority:** P2

**Evidence:** `packages/db/src/index.ts:183` passes `statement_timeout: config.statementTimeoutMs` but `apps/core/src/main.ts:371` calls `createPool({ connectionString })` with **no** `statementTimeoutMs` → undefined (no timeout). Worker pools (`new PgPool({ connectionString, max:3 })`) set no `statement_timeout` either (`apps/stream-worker/src/main.ts:199,243,263,294`).

**Impact:** With pools of 3-10 connections (H4), one runaway analytics/RLS query (a brand with large bronze_events, H2) can pin a connection for minutes, shrinking already-tiny pools and cascading to request queueing. No timeout = no backpressure floor.

**Root cause:** statement_timeout plumbed but never configured.

**Recommended fix:** Set conservative `statement_timeout` per pool class (short for OLTP/BFF, longer for analytics), env-tunable.

**Tenant impact:** Multi-tenant — one slow query starves the shared pool. **Detection:** long-running query alerts; pool exhaustion correlated with a single tenant.

---

## LOW

### L1 — StarRocks per-brand isolation injected app-side (no engine row policy on allin1 image); every Silver read appends `AND brand_id=?` — correct but means no engine-level partition pruning guarantee at scale
**Severity:** Low | **Category:** Analytics scalability | **Priority:** P3

**Evidence:** `packages/metric-engine/src/silver-deps.ts:10-37` — dev allin1 image lacks `CREATE ROW POLICY`; brand predicate appended at the seam. StarRocks pool `connectionLimit: 5` (`apps/core/src/main.ts:367`).

**Impact:** Functionally fine, but Silver query performance at scale depends on StarRocks tablet/bucket design keyed on brand_id (not visible in this scope) and a 5-connection analytics pool caps dashboard concurrency. Flagged so the prod graduation (engine row policy + bucketing) is verified before high brand counts.

**Recommended fix:** Verify Silver table bucketing/partitioning on brand_id; size the analytics pool for dashboard concurrency at target scale.

**Tenant impact:** Multi-tenant analytics. **Detection:** `OlapQueryDuration` per table; StarRocks scan stats.

### L2 — Redis rate limiter fails open and uses `maxRetriesPerRequest:1`; under Redis pressure rate limits silently disappear (cost/abuse exposure, not a hard outage)
**Severity:** Low | **Category:** Cost-control resilience | **Priority:** P3

**Evidence:** `apps/core/src/main.ts:335-345` — `enableOfflineQueue:false`, `maxRetriesPerRequest:1`, comment "RateLimiter is fail-open anyway." `bff.routes.ts:168,225,267` gate login/register on it.

**Impact:** If Redis is degraded under load, rate limiting fails open — login/register/abuse protections vanish exactly when the system is stressed, allowing request floods that amplify the DB/scheduler load above. A cost/abuse exposure rather than a correctness bug.

**Recommended fix:** Distinguish auth-critical limiters (consider fail-closed or a local fallback bucket) from best-effort ones; alarm on rate-limiter fail-open events.

**Tenant impact:** Platform-wide. **Detection:** the "Redis connect failed — rate limiting will fail-open" warn log (L344); auth-failure-spike monitor.

---

## Cost trajectory (evidence-based)

- **< 100 brands:** Current footprint adequate. Single Postgres, 12-partition Redpanda, StarRocks allin1, sequential scheduler all hold. Matches the doc's "<100 brands" framing (`04_…Plan.md:347`).
- **First inflection — Postgres (H2 + H3 + H4):** Bronze + ledgers grow unbounded in OLTP Postgres while the GUC-per-query pattern doubles statement load and tiny un-pooled connection limits cap concurrency. Postgres storage/IOPS/connections are the first wall, likely between 100–500 brands.
- **Second inflection — scheduler compute + provider egress (C1 + C2 + M3):** The sequential, single-instance scheduler's tick duration crosses the 45s SLA in the low hundreds of connectors and degrades linearly; secret-store + provider-API call volume scales with connectors × ticks. This forces a re-architecture (work queue + sharding), not a rightsizing, before 1k brands.
- **Third — Redpanda consumer CPU (H1):** 8 groups × topic volume in one process becomes CPU-bound as event rate rises; mitigated only by splitting consumers/topics.

---

## Verdict

The data-plane *correctness* primitives (RLS, idempotent Bronze, overlap locks, isolated backfill lane) are solid, but the *scaling envelope* was not built to match the product's own brand-growth ambition. The **single-instance, fully-sequential continuous ingest scheduler (C1) is the first and hardest bottleneck** — it ships the "premature <100 brands" continuous design without the horizontal-partitioning primitives (claim/lease/shard, due-work queue, shared infra) needed to survive past low hundreds of connectors, and the per-connector Pool/Kafka churn (C2) compounds it. The first **cost** wall is Postgres absorbing the unbounded Bronze firehose plus ledgers (H2) while a GUC-per-query pattern (H3) and tiny un-pooled connections (H4) erode its headroom. None of these are theoretical: each cites the exact loop, query, pool, or migration. Brain can reach ~100 brands on this footprint, but **C1/C2 require a work-queue re-architecture and H2/H4 require Postgres tiering + a pooler before 500–1k brands** — these are pre-1k-brand blockers, not far-horizon optimizations.
