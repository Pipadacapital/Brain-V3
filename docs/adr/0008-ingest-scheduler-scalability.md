# ADR-0008 — Ingest-scheduler scalability: the continuous re-pull tick, its throughput ceiling, and the work-queue re-architecture

Status: **Accepted** (2026-06-30). Documents the current design and the planned scaling envelope.

> **Docs-only / no code change.** This ADR adds, changes, and removes **no** runtime component, table, migration, or config. It records *why* the continuous ingest scheduler is shaped the way it is, what its throughput ceiling and inflection point are, why that ceiling is acceptable at the current brand count, and the re-architecture that is **already partly landed** (migration `0053`) plus the work that remains. It is the architectural home for the audit's C1/C2 scalability findings (`docs/audit/10-scalability-cost.md`).

## Context

The continuous near-real-time ingestion scheduler lives in `apps/stream-worker/src/jobs/ingest-scheduler/run.ts` and is wired once into the already-running stream-worker process (`apps/stream-worker/src/main.ts` — `startIngestScheduler(ingestSchedulerPool, ingestSchedulerIntervalMs, ingestSchedulerBatch, connectorRateLimiter)`). On a short interval it re-pulls every connected connector (Shopify / Meta / Google Ads / Razorpay) across every brand by invoking the **same** `run(connectorInstanceId)` the on-demand "sync now" claimer invokes — live and scheduled ingestion converge on one code path.

### The original design the scalability audit flagged (C1/C2)

The independent scalability audit (`docs/audit/10-scalability-cost.md`, 2026-06-19) named the ingest scheduler the **first and dominant bottleneck**:

- **C1 (Critical, P0).** The scheduler was a *single-instance, fully-sequential* interval loop: every tick called `enumerateConnectedConnectors(pool)` (three SECURITY-DEFINER full scans of `connector_instance`, one per provider family) to return *every* connected connector across *all* brands, then a plain `for` loop dispatched `run(connector_instance_id)` **one at a time** ("SEQUENTIAL dispatch (never Promise.all)"). Because each `run()` is a *live multi-page HTTP re-pull* against the upstream vendor (seconds of wall-clock each), the tick duration was `Σ(per-connector HTTP time)` — **O(total connectors)** of serialized external I/O inside one tick. The `inFlight` guard meant a tick that overran its interval simply never overlapped the next, so the effective reconciliation cycle silently degraded from the configured interval to `tick_duration`. Running a second stream-worker did **not** help: with no claim/lease/shard, both replicas enumerated all and dispatched all; only the per-connector `FOR UPDATE SKIP LOCKED` overlap-lock inside `run()` prevented double-execution, at the cost of wasted enumeration and lock contention.
- **C2 (Critical, P0).** Each `run()` was authored as a standalone CLI job and constructs its **own** `pg.Pool` (`max: 3`) + Kafka producer per dispatch, then tears them down — enormous per-connector fixed setup cost (TCP+TLS connect, Kafka client bootstrap) that can dwarf the actual sync for a connector with no new orders, and a connection-exhaustion hazard the moment dispatch is made concurrent.
- Supporting findings: **M1** (redundant whole-fleet enumeration every tick with no due-time predicate), **M3** (per-connector secret-store token/salt fetch inside the hot loop, no TTL cache).

The architecture plan itself frames continuous reconciliation as premature below ~100 brands (`docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:347` — "continuous is premature <100 brands"); the original scheduler shipped the continuous design without the horizontal-scaling primitives needed to survive growth.

### What has already changed since the audit (migration 0053)

The core of C1's recommended fix is **already landed**. `db/migrations/0053_connector_repull_work_queue.sql` ("replace poll-everything-every-45s with a DUE-TIME WORK QUEUE") added, additively (I-E02):

