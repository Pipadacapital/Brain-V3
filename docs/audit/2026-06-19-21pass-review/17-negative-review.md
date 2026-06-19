# Pass 17: Negative Review Audit (2026-06-19)

**Auditor:** Principal-level automated audit — Audit Pass 17  
**Date:** 2026-06-19  
**Scope:** Brain V3 monorepo — all apps, packages, infra  
**Branch:** master (HEAD 44676d3)

---

## Board Verdict

Brain's data-plane invariants (D-1 accept-before-validate, D-2 brand-salt crash, D-7 offset-after-write) are correctly implemented and the critical tenant-isolation invariant (NN-1 GUC via set_config with `true`) is applied correctly in 4 of 6 call sites — but a single rogue `false` in `BackfillJobRepository` is a **P0 cross-tenant data bleed** that can serve Brand B's orders to Brand A on a pooled connection. Beyond that: the collector, stream-worker, and core services all ship dev-mode defaults that will silently mis-route events, expose admin endpoints, or accept any CORS origin the moment a single environment variable is omitted in production. The in-memory OAuth state store is self-documented as not production-safe and blocks horizontal scaling. Postgres pool cardinality is 55+ connections per single stream-worker pod with no PgBouncer, which will hit Postgres max_connections at 3+ pods. The collector spool table has no deletion path and will exhaust disk. The CAPI passback object is constructed then immediately voided in main.ts, meaning no ad-platform passback ever fires in production. ArgoCD references two Helm/kustomize paths that do not exist in the repo, making the production deployment entirely declarative fiction. Severity breakdown: 2 Critical · 4 High · 4 Medium.

**Severity counts:** 2 Critical · 4 High · 4 Medium

---

## Finding 1

**ID:** negative-review-1  
**Title:** BackfillJobRepository GUC set_config(false) — cross-tenant RLS bleed on pooled connection  
**Severity:** Critical  
**Priority:** P0  
**Category:** Security / Tenant Isolation  
**EvidenceRef:** `apps/stream-worker/src/infrastructure/pg/BackfillJobRepository.ts:257,277`  
**Impact:** If Brand A's backfill job runs and releases the connection, the next query on that connection (any brand) inherits Brand A's `app.current_brand_id` GUC and therefore bypasses RLS — reading or writing Brand A's rows under Brand B's session. All other call sites use `true` (transaction-local); this is the sole outlier.  
**RootCause:** `set_config('app.current_brand_id', $1, false)` sets the GUC at SESSION scope, not transaction-local scope. When `client.release()` returns the connection to the pool the GUC is still set to the previous brand.  
**Fix:** Change both call sites to `set_config('app.current_brand_id', $1, true)` (matching every other repository in the codebase). Add a pool `on('connect')` hook that resets the GUC to `''` as defense-in-depth.  
**TenantImpact:** Cross-tenant data leak — Brand B can read Brand A order rows through RLS bypass.  
**Detection:** Grep `set_config.*false` across `*.ts`; any hit is a critical finding.

---

## Finding 2

**ID:** negative-review-2  
**Title:** InProcessOAuthStateStore used for all OAuth flows in production — CSRF under multi-pod  
**Severity:** Critical  
**Priority:** P0  
**Category:** Security / Scalability  
**EvidenceRef:** `apps/core/src/main.ts:544`; `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts:1-61`; `apps/core/src/modules/connector/catalog/index.ts:12-14`  
**Impact:** The store's own JSDoc says "NOT suitable for multi-instance production deployments." Under 2+ core pods, an OAuth callback can land on a different pod than the one that generated the nonce — resulting in nonce-not-found → OAuth failure. Worse, a replay attacker can probe a pod that never saw the nonce, bypassing CSRF validation entirely.  
**RootCause:** `new InProcessOAuthStateStore()` is wired for Shopify, Meta, and Google Ads OAuth at `main.ts:671,674,680,683`. No Redis-backed implementation exists. Scale-C4 ADR is documented but unimplemented.  
**Fix:** Implement `RedisOAuthStateStore` using the existing Redis client (already imported in main.ts). TTL should match nonce expiry (~10 min). Reference: `packages/redis-client` + `Scale-C4` note in `connector/catalog/index.ts`.  
**TenantImpact:** OAuth callback failures for all connector types under horizontal scale; potential CSRF nonce bypass.  
**Detection:** Grep `InProcessOAuthStateStore` in `main.ts`; confirm no Redis-backed alternative exists.

