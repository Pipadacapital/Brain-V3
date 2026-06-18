# PASS 16 — Production Readiness Audit

**Board:** production-readiness · **Auditor:** independent principal reviewer · **Date:** 2026-06-19
**Question:** Can Brain go live? What fails first, what breaks under load, what breaks during an incident, what blocks enterprise readiness?

## Verdict (one paragraph)

**Brain CANNOT go live.** The deployment substrate is a façade: every ArgoCD Application points at a Helm chart or Kustomize overlay path that **does not exist in the repo** (`infra/helm/core`, `infra/helm/stream-worker`, `infra/k8s/collector/overlays/production`), there are **zero Kubernetes Deployment manifests**, **zero Dockerfiles** (the CI `docker build -f apps/<app>/Dockerfile` references files that are absent), **no probes/HPA/PDB/resource-limits anywhere**, and the entire `@brain/observability` package is an **explicit Sprint-0 stub** that emits metrics via `console.info` and produces no-op spans — so the `/metrics` endpoints Prometheus scrapes (`:9091`/`:9092`) and the p95/error-rate signals the CI "auto-rollback" prints **are never produced**. The "auto-rollback" itself is `echo` text, not an alarm or hook; **no alert rule exists in the entire repo**. `stream-worker` (the consumer carrying ledger/identity/consent writes) exposes **no HTTP port at all**, so it is unprobeable and unmonitorable. The documented runbooks/playbooks (RB-1/2/3, incident ladder) live only as prose in `docs/requirements/04` §M — `docs/runbooks/` and `docs/playbooks/` are one-line README stubs, so the on-call surface is non-operational. Under load, the first thing to fail is the collector spool (unbounded, per-pod in-memory rate limiting) filling the shared RDS disk. This is pre-alpha operational maturity dressed as a production pipeline.

---

## Findings

### F1 — ArgoCD Applications point at deployment manifests that do not exist | Critical | Deploy/GitOps
**Evidence:**
- `infra/argocd/envs/prod/core.yaml:18` → `path: infra/helm/core`; `stream-worker.yaml:19` → `path: infra/helm/stream-worker`; `web.yaml`, `collector.yaml:31` → `path: infra/k8s/collector/overlays/production`.
- `find infra/helm -type f` returns ONLY `infra/helm/README.md` + `infra/helm/authentik/values-dev.yaml`. There is **no** `infra/helm/core`, `/stream-worker`, `/collector`, `/web`, `/litellm`.
- `ls infra/k8s` → `No such file or directory`. The collector Application targets a kustomize overlay tree that does not exist.
- The four Applications are also **internally inconsistent**: collector uses Kustomize (`infra/k8s/...`), the other three use Helm (`infra/helm/...`). Neither family of paths exists.

**Impact (production):** `argocd app sync` for any service fails at manifest generation — nothing deploys. There is no path from a built image to a running pod. Go-live is impossible.
**Root cause:** GitOps Application shells were authored before (or without) the actual chart/manifest authoring; CI was never run end-to-end against a real cluster.
**Fix:** Author one Helm chart (or Kustomize base+overlays) per deployable under the referenced path, with Deployment/Service/HPA/PDB/probes/resources; pick ONE templating tool across all four apps; add a CI job that runs `helm template`/`kustomize build` + `argocd app diff` to fail the build when a referenced path is missing.
**Priority:** P0 · **Tenant Impact:** all tenants (no service runs) · **Detection:** would surface as the first `argocd app sync` error — but there is no integration test catching it pre-merge.

### F2 — No Dockerfiles exist; CI builds reference absent files | Critical | Build/Supply-chain
**Evidence:** `find apps -name "Dockerfile*"` returns nothing. `.github/workflows/main.yml:74` runs `docker build ... -f apps/${{ matrix.app }}/Dockerfile .` for `[collector, stream-worker, core, web]`. The skill mandates multi-stage non-root Dockerfiles with `HEALTHCHECK`; `grep -rl HEALTHCHECK apps` → none.
**Impact:** The `build-and-push` job fails at `docker build` for every affected service — no image is ever produced, signed (cosign step never reached), or pushed. The entire pipeline downstream (gitops-staging, prod-promote) operates on empty digest outputs.
**Root cause:** Image packaging was never implemented; CI was written speculatively.
**Fix:** Add multi-stage Dockerfiles (slim base → deps → builder → non-root runner) per app with a `HEALTHCHECK`; verify `docker build` in a CI smoke before the matrix push.
**Priority:** P0 · **Tenant Impact:** all tenants · **Detection:** first real CI run on `main`.

