# PASS 11 — Reliability Audit (Brain Commerce OS)

**Reviewer:** Independent principal-level (reliability board)
**Scope:** Failure simulation (service/DB/Redpanda/network-partition/migration-failure/dependency-down), retry (backoff+jitter+max+idempotency), timeouts, circuit breakers, graceful degradation, recovery, failover, DR, idempotency of critical writes (ledgers, consumers), the collector accept-before-validate + spool + 503-Retry-After contract.
**Method:** Direct code reading of `apps/collector`, `apps/stream-worker`, `apps/core`, `packages/*`, `db/migrations`, cross-checked against `docs/requirements/04`, `06`, and `docs/data-collection-platform`.

---

## Summary of severities

| Severity | Count |
|---|---|
| Critical | 2 |
| High | 4 |
| Medium | 5 |
| Low | 3 |

---

## CRITICAL

### R-01 — Redis dedup claims the slot BEFORE the durable Bronze write; a transient DB failure permanently drops the event
**Severity:** Critical | **Category:** Idempotency / data loss on retry | **Priority:** P0

**Evidence:**
- `apps/stream-worker/src/application/ProcessEventUseCase.ts:159-200` — ordering is: Step 2 Redis `checkAndClaim` (SET NX EX 604800) → Step 4 `bronze.write()`.
- `RedisDedupAdapter.checkAndClaim` (`apps/stream-worker/src/infrastructure/redis/RedisDedupAdapter.ts:49-54`) sets `dedup:{brand}:{event_id}` with a 7-day TTL on first sight and returns `isFirstSight:true`.
- `BronzeRepository.write` (`BronzeRepository.ts:92-144`) `throw`s on any non-conflict error (DB down, statement_timeout 10s, RLS GUC error, pool exhaustion).
- `CollectorEventConsumer.eachMessage` (`CollectorEventConsumer.ts:124-159`) on a thrown write error does NOT commit the offset and re-delivers.

**Failure trace (simulated DB blip):** message arrives → Redis claims the slot (`isFirstSight:true`) → `bronze.write()` throws (Postgres restart / failover / pool exhausted) → consumer does not commit → Redpanda re-delivers the SAME message → Step 2 Redis now returns `isFirstSight:false` → `ProcessEventUseCase` returns `{outcome:'dedup_hit'}` → consumer treats it as success and **commits the offset**. The event is now gone from the topic and was never written to `bronze_events`. The dedup key persists for 7 days, so every retry inside that window is suppressed.

**Impact (production terms):** Any Postgres hiccup (RDS failover, a 10s `statement_timeout` trip under load, connection-pool saturation at `max:5`) silently destroys the in-flight events for that window. This is the exact opposite of the "never lose an event / 99.95% durability" guarantee the collector exists to provide (`docs/requirements/04:976`). It corrupts Bronze completeness and every downstream metric/ledger derived from it.

**Root Cause:** The "claim" (Redis NX) is performed before the "commit" (durable write) without compensation. A claim must only become permanent once the durable write commits.

**Recommended Fix:** Reorder to write-first, or make the dedup claim reversible: on any Bronze write throw, `DEL` the Redis dedup key before re-throwing (so the redelivery re-attempts the write). The PK `ON CONFLICT DO NOTHING` already provides a durable second-line dedup, so the Redis layer can safely be released on failure. Add a regression test that throws from `bronze.write()` once, then asserts the redelivery writes the row.

**Tenant Impact:** Multi-tenant. A shared Postgres incident drops events across all brands simultaneously (one DB, all tenants).

**Detection:** Currently invisible — `dedup_hit` is emitted as a normal counter (`collector_dedup_conflict_total`, `CollectorEventConsumer.ts:108-114`), indistinguishable from a legitimate duplicate. Surfaces only as an unexplained Bronze-vs-source reconciliation gap days later.

---

