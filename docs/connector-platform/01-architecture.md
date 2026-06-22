# Brain Connector Platform — Architecture (Authoritative)

> **Status:** Stage-2 binding architecture. Audience: builders (`@backend-developer`, `@intelligence-engineer`), reviewers, the Engineering Advisor.
> **Scope:** the universal real-time connector platform — the surface that ingests every external commerce app (Shopify, WooCommerce, Meta Ads, Google Ads, GA4, Razorpay, Shiprocket, GoKwik, Shopflo, …100+) into Brain's lakehouse with one mechanical extension cost per new connector.
> **Date:** 2026-06-22 · **Repo root:** `/Users/rishabhporwal/Desktop/Brain V3`
>
> **Reading convention.** Every claim is tagged:
> - **EXISTS** — verified live in the repo this session, with `file:line`.
> - **RECOMMENDED** — the target design to build; maps to a verified gap id in `docs/connector-platform/` gap register.
> - **PARTIAL** — present but materially incomplete; the delta is stated.
>
> Pattern tags `[Strategy] [Adapter] [Factory] [Template] [Repository] [CoR] [CircuitBreaker] [Retry] [Outbox] [Idempotency]` mark where each of the 10 design patterns applies.

---

## 0. The one-sentence thesis

Brain today is **eight hand-cloned vertical slices** behind a metadata catalog (`apps/core/src/modules/connector/catalog/registry.ts:38` EXISTS), where adding the 9th connector edits ~8 extension points across 3 apps plus a migration. The target is **one `IConnector` lifecycle contract + one `IMapper` canonical-event contract + a data-driven `ConnectorFactory`**, so the 9th connector is one Strategy implementation + one catalog row + one mapper — **1x engineering, not Nx** (the Single-Primitive Rule applied to connectors). Everything in this document is structured to make that split mechanical *while preserving the day-one invariants the eight existing slices already honor*: tenant key at every layer, minor-units money, single Kafka pipeline, deterministic idempotent `event_id`, secret-ref-only storage, Bronze-is-source-of-truth.

---

## 1. Connector Platform Architecture

### 1.1 Where connectors live in the service topology

The connector platform is **not a service** — it is a bounded context split across the existing services, which is correct per `architecture-patterns` (background jobs are Kafka consumers/runners *inside* the owning service, never a new service).

```
                          ┌──────────────────────────────────────────┐
   Merchant / Vendor      │              apps/core (Node)              │
   ─────────────────►     │  connector bounded context:                │
   OAuth redirect         │   • catalog/        (marketplace metadata) │
   credential paste       │   • connection/     (connect/disconnect)   │
   inbound webhooks ──────┼─► • sources/<cat>/<provider>/ (per-app)     │
                          │   • sync/           (on-demand trigger)     │
                          │   • settlement/ backfill/ pixel/            │
                          │  RECOMMENDED: @brain/connector-core kernel  │
                          │  + IConnector + ConnectorFactory            │
                          └──────────────┬─────────────────────────────┘
                                         │ produces → ONE Kafka live topic
                                         ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │                    Redpanda (Kafka API)                            │
   │   {env}.collector.event.v1   (live lane — all sources)             │
   │   {env}.collector.order.backfill.v1  (backfill lane — isolated)    │
   │   *.dlq  *.quarantine  brain.{orders,…} (entity topics, flag-gated)│
   └──────────────┬───────────────────────────────┬────────────────────┘
                  │                                │
   ┌──────────────▼──────────────┐   ┌─────────────▼─────────────────────┐
   │   apps/stream-worker (Node)  │   │  db/iceberg/spark (PySpark sink)   │
   │  repull/backfill RUNNERS:    │   │  bronze_materialize.py             │
   │   shopify-repull, meta-…,    │   │  → Iceberg Bronze (sole SoR)       │
   │   gokwik-…, razorpay-…  (8)  │   └─────────────┬─────────────────────┘
   │  consumers: Bronze bridge,   │                 │
   │   ledger, identity-bridge,   │   ┌─────────────▼─────────────────────┐
   │   consent-suppressor, DLQ    │   │  StarRocks (OLAP) + dbt            │
   │  ingest-scheduler (cron)     │   │  Silver (by entity) → Gold → Feature│
   └──────────────────────────────┘  └─────────────┬─────────────────────┘
                                                    │
                                      ┌─────────────▼──────────────────────┐
                                      │  apps/web (Next) marketplace + health│
                                      │  packages/metric-engine (read seam)  │
                                      │  AI / Ask-Brain / recommendations    │
                                      └──────────────────────────────────────┘
```

**Two execution planes, one contract.** EXISTS:
- **Connect/auth/webhook plane** lives in `apps/core` (`apps/core/src/modules/connector/`, dirs verified: `catalog/ connection/ sources/ sync/ settlement/ backfill/ pixel/ internal/`).
- **Ingestion plane** (scheduled repull, historical backfill) lives in `apps/stream-worker/src/jobs/` (verified: 8 `*-repull`/`*-backfill` job dirs + `ingest-scheduler` + `sync-request-claimer`).

