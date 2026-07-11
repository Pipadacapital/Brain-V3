# Phase 0 — Discovery: Brain Platform Current-State Map

> **ADDENDUM 2026-07-11:** The live-state facts in §0 and §4.3 were snapshotted mid-go-live and are now stale. The go-live completed overnight (2026-07-10→11): all workloads, Kafka, Trino, monitoring and ALB ingresses are deployed and public endpoints return 200. The refreshed live snapshot and the Phase-1 findings register live in `audit/01-architecture-gaps.md` — headline deltas: iceberg-rest fixed; metrics-server missing (autoscaling dead); medallion Silver/Gold/serving never initialized; CronWorkflows not deployed.

**Date:** 2026-07-10
**Scope:** Factual, evidence-backed map of the as-built system. No opinions, no findings register (that is Phase 1+). Every statement is grounded in a file path or a live-system observation captured today.
**Method:** 6 parallel read-only codebase sweeps (monorepo, pipelines, IaC, services/config, connectors, observability) + live snapshots of AWS/EKS prod (`kubectl` against `arn:aws:eks:ap-south-1:380254378136:cluster/brain-prod`, `aws sts` as account 380254378136).

---

## 0. Executive current-state summary

- **Codebase:** pnpm/Turborepo monorepo — 4 deployable apps (collector, core, stream-worker, web), 35 shared packages, 5 tool packages. Stack matches the locked list (Fastify, Kafka KRaft, Spark batch, Iceberg, Trino, Redis, Neo4j, Apicurio); StarRocks and dbt fully removed.
- **Pipeline:** Kafka Connect Iceberg sink lands Bronze (10 tables, ADR-0010); 21 Silver Spark jobs; Neo4j identity SoR with bi-temporal `silver_identity_map`; 28+ Gold Spark jobs in a two-phase (Customer360 → BI) orchestration; ~60 Trino `brain_serving.mv_*` views fronted by a Redis TTL/invalidation cache.
- **Prod infra:** Terraform fully authored and applied (VPC, EKS 1.32 w/ 3 system nodes, Aurora Serverless v2, ElastiCache, S3 medallion/audit/metrics, IRSA×10+, GitHub OIDC, fck-nat). ArgoCD app-of-apps live with 24 apps.
- **Live prod state (today, 2026-07-10):** cluster is **mid-go-live**. Platform layer healthy (Karpenter, KEDA, ESO, ALB controller, cert-manager, ArgoCD). Data tier partially up: `iceberg-rest` in **CrashLoopBackOff** (deployed image lacks the Postgres JDBC driver — the merged custom-image fix is not what is running), `neo4j` Pending awaiting a Karpenter on-demand node (nodeclaim provisioning was in progress at snapshot time), and **kafka / kafka-connect / trino / kube-prometheus-stack / collector / core / web / stream-worker are not yet deployed** (OutOfSync/Missing/Unknown in ArgoCD; no pods).
- **Local dev:** Docker daemon not running at snapshot time; local stack (26 compose services) is down. All local-stack facts below are from config, not live observation.

---

## 1. Monorepo structure

Workspace: `pnpm-workspace.yaml`, `turbo.json`, TS `NodeNext`/strict, composite project refs (`tsconfig.base.json`).

### 1.1 Apps (deployables)

| App | Framework | Entry | Port | Role |
|---|---|---|---|---|
| `apps/collector` | Fastify 4 | `src/main.ts` | 8787 | Accept-before-validate ingest; PG spool durability gate (D-1: HTTP 200 before Kafka); async drainer → Kafka |
| `apps/core` | Fastify 5 | `src/main.ts` | 3000 | Modular monolith, 13 modules (workspace-access, connector, frontend-api/BFF, identity, analytics, attribution, billing, data-quality, ml, ai, notification, recommendation, pixel) |
| `apps/stream-worker` | Node/KafkaJS | `src/main.ts` | 8091 (health/metrics only) | Consumer groups: live pipeline, identity bridge, consent suppressor, erasure orchestrator, ledger bridges, backfill runners, DQ checks, ingest scheduler |
| `apps/web` | Next.js 15 | App Router | 3000 | Dashboard (Radix + Tailwind, TanStack Query, Recharts) |