### R-02 — Collector never implements `503 SPOOL_FULL` + `Retry-After`; on spool failure it returns a bare 500 and there is no back-pressure guard
**Severity:** Critical | **Category:** Graceful degradation / contract divergence | **Priority:** P0

**Evidence:**
- The contract is explicit: `docs/requirements/06:454` (`// 503 { "error": { "code": "SPOOL_FULL" } } + Retry-After`), `06:705` ("as the durable spool nears capacity → `503 SPOOL_FULL` + `Retry-After`"), `04:801` ("Backpressure Guard / spool-full → 503 + Retry-After (never silent drop)"), `04:976` ("spool full → 503 + Retry-After").
- The handler `apps/collector/src/interfaces/rest/collect.route.ts:20-37` has NO spool-depth check and NO 503 path. On `acceptUseCase.execute` throw it produces an unhandled rejection → Fastify default 500 (no `Retry-After`, no `SPOOL_FULL` code).
- `AcceptEventUseCase.execute` (`accept-event.usecase.ts:28-31`) comment even states "If this throws, HTTP 500 is returned" — directly contradicting the documented 503 contract.
- No spool-capacity metric or guard exists anywhere in `apps/collector`.

**Failure trace:** Redpanda outage persists → drainer holds rows `pending` (`drain-events.usecase.ts:41-48`) → `collector_spool` grows unbounded → disk/connection pressure → `PgSpoolRepository.insert` (`pg-spool.repository.ts:38-47`) eventually throws (pool `max:10`, `connectionTimeoutMillis:5000`) → handler returns 500. The pixel SDK on a 500 is permitted to drop (a 500 is "server bug, give up"), whereas a 503 + `Retry-After` is the contractually-defined "buffer + retry" signal. **A 500 instead of a 503 turns a recoverable back-pressure event into client-side data loss** — the precise failure the spool exists to prevent.

**Impact:** During a sale-day Redpanda degradation (the exact scenario `04:187` cites: "spiky sale-day load; spool absorbs Redpanda degradation"), the spool fills, the edge returns 500s, SDKs give up, and events are lost — defeating the 99.95% accept SLA.

**Root Cause:** The back-pressure guard described in three architecture docs was never built; the happy-path accept handler has no failure branch.

**Recommended Fix:** Add a spool-depth check (cheap: `SELECT count(*) FROM collector_spool WHERE status='pending'` cached for N seconds, or a high-water-mark gauge) and an error boundary that maps spool-INSERT failure / over-capacity to `503 {error:{code:'SPOOL_FULL'}}` + `Retry-After`. Emit a `collector_spool_depth` gauge with an alarm.

**Tenant Impact:** Multi-tenant — the edge is shared; a global spool-full event degrades all brands. No per-tenant blast isolation on the spool.

**Detection:** No spool-depth metric exists, so the operator learns of it only when SDKs report drops or Bronze gaps appear. The 500 (not 503) would show as a generic 5xx spike, masking the true cause.

---

## HIGH

### R-03 — Per-(partition,offset) retry counters are in-memory; pod restart / rebalance loses the count → poison messages never reach the DLQ
**Severity:** High | **Category:** Recovery / poison-pill handling | **Priority:** P1

**Evidence:** Every consumer keeps `private readonly retryCount = new Map<RetryKey, number>()`:
`CollectorEventConsumer.ts:34`, `LiveLedgerBridgeConsumer.ts:45`, and (per grep) `BackfillOrderConsumer`, `ConsentSuppressorConsumer`, `CapiDeletionConsumer`, `GokwikAwbLedgerConsumer`, `SettlementLedgerConsumer`, `SpendLedgerConsumer`. The DLQ-after-MAX_RETRY logic (`CollectorEventConsumer.ts:134-159`) reads/writes this in-memory map only.

