# STACK — seam bindings (Brain, Phase 1 as-built)

> Canon scope = **PHASE 1 AS-BUILT** (24-week plan, M0–M5, recommend-only AI, deterministic
> decisioning, single-region India AWS `ap-south-1`). Deployables: **collector · stream-worker ·
> core (modular monolith) · web (Next.js)** + Argo jobs. Stack is **MANAGED-FIRST** (Redpanda Cloud,
> managed StarRocks, managed IdP/Authentik, Grafana Cloud, node-pg-migrate, KafkaJS). Phases 2–4 are
> deferred and noted as **future amendments**; they do not bind Phase 1.
>
> Sources: doc 03 (Tech Stack ADRs), doc 04 (Architecture §3/§5/§7/§12/§14/Part F ADRs), doc 10
> (Execution Plan §5/§13 managed-stack confirmation), the repo (`package.json`, `docker-compose.yml`,
> `apps/`, `packages/`). Money everywhere = integer minor units (`*_minor BIGINT`) + `currency_code
> CHAR(3)` ∈ {INR, AED, SAR}. Tenant key = `brand_id`.

## Seam bindings

| Seam | Intent the OS depends on | Bound to (Brain, Phase 1) | ADR |
|---|---|---|---|
| **PersistenceAdapter** | System-of-record read/write, tenant isolation, reversible migrations | **AWS RDS PostgreSQL 16** (Multi-AZ, PITR) — the control plane (workspace/access, connector cursors, identity graph `brain_id_alias`, metric registry, Decision Log, hash-chained audit, billing). RLS + per-request tenant context + non-owner app role. Migrations via **`node-pg-migrate`** (`packages/db`); RLS + app-role in migration #1. `pgvector` reserved (Phase 3). | ADR-001 |
| **AnalyticsAdapter** | Aggregate queries over high-volume facts | **Managed StarRocks** (serving; native PK tables → real upserts for the mutable order lifecycle) over **dbt-on-StarRocks** Silver/Gold built from **Bronze = Apache Iceberg on S3 + Glue Data Catalog**. One-way `Iceberg → dbt → StarRocks → Analytics API`; **never** `StarRocks → Iceberg`. Read **only** through the Analytics API (sole DB read path). | ADR-002 |
| **EventAdapter** | Idempotent, replayable publish/consume | **Redpanda Cloud** (ap-south-1) + **Apicurio** schema registry (FULL_TRANSITIVE) + **Avro** wire format + **KafkaJS** client. Durability lives in the Collector **durable spool** (accept→spool→ack→produce), not the Kafka client. Topics `{env}.{domain}.{event}.v{n}`; live vs backfill lanes split. Idempotency key = `(brand_id, event_id)`; Bronze (24-mo, immutable) is the replay SoR. | ADR-003 |
| **CacheAdapter** | Hot reads, dedup, rate-limit state, scoped keys + TTL | **Redis on ElastiCache**. One read-through cache in front of the Analytics API; tenant-scoped keys via `tenant-context.brandKey()` (`brand_id + metric_id + metric_version + filters_hash + grain + as_of`). TTL + event-nudged invalidation (no purge bus). Also session + rate-limit + MCP-key state. | ADR-004 |
| **BlobAdapter** | Large immutable object storage | **Amazon S3** — Iceberg substrate + export artifacts. **Per-brand S3 prefix** + **per-brand data key (envelope encryption under a small CMK set)** = physical/cryptographic isolation. WORM (Object Lock) anchors audit checkpoint hashes. | ADR-005 |
| **IdentityAdapter** | AuthN, AuthZ, sessions, roles | **Authentik (self-hosted on EKS)** — OIDC/SAML, MFA day one; in-region, no per-MAU cost (Stakeholder-ratified, doc 03 §5). Access JWT (15 min) + rotating refresh (7 d) + a **revocation denylist checked on every protected action**. 4 roles (Owner/Brand Admin/Manager/Analyst) as permission templates enforced in JWT claims + RLS + MCP scopes, **never in app code**. Distinct from the **customer Identity Graph** (§Locked, ADR-008). | ADR-006 |
| **SecretsAdapter** | Managed secrets / keys, never embedded | **AWS Secrets Manager + KMS**. KMS-backed secrets never in code/logs (no-PII-in-logs lint). **Per-brand KMS data keys** for S3, connector OAuth tokens, and the PII vault — per-brand revocation = clean offboarding/breach lever and the crypto-shred erasure mechanism. | ADR-007 |
| **ObservabilityAdapter** | Correlation identity across traces/metrics/logs | **Grafana Cloud + OpenTelemetry** (NOT self-hosted Mimir/Loki/Tempo — managed-first per doc 10 §5/§13). Every span/log carries `brand_id` (PII-redacted) + `correlation_id`; `gen_ai.*` spans on the AI path. Monitors API latency, Redpanda lag, DLQ/quarantine depth, materialization lag, connector health, DQ, LLM cost/latency; feeds the public status surface. | ADR-009 |
| **DeployAdapter** | Progressive rollout + bake + auto-rollback | **GitHub Actions → ECR → Helm → ArgoCD → EKS** (one cluster, namespaced collector/consumers/core/jobs; Argo Workflows for scheduled jobs). **Auto-rollback on K8s health-probe failure**; ArgoCD + Helm give declarative rollback. **Canary / percentage-rollout / 60s kill-switch infra is deferred to Phase 4** (with autonomy) — Phase 1 ships a **tenant-aware feature-flag package** (`packages/feature-flags`) for per-brand ops kill-switches + beta gating, not LaunchDarkly-style targeting. dev/staging/prod on separate AWS accounts. | ADR-010 |
| **ModelAdapter (AI)** | Cheapest-sufficient inference routing, cache, fallback | **LiteLLM gateway** in front of Claude / GPT / Gemini — model pinning, prompt caching, per-brand budgets, fallback, cost routing. **No service calls a model directly** (`packages/ai-gateway-client`). Effort-tier declared per path (deterministic ≫ statistical ≫ small model ≫ frontier); each tier binds its own eval gate. Numbers are deterministic (bound to `metric_id`); the model only narrates — **never text-to-SQL**. | ADR-013 |
| **RegionAdapter** | Region/locale-varying behavior (residency, formats) | **Single-region India (`ap-south-1`) in Phase 1**; the RegionAdapter **seam is built now** but only the India binding is active. Properties: data residency (in-region by default; cross-border model-provider paths on the sub-processor registry under the DPA), currency ∈ {INR, AED, SAR}, locale/RTL (`next-intl`), compliance regime (DPDP now; PDPL/GDPR seams reserved). UAE/GCC coverage + Arabic/RTL = **Phase 5 amendment**. | ADR-014 |
| **Client surfaces** | Web and/or mobile UIs | **Next.js (web only)** — TypeScript, TailwindCSS, Shadcn UI, TanStack Query, React Hook Form + Zod, Apache ECharts, Authentik OIDC, `next-intl`. Reaches the core via the **`frontend-api` BFF** (httpOnly cookie → short token → fan-out); never touches StarRocks/Iceberg directly. **Mobile = responsive web + PWA push; no native app in Phase 1.** Email is the primary real-time alert channel; WhatsApp is a scheduled-delivery channel (briefs/digests). | ADR-015 |