---

## Finding 3

**ID:** negative-review-3  
**Title:** Collector spool table is append-only with no deletion path — unbounded disk growth  
**Severity:** High  
**Priority:** P1  
**Category:** Operational / Scalability  
**EvidenceRef:** `db/migrations/0015_collector_spool.sql` (comment: "No DELETE — spool rows are append-only; archival is a future housekeeping job.")  
**Impact:** Every inbound event is inserted into `collector_spool` and never deleted. In production at even modest traffic (1k events/min) the table grows at ~500k rows/day. There is no partition scheme, no TTL, and no scheduled deletion. Disk exhaustion will eventually halt all inserts (D-1 invariant broken).  
**RootCause:** Deliberate design deferral ("future housekeeping job"). No job was ever created.  
**Fix:** Add a Postgres `pg_cron` job or a stream-worker maintenance loop to `DELETE FROM collector_spool WHERE created_at < NOW() - INTERVAL '7 days' AND status = 'processed'`. Alternatively partition by week.  
**TenantImpact:** Disk exhaustion takes down the entire multi-tenant collector — all brands' ingest stops.  
**Detection:** Check migration for DELETE grant on `brain_app`; none exists. Scan codebase for `collector_spool` DELETE statement — zero hits.

---

## Finding 4

**ID:** negative-review-4  
**Title:** Stream-worker spawns 55+ Postgres connections per pod — no PgBouncer, max_connections cliff at 3 pods  
**Severity:** High  
**Priority:** P1  
**Category:** Scalability / Reliability  
**EvidenceRef:** `apps/stream-worker/src/main.ts:103,199,243,263,294` — pools: auditPool(3), bronze(5), identityRepo(5), consentRepo(5), capiDeletionRepo(5), backfillBronze(5), ledgerWriter(3), liveLedgerWriter(3), settlementMapPool(3), settlementLedgerWriter(3), spendLedgerWriter(3), gokwikAwbLedgerWriter(3), syncClaimerPool(3), dqPool(3), ingestSchedulerPool(3) = ~55 connections  
**Impact:** Postgres default `max_connections = 100`. Three stream-worker pods = 165 connections, exhausting the database. Additional services (core, web) compete for the same pool. `FATAL: remaining connection slots are reserved` errors will cascade.  
**RootCause:** Each domain concern owns its own `pg.Pool` instance. No connection multiplexer (PgBouncer/Pgpool) is present anywhere in `infra/`.  
**Fix:** Deploy PgBouncer in transaction-pooling mode as a sidecar or shared service. Reduce individual pool `max` sizes to 2. Target total < 20 per pod. Alternatively consolidate to a shared pool passed via dependency injection.  
**TenantImpact:** Database connection exhaustion is a full-platform outage — all tenants affected.  
**Detection:** Count `new Pool(` and `new *Repository(dbUrl)` in `stream-worker/src/main.ts`; multiply by replica count.

---

## Finding 5

**ID:** negative-review-5  
**Title:** COLLECTOR_TOPIC defaults to `dev.collector.event.v1` — prod pod silently consumes dev topic  
**Severity:** High  
**Priority:** P1  
**Category:** Operational / Data Integrity  
**EvidenceRef:** `apps/stream-worker/src/main.ts:53` — `const topic = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';`  
**Impact:** If `COLLECTOR_TOPIC` is not set in the production deployment (e.g., a missed secret/env-var in K8s), stream-worker silently subscribes to `dev.collector.event.v1` — consuming zero production events. All prod events go unprocessed. No error is raised; the service appears healthy.  
**RootCause:** Soft default instead of a `getEnvOrThrow` call. Compare: collector's topic is derived from `NODE_ENV` (a different smell), but stream-worker has no such guard.  
**Fix:** Replace `?? 'dev.collector.event.v1'` with `getEnv('COLLECTOR_TOPIC')` where `getEnv` throws if undefined (matching the pattern used for `DATABASE_URL` and `KAFKA_BROKERS` elsewhere in the same file).  
**TenantImpact:** Silent total ingest failure — all tenants' events are not processed; no alert triggers.  
**Detection:** Grep `?? 'dev\.'` in `stream-worker/src/main.ts`.