**Failure trace:** A genuinely poison message (deterministically throws in the write path) increments the counter; on attempt 5 it should DLQ. But if the pod is killed / the consumer group rebalances / the process restarts at any point before 5 (common under K8s rolling deploys and HPA scale events), the counter resets to 0. The message is re-delivered, re-fails, resets again → an **infinite retry loop that never reaches the DLQ**, blocking the partition indefinitely (autoCommit is off, so the stuck offset never advances).

**Impact:** A single poison message on a partition halts all downstream progress for every brand whose key hashes to that partition, with no automatic escape. Consumer lag grows without bound; the kafka-consumer-lag monitor fires but there is no self-heal.

**Root Cause:** Retry state is process-local, not derived from a durable signal (Kafka header / delivery count / a persisted attempt store).

**Recommended Fix:** Derive the attempt count from a durable source — a `x-delivery-attempt` header bumped on each requeue, a Redis counter keyed by `topic:partition:offset`, or KafkaJS retry-topic pattern — so MAX_RETRY survives restarts. At minimum, bound the map and persist the counter.

**Tenant Impact:** Multi-tenant — a poison message stalls a whole partition (many brands), not just the offending brand.

**Detection:** Surfaces as `kafka-consumer-lag` climbing with no DLQ rows appearing. No metric distinguishes "stuck" from "busy."

---

### R-04 — No health/liveness/readiness probe on the stream-worker; consumers can wedge with no restart signal
**Severity:** High | **Category:** Liveness / recovery | **Priority:** P1

**Evidence:** `apps/stream-worker/src/main.ts` has no `listen()`, no Fastify/http server, no `/healthz` or `/readyz` (grep for `listen|healthz|/health|createServer` returns nothing). The process is a bare set of `consumer.run` loops (`main.ts:347-407`). The observability skill's floor requires "health checks (liveness + readiness + dependency)" on every service.

**Failure trace:** If a consumer's `eachMessage` deadlocks (e.g. on an un-timeouted external call, see R-06), or the KafkaJS connection silently stalls, there is no probe for K8s to fail → the pod stays `Ready` and `Live` while processing nothing. No automatic restart; lag grows silently.

**Impact:** A wedged stream-worker requires manual detection + manual restart. Bronze ingestion, identity bridge, all ledger bridges, consent suppression, and CAPI deletion all stop with no automated recovery.

**Root Cause:** The worker was built as a script, not as a probe-able service; the deploy-pipeline-from-day-one health-probe requirement was skipped for this deployable.

**Recommended Fix:** Add a minimal HTTP server exposing `/healthz` (process alive) and `/readyz` (each consumer group connected + last-poll-within-threshold + PG/Redis reachable). Wire K8s liveness/readiness to them.

**Tenant Impact:** Multi-tenant — one wedged worker stalls ingestion/ledgers for all brands.

**Detection:** Only via the external `kafka-consumer-lag` monitor; the pod itself reports healthy.

---

### R-05 — Core service `/health` is a static 200 with no dependency check; no readiness/liveness split
**Severity:** High | **Category:** Health probes | **Priority:** P1

**Evidence:** `apps/core/src/main.ts:327-331` — `/health` returns `{status:'ok', version, timestamp}` unconditionally. There is no `/readyz`, no `/healthz` (grep returns none in `apps/core/src`), and the single endpoint never probes Postgres, Redis, MySQL/StarRocks, or Kafka — all of which `main.ts` connects to.

**Failure trace:** Postgres or Redis is down → `/health` still returns 200 → K8s keeps routing traffic to a core pod that 500s every real request. There is no readiness gate to pull the pod out of the load-balancer rotation during a dependency outage or during slow startup (warm-up).

**Impact:** During a dependency partition, the LB cannot distinguish a healthy pod from a broken one; traffic continues to a pod that cannot serve, amplifying the error rate instead of shedding. This is the "trivial health probe" anti-blind trigger.

**Root Cause:** Placeholder health endpoint never upgraded to a real readiness check.