### 1.2 Why this shape is required

| Requirement | Why the split | Invariant upheld |
|---|---|---|
| Real-time low-latency webhook receipt | must sit in the user-facing edge (`core`) with the HTTP server | no event loss |
| Long-running historical backfill | must be an isolated runner that can't block the live lane | backfill lane separated from live (ADR-BF-7) |
| Horizontal ingestion scale (10k brands × N connectors) | stream-worker replicas claim disjoint batches via `FOR UPDATE SKIP LOCKED` | stateless, state in datastores |
| Bronze immutability | a single PySpark sink consumes the canonical topic; no service writes Bronze directly | Bronze is source of truth |

### 1.3 Future-connector & AI/analytics support

A new connector touches **only** `core` (a Strategy + catalog row + mapper) and `stream-worker` (one `REPULL_DISPATCH` entry). It needs **no** new service, **no** new Kafka topic, and (RECOMMENDED, §12) **no** new migration. AI/analytics inherit it for free because the canonical event shape is contract-guaranteed (§3, §8).

---

## 2. Connector Framework Design

### 2.1 Current state (EXISTS) — eight bespoke vertical slices

The deferral is **explicit and documented**, not accidental:

- `apps/core/src/modules/connector/index.ts:12` — `"Scope note: NO IConnector/BaseConnector/plugin registry (scope-defer — §2)."`
- `apps/core/src/modules/connector/catalog/dispatch.ts:4` — `"RULE: static record, NOT a plugin registry / IConnector base class."`

The canonical entities `ConnectorInstance`, `ConnectorSyncStatus`, `ConnectorCursor` and their repository interfaces live under `sources/storefront/shopify/domain/` and are imported cross-source (`index.ts:23-25` re-exports them from the Shopify path). This makes **Shopify the accidental base** — verified by the literal header comments `"Clone of ConnectRazorpayCommand"` / `"Mirror of ConnectGokwikCommand"` in the credential connect commands.

What already works as narrow registries (the right pattern, scoped):
- `apps/stream-worker/src/jobs/sync-request-claimer/run.ts:50-59` — `REPULL_DISPATCH` declarative map **[Strategy]** (replaced a switch; coverage-tested). EXISTS, verified.
- `apps/core/src/modules/connector/catalog/dispatch.ts` — `OAuthDispatch` table **[Strategy]** for 3 OAuth providers only. EXISTS.

### 2.2 Target framework (RECOMMENDED) — `@brain/connector-core` kernel

Gap: `unified-connector-contract`. There is **no `packages/connector-core`** today (verified: `ls packages/` has no such dir).

```
packages/connector-core/src/
  domain/
    ConnectorInstance.ts        ← MOVED out of sources/storefront/shopify/domain
    ConnectorSyncStatus.ts      ← (neutral kernel, no *.myshopify.com rule)
    ConnectorCursor.ts
    repositories/IConnectorInstanceRepository.ts  ← interface (DI seam)
  contracts/
    IConnector.ts               ← the 8-method lifecycle contract (§3)
    IMapper.ts                  ← raw → CanonicalEvent contract (§3.2)
    CanonicalEvent.ts
  ConnectorFactory.ts           ← resolves provider → IConnector via CONNECTOR_CATALOG  [Factory]
  hash/hashToUuidShaped.ts      ← single copy (today duplicated verbatim in all 7 mappers)
```

| Concern | Pattern | Binding |
|---|---|---|
| Resolve provider → behavior | **[Factory]** | `ConnectorFactory.for(provider)` keyed off `registry.ts` catalog |
| Per-provider lifecycle behavior | **[Strategy]** | each connector implements `IConnector` |
| Per-provider raw→canonical map | **[Strategy] + [Adapter]** | each implements `IMapper<TRaw, CanonicalEvent>` |
| Common lifecycle steps, provider hooks | **[Template]** | base methods run common flow, delegate variance |
| Domain persistence behind interface | **[Repository]** | `IConnectorInstanceRepository` → `Pg…Repository` (infra) |

**Migration discipline (staged, reversible):** publish the kernel with re-exports for backward compat → re-point each source's imports → delete the old Shopify re-exports last. Each step compiles. No schema change, no new service. Pure additive TypeScript per `api-discipline`.

### 2.3 DDD shape per connector (the iron law)

Every connector source already follows bounded-context DDD (EXISTS, verified under `sources/storefront/shopify/`): `domain/ application/ infrastructure/ interfaces/`. The kernel does not change this — it gives the domain a **neutral base** to inherit instead of importing Shopify's.

---

## 3. Connector Contracts — the 8-method `IConnector`

### 3.1 The lifecycle contract (RECOMMENDED)

