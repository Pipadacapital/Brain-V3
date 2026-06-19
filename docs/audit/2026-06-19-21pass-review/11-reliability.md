# Pass 11: Reliability Audit (reliability)

## Board Verdict

The Brain monorepo demonstrates strong reliability fundamentals in its core ingest path: the collector's accept-before-validate spool architecture correctly decouples availability from Kafka health; the stream-worker consumer fleet all enforce `autoCommit: false` with per-(partition, offset) retry counters and DLQ routing after MAX_RETRY=5; ledger writes are idempotent via `ON CONFLICT DO NOTHING` on well-chosen composite keys; and the SIGTERM/SIGINT shutdown path cleanly drains all 9 consumers plus 3 interval loops. However, the audit found six concrete reliability gaps: three production-grade risks (no HTTP fetch timeout on any external API client, no `connectionTimeoutMillis` on in-process PgPools that are never checked by readiness probes, and the stop() on interval schedulers drops the in-flight tick mid-run without awaiting it) and three medium risks (the KafkaJS `retry: {retries: 5}` configuration inside job `run()` functions uses default exponential backoff with no jitter, risking thundering-herd; `phone-guard-reeval` enumerates brands via a bare `SELECT … FROM brand WHERE status='active'` that returns zero rows under FORCE RLS; and the stream-worker exposes no liveness/readiness HTTP endpoint so Kubernetes cannot distinguish a deadlocked process from a healthy one).

**Severity counts:** Critical 0 | High 3 | Medium 3 | Low 0

---

## Finding REL-1

**Title:** All external-API fetch calls have no network timeout — a stalled upstream hangs the repull job forever

**Severity:** High

**Category:** Timeouts