**Recommended Fix:** Split into `/healthz` (liveness — process up, NOT dependent on datastores to avoid restart-loops) and `/readyz` (readiness — Postgres `SELECT 1`, Redis ping, downstream reachability with short timeouts). Wire probes accordingly. The collector already models this correctly (`health.route.ts`) — mirror it.

**Tenant Impact:** Multi-tenant — core is the shared control plane; a false-healthy pod degrades all tenants' API traffic.

**Detection:** Error-rate spike with no corresponding pod-unready signal — the LB keeps the bad pod in rotation.

---

### R-06 — Connector HTTP clients have no request timeout; a hung upstream socket blocks the job (and the partition) indefinitely
**Severity:** High | **Category:** Timeouts | **Priority:** P1

**Evidence:** None of the connector `fetch` calls pass an `AbortController`/`signal` or timeout:
- `shopify-paged-client.ts:73-78` (`countOrders`), `:130-135` (`fetchOrdersPage`) — bare `fetch(url, {headers})`.
- `meta-insights-client.ts:147-152` (`getJson`) — bare `fetch`.
- (grep confirmed `AbortController|signal:` absent from all `*client*.ts` under `apps/stream-worker/src/jobs`.)
- Node's global `fetch` (undici) has no default total timeout; a server that accepts the connection then never responds leaves the promise pending forever.

**Failure trace (network partition / slow upstream):** Shopify/Meta accepts the TCP connection but stalls (a partial partition, an overloaded upstream). The `await fetch` never resolves and never rejects. The backfill/spend job's page loop hangs; if invoked from a consumer's `eachMessage`, that partition's offset never advances — combining with R-04 (no liveness probe) to produce a silent, unrecoverable stall.

**Impact:** A single slow vendor endpoint freezes a connector sync indefinitely, with no timeout to convert the hang into a retryable error. The 429 backoff logic is irrelevant because a hung socket never returns a status code.

**Root Cause:** Retry/backoff was implemented for explicit 429/5xx responses but not for the no-response case; no deadline on any outbound call.

**Recommended Fix:** Wrap every connector `fetch` with `AbortSignal.timeout(ms)` (e.g. 30s per request) and treat the abort as a retryable error feeding the existing bounded-backoff loop. Add a per-job overall deadline.