- a nullable `connector_instance.next_repull_at TIMESTAMPTZ` (NULL = due immediately / never claimed),
- a partial due-scan index `connector_instance_due_repull_idx ON connector_instance (next_repull_at) WHERE status = 'connected'`,
- a SECURITY-DEFINER `claim_due_repull_connectors(p_batch, p_interval_seconds)` that, in one statement, selects up to `batch` connected connectors whose `next_repull_at` is due `ORDER BY next_repull_at ASC NULLS FIRST FOR UPDATE SKIP LOCKED LIMIT batch`, **stamps** each claimed row `next_repull_at = now() + interval`, and returns them — guarded at migration time to be SECURITY DEFINER with a pinned `search_path` (anti-hijack), `GRANT EXECUTE … TO brain_app`.

The scheduler in `run.ts` was rewritten around it. The current tick (`tick()` → `claimDueRepullConnectors(pool, batch, intervalSeconds)`) is therefore **claim-based, not enumerate-everything**, and dispatch is a **bounded-concurrency worker pool**, not a serial loop. This ADR documents the design *as it stands today* and the residual gaps, rather than the superseded C1 baseline.

## Decision

Accept the current claim-based scheduler as the steady-state design for the current scale, and record the throughput ceiling, the inflection point, and the planned remaining re-architecture so future scaling work extends a known contract rather than re-deriving it.

### D1 — Current design: a multi-replica due-work claim with bounded per-tick concurrency.

Per tick (`run.ts`):

1. **Claim, don't enumerate.** `claimDueRepullConnectors(pool, batch, intervalSeconds)` (`apps/stream-worker/src/jobs/sync-request-claimer/run.ts`) calls `claim_due_repull_connectors` (0053). `FOR UPDATE SKIP LOCKED` means two replicas claim **disjoint** batches with no replica ordinals — the scheduler is now **parallel across replicas**, naturally load-balanced, each connector dispatched at most once per interval. `brand_id`/`provider` are server-trusted (read from the DB row, MT-1).
2. **Bounded-concurrency dispatch.** The claimed batch is drained by a pool of `resolveDispatchConcurrency()` workers (`DEFAULT_DISPATCH_CONCURRENCY = 8`, env `REPULL_DISPATCH_CONCURRENCY` clamped `1..32`) — parallel, so a tick of N connectors costs `~max single chain` rather than the *sum*, but capped so we never fan an unbounded burst.
3. **Fail-isolation + deadline.** `dispatchOne` runs each repull inside a per-connector try/catch and races it against `DISPATCH_DEADLINE_MS` (5 min) so one hanging vendor cannot pin a pool slot forever; `run()` persists `connector_sync_status.state='error'` itself.
4. **Overlap safety is free.** Each `run()` already calls its own `FOR UPDATE SKIP LOCKED` overlap-lock, so a tick that overlaps a still-running repull (or the manual claimer) finds the row locked and skips. The scheduler adds no new lock.
5. **Per-provider global cap.** Each dispatch passes the per-provider atomic-Redis `rateLimiter.tryAcquire(provider)` (cross-replica), independent of dispatch parallelism; over quota → skip this tick (the connector stays due and re-pulls next interval).
6. **Loop guards.** `startIngestScheduler` runs one `setTimeout` loop with an `inFlight` re-entrancy guard and an interval floor `MIN_INTERVAL_MS = 15_000` (anti-stampede). Defaults: `DEFAULT_INTERVAL_MS = 45_000` (config `SYNC_SCHEDULER_INTERVAL_MS`), `DEFAULT_CLAIM_BATCH = 100` (config `REPULL_CLAIM_BATCH`).
7. **Tick-overrun canary.** When a tick that had work takes `>= effectiveInterval`, `ingest_scheduler_tick_overrun_total` is incremented and a `TICK OVERRUN … add replicas or lower the claim batch` warning is logged — freshness degradation is observable before it becomes total staleness (`BrainIngestStale` only fires at total zero).

### D2 — The throughput ceiling and the inflection point.