> ASSUMPTION: The OS template separates `ModelAdapter` (ADR-013) and `RegionAdapter` (ADR-014) as
> distinct seams, so I numbered them after ADR-012 (the notification chokepoint, doc 04 Part F) and
> kept `Client surfaces` as ADR-015. Doc 03/04 do not assign these exact ADR numbers — confirm the
> numbering does not collide with a doc-04 Part F ADR you intend to keep canonical.

> RESOLVED (Stakeholder, 2026-06-15): the doc-03/doc-04 IdP conflict is settled in favour of
> **self-hosted Authentik on EKS** from launch (doc 03 §5; matches the dev `docker-compose`). Doc 04's
> "managed IdP at launch" hedge is superseded for Phase 1.

## Phasing (Phase 1 vs deferred — deferred = future amendment, NOT bound)

**Phase 1 active seams:** PersistenceAdapter (Postgres+RLS), AnalyticsAdapter (Bronze-Iceberg + dbt-on-StarRocks-native Silver/Gold + StarRocks serving), EventAdapter (Redpanda Cloud + Apicurio + KafkaJS, durable spool), CacheAdapter (Redis), BlobAdapter (S3 + per-brand prefix/KMS), IdentityAdapter (self-hosted Authentik on EKS), SecretsAdapter (Secrets Manager + per-brand KMS), ObservabilityAdapter (Grafana Cloud + OTel), DeployAdapter (GitHub Actions→ECR→Helm→ArgoCD→EKS, ArgoCD rollback), ModelAdapter (LiteLLM, recommend-only/narrate-only), RegionAdapter (India binding only, seam built), Client (Next.js web + PWA push).