**Tenant Impact:** Single-tenant per job run (one brand's connector), but a wedged job consuming a worker slot/partition can starve other brands' scheduled syncs.

**Detection:** Job appears "running" forever; no error logged. Surfaces as a stale connector freshness alarm (if one exists) hours later.

---

## MEDIUM

### R-07 — Drainer produces with `retries:0` and no inter-tick backoff/jitter; a flapping Redpanda gets hammered and there is no idempotent producer
**Severity:** Medium | **Category:** Retry / backoff | **Priority:** P2

**Evidence:** `kafka-producer.ts:31-33` sets KafkaJS `retry:{retries:0}` and `:49-54` `idempotent:false`. The drainer (`drainer.ts:43-45`) ticks on a fixed `setInterval` (default 1000ms, `main.ts:115`) with no backoff/jitter when produces are failing. On first produce failure the batch `break`s (`drain-events.usecase.ts:47`) and retries the same oldest rows every tick.

**Impact:** During a Redpanda flap, the drainer retries the identical batch every second with zero backoff and zero jitter — a thundering-herd against a recovering broker, and (with `idempotent:false`) a produce that succeeds broker-side but whose ack is lost will be **re-produced**, creating duplicate Kafka records. Duplicates are caught later by Redis/PK dedup (so no Bronze dup), but they inflate topic volume and waste the dedup path.

**Root Cause:** "Drainer owns retry" was asserted (`kafka-producer.ts:32` comment) but the drainer's retry is a fixed-interval loop with no backoff, no jitter, and a non-idempotent producer.

**Recommended Fix:** Add exponential backoff + jitter to the drainer tick when consecutive produce failures occur; enable `idempotent:true` on the producer (it is the canonical fix for lost-ack duplicates) or accept duplicates explicitly and document the reliance on downstream dedup.

**Tenant Impact:** Multi-tenant — shared drainer/broker.

**Detection:** Produce-failure log spam (`drain-events.usecase.ts:44`); no metric on drainer failure rate or spool depth.

---

### R-08 — No global `Idempotency-Key` middleware on mutating API endpoints, despite the contract requiring it on every mutation
**Severity:** Medium | **Category:** Idempotency of critical writes | **Priority:** P2

**Evidence:** `docs/requirements/04:1005` — "Every mutating endpoint requires `Idempotency-Key: <uuid>` (result cached 24h, replayed on repeat)." Grep for a 24h-cache / replay middleware in `apps/core/src/modules/frontend-api` and `main.ts` returns nothing. The only idempotency present is ad-hoc per-command (`main.ts:1321`, `:1600`, `:1616` generate a `randomUUID()` when the header is absent — i.e. NOT replay-safe; a client retry without the header gets a fresh key and re-executes).

**Impact:** A client that retries a POST after a network timeout (the canonical retry case) re-executes the mutation — double-invites, double-disconnects, duplicate connector installs — because there is no request-level dedup cache. The per-command `ON CONFLICT` keys help some paths but not all mutations.

**Root Cause:** The documented global idempotency layer was never implemented; idempotency is left to each handler, inconsistently.

**Recommended Fix:** Implement the contract's 24h idempotency cache as a Fastify preHandler keyed by `(brand_id, route, Idempotency-Key)` storing the response; reject mutations missing the header where the contract requires it.

**Tenant Impact:** Single-tenant per request, but applies across all tenants' write paths.

**Detection:** Duplicate-entity reports / user complaints; no metric.

---

### R-09 — Audit-write failure on a cross-brand security event is swallowed, weakening the forensic guarantee under DB stress
**Severity:** Medium | **Category:** Graceful degradation vs durability tradeoff | **Priority:** P2

**Evidence:** `ProcessEventUseCase.ts:212-242` — `writeBrandMismatchAudit` catches and swallows any audit-write error (`:236-241`), and the quarantine proceeds. The comment (`:209-211`) explicitly chooses "missing forensic row < letting a cross-brand event through."

**Impact:** The tradeoff is defensible (don't block quarantine on audit), but during a Postgres incident every `pixel.brand_mismatch` (a security signal — a browser stamping another tenant's brand_id) loses its audit trail silently. There is no DLQ/retry/outbox for the dropped audit row, so the forensic record is permanently gone, not deferred.

**Root Cause:** No durable fallback (outbox/queue) for the audit write; failure → drop.

**Recommended Fix:** On audit-write failure, emit to a durable retry sink (outbox table or a `.audit-dlq` topic) so the forensic row is eventually written, not lost. At minimum emit a dedicated `audit_write_failed` counter so the loss is observable.

**Tenant Impact:** Multi-tenant security forensics — affects cross-brand attack visibility.

**Detection:** Only a `console.error` (`:237`); no metric/alarm.

---

### R-10 — Spool drain is unordered-by-failure and `break`s the whole batch on the first error; head-of-line blocking by one bad row
**Severity:** Medium | **Category:** Recovery / liveness | **Priority:** P2

**Evidence:** `drain-events.usecase.ts:31-49` — on the FIRST produce error the loop `break`s, abandoning the rest of the batch, and `pollPending` (`pg-spool.repository.ts:50-58`) always returns rows `ORDER BY id` (oldest first). If a specific row deterministically fails to produce (e.g. an oversized payload exceeding broker max message bytes), the drainer retries that same oldest row every tick forever and **never drains anything behind it**.

**Impact:** One un-producible spool row halts all draining → spool grows unbounded → eventually R-02 (spool full). No DLQ/skip path exists on the drainer side (unlike the consumer side which has a DLQ).

**Root Cause:** The drainer has back-pressure semantics but no poison-row handling; `break` conflates "broker down" (correct to hold) with "this row is bad" (should be quarantined).

**Recommended Fix:** Distinguish transient broker errors (hold + backoff) from per-message permanent errors (route the row to a spool-DLQ status + advance). Track per-row produce attempts.

**Tenant Impact:** Multi-tenant — one poison row blocks the shared spool.

**Detection:** No per-row attempt metric; surfaces as stuck spool depth.

---

### R-11 — No circuit breaker anywhere on cross-service / external calls
**Severity:** Medium | **Category:** Circuit breakers / cascading failure | **Priority:** P2

**Evidence:** Grep for `circuit|CircuitBreaker|opossum|breaker` across `apps/` and `packages/` returns only filename coincidences (a `can-contact.engine.ts` and two `RedisDedupAdapter.ts`), no breaker implementation. The observability skill mandates "circuit breakers on every cross-service/external call." Outbound calls to Shopify/Meta/Google/Razorpay (connector clients), Redis (dedup), Postgres (writers), the AI gateway, and SES have no breaker.

**Impact:** A slow/failing dependency (e.g. SES, the AI gateway, a vendor API) is retried/awaited per-call with no fail-fast fallback. Under sustained dependency failure, request threads and worker slots pile up on doomed calls instead of shedding to a degraded mode. Combined with R-06 (no timeouts on connectors) this is a cascading-failure setup.

**Root Cause:** The breaker layer in the reference architecture was not implemented.

**Recommended Fix:** Wrap cross-service/external calls in a breaker (e.g. opossum) with a documented fallback per dependency (cached/last-known/template), emit `CircuitBreakerState`, and alarm on sustained Open.

**Tenant Impact:** Multi-tenant — a shared-dependency slowdown cascades across tenants.

**Detection:** No breaker-state metric; surfaces as latency/error spikes.

---

## LOW

### R-12 — Connector backoff uses pure exponential with no jitter
**Severity:** Low | **Category:** Retry / backoff | **Priority:** P3

**Evidence:** `meta-insights-client.ts:168` (`Math.min(30_000, 1000 * 2 ** attempt)`) and `shopify-paged-client.ts:140-141` (fixed `Retry-After` or 2s) apply no jitter. Multiple ad accounts re-pulling concurrently after a shared throttle window will retry in lock-step.

**Impact:** Mild thundering-herd against vendor rate limiters, prolonging throttle recovery.

**Recommended Fix:** Add full/decorrelated jitter to the backoff.

**Tenant Impact:** Multi-tenant (concurrent brand syncs synchronize).

**Detection:** Repeated 429 clusters in connector logs.

---

### R-13 — Redis dedup adapter is `enableOfflineQueue:false`; a Redis blip throws into the write path (fail-closed, no fallback)
**Severity:** Low | **Category:** Dependency-down handling | **Priority:** P3

**Evidence:** `RedisDedupAdapter.ts:25-29` — `enableOfflineQueue:false`, `maxRetriesPerRequest:3`. When Redis is down, `checkAndClaim` throws → `ProcessEventUseCase` throws → consumer retries (no commit). This is fail-closed (correct for safety, no event loss) but the worker cannot make progress at all while Redis is down, even though the PK `ON CONFLICT` is a sufficient durable dedup backstop.

**Impact:** Redis becomes a hard ingestion dependency: a Redis outage stops all Bronze ingestion despite Postgres being available and the PK dedup being sufficient. No graceful degradation to "PK-only dedup."

**Recommended Fix:** On Redis error, optionally degrade to PK-only dedup (skip the Redis layer, rely on `ON CONFLICT`) behind a flag, so a Redis outage degrades rather than halts. (Contrast: core's RateLimiter fail-opens on Redis, `main.ts:333-345` — the dedup path has no equivalent degraded mode.)

**Tenant Impact:** Multi-tenant — shared Redis outage halts all ingestion.

**Detection:** Write-error log spam + consumer lag.

---

### R-14 — No evidence of DR / restore-drill / failover runbooks for the financial ledger and Bronze stores
**Severity:** Low | **Category:** DR / failover | **Priority:** P3

**Evidence:** The realized_revenue_ledger and ad_spend_ledger are append-only financial sources of truth (`LedgerWriter.ts`), and Bronze is the ingestion spine. No restore-drill, backup-integrity probe, or cross-region failover runbook is present in `docs/runbooks/` referencing these stores (the devops skill mandates "an untested backup is not a backup" with a periodic restore-from-backup drill verified against the metric registry). Reported Low because it is a documentation/process gap auditable against the skill, not a code defect — but the financial impact of an unproven ledger restore is high.

**Impact:** RTO/RPO for the revenue ledger are unproven; a restore that yields wrong recognized-GMV numbers would not be caught before relied upon.

**Recommended Fix:** Add a scheduled OLTP point-in-time restore drill into a scratch instance, recompute canonical metrics (realized_gmv_as_of) on restored data, and assert parity. Add a backup-integrity checksum probe.

**Tenant Impact:** Multi-tenant — a shared OLTP restore affects all brands' financials.

**Detection:** Would only surface during a real incident — which is the point of the drill.

---

## Strengths observed (for balance)

- **Collector accept-before-validate ordering is correctly implemented** end-to-end: spool INSERT commits before ACK, no validation/Kafka in the request path (`collect.route.ts`, `accept-event.usecase.ts`), drainer is a separate loop (`drainer.ts`). The durability anchor is the spool commit, as designed — *except* it returns 500 not 503 on failure (R-02).
- **Offset-commit-after-write discipline (D-7) is consistently applied** across consumers — offset commits only after a confirmed Bronze/ledger write or DLQ produce.
- **Ledger writes are genuinely idempotent**: every `LedgerWriter` method uses `ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING` with deterministic `ledger_event_id` hashing, append-only by GRANT, signed-negative reversals (`LedgerWriter.ts` throughout). Replay-safe.
- **The live-ledger bridge as a separate consumer group with its own offset** (`LiveLedgerBridgeConsumer.ts`) correctly decouples ledger recognition from Bronze write, so a ledger failure retries independently without corrupting Bronze — a sound atomicity design.
- **Collector schema-registration degrades-don't-crash** with bounded exponential backoff (`main.ts:44-85`).
- **Migrations use node-pg-migrate** (`package.json:24`), which wraps each migration in a transaction by default — a migration failure rolls back cleanly (migration-failure simulation passes).
- **Connectors handle 429 with `Retry-After`/bounded backoff** and surface persistent throttle as a typed error (`meta-insights-client.ts`, `shopify-paged-client.ts`) — the gap is the no-response/timeout case (R-06) and jitter (R-12), not the explicit-throttle case.

---

## Verdict

The system gets the **hard structural reliability primitives right** — accept-before-validate spooling, offset-after-write commit discipline, and genuinely idempotent append-only ledger writes — which protects the financial source of truth from replay corruption. However, two **Critical** defects undermine the core "never lose an event" promise: the Redis dedup slot is claimed *before* the durable Bronze write, so any transient Postgres failure permanently drops in-flight events on redelivery (R-01); and the contractually-mandated `503 SPOOL_FULL + Retry-After` back-pressure path simply does not exist (R-02), turning a recoverable Redpanda outage into client-side data loss via a bare 500. These are compounded by process-local retry counters that lose poison-pill state across restarts (R-03), a complete absence of liveness/readiness probes on the stream-worker (R-04) and a trivially-static core health endpoint (R-05), and no request timeouts or circuit breakers on external calls (R-06, R-11). The durability *intent* is well-engineered; the **failure-path completeness is not** — the reliability guarantees hold on the happy path and break precisely under the dependency failures they are meant to absorb. Fix R-01 and R-02 before any sale-day load; they directly negate the 99.95% durability SLA.