The governing relation per replica is: a tick keeps pace iff `claim_batch × (per-connector repull wall-clock ÷ dispatch_concurrency) ≤ interval`. With the defaults (`batch = 100`, `concurrency = 8`, `interval = 45s`) and an audit-derived ~3s average Shopify-class re-pull, one replica sustains roughly `8 × (45 / 3) ≈ 120` connector-repulls per tick — comfortably draining a 100-batch. Fleet throughput then scales with replica count, because replicas claim disjoint due batches: `R` replicas ≈ `R × batch` connectors per interval.

The **inflection point** is therefore not a single-replica wall (the original C1 ceiling of "low hundreds of connectors, then the 45s SLA collapses linearly" no longer applies to the steady state) but the point where the *residual* per-connector overheads (C2/M1/M3 — a fresh Pool + Kafka producer + token/salt fetch + redundant enumeration per `run()`) and the shared Postgres / secret-store / provider-API budgets dominate. Per the audit's cost trajectory that is the **~hundreds of connectors / approaching ~1k brands** band: the second cost inflection is "scheduler compute + provider egress + secret-store call volume scaling with connectors × ticks." Below ~100 brands the footprint is comfortably adequate (matching the plan's "<100 brands" framing).

### D3 — Why the current ceiling is acceptable now.

- The platform is operating well below the inflection band; at the current brand count one replica with the default batch/concurrency drains the due set within the interval, and the overrun canary (D1.7) gives early warning long before freshness silently collapses.
- The hardest part of C1 — the single-leader, enumerate-all, strictly-sequential model — is **already removed** (0053 + the claim-based tick). Adding throughput today is an operational lever (add a stream-worker replica; raise `REPULL_DISPATCH_CONCURRENCY` / lower `REPULL_CLAIM_BATCH`), not a code change.
- Correctness primitives are intact and tenant-safe regardless of scale: the claim is SECURITY-DEFINER + cross-tenant but atomic; the brand-scoped repull runs under its own per-brand GUC; overlap is guarded by `run()`'s own `SKIP LOCKED`; per-provider rate limits are cross-replica atomic.
- The remaining overheads (C2/M3) are *fixed per-connector cost*, not *correctness or blast-radius* risks — they inflate cost and latency headroom as the fleet grows, but do not threaten isolation, dedup, or freshness at the current scale.

### D4 — The remaining re-architecture (planned, not yet built).

When the fleet approaches the inflection band, the following extend the current claim model. None changes the read/write contract; all are additive.

1. **A dedicated due-work table, `connector_sync_schedule(brand_id, connector_instance_id, next_due_at, …)`.** Today the due-time lives as a single `connector_instance.next_repull_at` column (per *connector*, due-stamp interval == loop interval). A dedicated schedule table lets a connector carry **per-resource** cadences (e.g. orders every 45s, settlements hourly) and an explicit, **staggered** seed of `next_due_at` so the fleet is spread across the interval rather than re-bunching at `now()+interval` each claim — the same `SELECT … WHERE next_due_at <= now() FOR UPDATE SKIP LOCKED LIMIT batch` claim shape, finer granularity.
2. **Inject shared infra into `run()` (closes C2).** Pass the scheduler's already-held Pool + a single long-lived per-process Kafka producer into `run()` so scheduled dispatch *borrows* shared infra; keep the CLI entrypoint constructing its own only when invoked directly. This removes the per-connector connect/teardown overhead and the `max:3 × concurrency` connection-exhaustion hazard, and is the prerequisite for safely raising dispatch concurrency. (Pair with a `replicas × pool_max ≤ max_connections − headroom` budget / a PgBouncer-class pooler.)
3. **Pass resolved connector metadata into `run()` (closes M1).** The claim already returns `{connector_instance_id, brand_id, provider}`; hand it to `run()` so it no longer re-enumerates the whole fleet to filter to one id.
4. **Short-TTL secret cache (closes M3).** Cache salt (rarely rotates) and token (invalidate on auth-error) keyed by brand/secret-ref so the hot loop stops re-reading the secret store per connector per tick.
5. **Gate continuous mode behind a brand-count / feature flag.** Per the plan's "premature <100 brands" guidance, make the continuous lane explicitly flag-gated so small deployments run on-demand-only and the continuous fleet sweep turns on deliberately at a reviewed brand threshold.