```typescript
// packages/connector-core/src/contracts/IConnector.ts
export interface IConnector {
  authenticate(ctx): Promise<AuthResult>;     // OAuth code-exchange OR credential bundle store
  validate(ctx): Promise<ValidationResult>;   // test-connect ping BEFORE storeSecret (close silent-cred gap)
  connect(ctx): Promise<ConnectorInstanceId>; // persist instance + sync_status + emit connector.connected
  sync(ctx): Promise<SyncRunResult>;          // incremental trailing-window repull (scheduled + on-demand)
  backfill(ctx): Promise<BackfillJobResult>;  // historical, page-checkpointed, separate cursor + lane
  webhook(req): Promise<WebhookResult>;       // inbound real-time (delegates verify+map to provider Strategy)
  health(ctx): Promise<HealthState>;          // 7-state transition (Healthy…TokenExpired…RateLimited)
  disconnect(ctx): Promise<void>;             // invalidate secret, mark Disconnected, stop dispatch
}
```

| Method | Today (EXISTS) | Target (RECOMMENDED) | Gap |
|---|---|---|---|
| `authenticate` | per-source `Connect<X>Command` / `HandleOAuthCallbackCommand` | base Template + provider hook | `unified-connector-contract` |
| `validate` | **absent** — credentials stored without a test-connect ping | test-connect before `storeSecret`; distinct `CREDENTIAL_INVALID` code | `woocommerce-onboarding-backfill-resilience` |
| `connect` | per-source (near-identical, `"Clone of"`) | base Template, provider hook for the enumeration-key column | `unified-connector-contract` |
| `sync` | 8 bespoke `*-repull/run.ts` | thin adapters calling `IConnector.sync()` | `unified-connector-contract` |
| `backfill` | Shopify-only 24-month; WooCommerce 90-day repull only | configurable-depth base | `woocommerce-onboarding-backfill-resilience` |
| `webhook` | 4 bespoke handlers (~1600 LOC) + 4 HMAC VOs | one `WebhookPipeline` Template + provider verify/map Strategy | `generic-webhook-pipeline` |
| `health` | only connect→Healthy / disconnect→Disconnected wired | `markTokenExpired()`/`markRateLimited()` from auth/rate-limit branches | `health-state-operational-transitions` |
| `disconnect` | `DisconnectCommand` EXISTS; does **not** revoke Shopify token | + token invalidate on `app/uninstalled` | `shopify-compliance-token-lifecycle` |

**[CircuitBreaker]** wraps `sync()` so one slow vendor call can't stall the sequential `ingest-scheduler` tick (`ingest-scheduler/run.ts:79-111` today has no per-call deadline — gap `observability-trace-and-circuit-breaker`).

### 3.2 The mapper contract `IMapper<TRaw, CanonicalEvent>` (RECOMMENDED)

Gap: `shared-mapper-contract`. The 7 mapper packages EXIST (`packages/{shopify,woocommerce,ad-spend,razorpay,gokwik,shiprocket,shopflo}-mapper`, verified) but each exposes a provider-unique signature and **copies `hashToUuidShaped` verbatim** (flagged `IDENTICAL` in all 7). There is no compile-time guarantee a new mapper emits canonical Bronze.

```typescript
export interface CanonicalEvent<TProps> { event_name: string; occurred_at: string; properties: TProps }
export interface IMapper<TRaw, TEvent extends CanonicalEvent<unknown>> {
  map(raw: TRaw, brandId: string, saltHex: string): { event: TEvent; eventId: string; provenance: Provenance };
}
```

The type makes **minor-units money (I-S07)** and **PII-boundary-hash (I-S02)** *contract obligations* — a mapper that emits floats or skips hashing won't compile against the kernel's `Money`/hashed-field helpers. **[Strategy] [Adapter] [Template]**.

### 3.3 Future-connector & AI/analytics support

A new connector compiles against `IConnector` + `IMapper` → guaranteed canonical Bronze → Silver entity marts, identity resolution, attribution, and recommendations ingest it with **zero downstream code**. Uniform `health()` feeds the recommendation **confidence gate** (a stale/blocked connector reads `degraded`/`blocked`, not falsely `safe`).

---

## 4. Authentication Architecture

### 4.1 Two auth models (EXISTS)

| Model | Providers | Flow | Storage |
|---|---|---|---|
| OAuth 2.0 auth-code | Shopify, Meta, Google Ads, (GA4 RECOMMENDED) | HMAC-first callback (Shopify) / state-nonce; token exchange in POST body | secret → AWS Secrets Manager **ARN only** in PG (`connector_instance.secret_ref`, NN-2) |
| Credential bundle | Razorpay, GoKwik, Shopflo, Shiprocket, WooCommerce | composite JSON bundle | same ARN-only model |

Verified strengths:
- `HandleOAuthCallbackCommand.ts:77-169` — 8-step enforcement, HMAC **first**, brandId from server-side state-nonce (never query/body). **[Idempotency]** single-use nonce via atomic Redis Lua GET+DEL.
- KMS CMK per brand (`packages/connector-secrets/src/AwsSecretsManager.ts:84`).
- Per-brand PII vault DEK, AES-256-GCM, crypto-shred via `brand_keyring.is_active`.