### F3 — No liveness/readiness probes exist for any service; stream-worker exposes no HTTP port | Critical | Probes
**Evidence:**
- `grep -rl "livenessProbe\|readinessProbe" .` (excl node_modules) → **zero** matches. No Deployment to attach probes to (F1).
- Only `apps/collector/src/interfaces/rest/health.route.ts` implements `/healthz` (liveness) + `/readyz` (readiness, pings spool DB) — but no manifest wires them.
- `apps/core/src/main.ts:327` exposes `/health` returning a static `{status:'ok'}` (**no dependency check** — a trivial liveness with no readiness gate; it will report healthy while Postgres/Redis/Kafka are down).
- `apps/stream-worker/src/main.ts` imports `kafkajs`/`pg` only — **no Fastify/http listener, no port, no health route**. `grep listen apps/stream-worker/src` → none. It is structurally unprobeable.

**Impact:** Kubernetes cannot restart a wedged stream-worker (no liveness) and cannot gate traffic on core readiness (its `/health` is static). A stream-worker that loses all Kafka consumers stays "Running" forever; lag grows silently; ledger/identity/consent writes stall with no restart, no probe failure, no alert. Core will receive traffic before its DB pool is ready and 500 the first requests after every rollout.
**Root cause:** Probes treated as a manifest concern that was never built; the pure-consumer worker was never given an ops surface.
**Fix:** Add an HTTP health server to stream-worker exposing `/healthz` (process alive) + `/readyz` (consumer group assigned AND DB reachable AND lag < threshold). Replace core's static `/health` with a `/readyz` that checks pool + Redis + the webhook Kafka producer. Wire `livenessProbe`/`readinessProbe`/`startupProbe` in every Deployment. Liveness MUST NOT depend on a datastore (restart-loop anti-pattern) — keep liveness shallow, readiness deep.
**Priority:** P0 · **Tenant Impact:** all tenants (silent stalls are cross-tenant) · **Detection:** today it does NOT surface — that is the finding.

### F4 — Observability is a stub: no real metrics/traces are ever emitted | Critical | Monitoring
**Evidence:** `packages/observability/src/index.ts:12-15` "avoids importing @opentelemetry/* in Sprint 0… exports a stub implementation… wired to the real OTel SDK in M1." `StubSpan.end()` (line 91-93) is a no-op; the default counter sink (line 162-169) emits `console.info('[metric] ...')`. `grep "@opentelemetry\|prom-client" apps/*/package.json packages/observability/package.json` → **no OTel/prom-client dependency anywhere**. `grep "get('/metrics'" apps` → no `/metrics` route exists.
**Impact:** `infra/observe/prometheus.yml:10-16` scrapes `host.docker.internal:9091`/`:9092` for collector/stream-worker metrics — **endpoints that don't exist**. RED metrics, KafkaConsumerLag, p95/p99 latency, error rate — none are produced. The SLO/error-budget table in the skill, the auto-rollback signals in CI, and Grafana dashboards have **no data source**. Brain is blind in production.
**Root cause:** Instrumentation was deferred to "M1" and never completed; the stub shipped as if real.
**Fix:** Add `@opentelemetry/sdk-node` + auto-instrumentations + a `prom-client`/OTLP `/metrics` exporter per service; emit the standard RED set + KafkaConsumerLag + DB query duration; point Prometheus/Grafana at real targets (k8s pod scrape, not `host.docker.internal`).
**Priority:** P0 · **Tenant Impact:** all tenants · **Detection:** would surface as empty Grafana panels on day one.

