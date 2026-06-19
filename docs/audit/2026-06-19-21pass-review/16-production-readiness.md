# Pass 16: Production Readiness Audit (production-readiness)

## Board Verdict

Brain's application code demonstrates solid per-service startup/shutdown discipline (accept-before-validate D-1 invariant in collector, graceful SIGTERM handlers in all three deployables), but the gap between the documented production posture (doc-04 §K–§I) and the actual deployed state is wide enough to block enterprise go-live. The six findings below are not theoretical: the infra/k8s/ directory that ArgoCD is wired to sync from does not exist (every prod deploy would fail immediately); the SLO burn alert rules reference metric names that are emitted only as console.info stubs (no real Prometheus counters exist); the stream-worker — the most critical stateful consumer — exposes no HTTP endpoint at all, making K8s health-probe-based auto-rollback impossible; the in-memory OAuth state store guarantees login-to-connector flows break silently when more than one core replica is running; collector's readyz probe reports "ready" even when the drainer is stuck and the spool is growing; and the runbooks referenced in doc-04 §M.3/§M.4 exist only as two-line pointer stubs. No finding here is speculative — each is anchored to specific lines of code or manifest that were read during the audit.

**Severity counts:** Critical: 2 · High: 2 · Medium: 2

---

## Finding PR-1

**Title:** infra/k8s/ directory does not exist — ArgoCD prod and staging deploys fail at sync

**Severity:** Critical

**Category:** Deployment / CI-CD

**evidenceRef:**
- `infra/argocd/envs/prod/collector.yaml:26` — `path: infra/k8s/collector/overlays/production`
- `infra/argocd/envs/staging/collector.yaml:26` — `path: infra/k8s/collector/overlays/staging`
- Confirmed absent: `ls infra/k8s` → `NOT FOUND`

**impact:** Every ArgoCD sync for collector (prod and staging) resolves to a non-existent kustomize path. ArgoCD will enter `OutOfSync / Error` state. No new image can be promoted to any environment. CI pipeline's "bake window" step (`main.yml:197-207`) references dashboards and rollback signals that also cannot fire because the deployment never happens. The entire GitOps path is severed.

**rootCause:** The doc-04 §K spec (lines 1998-2028) defines the full K8s Deployment + HPA + PDB manifests inline. These were never extracted into the referenced `infra/k8s/` directory structure. The ArgoCD Application manifests were written assuming the K8s manifests would exist at those paths, but the extraction was not done.

**fix:** Create `infra/k8s/collector/overlays/production/kustomization.yaml` (and staging equivalent) containing at minimum the Deployment, HPA, and PDB as defined in doc-04 §K lines 1980-2028. Mirror the pattern for `stream-worker` and `core` ArgoCD apps. Health probe paths must also be reconciled (see PR-3). Without this, no environment can deploy.

**priority:** P0

**tenantImpact:** All tenants — no deployments possible for any service in any environment.

**detection:** ArgoCD sync status page shows `OutOfSync / ComparisonError: path does not exist`. Currently undetected because no one has attempted a prod sync.

---

## Finding PR-2

**Title:** SLO burn alert rules reference metric names that do not exist — all production alerts are dead

**Severity:** Critical

**Category:** Observability / Alerting

**evidenceRef:**
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:1855-1883` — alert rules referencing `collector_acks_total`, `collector_requests_total`, `parity_convergence_abs_diff_minor`, `audit_chain_verify_failures_total`, `tenant_context_violation_total`
- `packages/observability/src/index.ts:162-169` — `defaultCounterSink` emits `console.info("[metric] ...")` — no real OTel meter, no Prometheus counter registration
- `infra/observe/prometheus.yml:11-16` — Prometheus configured to scrape collector at `:9091` and stream-worker at `:9092`; neither app opens those ports

**impact:** The multiwindow SLO burn alerts (14.4×/6× for collector's 99.95% target, cross-tenant isolation breach, audit chain break, parity drift) are all wired to metric names that are never emitted as real Prometheus counters. Prometheus scrapes phantom endpoints. The "Grafana Cloud bake dashboard" (`main.yml:207`) references `https://grafana.brain-platform.io/d/bake-window` which cannot exist without real metrics. In a P0 incident, the on-call team has no automated page — detection depends entirely on manual log inspection.

**rootCause:** The `@brain/observability` package explicitly notes in its Sprint 0 posture (`index.ts:12-15`): "stub implementation ... wired to the real OTel SDK in M1." The metric registry and counter emission were left as stubs. The alert rule YAML in doc-04 §I.3 is documentation-only; it was never deployed to a Prometheus/Grafana instance.