---

## Finding 6

**ID:** negative-review-6  
**Title:** StarRocks bootstrap and prod default both use hardcoded dev password `brain_analytics_dev`  
**Severity:** High  
**Priority:** P1  
**Category:** Security / Credentials  
**EvidenceRef:** `db/starrocks/bootstrap.sql:12` (`IDENTIFIED BY 'brain_analytics_dev'`); `apps/core/src/main.ts:191` (`getEnv('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev')`)  
**Impact:** If `STARROCKS_ANALYTICS_PASSWORD` is not set in production, the core service connects to StarRocks with a well-known password that matches the bootstrap SQL. Any attacker with network access to StarRocks port 9030 can authenticate as `brain_analytics` and read all Silver-tier analytics data across all brands.  
**RootCause:** Convenience default left in place for dev parity; no environment enforcement.  
**Fix:** Change `getEnv('STARROCKS_ANALYTICS_PASSWORD', 'brain_analytics_dev')` to `getEnv('STARROCKS_ANALYTICS_PASSWORD')` (no default, throws if missing). Rotate the credential in bootstrap.sql to a placeholder and require it to be overridden at deployment time.  
**TenantImpact:** Cross-tenant analytics data exposure if the credential is not overridden.  
**Detection:** Grep `brain_analytics_dev` across all files — matches in both bootstrap SQL and app config.

---

## Finding 7

**ID:** negative-review-7  
**Title:** CAPI passback adapter constructed then immediately voided — no ad-platform passback ever fires  
**Severity:** Medium  
**Priority:** P2  
**Category:** Functional / Feature Completeness  
**EvidenceRef:** `apps/core/src/main.ts:425-428` (`void capiCredsPort; void capiAdapter;`); `apps/core/src/modules/notification/internal/capi-passback.service.ts:164` (`pixelId: ''`)  
**Impact:** Meta Conversions API passback is a core product feature (consent-gated CAPI for ad attribution). The adapter is built but immediately suppressed with `void`. The passback service carries `pixelId: ''`, which would generate requests to `/events` instead of `/${pixelId}/events`. CAPI passback is non-functional in all environments including production.  
**RootCause:** Dev/stub guard left open-ended: `capiCredsPort` returns a no-op in non-production; the `void` statements suppress TypeScript's "unused variable" error without wiring the adapter into any route handler.  
**Fix:** Wire `capiAdapter` into the CAPI passback route handler. Resolve `pixelId` from the brand's connector config (the Meta connector stores this). Remove `void` statements and add an integration test that asserts a CAPI POST is issued when consent is present.  
**TenantImpact:** All brands: ad attribution (Meta CAPI) never fires — marketing ROI measurement is broken for any brand relying on CAPI passback.  
**Detection:** Search `void capiAdapter` and `void capiCredsPort` in `main.ts`.

---

## Finding 8

**ID:** negative-review-8  
**Title:** EDGE_ORIGIN_ALLOWLIST defaults to empty string — collector accepts POST from any origin  
**Severity:** Medium  
**Priority:** P2  
**Category:** Security  
**EvidenceRef:** `apps/collector/src/main.ts:138` — `originAllowlist: (process.env['EDGE_ORIGIN_ALLOWLIST'] ?? '').split(',').map(o=>o.trim()).filter(o=>o.length>0)`  
**Impact:** When `EDGE_ORIGIN_ALLOWLIST` is not set, the filtered array is `[]`. `EdgeRateLimiter` treats an empty allowlist as "allow all" — any origin can POST events to `/collect`. Combined with in-memory rate limiting (per-pod, not distributed), an attacker can flood the collector from any domain.  
**RootCause:** Permissive-by-default allowlist designed for local dev convenience; no enforcement in production path.  
**Fix:** If `EDGE_ORIGIN_ALLOWLIST` is empty and `NODE_ENV === 'production'`, log a warning and optionally reject all cross-origin requests. Add this env var to the required production checklist.  
**TenantImpact:** Any brand's pixel can be polluted with synthetic events from unauthorized origins, corrupting attribution data.  
**Detection:** Grep `EDGE_ORIGIN_ALLOWLIST` — only one reference, no throw-if-empty guard.