### 1.2 Packages (35) — tiers

- **Foundation:** contracts (Zod → openapi/avro/mcp codegen), db, config (Zod env loaders), events, observability (OTel/Sentry/pino), tenant-context, platform-flags.
- **Identity:** identity-core, identity-normalization, pii-vault (KMS DEK).
- **Domain:** money, audit, metric-engine, semantic-metrics, attribution-writer, domain-journey; Waves E–I scaffolds: ai-features, ai-platform, action-core, decision-policies, prompt-loader (contracts/stubs, flags OFF).
- **Connector:** connector-core (kernel), connector-secrets, 9 mappers (shopify, woocommerce, ga4, razorpay, shiprocket, shopflo, gokwik, ad-spend, logistics-status).
- **Client:** pixel-sdk, ai-gateway-client (LiteLLM).
- **Test:** testing-golden (golden fixtures + generator CLI).

No fully-orphaned packages detected; knip config (`knip.jsonc`) + ESLint boundary rules (packages must not import apps) enforce the graph.

### 1.3 Tools & CI

- `tools/`: data-quality, isolation-fuzz, parity-oracle, pixel-fixture, seed, dev/ (dev-up.sh, v4-refresh-loop.sh), lint/ (v4-naming-guard.sh), load-test (k6), observability (freshness exporter).
- `.github/workflows/`: `pr.yml` (lint/typecheck/unit affected, boundaries, contracts, isolation fuzz, naming guard, log-grep PII gate), `integration.yml`, `deploy.yml` (build→ECR digest→cosign→gitops values-bump), `infra.yml`, `prod-apply.yml` (manual, typed-confirm + GitHub Environment gate), `parity-oracle.yml` (nightly), `knip.yml`.

---

## 2. Data pipeline (Bronze → Silver → Identity → Gold → Serving)

### 2.1 Bronze landing — Kafka Connect Iceberg sink (ADR-0010)

Configs: `infra/kafka-connect/iceberg-bronze-*.json` (10 connectors); compose service `kafka-connect` (cp-kafka-connect 7.6.1 + Iceberg sink 1.9.2); exactly-once via `control-iceberg` topic.

| Bronze table (`brain_bronze.*`) | Source topic |
|---|---|
| `collector_events_connect` | `{env}.collector.event.v1` + `{env}.collector.order.backfill.v1` |
| `{shopify,woocommerce}_orders_raw_connect` | `{env}.{provider}.orders.raw.v1` |
| `{meta,google}_spend_raw_connect` | `{env}.{provider}.spend.raw.v1` |
| `ga4_rows_raw_connect` | `{env}.ga4.rows.raw.v1` |
| `shiprocket_shipments_raw_connect` | `{env}.shiprocket.shipments.raw.v1` |
| `gokwik_events_raw_connect` | `{env}.gokwik.events.raw.v1` |
| `shopflo_checkout_raw_connect` | `{env}.shopflo.checkout.raw.v1` |
| `razorpay_settlement_raw_connect` | `{env}.razorpay.settlement.raw.v1` |

Bronze is append-only; dedup lives in Silver. Raw-lane retention: row-TTL DELETE + snapshot expiry (`bronze_raw_retention.sh`, ADR-0006 D4).

**Note vs. reference architecture:** the spec's "single `brain_bronze.events` table with a `connector` column" is implemented as 1 collector table + 9 per-provider raw lanes (the unified `bronze_landing`/`events` design was superseded by ADR-0010 cutover, 2026-07-05). Recorded as a Phase 1 comparison item, not judged here.

### 2.2 Silver — Spark batch (`db/iceberg/spark/silver/`, 21 run scripts)

Watermark/incremental via `silver_job_watermark`; two-stage gate (technical `_silver_technical.py` → business canonicalization; quarantine to `brain_silver.silver_quarantine`, replayable). Key marts: `silver_collector_event` (admission gate), `silver_order_state` (brain_id-resolved spine), `silver_order_line`, `silver_touchpoint` (sessionization + stitched columns), `silver_payment/settlement/refund/shipment`, `silver_campaign/marketing_spend`, `silver_engagement_signal`, `silver_cart_event`, identity tables (below). Silver stores hashed identifiers; brain_id resolution enters via the identity export → `silver_order_state` join (see 2.3).