### F5 — "Auto-rollback" is echo text, not an alarm or hook; no alert rules exist in the repo | Critical | Auto-rollback/Alerting
**Evidence:** `main.yml:197-207` "Bake window monitor armed" is a series of `echo` lines describing rollback signals; there is no Alertmanager rule, no composite-alarm→rollback wiring, no `argocd app rollback` automation. `grep -rl "alert:\|PrometheusRule\|AlertmanagerConfig" infra` → **zero**. The only real alarm is `infra/terraform/modules/observability/main.tf` — a single CloudWatch composite on (CrashLoop OR node-not-ready), which (a) depends on Container Insights metrics that require the unbuilt cluster, and (b) has **no rollback action** (no SNS→Lambda→ArgoCD).
**Impact:** The documented auto-rollback (p95>2s, error>1%, ack<99.95%) cannot fire — the signals don't exist (F4) and nothing consumes them. A bad deploy bakes indefinitely; a human must notice via customer reports. SLO burn-rate alerting (skill §"SLO error-budget policy") is entirely absent.
**Root cause:** Rollback was documented in the playbook but never implemented as code.
**Fix:** Author PrometheusRule alerts (error-rate, p99, consumer-lag, ack-rate, isolation-breach) + an Alertmanager receiver that triggers an ArgoCD rollback (or Argo Rollouts canary with automated analysis); make the bake-window job poll the alert state and fail/rollback, not echo.
**Priority:** P0 · **Tenant Impact:** all tenants (every deploy is unguarded) · **Detection:** first bad deploy.

### F6 — Runbooks and playbooks are non-operational stubs | High | Incident readiness
**Evidence:** `docs/runbooks/README.md` is 3 bullet lines pointing to "docs/04 §M.3 (Brain-docs)"; `docs/playbooks/README.md` is 2 lines pointing to §M.4. The actual content (RB-1 RDS PITR, RB-2 EKS recovery, RB-3 StarRocks rebuild, incident severity ladder) exists ONLY as prose in `docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:2158-2171`. There is no executable runbook, no command sequence a responder can follow, no rehearsal record, no on-call rotation doc.
**Impact:** During a SEV1 (cross-brand leak = always P0 per §M.4), the responder has a paragraph, not a procedure. RB-2 claims "RTO≤30m: Terraform apply EKS → bootstrap ArgoCD → sync all Applications" — but the Applications point at non-existent manifests (F1), so the documented recovery path is itself broken. No restore drill has been run; RTO/RPO targets (RPO≤15m, RTO≤4h→1h, §558) are unproven ("an untested backup is not a backup").
**Root cause:** Runbook directories were scaffolded but the content was never migrated/operationalized; DR was never rehearsed.
**Fix:** Convert §M.3/§M.4 prose into step-by-step runbooks under `docs/runbooks/` with exact commands, verification gates, and owner; schedule a restore drill (RDS PITR + StarRocks rebuild) and record measured RTO/RPO; publish on-call rotation + severity ladder.
**Priority:** P1 · **Tenant Impact:** all tenants during incidents · **Detection:** discovered the hard way mid-incident.

### F7 — Collector spool has no size cap; rate limiting is per-pod in-memory → unbounded RDS growth is what fails first | High | Back-pressure/Load shedding
**Evidence:** `apps/collector/src/main.ts:163` graceful shutdown drains, but the spool itself (`PgSpoolRepository`) has no row-count/disk ceiling and no shed-on-full path. Back-pressure (`drainer.ts:7-9`) holds rows 'pending' when Redpanda is down — correct for durability but **unbounded**: a multi-hour Redpanda outage grows `collector_spool` until the shared RDS volume fills. The only admission control is `EdgeRateLimiter` (`edge-guard.ts:40-66`), an **in-memory `Map` per pod** — with N collector replicas the effective aggregate limit is N× the configured `maxPerWindow`, and a restart resets all buckets. There is no global (Redis) rate limit and no load-shedding when spool depth crosses a threshold.
**Impact (what fails first under load):** A spike or a Redpanda stall fills the spool → RDS storage exhausts → **every** write path on that shared Postgres (auth, ledger, identity, audit) fails, not just ingestion. A single tenant flooding `/collect` can exhaust the shared bucket budget for all tenants on that pod. No metric exists (F4) to see spool depth growing.
**Root cause:** Durability prioritized over bounded resource consumption; rate limiting kept node-local for simplicity.
**Fix:** Add a spool-depth high-water mark that sheds (`503 Retry-After`) before RDS pressure; move rate limiting to Redis for a true cross-pod limit; alert on `spool_pending_rows` and `rds_free_storage`; size the spool volume + alarm separately from the OLTP main.
**Priority:** P1 · **Tenant Impact:** multi-tenant blast radius — shared RDS exhaustion takes down all tenants · **Detection:** would surface as RDS FreeStorageSpace alarm — which is not configured.