---

## Finding 9

**ID:** negative-review-9  
**Title:** Zero HTTP security response headers — no CSP, no X-Frame-Options, no HSTS  
**Severity:** Medium  
**Priority:** P2  
**Category:** Security  
**EvidenceRef:** `apps/web/next.config.js` (no `headers()` export); `apps/core/src/main.ts` (no `reply.header('Content-Security-Policy', ...)` anywhere)  
**Impact:** The web application (Next.js) and core API (Fastify) serve no security headers. This enables: clickjacking (no X-Frame-Options), MIME sniffing (no X-Content-Type-Options), XSS amplification (no CSP), and protocol downgrade (no HSTS). For an e-commerce OS handling payment and identity data, this fails basic web security hygiene.  
**RootCause:** Security headers were never added; no helmet-equivalent middleware is present.  
**Fix:** Add `fastify-helmet` to core. Add a `headers()` export to `next.config.js` with `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy`, and `Strict-Transport-Security`.  
**TenantImpact:** All brands' admin users are exposed to clickjacking and XSS amplification vectors.  
**Detection:** Grep `X-Frame-Options\|Content-Security-Policy\|helmet` across all app source — zero hits.

---

## Finding 10

**ID:** negative-review-10  
**Title:** ArgoCD prod manifests reference non-existent Helm/kustomize paths — production deploy is broken  
**Severity:** Medium  
**Priority:** P2  
**Category:** Operational / Deployment  
**EvidenceRef:** `infra/argocd/envs/prod/stream-worker.yaml` (references `infra/helm/stream-worker` — directory absent); `infra/argocd/envs/prod/collector.yaml` (references `infra/k8s/collector/overlays/production` — directory absent)  
**Impact:** ArgoCD will report both Applications as `OutOfSync` with `ComparisonError: path not found`. Neither stream-worker nor collector can be deployed to production via GitOps. Any "prod deploy" has been manual or is simply not happening.  
**RootCause:** Manifest stubs were committed with placeholder paths; the actual Helm charts or kustomize overlays were never created.  
**Fix:** Either create the referenced Helm charts/overlays, or update the ArgoCD Application manifests to point to the actual deployment manifests that exist in `infra/`.  
**TenantImpact:** Production deployment of data-plane services (collector + stream-worker) is declaratively broken — all tenants' event ingest cannot be deployed reproducibly.  
**Detection:** `ls infra/helm/stream-worker infra/k8s/collector/overlays/production` — both return "No such file or directory."

---

## Finding 11

**ID:** negative-review-11  
**Title:** CollectorEventConsumer retry counter not reset on Kafka partition rebalance — stale DLQ routing  
**Severity:** Medium  
**Priority:** P2  
**Category:** Reliability / Data Integrity  
**EvidenceRef:** `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts:34` — `private readonly retryCount = new Map<RetryKey, number>();`  
**Impact:** After a consumer group rebalance (e.g., pod restart, scaling event), the `retryCount` map on the new consumer starts at zero for all messages, but the map on the old consumer (which saw 2 retries already) is discarded. If the new consumer picks up those messages, it will retry them again from 0 — exceeding the effective retry budget. Conversely, if a partition is re-assigned to a pod that already has stale counter entries, a message could hit the DLQ prematurely.  
**RootCause:** No `partitionsRevoked` or `rebalanceListener` handler clears the in-memory `retryCount` map on reassignment.  
**Fix:** Register a `eachBatch` or `rebalanceListener` callback on the KafkaJS consumer that calls `this.retryCount.clear()` on `partitionsRevoked`. Alternatively, use Kafka's native retry topic pattern (commit offset only after confirmed write, D-7) rather than an in-process counter.  
**TenantImpact:** Events from any tenant can be incorrectly DLQ'd or over-retried after any scaling event.  
**Detection:** Grep `partitionsRevoked\|rebalanceListener` in `CollectorEventConsumer.ts` — zero hits.