### 2.3 Identity — Neo4j SoR + bi-temporal map

- **SoR:** Neo4j 5.21 (Customer/Identifier nodes; IDENTIFIES / ALIAS_OF / MERGED_INTO edges; brand_id on every node). Writer: stream-worker identity bridge; core is read-only.
- **Exports:** `identity-export` node job (Neo4j → PG `ops.silver_identity_link`, hourly :02); Spark `silver_identity_alias.py` (CURRENT state), `silver_identity_map.py` (**bi-temporal** effective_from/effective_to intervals), `silver_identity_unmerge.py`.
- **Stitch:** `journey-stitch-from-identity` (deterministic, unambiguous-only; :15) → `journey-stitch-export` (→ Iceberg `silver_journey_stitch`, :16) → `silver_touchpoint` rebuild consumes it.
- **Probabilistic:** `silver_probabilistic_stitch.py` (Splink) → `silver_probabilistic_match`, **quarantined** — not consumed by Gold; guard test `probabilistic_quarantine_guard_test.py`.

### 2.4 Gold — two-phase (`db/iceberg/spark/gold/`, 17 run scripts / 28+ jobs)

- **Phase 1 (handoff):** `gold_revenue_ledger` (recognized revenue: prepaid finalization, COD delivery/RTO, returns), `gold_customer_360`, segments/cohorts/scores.
- **Phase 2 (BI):** attribution (`gold_attribution_credit/paths`, campaign, utm), **versioned journeys** (`journey_events` with `data_version`/`is_current` + reversion job on merge), measurement/Wave-C facts (`gold_measurement_{costs,fees,settlements,refunds,inventory}`, `gold_product_costs`, `gold_order_economics`, `gold_contribution_margin`), gap marts (engagement, funnel, abandoned cart, retention, affinity, behavior, health, conversion feedback, cod_rto), executive (CAC/LTV/ROAS), `gold_ai_features`.

### 2.5 Serving — Trino + Redis

- ~60 view definitions in `db/trino/views/` applied idempotently by `run-trino-views.sh`; app/BFF/metric-engine read only `brain_serving.mv_*`; `${BRAND_PREDICATE}` seam injects `brand_id = ?` at query time.
- Redis cache: brand-prefixed keys, per-metric TTL tiers (5m–1h), SETNX stampede locks, invalidation via `intelligence.gold.rewritten.v1` producer (refresh step 7) → `AnalyticsCacheInvalidateConsumer` SCAN/DEL; fail-open with TTL safety net.

### 2.6 Orchestration

- **Dev:** `tools/dev/v4-refresh-loop.sh` — Phase 1 (identity-export → silver gate → order spine → silver tier → revenue ledger → stitch → touchpoint rebuild → Customer360) then Phase 2 (BI gold → views → cache-bust), 5-min loop; daily maintenance (retention + compaction) via guard files.
- **Prod:** Argo CronWorkflows (`infra/helm/cronworkflows/`) — staggered hourly IST (:02 identity-export, :05 silver, :15/:16 stitch, :25 gold), weekly maintenance, daily token-refresh jobs; concurrency `forbid`.

---

## 3. Runtime services & configuration

### 3.1 Local dev substrate (docker-compose.yml, profiles core/full-obs/debug/ai)

26 services: postgres 16 + pgbouncer, neo4j 5.21, redis 7 (192MB volatile-lru), minio + init, kafka 3.8.1 KRaft + kafka-init (topics) + kafka-connect + connect-init (10 sinks), apicurio 2.6.3, iceberg-rest 1.9.2 (SQLite WAL, CATALOG_CLIENTS=1), trino 455 (7g bounded heap, restart unless-stopped), localstack 3.4 (Secrets/KMS/SES), prometheus/alertmanager/grafana(:3004), loki/tempo/otel-collector (full-obs), kafka-exporter/kafka-ui (debug), litellm (ai, disabled). All state on named volumes. **Live check today: Docker daemon not running — local stack down.**