### F8 — No uncaughtException / unhandledRejection handlers in any service | High | Graceful startup/shutdown
**Evidence:** `grep "uncaughtException\|unhandledRejection" apps/{core,collector,stream-worker}/src/main.ts` → **zero**. Each `main()` only handles SIGTERM/SIGINT. stream-worker's `main().catch()` (line 412) only covers the bootstrap promise, not runtime rejections from the 11 long-running consumers/interval loops started inside it.
**Impact:** An unhandled rejection in a consumer callback (e.g. a ledger write throwing) crashes the Node process abruptly under default semantics — bypassing the graceful `shutdown()` that drains consumers and `end()`s pools. In-flight Kafka offsets may commit inconsistently; DB connections leak. With no liveness probe (F3) on stream-worker, a half-dead process lingers.
**Root cause:** Crash-safety handlers omitted.
**Fix:** Add `process.on('unhandledRejection')` + `uncaughtException` that log (FATAL), attempt a bounded graceful drain, then `exit(1)` so k8s restarts cleanly; ensure consumers surface errors to a supervisor rather than swallowing.
**Priority:** P1 · **Tenant Impact:** all tenants on the affected pod · **Detection:** sporadic silent worker death, no alert.

### F9 — stream-worker has no resource limits, HPA, PDB, or topology spread (no manifest at all) | High | Capacity/Resilience
**Evidence:** `grep -rl "resources:\|HorizontalPodAutoscaler\|PodDisruptionBudget" infra` → only `authentik/values-dev.yaml`. No Deployment exists for stream-worker (F1), so it has no CPU/memory request/limit, no autoscaling, no PDB(minAvailable), no `topologySpreadConstraints`. The skill mandates all of these per service.
**Impact:** A single stream-worker pod runs every live consumer + backfill + 3 interval schedulers (`main.ts:248-299`). With no HPA it cannot scale to consumer lag; with no PDB a node drain can take the only replica to zero (all live ingestion ledger writes stop); with no memory limit an OOM is silent. This is the documented "noisy neighbour" risk (ADR-001) with none of its promised mitigations (HPA, per-module circuit breakers) actually wired.
**Root cause:** Manifests never authored (F1 root cause).
**Fix:** Deployment with requests/limits, HPA on consumer-lag + CPU, PDB minAvailable≥1, 3-AZ spread; run ≥2 replicas for HA-critical consumer groups.
**Priority:** P1 · **Tenant Impact:** all tenants (ingestion outage) · **Detection:** would be KafkaConsumerLag alarm — not configured.

### F10 — gitops-staging image-bump targets keys that don't exist in the ArgoCD manifests; failures are swallowed | High | Deploy correctness
**Evidence:** `main.yml:118-128` `sed -i "s|image:.*brain-${app}-staging@sha256:.*|...|g" infra/argocd/envs/staging/${app}.yaml ... || true`. The ArgoCD Application manifests (e.g. `prod/core.yaml`) contain **no `image:` key** — the image is set via Helm values / kustomize `images:[]`, not in the Application. The `sed` matches nothing and `|| true` hides it. Also `needs.build-and-push.outputs[format('{0}_digest', matrix.app)]` references `matrix.app` in a job (`gitops-staging`) that has **no matrix** — it resolves to empty.
**Impact:** Even if F1/F2 were fixed, the staging promotion writes no digest — ArgoCD would deploy `:latest` or stale digests, defeating immutable-digest promotion and making "same digest staging→prod" (prod-promote §170) untrue.
**Root cause:** Workflow authored against an assumed manifest shape that the Applications don't have.
**Fix:** Bump the image in the Helm `values-<env>.yaml` / kustomize `images:` that the Application actually renders; remove `|| true`; fail the job if no digest was written.
**Priority:** P1 · **Tenant Impact:** all tenants (wrong/stale image risk) · **Detection:** silent — wrong image runs.