### 4.2 Verified auth gaps (RECOMMENDED fixes)

Gap `secrets-prod-rotation-app-secrets` (severity high, all 4 confirmed):

1. `META_APP_SECRET` / `GOOGLE_ADS_CLIENT_SECRET` read from raw `process.env` (`HandleMetaOAuthCallbackCommand.ts:179`, `HandleGoogleAdsOAuthCallbackCommand.ts:157`) — contra the Shopify ARN pattern. **Fix:** move to Secrets Manager ARNs + crash-fail Zod env schema at startup.
2. `meta-token-refresh/run.ts:65` writes refreshed token to `dev_secret` only — comment `"PROD: this is the seam for AwsSecretsManager.PutSecretValue"` is an **unimplemented TODO** → silent ~60-day token death in prod. **Fix:** implement `updateSecret`. **[Retry]** proactive re-exchange.
3. `AwsSecretsManager.storeSecret` only calls `CreateSecretCommand` (`AwsSecretsManager.ts:76-104`) → `ResourceExistsException` on reconnect/rotation. **Fix:** catch `AlreadyExists` → `PutSecretValue` (idempotent upsert) **[Idempotency]**.
4. `RotateWebhookSecretCommand` EXISTS but is wired to **no HTTP route**. **Fix:** `POST /api/v1/connectors/razorpay/:id/rotate-webhook-secret` (RBAC owner/admin, audit-logged), with an **old-secret grace window** (accept previous secret for a TTL so mid-retry signatures aren't dropped).

Plus `shopify-compliance-token-lifecycle` (high): the mandatory GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) and `app/uninstalled` are **absent** (App-Store blocker); the expiring-offline-token mandate (2026-04-01 new apps / 2027-01-01 all) needs a Shopify token-refresh job mirroring `meta-token-refresh`.

### 4.3 Future-connector & AI/analytics support

Idempotent `storeSecret` + app-secret-from-ARN + token write-back become **base-contract obligations** (`validate`/`authenticate` Template) — no per-connector prod-seam TODOs. AI/analytics: prevents silent spend-ingestion death (blanked ROAS/CAC) and keeps app credentials out of process introspection/logs.

---

## 5. Kafka Architecture

### 5.1 Topics, partitions, keys (EXISTS)

| Topic | Purpose | Partition key | Retention | Owner (produce → consume) |
|---|---|---|---|---|
| `{env}.collector.event.v1` | **live lane** — pixel + every webhook + every repull | `brand_id:event_id` | 7d (RECOMMENDED ≥30d) | core webhook producer + 8 repull jobs → CollectorEventConsumer + Spark sink |
| `{env}.collector.order.backfill.v1` | **backfill lane** (isolated from live lag, ADR-BF-7) | `brand_id:event_id` | 30d | shopify-backfill → BackfillOrderConsumer |
| `{topic}.dlq` | dead-letter | original | 30d | DlqProducer → DlqRedriver |
| `{topic}.quarantine` | security/consent gate failures (distinct from DLQ) | original | 30d | gate → quarantine sink |
| `{env}.brain.{orders,customers,shipments,payments,sessions,ads}` | entity topics (PARTIAL — dual-produce flag-gated, only shopify-repull) | `brand_id` | — | shopify-repull only |

Partition key = `brand_id:event_id` via `buildPartitionKey` (`packages/events/src/index.ts:140`, EXISTS) → **tenant-first ordering** at every producer.

### 5.2 DLQ + offset discipline (EXISTS, strong)

- `autoCommit=false` on all 10 consumer classes — offset commits **only** after confirmed Bronze/ledger write or DLQ produce (D-7). EXISTS, verified.
- DLQ stamps `x-dlq-original-topic`/`x-dlq-reason`; `DlqRedriver` bounded (`DEFAULT_MAX_REDRIVE=3`) **[Retry]** loop-guard.
- **[Outbox]-adjacent:** Bronze bridges are a declarative `BRONZE_BRIDGES` registry — adding a landing is one config entry (the wired-to-nothing anti-pattern is structurally prevented).

### 5.3 Verified Kafka conformance gaps (RECOMMENDED — Phase 0)

Gap `single-pipeline-idempotency-conformance` (high, all 3 confirmed):
1. **Producer idempotency off everywhere** — collector `kafka-producer.ts:51` `idempotent:false`; all 8 repull jobs + `DlqProducer.ts:18` default-false. **Fix:** `idempotent:true` + `acks:-1` on every producer **[Idempotency]**. Bronze `ON CONFLICT DO NOTHING` is the data-correctness backstop, but broker-level dedup is missing.
2. **IdentityBridgeConsumer has a volatile in-memory retry counter** (`IdentityBridgeConsumer.ts:28` `new Map`) — `main.ts:259` omits the durable Redis `RetryCounterAdapter` 5th arg that ConsentSuppressor/Backfill consumers receive → a poison identity event can wedge the partition. **Fix:** inject the durable counter **[Retry]**.
3. **Backfill topic name mismatch** — `docker-compose.yml:226` creates `dev.collector.event.v1.backfill` but `main.ts:121` / `order.backfill.v1.ts:104` consume `dev.collector.order.backfill.v1`. **Fix:** correct the `rpk topic create` line + set `allowAutoTopicCreation:false`.