Startup: `pnpm dev:up` → `tools/dev/dev-up.sh` — 7 idempotent steps (env template → PG first → migrate in subshell → infra healthy-poll → LocalStack secrets bootstrap → one-shot medallion refresh → turbo dev apps).

### 3.2 Postgres

126 migrations (`db/migrations/0001`–`0126`, node-pg-migrate). Schemas: tenancy, iam, connectors, jobs, billing, audit, ai_config, identity, consent, pixel, data_plane (event_spool), ml, ops. Roles: `brain` (migrations) vs `brain_app` (RLS-enforced runtime). Core reads via PgBouncer (transaction pooling); stream-worker connects direct (advisory locks incompatible with transaction pooling).

### 3.3 Kafka topics

Collector lanes (live/backfill/dlq/quarantine), 9 raw connector lanes, identity control topics (minted/linked/merged/unmerged/suppressed/review_queued), intelligence topics (cache.invalidate, customer360.recomputed, gold.rewritten), canonical fan-out (`{env}.brain.{orders,customers,shipments,payments,sessions,ads}`), `control-iceberg`. Dual `dev.*`/`prod.*` prefixes keyed off NODE_ENV. ~10 consumer groups (live, identity-bridge, 4 ledger bridges, consent, capi-deletion, backfill, dlq-redrive).

---

## 4. Infrastructure (IaC + live)

### 4.1 Terraform (`infra/terraform/`)

- **Bootstrap:** per-account state bucket + KMS + DynamoDB lock.
- **envs/prod (account 380254378136, ap-south-1, applied):** VPC 10.0.0.0/16 ×3 AZ; fck-nat t4g.nano (ADR-0009); VPC endpoints (S3, EC2, SSM, STS); EKS `brain-prod` 1.32 (system MNG t4g.medium 2–6); ECR ×5 (immutable, scan-on-push); Karpenter 1.0.8 (4 pools: streaming/batch/trino Spot t4g, ondemand tainted); Aurora Serverless v2 PG 16.4 (0.5–2 ACU; hosts app DB + `iceberg_catalog`); ElastiCache cache.t4g.micro ×1; S3 warehouse `brain-bronze-prod-380254378136` (namespaces, not per-tier buckets) + audit WORM bucket + Thanos metrics bucket; Secrets Manager shells + ESO; KMS ×3 (root/connector/audit); GitHub OIDC roles (plan/apply/ecr-push); IRSA ×10+.
- **envs/staging:** structural scaffold, zero compute. **envs/dev:** full apply.
- **Uncommitted at snapshot:** `bootstrap/.terraform.lock.hcl` (provider drift), `envs/prod/terraform.tfvars` — `eks_public_access_cidrs = ["0.0.0.0/0"]` (temporary go-live access, was single-IP pin), stray `bootstrap/bootstrap.plan.old.bak`. The Spot service-linked-role addition was committed (6c8d1c63).

### 4.2 Helm + ArgoCD

18 charts (`infra/helm/`), digest-pinned prod images, HPA (collector 3–24, stream-worker 3–48 + KEDA lag, core 3–12, trino workers KEDA CPU). ArgoCD app-of-apps (`infra/argocd/`), sync-waves: ESO (-3/-2) → Karpenter (-2..0) → platform (0) → data tier (1) → workloads (2); prod child apps are **manual sync**. CD: `deploy.yml` builds affected services → ECR digest → cosign → gitops values-bump commit.

### 4.3 Live prod cluster snapshot (2026-07-10)