**fix:** (1) Replace `defaultCounterSink` in `packages/observability/src/index.ts` with a real `@opentelemetry/api` MeterProvider integration. (2) Instrument `collector_acks_total` / `collector_requests_total` at `apps/collector/src/interfaces/rest/collect.route.ts`. (3) Open a `/metrics` endpoint on each service (prom-client or OTel Prometheus exporter). (4) Deploy the alert rule YAML from doc-04 §I.3 into a real Prometheus rules file under `infra/observe/`. (5) Fix the Prometheus scrape config to point to the actual metrics ports.

**priority:** P0

**tenantImpact:** All tenants — no automated alerting for any SLO breach, security event, or billing parity drift.

**detection:** Not detectable from production — only discoverable by manually checking Prometheus targets and confirming all are DOWN.

---

## Finding PR-3

**Title:** stream-worker has no HTTP server — K8s liveness/readiness probes and auto-rollback are impossible

**Severity:** High

**Category:** Health Checks / Kubernetes

**evidenceRef:**
- `apps/stream-worker/src/main.ts:1-417` — entire file; no `Fastify`, no `http`, no server, no health endpoint
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:549` — "Each deployable: four K8s health probes, a root handler, real-network smoke, env validation"
- `infra/argocd/envs/staging/collector.yaml:61` — "ArgoCD uses pod readiness probes (/health/live, /health/ready) to determine health"
- Collector health routes: `apps/collector/src/interfaces/rest/health.route.ts:14,19` — `/healthz` and `/readyz` (not the doc-specified `/health/live` and `/health/ready`)

**impact:** Without a health HTTP endpoint, K8s cannot probe the stream-worker for liveness or readiness. A stuck Kafka consumer, a deadlocked DQ check loop, or a half-initialized consumer group will not cause a pod restart. The ArgoCD staging auto-rollback (referenced in `infra/argocd/envs/staging/collector.yaml:62`) depends on probe failures — but no probes can fire. For collector specifically, the actual probe paths (`/healthz`, `/readyz`) diverge from the doc-04 spec (`/health/live`, `/health/ready`, `/health/startup`), so any K8s manifests derived from the spec would probe the wrong paths and immediately mark the pod unhealthy.

**rootCause:** stream-worker was designed as a pure KafkaJS consumer with no HTTP surface. The doc-04 §F.4 spec that requires four health probes per deployable was not implemented for this service. The collector health endpoints also drifted from the documented paths during implementation.

**fix:** (1) Add a lightweight Fastify HTTP server to stream-worker (port 9093 or configurable) exposing `GET /healthz` (liveness — always 200 if main loop running) and `GET /readyz` (readiness — checks Kafka consumer group lag or at minimum that `consumer.start()` completed without error). (2) Align collector health paths to match doc-04: add `/health/startup`, `/health/live`, `/health/ready` aliases or update the K8s manifests to use `/healthz`/`/readyz`.

**priority:** P1

**tenantImpact:** All tenants — stream-worker process failures (consumer lag, stuck jobs) are invisible to K8s and will not auto-recover.

**detection:** In an incident: stream-worker pod shows Running but all consumers silently dead. No alert fires. Only observable via Kafka consumer group lag monitoring (which also requires real metrics per PR-2).

---

## Finding PR-4

**Title:** InProcessOAuthStateStore used in production — OAuth flows fail silently under multi-replica core

**Severity:** High

**Category:** Operational Correctness / Multi-Replica

**evidenceRef:**
- `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts:5` — explicit comment: "NOT suitable for multi-instance production deployments (use Redis-backed store instead)"
- `apps/core/src/main.ts:544` — `const oauthStateStore = new InProcessOAuthStateStore();` — no environment check, no Redis alternative
- `apps/core/src/main.ts:671,674,680,683` — Meta and Google Ads OAuth also use the same in-memory store

**impact:** When core runs with `minReplicas: 3` (as doc-04 §K HPA implies), the OAuth state nonce stored by Pod A during connector install will not be visible to Pod B that receives the OAuth callback from Shopify/Meta/Google. The callback will return `StateNonceError` and the user sees `?connect_error=state_invalid`. Connectors cannot be installed in production with multiple core replicas. This affects Shopify, Meta Ads, and Google Ads OAuth — the primary connector onboarding path.

**rootCause:** The InProcessOAuthStateStore was written as a dev/test implementation with a clear note it is not production-safe. A Redis-backed implementation was deferred, but the production deployment path (`isProduction` check in `apps/core/src/main.ts:132`) does not switch to a durable store.

**fix:** Implement a `RedisOAuthStateStore` (using ioredis, the Redis client already wired in `apps/core/src/main.ts:335`) with the same `IOAuthStateStore` interface. Set TTL via Redis SETEX. Wire it in `apps/core/src/main.ts`: replace `new InProcessOAuthStateStore()` with `new RedisOAuthStateStore(redis)` when `isProduction` is true. The Redis instance is already available.

**priority:** P1

**tenantImpact:** All tenants attempting to connect Shopify/Meta/Google Ads connectors in production under multi-replica core deployment.

**detection:** Connector install page shows `?connect_error=state_invalid` intermittently (when callback lands on different pod). Support ticket volume spike.

---

## Finding PR-5

**Title:** Collector readyz reports "ready" when drainer is stuck and spool grows without bound

**Severity:** Medium

**Category:** Health Checks / Backpressure

**evidenceRef:**
- `apps/collector/src/interfaces/rest/health.route.ts:19-28` — `/readyz` only checks `spool.ping()` (SELECT 1 to PG); does not check drainer state or spool backlog depth
- `apps/collector/src/interfaces/jobs/drainer.ts:59-69` — drainer errors are caught and logged (`console.error`) but do not set any unhealthy flag
- `apps/collector/src/application/drain-events.usecase.ts:33` — "Back-pressure: if Redpanda is down, the whole batch silently stays pending"
- `db/migrations/0015_collector_spool.sql:12` — "No DELETE — spool rows are append-only; archival is a future housekeeping job"

**impact:** If Redpanda is unreachable (e.g., network partition, cert rotation), the collector continues accepting events (returning 200) and the readyz endpoint continues returning 200 (spool DB is fine). The spool table grows without bound. An extended Redpanda outage of even 1 hour at a modest ingest rate of 10 events/second fills the spool with 36,000 rows. No alert fires (per PR-2), no K8s signal changes, no operator awareness. In addition, the `collector_spool` table never deletes drained rows, creating a permanent table-bloat accumulation that grows heap size and increases VACUUM pressure over months of operation.

**rootCause:** The D-1 "accept before validate" invariant was correctly implemented (spool first, then produce), but the operational observability for spool health was deferred. The readyz check was scoped narrowly to DB reachability rather than overall pipeline health. The table archival job was explicitly deferred ("archival is a future housekeeping job").

**fix:** (1) Add a `spool_pending_depth` gauge to the drainer tick — emit the pending count after each `pollPending` call. (2) Add a spool-depth check to `/readyz`: if `COUNT(*) WHERE status='pending'` exceeds a configured threshold (e.g., 10,000 rows), return 503 so K8s can route traffic away. (3) Create a periodic archival job (or use a TTL-based partial DELETE) that removes `status='drained'` rows older than 7 days.

**priority:** P2

**tenantImpact:** Single-tenant first (the tenant whose events trigger the drainer overload), but unobserved Redpanda outages affect all ingest brands simultaneously.

**detection:** Only by querying `SELECT COUNT(*) FROM collector_spool WHERE status='pending'` directly. No alert exists.

---

## Finding PR-6

**Title:** Runbooks and playbooks are pointer stubs — no actionable incident response documentation exists

**Severity:** Medium

**Category:** Operational Readiness / Runbooks

**evidenceRef:**
- `docs/runbooks/README.md:1-6` — full content is 4 lines: three bullet-point titles (RB-1, RB-2, RB-3) and "Full text: docs/04 §M.3 (Brain-docs)"
- `docs/playbooks/README.md:1-2` — full content is 1 line: pointer to "docs/04 §M.4"
- `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2158-2171` — §M.3 contains 3-sentence summaries per runbook (not actual step-by-step runbooks); §M.4 is a 4-row severity table plus 2 sentences on roles

**impact:** In a P0 incident (cross-brand leak, collector SLO breach, RDS failure), the on-call engineer has no actionable runbook to follow. The RDS PITR runbook (RB-1) mentions "freeze writes (core read-only flag)" but there is no such flag implemented in the code. The EKS recovery runbook (RB-2) says "Terraform apply EKS" but the prod Terraform env (`infra/terraform/envs/prod/bootstrap.tf`) is a bootstrap file, not a full env module. The StarRocks rebuild runbook (RB-3) references an Argo `starrocks-rebuild` workflow that does not exist in `infra/argocd/`.

**rootCause:** Runbooks were deferred to a "template" status in doc-04. The actual repo runbooks are pointer files delegating to the same doc-04 summaries. No standalone runbook document with concrete CLI commands, decision trees, or role assignments has been authored.

**fix:** Author three standalone runbook markdown files at `docs/runbooks/RB-1-rds-pitr.md`, `docs/runbooks/RB-2-eks-recovery.md`, `docs/runbooks/RB-3-starrocks-rebuild.md`. Each must include: incident declaration steps, exact CLI commands (aws rds restore-db-instance-to-point-in-time, argocd app rollback, etc.), verification checks with expected outputs, escalation contacts, and estimated time per step. The "core read-only flag" referenced in RB-1 must also be implemented (feature flag or env var check).

**priority:** P2

**tenantImpact:** All tenants — a data loss event or availability incident during which the team has no playbook will extend MTTR significantly.

**detection:** Only during an actual incident when the on-call engineer discovers the runbook is three bullet points.