### 5.4 Future-connector & AI/analytics support

Idempotent producers + a DLQ on every consumer become base-contract guarantees → a new connector cannot introduce a duplicate-storm or a poison-wedge. Prevents duplicate ledger writes (revenue truth) and identity-resolution stalls that would starve attribution.

---

## 6. Medallion Architecture Mapping

```
Sources (8 connectors, IConnector.sync/webhook/backfill)
   │  raw → IMapper → CanonicalEvent (order.live.v1, spend.live.v1, settlement.live.v1, *_status.v1)
   ▼
Kafka ONE pipeline (collector.event.v1)                         [single-pipeline mandate]
   ▼
BRONZE  — Iceberg, append-only, immutable, partitioned by (bucket(16,brand_id), days(occurred_at))
   │       sole SoR; admission gating (R2 install_token→brand, R3 consent) replicated in Spark sink
   ▼
SILVER  — dbt marts, organized BY BUSINESS ENTITY (orders/customers/products/shipments/
   │       sessions/touchpoints/marketing/checkout) — connector is a `source` column, never a table
   ▼
GOLD    — serving marts, ADR-004 additive-only (counts/sums, never precomputed ratios)
   ▼
FEATURE — brain_feature schema (training substrate) + Redis online store (offline/online parity)
```

The connector platform's only job in the medallion is to **land canonical events into Bronze through the single pipeline**. Everything Silver-and-up is entity-organized and connector-agnostic — that is what lets a new connector light up analytics with zero downstream code.

---

## 7. Bronze Design

### 7.1 EXISTS

- Iceberg-native, append-only, format-v2, zstd, `PARTITIONED BY (bucket(16, brand_id), days(occurred_at))` — verified `db/iceberg/spark/bronze_materialize.py` `ensure_table` DDL.
- **[Idempotency]** `MERGE … WHEN NOT MATCHED THEN INSERT` on `event_id` — strict append-only dedup.
- Two-phase cold-start-safe streaming sink (`availableNow` drain → `processingTime` continuous).
- Admission gating replicated in the sink: `SERVER_TRUSTED_BRONZE` set, pixel R2 `install_token→brand` inner-join, brand-mismatch quarantine, R3 consent.
- 24-month compaction + snapshot expiry + right-to-erasure (crypto-shred) via `bronze_maintenance.py`.

### 7.2 Why required / changes

Bronze is the **replay floor** — every Silver/Gold mart is rebuildable from it, which is what makes connector cut-overs safe. Connector platform change: none to Bronze schema; new connectors land via the same canonical envelope. **PARTIAL gap** (`single-pipeline-idempotency-conformance` §5.3): live-topic retention 7d is too short for Spark replay if a checkpoint is lost — RECOMMENDED ≥30d.

### 7.3 AI/analytics support

Bronze is the immutable substrate for the feature layer's point-in-time correctness and for any model retraining; deterministic `event_id` makes re-pulls fully idempotent end-to-end.

---

## 8. Silver Design — by entity

### 8.1 EXISTS — 10 entity marts (verified `db/dbt/models/marts/`)

`silver_order_state`, `silver_order_line`, `silver_customers`, `silver_shipment`, `silver_shipment_event`, `silver_product`, `silver_sessions`, `silver_touchpoint`, `silver_marketing_spend`, `silver_checkout_signal`.

- **Connector-agnostic:** identity is a `source`/`platform` **column** (e.g. `silver_marketing_spend.platform ∈ {meta, google_ads}`), never a per-connector table. ADR-CM-1 structurally enforced.
- `brand_id` is first key/distribution/order column on every mart (I-ST01). **[Repository]**-style read seam `withSilverBrand` (`packages/metric-engine/src/silver-deps.ts`) injects `SET @brain_current_brand_id` + `AND brand_id=?` on every read — the sole runtime isolation gate (StarRocks Row Policies are enterprise-only — see §12 critical gap).
- Deterministic replay: 4-key ordering in `silver_order_state`, server-re-derived 30-min sessions, **ingestion-time** incremental watermark (late/backdated events never missed).

### 8.2 The one entity gap — RECOMMENDED, but corrected to LOW