- **Nodes:** 3× system (t4g.medium class, v1.32.9-eks, up 2d6h). Karpenter pools registered; one on-demand `t4g.xlarge` nodeclaim (`ondemand-w9x59`) provisioning at snapshot time — the Spot SLR fix unblocked Karpenter.
- **Running & healthy:** argocd (7 pods), argo-workflows, cert-manager, external-dns, external-secrets (3), keda (3), aws-load-balancer-controller (2), karpenter (2), pgbouncer (2), core EKS addons.
- **Broken / pending:**
  - `iceberg-rest` **CrashLoopBackOff** (12 restarts): `java.sql.SQLException: No suitable driver found for jdbc:postgresql://brain-prod-postgres.cluster-...` — the pod is running an image **without** the Postgres JDBC driver, i.e. the custom-image fix merged in PRs #360/#361 is not the image actually deployed (digest in values / ECR build not in effect). Secondary observation: the catalog logs its full JDBC properties **including the password in plaintext** at startup.
  - `neo4j-0` Pending: nodeSelector `brain.platform/pool=ondemand` — waiting on the Karpenter on-demand node above; PVC `data-neo4j-0` (gp3) WaitForFirstConsumer. Expected to self-resolve when the nodeclaim becomes Ready.
- **Not yet deployed (ArgoCD):** `strimzi-operator-prod` / `kube-prometheus-stack-prod` / `trino-prod` / `kafka-connect-prod` → OutOfSync+**Missing**; `strimzi-kafka-prod`, `external-secrets-config-prod` (Degraded), `aws-load-balancer-controller-prod` → OutOfSync; `collector/core/web/stream-worker/cronworkflows-prod` → Sync status **Unknown** (no pods; app images likely not yet pushed/synced).
- **No Ingress objects exist yet** → no ALB, no public endpoints live.

Consequence (factual): **no ingest, no Kafka, no Bronze landing, no Trino serving, and no Prometheus/Grafana are currently running in prod.** Production is a platform shell awaiting the data-tier and workload sync steps of the go-live runbook (`docs/runbooks/GO-LIVE.md`).

---

## 5. External integrations

Kernel: `packages/connector-core` — single `IConnector` 8-verb lifecycle (authenticate/validate/connect/sync/backfill/webhook/health/disconnect), `ConnectorFactory` registry, `secret_ref` ARN-only credentials (NN-2), 7-state health + 3-state safety (migration 0021).

| Connector | Auth | Modes | Lands to |
|---|---|---|---|
| Shopify | OAuth2 | webhook-first + bespoke paged backfill (`jobs.backfill_job`) | shopify orders raw lane + order.backfill.v1 |
| WooCommerce | API key | webhook + repull job (sync lane, not backfill queue) | woocommerce orders raw lane |
| Meta | OAuth2 | polling (28-day trailing) + resumable backfill (24 mo) | meta spend raw lane |
| Google Ads | OAuth2 (MCC) | polling + resumable backfill | google spend raw lane |
| GA4 | OAuth2/SA | polling (BQ export) | ga4 rows raw lane |
| Razorpay | key+secret | webhook (rotation grace window, MB-1 blocking map upsert) + settlement recon backfill ×3 resources | razorpay settlement raw lane |
| Shiprocket | API key | webhook + repull/backfill | shiprocket shipments raw lane |
| GoKwik / Shopflo | webhook-only | webhook-first (no REST backfill surface) | gokwik/shopflo raw lanes |

- **WebhookPipeline** (`apps/core/.../webhooks/platform/WebhookPipeline.ts`): HMAC-first (NN-4), brand resolved from DB not headers (MT-1), raw archive, age-window + Redis dedup, PII-hash at boundary, idempotent Kafka produce keyed by brand_id, 5-min secret TTL cache.
- **Backfill:** generic `runResumableBackfill` driver + per-provider ingestion manifests (`jobs.resource_backfill_state` cursors); `BACKFILL_QUEUE_PROVIDERS=['shopify']` vs `INGESTION_BACKFILL_PROVIDERS=[meta, google_ads, razorpay, shiprocket, ga4]`.
- **Pixel:** `@brain/pixel-sdk` — UUIDv7 events, click-ids/UTM/first-touch, consent gating (TCF v2 + custom signal), flag-gated identity capture; installers registry (Shopify Web Pixel/ScriptTag, WooCommerce plugin); collector serves `/api/v1/pixel.js` templated per install_token.
- **Secrets:** `ISecretsManager` → AwsSecretsManager (prod, per-brand KMS EncryptionContext) / LocalSecretsManager (dev; hard-fails under NODE_ENV=production).