### F11 — core liveness `/health` is static and would mask a dead process; no startup probe anywhere | Medium | Probes
**Evidence:** `apps/core/src/main.ts:327-331` `/health` returns `{status:'ok'}` unconditionally. There is no `/readyz` with dependency checks on core and no `startupProbe` for any service (slow boot: core resolves AWS secrets + connects webhook Kafka producer at `main.ts:555` before listening — a slow Secrets Manager would delay readiness with no startup grace).
**Impact:** A liveness probe on core's `/health` always passes even when the DB pool is exhausted, so k8s never restarts a wedged-but-listening core; without a startup probe, a slow-booting core (secrets fetch + Kafka connect) can be killed by an aggressive liveness probe → crash loop.
**Root cause:** Health endpoint added as a placeholder, not a real signal.
**Fix:** Split core into shallow `/livez` (event-loop responsive) + deep `/readyz` (pool/Redis/Kafka); add `startupProbe` with a generous failureThreshold covering secret+Kafka init.
**Priority:** P2 · **Tenant Impact:** all tenants on a wedged pod · **Detection:** delayed restart / boot crash-loop.

### F12 — Redis rate limiter and dependency calls are fail-open with no circuit breaker / alarm | Medium | Resilience
**Evidence:** `apps/core/src/main.ts:333-344` Redis client `enableOfflineQueue:false`, `maxRetriesPerRequest:1`, and the RateLimiter "fail-open" (comment line 341-343) — when Redis is down, rate limiting silently disables. No circuit-breaker state metric, no alarm. The skill requires a circuit breaker + breaker-state metric on every cross-service/external call; `grep -rl "circuit.?break"` finds only client-side backoff in repull jobs, not breakers around DB/Redis/Kafka.
**Impact:** During a Redis outage, auth/login rate limiting silently turns off (brute-force window opens) with no signal that protection is gone. No `CircuitBreakerState` metric exists to alarm on sustained Open.
**Root cause:** Fail-open chosen for availability without a compensating alert.
**Fix:** Emit a metric when the limiter fails open; alarm on sustained fail-open; wrap DB/Redis/Kafka calls in breakers with state metrics.
**Priority:** P2 · **Tenant Impact:** all tenants (auth protection silently degraded) · **Detection:** none today — that is the gap.

### F13 — `extractCorrelationId` fallback uses `Math.random` (collision risk on the correlation spine) | Low | Observability hygiene
**Evidence:** `packages/observability/src/index.ts:217` returns `gen-${Date.now()}-${Math.random().toString(36).slice(2,10)}` as the fallback correlation id (the code comment itself notes "real impl uses crypto").
**Impact:** Under high concurrency, `Math.random`-derived ids can collide, stitching unrelated requests' logs/traces together in the log explorer — undermining the "same request_id in every log line" verification the observability skill mandates. Minor while the SDK is a stub (F4) but a latent correctness bug once tracing is real.
**Root cause:** Placeholder RNG.
**Fix:** Use `crypto.randomUUID()`.
**Priority:** P3 · **Tenant Impact:** cross-request log confusion (all tenants) · **Detection:** confusing trace stitching during debugging.

---

## What fails first / breaks under load / breaks during an incident (summary)

- **Goes live?** No. F1+F2+F3 mean nothing can build or deploy or be probed.
- **First to fail under load:** the collector spool (F7) — unbounded, per-pod rate limiting, no shed-on-full → shared RDS disk exhaustion takes down all write paths for all tenants.
- **Breaks silently in steady state:** stream-worker (F3, F8, F9) — no port, no probe, no liveness, no HPA, no crash handler; a dead consumer group stalls ledger/identity/consent writes with zero signal.
- **Breaks during an incident:** the response itself (F5, F6) — no alerts to detect, no executable runbook to recover, and the documented RB-2 EKS recovery is broken because the Applications it re-syncs point at non-existent manifests (F1).
- **Blocks enterprise readiness:** no monitoring (F4), no auto-rollback (F5), no proven DR/RTO/RPO (F6), no SLO/error-budget enforcement, no per-service capacity controls (F9).