## Scope

Documentation only. **No** new service, topic, table, view, migration, or config; **no** edit to `run.ts`, `sync-request-claimer/run.ts`, `main.ts`, `0053_connector_repull_work_queue.sql`, or any vendor repull job. It records the current scheduler contract, its throughput ceiling and inflection point, and the planned (already partly landed) re-architecture.

## Consequences

- **+** The scheduler's scaling envelope now has one authoritative description: claim-based, multi-replica, bounded-concurrency; scale today by replicas / concurrency / batch knobs, not a rewrite.
- **+** The audit's C1/C2/M1/M3 findings have a documented home and a sequenced future plan (D4), so the next scaling push extends the 0053 claim contract instead of re-deriving it.
- **+** The inflection band (~hundreds of connectors / approaching ~1k brands) and the early-warning signal (`ingest_scheduler_tick_overrun_total`) are written down, so the re-architecture is triggered by evidence, not guessed.
- **−** A residual debt is recorded, not paid: C2 (per-`run()` Pool + Kafka producer churn), M1 (redundant in-`run()` enumeration), and M3 (uncached per-tick secret fetches) remain; the due-time is still a single per-connector column rather than a per-resource staggered schedule table; and continuous mode is not yet brand-count-gated. These are the explicit D4 follow-ups.

## References (real paths, line behaviors re-verified)

- Scheduler: `apps/stream-worker/src/jobs/ingest-scheduler/run.ts` — `tick()` (claim → bounded-concurrency pool), `startIngestScheduler` (interval loop + `inFlight` guard + overrun canary), `DEFAULT_INTERVAL_MS = 45_000`, `MIN_INTERVAL_MS = 15_000`, `DEFAULT_CLAIM_BATCH = 100`, `DEFAULT_DISPATCH_CONCURRENCY = 8`, `DISPATCH_DEADLINE_MS = 5 * 60 * 1000`, `resolveDispatchConcurrency()`.
- Claim primitive: `apps/stream-worker/src/jobs/sync-request-claimer/run.ts` — `claimDueRepullConnectors` (selects from `claim_due_repull_connectors($1,$2)`), `enumerateConnectedConnectors` (the superseded whole-fleet enumeration, still used by the on-demand claimer tick).
- Work-queue migration: `db/migrations/0053_connector_repull_work_queue.sql` — `connector_instance.next_repull_at`, `connector_instance_due_repull_idx`, `claim_due_repull_connectors(INT, INT)` (`FOR UPDATE SKIP LOCKED`, SECURITY DEFINER, pinned `search_path`, `GRANT … TO brain_app`).
- Wiring: `apps/stream-worker/src/main.ts` — `startIngestScheduler(ingestSchedulerPool, ingestSchedulerIntervalMs, ingestSchedulerBatch, connectorRateLimiter)`; config `SYNC_SCHEDULER_INTERVAL_MS` (default 45000), `REPULL_CLAIM_BATCH` (default 100), `REPULL_DISPATCH_CONCURRENCY` (`packages/config/src/stream-worker.ts`).
- Per-connector infra (C2): `apps/stream-worker/src/jobs/shopify-repull/run.ts` (and `shopify-backfill`, `meta-spend-repull`, `google-ads-spend-repull`, `razorpay-settlement-repull`) — each `run()` constructs its own Pool + Kafka producer.
- Audit findings: `docs/audit/10-scalability-cost.md` — C1, C2, M1, M3, and the cost trajectory.
- Premature-continuous framing: `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:347`.
- Related: [ADR-0006](0006-redpanda-native-bronze-kafka-connect-iceberg.md) (ingestion lane), [ADR-0007](0007-analytics-gateway.md) (serving read-path); CI invariant guard `tools/lint/v4-naming-guard.sh`.