---

## 6. Observability

- **Metrics:** Prometheus scrapes collector `/metrics` (:8787), stream-worker HealthServer (:8091), Kafka broker JMX (:9404), kafka-exporter lag (:9308), Connect JMX (:9405). App metrics registry: `brain_collector_accept_total`, `spool_full_total`, `brain_bronze_write_total`, ingest-scheduler dispatch/error/rate-limit, `connector_auth_rejected_total`, DLQ redrive, `dq_silver_lag_breach_total`, `revenue_over_reversal_total`, `ledger_write_total`.
- **Alerts (22 rules, promtool-clean):** `infra/observe/alerts/brain-slo.rules.yml` + `freshness.rules.yml` — collector 99.95% multi-window burn-rate, shedding-now, DLQ growth, consumer lag >50k, ingest stale, Connect task failed / lag, auth rejections, Meta token refresh, Silver lag, revenue over-reversal, webhook produce failing; freshness: executive marts ≤15m / segment ≤1h + anti-false-safety guards. Same rule set embedded as PrometheusRule CRDs in `infra/helm/kube-prometheus-stack/values-prod.yaml` (manual lockstep).
- **Dashboards:** 3 provisioned (Ingest Health, Connector Health, Revenue Integrity) + datasources (Prometheus/Loki/Tempo).
- **Freshness exporter:** `tools/observability/freshness-exporter/freshness_exporter.py` (Trino `$snapshots` age per Gold mart, SLA-classed); K8s manifest exists (`infra/observe/k8s/freshness-exporter.yaml`), not deployed.
- **Tracing/logging:** OTel collector with PII-redaction transform → Tempo/Loki locally; Grafana Cloud exporter commented out (pending tenant). W3C traceparent injected into Kafka headers. Prior internal audit (`docs/audit/11-observability.md`, F1–F12) records known gaps: unstructured console logging without correlation-ID binding, Math.random correlation fallback, no error-tracking backend, circuit-breaker metrics documented but not emitted.
- **Alerting delivery:** prod alertmanager routes critical → PagerDuty + Slack, warning → Slack (env-injected secrets). **Not live** — kube-prometheus-stack not deployed (see 4.3).
- **Runbooks:** `docs/runbooks/` — GO-LIVE.md (14 steps), prod-deploy, prod-m4-turn-on, secrets worksheet, cron-pipeline enablement, RB-4/RB-5, ADR-0006/0010 cutovers, local-dev startup.

---

## 7. Cost & budget context

$500/mo AWS budget with alerts-only enforcement (per project memory); prod sizing reflects cost-first choices: fck-nat over managed NAT, single-node Redis, Aurora 0.5–2 ACU, Spot pools for all elastic compute, Thanos 2-day local retention + S3, staging at zero compute.

---

## 8. Items queued for Phase 1 (architecture comparison) — recorded, not judged

1. Unified-Bronze spec ("single `brain_bronze.events` + connector column") vs. as-built 1+9 Connect-landed tables (ADR-0010 supersession).
2. `iceberg-rest` deployed image ≠ merged custom-image fix (live CrashLoopBackOff); plaintext JDBC password in catalog startup logs.
3. Prod go-live incomplete: data tier + workloads + monitoring not yet synced; no ingress; EKS API temporarily open to 0.0.0.0/0 (uncommitted tfvars).
4. Reference architecture names an "Analytics Gateway" between Redis and BFF; repo history shows analytics-gateway was removed as an orphan (2026-06-28 cleanup) — serving path is Trino → Redis cache → core BFF.
5. `gold_measurement_*` / semantic-layer / journey APIs / Waves E–I contracts: presence confirmed in code; invariant-level verification (flags OFF, quarantine enforced, brand_id everywhere, minor-units money incl. 3-decimal GCC currencies) deferred to Phase 1 checklist.
6. Observability audit F1–F12 partial remediations (structured logging, error tracking, Grafana Cloud export) — carry into Phase 3/4.