Gap `silver-settlement-entity` was **verified `already-built`/deferred**: the only settlement reader (`computeSettlementSummary`, `packages/metric-engine/src/settlement-summary.ts`) already reads the Gold lakehouse mart `brain_gold.gold_revenue_ledger` (not raw PG); `silver_checkout_signal` (PR #211) already closed the payments-category Silver gap. A `silver_settlement` mart would have **zero readers** today (speculative scaffolding) — deliberately deferred per the engineering memory. **Do not build until a payment-provider-economics reader exists.**

### 8.3 Future-connector & AI/analytics support

Because Silver is entity-keyed, a new connector that emits `order.live.v1` (e.g. a new storefront) flows into `silver_order_state`/`silver_order_line` with **zero new dbt**. New entity types (e.g. GA4 web-analytics) get one new entity mart, reused by every brand.

---

## 9. Gold Design

### 9.1 EXISTS — serving marts + ADR-004 discipline

`gold_revenue_ledger`, `gold_revenue_analytics`, `gold_customer_360`, `gold_customer_scores` (deterministic RFM/churn — *labeled NOT ML*), `gold_customer_segments`, `gold_cohorts`, `gold_cac`, `gold_marketing_attribution`, `gold_attribution_paths`, `gold_executive_metrics` (verified).

- **ADR-004 additive-only:** marts store additive components (`order_count`, `realized_value_minor`, `new_customers`, `acquisition_spend_minor`), never the ratio (AOV/CAC/RTO%) — those are computed in the metric-engine registry, preventing double-counting and non-reproducible numbers.
- `gold_revenue_ledger.sql` is var-gated `ledger_source=var('ledger_source','iceberg')` (lakehouse default, PG JDBC shim as reversible escape) — Phase-G re-point DONE (git log `c96932a`).

### 9.2 RECOMMENDED operational gaps

- No declared Argo CronWorkflow for `dbt build` or for `revenue_ledger_materialize.py` → Silver/Gold freshness rests on an undeclared external trigger. Add scheduled jobs + a DQ freshness check on the Iceberg ledger table (folds into `feature-materialization-scheduling-eval-gate` discipline).

### 9.3 Future-connector & AI/analytics support

Gold serves the dashboards and Ask-Brain; additive components mean a new connector's spend/revenue rolls up correctly with no ratio re-derivation.

---

## 10. Feature Layer Design

### 10.1 EXISTS / PARTIAL

- `feature_customer_daily.sql` (schema `brain_feature`) — point-in-time daily snapshots (correct grain, no label leakage). EXISTS.
- `packages/feature-store/` Redis online store + offline/online **parity by construction** (one `compute` fn drives both). EXISTS.
- `apps/stream-worker/src/jobs/feature-materialization/run.ts` — EXISTS but PARTIAL.

### 10.2 RECOMMENDED — gap `feature-materialization-scheduling-eval-gate` (medium, confirmed)

1. Materialization job is **not wired** into `stream-worker/main.ts` and has **no Argo cron**; Redis keys have **no TTL** (`feature-store/src/index.ts:66` bare `set`) → silent infinite-stale features if the job stops. **Fix:** declare a CronWorkflow + Redis TTL (~25–26h) + `last_materialized_at` sentinel + freshness alarm **[CircuitBreaker]**-style guard.
2. `promote-model.ts` enforces only stage-transition integrity — reads **no** eval-metrics baseline → a model with `auc=0.01` can reach production. **Fix:** read `metrics` jsonb, throw if any guardrail < baseline before production promotion (fail-safe).
3. litellm per-tenant spend cap is documented intent only (`docker-compose.yml:159` no config mount). **Fix:** author + mount `litellm.config.yaml` with per-tenant `virtual_key.max_budget`.

### 10.3 Future-connector & AI/analytics support

A reliable, monitored feature store is the substrate that consumes **new-connector signals** (GoKwik RTO flag, GA4 sessions) into models. The eval gate upholds *confidence-before-decisions* — unvetted models and stale features never drive recommendations.

---

## 11. Identity Design

### 11.1 EXISTS — Postgres union-find SoR (ADR-0003)

- Deterministic union-find resolver (`IdentityResolver.ts`, `@effort('deterministic')` — zero model cost), FORCE-RLS on all 7 identity tables, append-only merge/audit trail, deterministic `merge_id` (SHA-256, D-4) → byte-identical replays. EXISTS.
- Identifier vocabulary: email, phone, storefront_customer_id (strong); device_id, anon_id (medium, resolve-only). Per-brand salt via the single `hashIdentifier` primitive.
- Neo4j retired as a non-authoritative projection (gated off by default).

### 11.2 RECOMMENDED — gap `connector-pre-hashed-identity` (high, confirmed)

`ResolveIdentityUseCase.execute()` (`apps/stream-worker/src/application/ResolveIdentityUseCase.ts:85-91`) extracts only **raw** `props.email`/`props.phone`/`storefront_customer_id`. But Shopify/WooCommerce mappers emit `hashed_customer_email`/`hashed_customer_phone` and Shopflo emits `customer_email_hash` (byte-compatible with the resolver's own `hashIdentifier`). So order/checkout events stitch on `storefront_customer_id` **alone** — email/phone never enter `identity_link`, breaking brain_id continuity for guest/checkout flows (under-attributes LTV/CAC).

**Fix (additive, no schema change):** add a secondary extraction block reading the pre-hashed fields as already-hashed `tier='strong'` identifiers (`preHashed` flag → skip re-hash). The `IMapper` contract (§3.2) standardizes the pre-hashed field name so every future connector contributes uniformly. **[Strategy] [Adapter]**.

### 11.3 Future-connector & AI/analytics support

Uniform pre-hashed identity contribution → cross-channel brain_id continuity → accurate LTV, CAC, cohorts, attribution for every new connector.

---

## 12. Database Design

### 12.1 EXISTS — connector tables

`connector_instance`, `connector_sync_status`, `connector_cursor`, `connector_razorpay_order_map`, `connector_journey_stitch_map`, `connector_webhook_raw_archive` — all ENABLE+FORCE RLS, two-arg fail-closed `current_setting` (NN-1), REVOKE ALL / minimal GRANT, migration-time DO-block assertions. Credentials never in PG (NN-2, only `secret_ref` ARN). EXISTS, verified across migrations 0006/0021/0027/0030/0050/0062.

### 12.2 RECOMMENDED DB changes (Phase 1)

| Gap | Change | Pattern |
|---|---|---|
| `data-driven-provider-discovery` | add `connector_provider_config JSONB` (backfill 6 fat columns), replace N `list_<provider>_…` SECURITY DEFINER fns with one generic `list_connectors_for_repull(provider)`; collapse `enumerateConnectedConnectors` to one call | **[Repository] [Factory] [Strategy]** |
| `sync-run-history-ledger` | new `connector_sync_run` (append-only, FORCE-RLS, RANGE(`started_at`)-partitioned, born-secure via `maintain_time_partitions` 0080/0084) + `consecutive_failure_count`/`first_failure_at` on `connector_sync_status` | **[Outbox] [Repository]** |
| `webhook-archive-partition-dlq-pg` | RANGE(`received_at`)-partition `connector_webhook_raw_archive` (mirror 0075 — today the only un-partitioned high-cardinality heap) + new partitioned `connector_dlq_record` (queryable dead-letters beyond 30d Kafka) | **[Outbox] [Repository]** |
| `multi-account-per-provider` | drop `UNIQUE(brand_id,provider)` (migration 0006:35, KNOWN-CM-01) → `UNIQUE(brand_id,provider,account_key)`; Meta/Google enumerate **all** accounts not `[0]` | **[Repository] [Factory]** |

All are additive-then-cutover (new column/table → backfill → reads switched behind a flag → old dropped after parity), never a destructive single shot. The provider DB-CHECK coupling was already removed in 0062 (ADR-CM-1), lowering blast radius.

### 12.3 The critical isolation note (EXISTS, accepted-risk)

StarRocks Row Policies are open-source-tier-absent (`db/starrocks/bootstrap.sql` commented out) → the in-process `withSilverBrand` predicate is the **sole runtime gate** for Silver/Gold. Documented; prod graduation path is enterprise StarRocks Row Policies. This is a Silver/Gold concern, not a connector-table concern (connector tables are FORCE-RLS in PG).

### 12.4 Future-connector & AI/analytics support

A new connector needs **zero** new enumeration fn and **zero** new column (writes identifiers into `connector_provider_config` JSONB) — this plus the unified contract is what makes 100+ connectors mechanical. `connector_sync_run` + `connector_dlq_record` give every connector run-level observability and forensic dead-letter visibility, which feed the DQ grader and recommendation freshness gate.

---

## 13. Topic Design

### 13.1 Naming + ownership conventions (EXISTS)

- Prefix is `{env}` (`prod`/`dev`); suffix is a versioned `<surface>.v<N>` (`collector.event.v1`, `collector.order.backfill.v1`). Shared constants in `@brain/contracts` (`COLLECTOR_EVENT_V1_TOPIC_SUFFIX`, `ORDER_BACKFILL_V1_TOPIC_SUFFIX`).
- **Single-pipeline mandate:** every producer (pixel, all 4 webhooks, all 8 repull/backfill) emits to the **same live topic** before any Bronze write — no raw-event bypass exists (verified). This is the connector platform's strongest invariant: a new connector adds zero topics.
- Backfill lane is a **separate topic + consumer group** (ADR-BF-7) so historical backfills can't lag the live lane.

### 13.2 RECOMMENDED topic changes

| Gap | Change |
|---|---|
| `single-pipeline-idempotency-conformance` | fix `docker-compose` backfill topic name; raise live retention to ≥30d; disable `allowAutoTopicCreation` |
| entity topics (PARTIAL) | dual-produce `brain.{orders,…}` is wired only in `shopify-repull` (flag-gated off). **Decision required:** either generalize dual-produce to all sources via the pipeline, or document the firehose-only decision and stop creating empty entity topics |

### 13.3 Collector env-var consistency (low)

`collector/src/main.ts:104` builds the topic prefix from `NODE_ENV` while repull jobs use `APP_ENV` — RECOMMENDED to unify on `APP_ENV` (or pin `COLLECTOR_TOPIC` explicitly in manifests) to avoid a silent cross-environment topic split.

---

## 14. Design-pattern application map (the 10 patterns)

| Pattern | Where applied | EXISTS / RECOMMENDED |
|---|---|---|
| **Strategy** | `OAuthDispatch` (EXISTS), `REPULL_DISPATCH` (EXISTS); per-provider `IConnector` + `IMapper` + webhook verify/map | EXISTS + RECOMMENDED |
| **Adapter** | mappers raw→canonical; vendor API clients; repull jobs as thin adapters over `IConnector.sync()` | EXISTS + RECOMMENDED |
| **Factory** | `ConnectorFactory.for(provider)` keyed off `CONNECTOR_CATALOG` | RECOMMENDED (`unified-connector-contract`) |
| **Template** | `WebhookPipeline` common steps + provider hooks; base `connect/validate/authenticate` | RECOMMENDED (`generic-webhook-pipeline`, `unified-connector-contract`) |
| **Repository** | `IConnectorInstanceRepository`→`Pg…` (EXISTS); `withSilverBrand` read seam (EXISTS); new `connector_sync_run`/`connector_dlq_record` repos | EXISTS + RECOMMENDED |
| **CoR (Chain of Responsibility)** | webhook pipeline stages (raw-body → HMAC → replay/dedup → resolve → produce → archive → touch); enumerate→dispatch chain | RECOMMENDED |
| **CircuitBreaker** | wrap `IConnector.sync()` so a slow vendor can't stall the scheduler tick; feature-staleness guard | RECOMMENDED (`observability-trace-and-circuit-breaker`) |
| **Retry** | DlqRedriver bounded redrive (EXISTS); meta-token proactive refresh (EXISTS); idempotent producers; full-jitter vendor backoff | EXISTS + RECOMMENDED |
| **Outbox** | declarative `BRONZE_BRIDGES` (EXISTS, adjacent); `connector_dlq_record` PG mirror of the Kafka DLQ; `connector_sync_run` | EXISTS + RECOMMENDED |
| **Idempotency** | deterministic uuidV5 `event_id` + Bronze `ON CONFLICT DO NOTHING` (EXISTS); Redis SET-NX webhook dedup (EXISTS); idempotent `storeSecret`; idempotent producers | EXISTS + RECOMMENDED |

---

## 15. Build sequencing (binds to the phased plan)

| Phase | Theme | Gaps | DB? | New service? |
|---|---|---|---|---|
| **0** | Stop the bleeding (no-event-loss conformance) | `single-pipeline-idempotency-conformance`, `shiprocket-woocommerce-never-dispatched`, `secrets-prod-rotation-app-secrets` | no | no |
| **1** | Foundation (kernel + DB model) | `unified-connector-contract`, `shared-mapper-contract`, `data-driven-provider-discovery`, `sync-run-history-ledger`, `webhook-archive-partition-dlq-pg`, `multi-account-per-provider` | yes (additive-then-cutover) | no (new **package** `@brain/connector-core`) |
| **2** | Pipeline hardening | `generic-webhook-pipeline`, `health-state-operational-transitions`, `observability-trace-and-circuit-breaker` | no | no |
| **3** | Per-app coverage + AI gates | `connector-pre-hashed-identity`, `shopify-compliance-token-lifecycle`, `razorpay-event-coverage-disputes-refunds`, `meta-async-insights-throttle`, `woocommerce-onboarding-backfill-resilience`, `feature-materialization-scheduling-eval-gate` | no | no |
| **deferred** | externally blocked | `ga4-connector-build` (live GA4 creds), `shiprocket-gokwik-live-clients-webhooks` (partner creds) | — | no |

**Every phase ships its own per-service deploy track** (affected-only build → container image → per-service deploy → canary → auto-rollback) for the services it touches (`core`, `stream-worker`, `collector`), never deploy-all, never a follow-up.

---

## 16. Invariants this architecture preserves (the gate)

- Tenant key (`brand_id`) at every layer: PG FORCE-RLS, Kafka partition key, event envelope, Silver read predicate, secret enumeration via SECURITY DEFINER.
- Money in integer minor units + `currency_code` (I-S07), enforced by the `Money`/`IMapper` type contract.
- Single Kafka pipeline; Bronze is sole source of truth; deterministic idempotent `event_id`.
- Secret-ref-only in PG (NN-2); no secrets in logs (I-S09).
- Idempotency on every connector write + mutation; offset-after-write (no event loss, D-7).
- Cheapest-sufficient-effort: identity resolution and RFM/churn are **deterministic** (zero model cost); the only LLM surface (Ask-Brain) is registry-bound and number-grounded.