**evidenceRef:**
- `apps/stream-worker/src/jobs/shopify-backfill/shopify-paged-client.ts:73-135` — `fetch(url, { headers: … })` with no `signal` option
- `apps/stream-worker/src/jobs/shopify-repull/shopify-live-client.ts:81-115` — same pattern
- `apps/stream-worker/src/jobs/meta-spend-repull/meta-insights-client.ts:147-183` — `fetch(url, { headers: … })` in the retry loop, no `AbortSignal.timeout()`
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/razorpay-settlements-client.ts:88-126` — same
- `apps/stream-worker/src/jobs/google-ads-spend-repull/google-ads-searchstream-client.ts:135-201` — same
- Compare: `apps/core/src/modules/connector/pixel/application/commands/VerifyPixelCommand.ts:128,136` — the pixel module correctly uses `AbortSignal.timeout(10_000)` / `AbortSignal.timeout(15_000)`, proving the pattern is known

**Impact:** If a third-party API (Shopify, Meta, Razorpay, Google Ads) stalls mid-response — a documented failure mode for all four — the repull job holds the `FOR UPDATE SKIP LOCKED` cursor lock and the pg-pool connection indefinitely. The ingest-scheduler's `inFlight` guard (`run.ts:128`) means the entire scheduler loop halts: no other brand's connectors get polled for the duration. In production with dozens of brands, a single stalled Shopify API call blocks all connector ingestion indefinitely. The process must be killed externally to recover.

**rootCause:** External API client implementations follow the Razorpay/Meta/Shopify retry-on-429 pattern but never added a `signal: AbortSignal.timeout(N)` to the underlying `fetch()` call. The one correct usage is in core's pixel verification command, not in the stream-worker job clients.

**Fix:** Add `signal: AbortSignal.timeout(30_000)` (30 s is appropriate for paginated API endpoints) to every `fetch()` call in `shopify-paged-client.ts`, `shopify-live-client.ts`, `meta-insights-client.ts`, `razorpay-settlements-client.ts`, and `google-ads-searchstream-client.ts`. The Google OAuth token exchange (`google-ads-searchstream-client.ts:135`) should use a shorter timeout (10 s). Treat `AbortError` / `TimeoutError` the same as a 5xx: log + throw so the job marks `connector_sync_status` as `error`.

**Priority:** P1

**tenantImpact:** All brands across all connected providers. The scheduler is cross-brand sequential (`ingest-scheduler/run.ts:65`) so a stall in brand A blocks brands B–N. Full multi-tenant blast radius.

**Detection:** Connector sync jobs that never complete; `connector_sync_status.state` stuck in `'syncing'`; missing rows in the ingest-scheduler tick logs; elevated `last_sync_at` staleness reported by the DQ freshness check.

---

## Finding REL-2

**Title:** Interval scheduler stop() does not await the in-flight tick — pools closed while DB queries are still running

**Severity:** High

**Category:** Graceful Drain

**evidenceRef:**
- `apps/stream-worker/src/jobs/sync-request-claimer/run.ts:235-239` — `stop()` sets `running = false` and returns immediately; the `while (running)` loop is async but there is no `await` on the loop's promise
- `apps/stream-worker/src/jobs/ingest-scheduler/run.ts:145-149` — identical pattern
- `apps/stream-worker/src/jobs/dq/run.ts:139-143` — identical pattern
- `apps/stream-worker/src/main.ts:307-320` — `shutdown()` calls `syncRequestClaimer.stop()`, `dqChecker.stop()`, `ingestScheduler.stop()` in `Promise.all`, then immediately proceeds to `syncClaimerPool.end()`, `dqPool.end()`, `ingestSchedulerPool.end()` — all sequential after the Promise.all resolves, but stop() is a no-op that resolves instantly without waiting for the tick

**Impact:** On SIGTERM (Kubernetes rolling restart), `stop()` resolves in microseconds. The shutdown sequence then calls `pool.end()` on the PgPool while the currently-running tick may be mid-query (e.g., `claimSyncRequest` inside a `BEGIN…COMMIT` transaction, or a full ingest scheduler tick dispatching repull jobs). The PgPool `end()` call terminates active connections. The in-flight query throws a connection-closed error, which propagates as an unhandled rejection in the dangling async loop. This can corrupt in-progress operations: a cursor-claim transaction may be mid-UPDATE when the pool is torn down, leaving the cursor row in a partially-claimed state (though `ROLLBACK` on connection close should clean it up at the DB level).

**rootCause:** The `startSyncRequestClaimer`/`startIngestScheduler`/`startDqChecks` pattern stores `void loop()` without keeping a reference to the Promise, so `stop()` has no way to await it. The KafkaJS `consumer.stop()` correctly waits for the in-flight `eachMessage` handler; the interval loops were modelled differently.

**Fix:** Store the loop Promise and expose it from `stop()`:
```ts
const loopPromise = loop();
return {
  stop: async () => {
    running = false;
    await loopPromise; // wait for the tick to complete
  },
};
```
`while (running)` plus the `inFlight` guard means the loop exits cleanly after the current tick finishes. Pool teardown can then proceed safely.

**Priority:** P1

**tenantImpact:** Process-wide. Affects all brands whose in-flight connectors are running when a deploy rolls out.

**Detection:** Kubernetes rolling-restart logs showing `pool ended` errors; PgPool connection errors during shutdown; connector_sync_status rows left in `'syncing'` state after pod restart.

---

## Finding REL-3

**Title:** stream-worker has no liveness or readiness HTTP endpoint — Kubernetes cannot detect deadlock or dependency failure

**Severity:** High

**Category:** Health/Readiness Probes

**evidenceRef:**
- `apps/stream-worker/src/main.ts:1-417` — entire file; no Fastify/HTTP server started; no `/healthz` or `/readyz` route registered
- Compare: `apps/collector/src/interfaces/rest/health.route.ts:12-41` — collector correctly exposes `/healthz` (liveness) and `/readyz` (readiness via spool DB ping)
- Compare: `apps/core/src/main.ts:327-331` — core exposes `/health`
- `infra/argocd/envs/prod/stream-worker.yaml:1-31` — Helm chart is referenced but no probe values are present in the repo (`infra/helm/stream-worker` directory exists but is empty of chart content)
- `infra/argocd/envs/staging/stream-worker.yaml:1-32` — same

**Impact:** If the stream-worker process deadlocks (e.g., all 9 KafkaJS consumers stall waiting for a broker that has split-brained, or all PgPool connections are exhausted due to a slow query and connection timeout is not set on the shared pools — see REL-4), Kubernetes has no way to detect the failure. The pod stays `Running`, no restarts are triggered, and consumer lag grows silently until an alert fires on Kafka consumer-group lag — if such an alert is wired. A probe would allow Kubernetes to restart the pod within `failureThreshold * periodSeconds` seconds.

**rootCause:** The stream-worker was designed as a pure Kafka consumer with no HTTP surface; adding a health server was deferred. The collector pattern was not propagated to the stream-worker.

**Fix:** Add a minimal Fastify (or raw `http.createServer`) health server in `apps/stream-worker/src/main.ts`. Liveness (`/healthz`): always 200 if the Node process is reachable. Readiness (`/readyz`): ping the PgPool (`SELECT 1`), check Redis dedup is connected, and verify at least one Kafka consumer is running. Add the probe definitions to the Helm values for stream-worker.

**Priority:** P1

**tenantImpact:** All tenants: a deadlocked stream-worker stops processing all brands' events. The collector still ACKs (spool is durable) but the backlog grows unboundedly.

**Detection:** Currently undetectable from the outside until Kafka consumer-group lag alerts (if configured) or a manual ops check. With probes: Kubernetes restarts the pod within minutes.

---

## Finding REL-4

**Title:** Main-process PgPools have no connectionTimeoutMillis — Postgres unavailability causes indefinite pool.connect() hangs

**Severity:** Medium

**Category:** Timeouts

**evidenceRef:**
- `apps/stream-worker/src/main.ts:103` — `auditPool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30_000 })` — no `connectionTimeoutMillis`
- `apps/stream-worker/src/main.ts:199` — `settlementMapPool = new PgPool({ connectionString: dbUrl, max: 3 })` — no timeout at all
- `apps/stream-worker/src/main.ts:243` — `syncClaimerPool = new PgPool({ connectionString: dbUrl, max: 3 })` — no timeout
- `apps/stream-worker/src/main.ts:263` — `dqPool = new PgPool({ connectionString: dbUrl, max: 3 })` — no timeout
- `apps/stream-worker/src/main.ts:294` — `ingestSchedulerPool = new PgPool({ connectionString: dbUrl, max: 3 })` — no timeout
- Compare: `apps/collector/src/infrastructure/pg-spool.repository.ts:28` — correctly sets `connectionTimeoutMillis: 5_000`
- Compare: `apps/stream-worker/src/infrastructure/pg/BronzeRepository.ts:37` — `statement_timeout: 10_000` is set but `connectionTimeoutMillis` is absent

**Impact:** During a Postgres failover (primary dies, replica promotion takes 15–30 s), `pool.connect()` blocks with no timeout. Every consumer handler that tries to write to the ledger or execute a sync claimer tick waits indefinitely on acquiring a connection. With `max: 3` pools, all 3 slots can become stuck simultaneously, blocking subsequent requests behind them. The KafkaJS consumer's `eachMessage` handler does not return, preventing offset commits and growing consumer lag. The process appears healthy but is frozen.

**rootCause:** The pools created directly in `main.ts` were not standardised against the connection timeout pattern used in `PgSpoolRepository`. The infrastructure layer repositories (BronzeRepository, IdentityRepository, LedgerWriter) each set `statement_timeout` but also lack `connectionTimeoutMillis`.

**Fix:** Add `connectionTimeoutMillis: 5_000` to all five `new Pool()`/`new PgPool()` calls in `main.ts` and to the Pool constructors in `BronzeRepository.ts:33`, `IdentityRepository.ts:42`, `LedgerWriter.ts:64`, `ConsentRepository`, and `CapiDeletionRepository`. This causes `pool.connect()` to throw after 5 s, which the consumer's catch block will count as a retry (up to MAX_RETRY=5) before DLQ routing.

**Priority:** P2

**tenantImpact:** All brands processed by the stream-worker are blocked simultaneously during a Postgres failover.

**Detection:** Consumer lag alert (if configured); long-running idle connections in `pg_stat_activity`; node process CPU at 0% despite being in `Running` state.

---

## Finding REL-5

**Title:** KafkaJS retry config in repull job `run()` functions uses default exponential backoff with no jitter — thundering-herd risk on broker restart

**Severity:** Medium

**Category:** Retry Logic (Backoff + Jitter)

**evidenceRef:**
- `apps/stream-worker/src/jobs/shopify-repull/run.ts:83-87` — `kafka.producer({ retry: { retries: 5 } })` — uses KafkaJS default backoff (initialRetryTime=300ms, factor=0.2) with no jitter configuration
- `apps/stream-worker/src/jobs/shopify-backfill/run.ts:83` — same
- `apps/stream-worker/src/jobs/razorpay-settlement-repull/run.ts:103` — same
- `apps/stream-worker/src/jobs/meta-spend-repull/run.ts:73` — same
- `apps/stream-worker/src/main.ts:97` — main Kafka client: `retry: { retries: 5 }` — same
- Compare: `meta-insights-client.ts:168` — `Math.min(30_000, 1000 * 2 ** attempt)` — exponential backoff but also no jitter

**Impact:** When a Redpanda broker restarts, all concurrently-running repull jobs (one per connector per brand, potentially 10–50 when the ingest scheduler dispatches them sequentially) plus the 9 consumer groups all reconnect within the same retry window. The default KafkaJS `multiplier: 0.2` provides minimal spread. A burst of simultaneous reconnects can overload the newly-restarted broker. While the connector jobs are sequential within a tick, multiple ticks from different runs or the sync claimer can overlap via the `FOR UPDATE SKIP LOCKED` gap.

**rootCause:** The `retry` object was copied from documentation examples which do not include jitter. KafkaJS supports a `multiplier` and `maxRetryTime` but not an explicit `jitter` function without a custom `retry` callback.

**Fix:** Add `multiplier: 0.5, maxRetryTime: 30_000, restartOnFailure: async () => true` to all `new Kafka({ retry: … })` configs. For the external HTTP client backoffs (Meta, Razorpay, Shopify 429 loops), add `Math.random() * backoffMs * 0.3` as a jitter term. Example for meta-insights-client: `const backoffMs = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500`.

**Priority:** P2

**tenantImpact:** All connected brands whose connectors are being polled at the time of broker restart. Primarily affects producer reconnect storms; consumer reconnect is handled by KafkaJS internally.

**Detection:** Elevated Kafka producer error rate in logs; connector_sync_status rows that transition to `error` immediately after a broker restart.

---

## Finding REL-6

**Title:** phone-guard-reeval enumerates brands via bare `SELECT … FROM brand` — zero rows returned under FORCE RLS, job silently no-ops

**Severity:** Medium

**Category:** Data Consistency During Failures

**evidenceRef:**
- `apps/stream-worker/src/jobs/phone-guard-reeval.ts:41-48` — `pool.query('SELECT id, phone_guard_threshold, suppression_window_days FROM brand WHERE status = \'active\'')`  — no GUC set, connecting as brain_app
- `apps/stream-worker/src/jobs/revenue-finalization.ts:97-100` — comparison: correctly uses `SELECT id FROM list_active_brand_ids()` (SECURITY DEFINER) 
- The revenue-finalization comment at line 97-99 explicitly notes: "NOTE (tracked): identity's phone-guard-reeval.ts has the same F-SEC-01 bug — it performs a bare SELECT from brand under FORCE RLS with no GUC and gets 0 brands."

**Impact:** On any production Postgres host where FORCE RLS is enforced for `brain_app` (which is the stated security model — migrations 0001–0014 establish `FORCE ROW LEVEL SECURITY` on the brand table), `phone-guard-reeval` returns zero brands and logs "complete: un-suppressed=0 extended=0". Phone-guard suppression windows never expire: shared-utility identifiers (kiosk phones flagged in a past burst) remain suppressed indefinitely, permanently breaking identity resolution for legitimate repeat customers. There is no error — the job "succeeds" returning zero work done. This is the same class of bug as F-SEC-01 in revenue-finalization, which was fixed, but phone-guard-reeval was not updated.

**rootCause:** The job was written before the SECURITY DEFINER enumeration pattern (`list_active_brand_ids()`) was established. When revenue-finalization was fixed, the comment was added but the fix was deferred.

**Fix:** Replace the bare `SELECT … FROM brand WHERE status = 'active'` in `phone-guard-reeval.ts:41-48` with `SELECT id, phone_guard_threshold, suppression_window_days FROM list_active_brand_ids()`. The function already returns the needed columns (id, cod/prepaid horizons, currency_code — phone guard needs threshold and window, which can be added to the fn or queried separately under brand GUC after enumeration). This is a tracked TODO in the codebase (`revenue-finalization.ts:97-99`).

**Priority:** P2

**tenantImpact:** All brands on the production host with FORCE RLS enabled. All shared-utility phone suppressions are permanent, blocking identity merge for legitimate repeat customers across all tenants.

**Detection:** `phone-guard-reeval` job logs showing `un-suppressed=0 extended=0` every run with active suppressions in the database; growing count of `suppressed_until IS NOT NULL` rows in `shared_utility_identifier` that never clear; identity resolution quality degrading over time (SUI suppression → lower merge rate).