**Deferred (future amendments — do NOT bind in Phase 1):**
- **Phase 2:** extract Identity to its own gRPC service; extract Billing if scale/compliance demands; holdout/exposure **evidence capture** (capture only, no engine); review-queue UI worked + SLA; probabilistic identity (never alone); autocapture fallback; model-switch UI; per-channel windows.
- **Phase 3:** migrate Silver/Gold to **Iceberg-SoR**; add **Athena/Trino** (ad-hoc/BI) + **Apache Spark** (batch/heavy transforms/Iceberg maintenance) + **AWS Lake Formation**; add the **Python ML service** (Feast / predictions / MMM / incrementality → unlock `Calibrated`); StarRocks flips to reading Iceberg via external catalog (zero consumer change); WhatsApp lifecycle (the send/consent chokepoint goes live for WhatsApp + CAPI).
- **Phase 4:** Owner-configured auto-execute; the 60s kill-switch + auto-revert; **canary / progressive-delivery / percentage-rollout infra** (the DeployAdapter graduation trigger).
- **Phase 5:** multi-region; GCC coverage + Arabic/RTL UI (the RegionAdapter graduation trigger; seam built in Phase 1).

**Graduation rule (frozen, doc 03 §18 / doc 04 §18):** nothing in a later phase becomes a dependency of an earlier one — including MMM. Each heavy layer graduates only on its documented trigger; the split stays mechanical because the contracts (Analytics API, `channel_contribution` reserved columns, `Calibrated` enum, RegionAdapter seam) exist day one.

## Locked choices (the 13 ratified ADRs — LOCKED; a swap or new layer needs a fresh ADR + Stakeholder)

1. **Modular monolith + 3 deployables + web** (collector · stream-worker · core monolith · Next.js web) + Argo jobs — NOT 8 microservices (doc 04 §1.3/§5.1, doc 10 §intro). Bounded contexts are enforced internal modules (import-lint) with extraction seams.
2. **One read path / one Analytics API** — the Analytics API is the **sole** StarRocks/Iceberg-touching component; dashboards, NLQ, MCP, export, Morning Brief are thin clients (ADR-002, doc 04 §5.2/§10).
3. **Accept-before-validate collector** — durable spool, ack before any gate; the 99.95% guarantee lives in the spool, producer swappable (doc 03 §7, doc 04 §6.2). **KafkaJS in Phase 1** (no Go collector swap; that is a Phase-2 option).
4. **In-process TypeScript metric engine** over the registry — the **only** place a number is computed; all non-additive math (per-SKU tax, realization-date FX, banker's rounding, largest-remainder allocation, ratios); dbt/SQL does additive input marts only (`packages/metric-engine`, doc 03 §14, doc 04 §10).
5. **Iceberg as the system of record** (Bronze on S3+Glue, append-only, 24-mo) — open, ACID, time-travel; the brand owns its data (doc 03 §13, doc 04 §7).
6. **StarRocks for serving** — native PK tables (real upserts for the mutable order lifecycle) + external-catalog path reserved for the Phase-3 Iceberg-SoR flip (doc 03 §14).
7. **TypeScript everywhere** (frontend, backend, stream processors) — two deliberate exceptions, both deferred: a librdkafka/Go collector producer (Phase 2 if load demands) and the Python ML service (Phase 3).
8. **Centralized identifier hashing in the identity core** — a shared library executed in-stream by the consumer (CI conformance vectors); per-brand salt → cross-brand hashes uncorrelatable. Identity-graph write is an **async idempotent writer off Bronze**, never a synchronous edge gate (`packages/identity-core`, doc 03 §11, doc 04 §8 / C4).
9. **Per-brand KMS + S3 prefix** — physical + cryptographic store isolation; per-brand data keys for S3, connector tokens, PII vault (ADR-005/007, doc 04 §12).
10. **Postgres RLS + per-request tenant context + non-owner app role** — isolation is a kernel property; a forgotten `WHERE` returns nothing (ADR-001, doc 03 §10, doc 04 §12).
11. **Single outbound notification / send-consent chokepoint** as a named module — ALL outbound (email/push/in-product now; WhatsApp + CAPI in Phase 3) passes consent + DND + DLT + quiet-hours fail-closed before any channel adapter (ADR-012 / M10, doc 04 Part F).
12. **Per-brand wrapped DEK + crypto-shredding** — DPDP/PDPL erasure reconciled with immutable Bronze by destroying per-brand keys; no raw PII ever in events/Bronze/logs (C2 invariant, doc 04 §6.6/§7.7).
13. **Dual-store parity oracle** (3 layers) — CI golden-fixture test + hourly runtime convergence monitor + decision-path purity assertion; "same *finalized* number everywhere" (doc 03 §21, doc 04 §7.6/§10).

**Stack is LOCKED.** Routine work references this file. A new layer or a swap requires a fresh ADR (Stakeholder via `tech-stack-evaluation`); a breaking change to a public surface requires the Engineering Advisor via `api-discipline`.
