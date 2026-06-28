# Connector Platform — Refined Architecture & Gap Register

> Status: synthesized from an 8-domain gap analysis (Connector Manager/Registry, Connector
> Runtime/Adapter, Auth/Secrets/OAuth lifecycle, Request Validator/Metadata Enricher/Envelope
> Builder, Retry/Circuit-Breaker/DLQ/Kafka Producer, Historical Backfill/Incremental Sync,
> Observability/Design-Patterns/Boundary, and UI surfacing).
>
> Headline: **the connector platform is substantially BUILT and architecturally clean.** This
> document exists to pinpoint the *genuine* gaps and to keep us from rebuilding what already works.
> Almost every gap is a wiring / orchestration / instrumentation task on top of primitives that
> already exist — extend, don't rebuild.

---

## (a) Overview — scope + the ingestion-only boundary

The connector platform is Brain's **ingest edge**: it connects to external commerce/marketing/
logistics/analytics sources, authenticates, validates, and lands their data as events onto Kafka
for Spark to materialize into Bronze. It owns a clean static **Connector Registry** (catalog), a
neutral **kernel** (`@brain/connector-core`: `IConnector` 8-verb lifecycle, `ConnectorFactory`,
`IngestionManifest`, `ConnectorInstance`/`ConnectorSyncStatus`), per-source **adapters/strategies/
mappers**, four **execution models** (webhook / polling / batch-backfill / streaming-pixel), a
per-brand **secret vault** (AWS Secrets Manager + KMS CMK), and a full **observability** package.

### Boundary discipline (load-bearing invariant)
Connectors understand ONLY the external platform — never Brain business logic. The platform's job
ends at: authenticate → validate → **PII-hash at the edge** → build a transport envelope → produce
idempotently to Kafka. It does **no** canonicalization of business meaning, identity resolution,
attribution, Customer360, or metric computation — those live downstream in Silver/Gold Spark jobs
(`db/iceberg/spark/{silver,gold}`). Credentials never cross the entity boundary (only a `secret_ref`
ARN lands in Postgres — NN-2). This boundary is respected today and must stay respected.

**V4 note:** CLAUDE.md's target is that connectors land **raw, pre-normalized** payloads into Bronze
and **Spark-Silver owns normalization**. Today the TS mappers normalize *pre-Bronze* (the live lane
emits canonical `CollectorEventV1`). The Spark raw-lane (`bronze_raw_landing.py`, 9 `*.raw.v1` lanes)
is built and waiting, but **no TS producer emits onto the raw lanes yet** — see GAP G1.

---

## (b) BUILT inventory — do NOT rebuild

These are confirmed BUILT with file evidence. Treat as done.

### Registry / Manager / Lifecycle
- **Connector Registry (static catalog)** — `apps/core/src/modules/connector/catalog/registry.ts`
  `CONNECTOR_CATALOG` (11 connectors / 7 categories), `catalog/index.ts` `getDefinition`/`isConnectable`.
  Static-const-as-SoR is a deliberate, correct divergence (ADR-CM-1).
- **Install / connect** — `bootstrap/registerConnectors.ts` POST `/api/v1/connectors` (OAuth dispatch +
  generic schema-driven `planCredentialConnect`).
- **Remove / disconnect** — DELETE `/api/v1/connectors/:id` → `DisconnectCommand` (flips
  status=disconnected/health=Disconnected/safety=blocked).
- **Configure** — declarative `CredentialConnectSpec` + `credential-schema.ts`
  `splitConnectorCredentials`/`planCredentialConnect` (zero per-connector code); BYO-OAuth
  `storeBrandOAuthAppCreds`; `RotateWebhookSecretCommand`.
- **Schedule polling** — `apps/stream-worker/src/jobs/ingest-scheduler/run.ts` (work-queue, bounded
  concurrency, rate-limit gate, overlap-lock) + `sync-request-claimer/run.ts` + `RequestConnectorSyncCommand`.
- **Backfill engine** — `RequestConnectorBackfillCommand` (queue + overlap-lock) + `connector-core`
  `Backfill.ts` `runResumableBackfill` + `IngestionManifest.resolveBackfillFloor` +
  `ingestion-backfill/run.ts` manifest-driven driver.
- **Track sync status** — `connector-core` `ConnectorSyncStatus` + `GetConnectorStatusQuery` +
  GET `/:id/status`.
- **ConnectorFactory** — Open/Closed registry (`packages/connector-core/.../ConnectorFactory.ts`),
  `buildConnectorFactory` registers shopify+ga4 today.

### Runtime — all four execution models
- **Webhook** — `WebhookPipeline.ts` Template-Method (rate-limit → HMAC verify → brand resolve →
  raw archive → age-gate+Redis dedup → payloadMap → idempotent produce → side-effects → sync touch);
  6 `IWebhookStrategy` providers.
- **Polling** — 8 stream-worker repull jobs (shopify/ga4/meta/google-ads/woo/razorpay/gokwik/shiprocket).
- **Batch/historical** — `RequestConnectorBackfillCommand` + `runResumableBackfill` + `NoLoss.ts` DLQ.
- **Streaming (pixel)** — `apps/collector` → Kafka → Spark-SS `bronze_raw_landing.py`.

### Auth / Secrets / OAuth lifecycle (strongest domain)
- **Declarative auth** — `ConnectorAuthField.secret` drives `splitConnectorCredentials`.
- **Per-brand vault** — `ISecretsManager` + `AwsSecretsManager` (KMS CMK envelope encryption, IRSA,
  per-brand namespacing, UPSERT preserving ARN); `LocalSecretsManager` prod-hard-fails.
- **All 5 auth mechanics** — OAuth2 auth-code (Redis single-use ≤15min state nonce), API keys,
  server-minted JWT (Shiprocket), HMAC webhook signatures (one parameterized timing-safe primitive).
- **OAuth token lifecycle** — store + refresh-before-expiry (Meta/Shopify daily crons, Google/GA4
  mint short-lived at run start, Shiprocket 9d<10d re-mint) + rotation write-back preserving ARN.

### Validator / Envelope (webhook lane is the complete realization)
- HMAC-first fail-closed verification; brand resolved from DB (never the body); age/replay window;
  Redis dedup; Zod `CollectorEventV1` envelope built PRE-Kafka; verbatim raw archiving.
- Envelope metadata BUILT: `brand_id`/`tenant`, `source`, `schema_version`, `received_at`/`ingested_at`,
  `correlation_id`. `trace_id` deliberately rides `correlation_id` + Kafka traceparent (divergence-OK).

### Retry / Circuit-Breaker / DLQ / Producer (stream-worker side mature)
- Real `CircuitBreaker` (Closed/Open/HalfOpen, OTel counters); exponential backoff; timeouts;
  durable Redis retry counter; no-loss DLQ (offset committed only after DLQ produce); loop-guarded
  `DlqRedriver` + CLI; idempotent producer factory (stream-worker); tenant-leading partition keys;
  "no external system talks to Kafka directly" entry-point invariant.

### Incremental sync — all 5 strategies
- Webhooks; since_id cursor paging; updated_at high-water; date-window/delta; page_token. Continuous
  scheduler with bounded concurrency + per-provider rate-limit + tick-overrun canary. Lane isolation
  (backfill topic vs live topic, both deduped at Bronze). Deterministic dedup + no-loss guarantees.

### Observability + design patterns
- `@brain/observability` wraps real OTel SDK (spans/meter/OTLP), PII-redaction, correlation-ID,
  Kafka W3C trace inject/extract, `CircuitBreaker`, Sentry, structured logger. ~20 connector counters
  → Prometheus + Grafana (`connector-health.json`, `ingest-health.json`) + SLO alerts. All 9 GoF/
  resilience patterns present (Adapter/Factory/Strategy/Registry/Template-Method/Command/CircuitBreaker/
  Retry/constructor-DI). DLQ count, backfill progress, success/failure-rate per connector all BUILT.

### UI
- Integration Marketplace (`marketplace-view.tsx`) — category catalog, OAuth/credential/BYO-app flows,
  7-state health badges, safety flags, multi-account ad activation, 1-storefront exclusivity,
  embedded Sync-Now. Connection status in 3 places. Reactive TokenExpired badge + reconnect CTAs.

---

## (c) GAP REGISTER — file-level build tasks

Deduped across domains. Priority = product/risk weight; Effort = S/M/L. `ships_ui` flags whether the
gap surfaces a stakeholder-visible UI on its own.

### HIGH priority

**G1 — Raw-lane Event-Envelope producer (V4 verbatim `*.raw.v1`)** · L · ships_ui: no
The Spark raw-lane (`db/iceberg/spark/bronze_raw_landing.py`, 9 lanes) is built but **no TS producer
emits onto `*.raw.v1`**. Build a small util that wraps each verbatim provider record in
`{brand_id (server-trusted from DB row), source, resource, trace_id/correlation_id, payload:<original-bytes>}`
and produces to the matching `*.raw.v1` topic. Wire into `apps/stream-worker/src/jobs/*-repull/run.ts`
and/or the webhook pipeline so connectors land RAW pre-normalized payloads and Spark-Silver owns
normalization (the V4 target). Keep the canonical live lane until parity is proven.

**G2 — Core webhook/M1 Kafka producer must be idempotent (acks=all)** · S · ships_ui: no
`apps/core/src/main.ts:638` `webhookKafka.producer()` is a BARE producer (KafkaJS default acks=1),
shared by `WebhookPipeline` (the live order/payment commerce lane) AND the M1 lifecycle publisher.
Extract `createIdempotentProducer` into `@brain/events` (shared by core + stream-worker), replace the
bare producer with `idempotent:true` (forces acks=-1, retries→MAX_SAFE_INTEGER). Verify
`WebhookPipeline.ts:393` send still 500s on failure so the provider retries. Closes "No event loss"
on the commerce entry point. (Subsumes the separate acks=all gap.)

**G3 — DLQ durable PG record at write-time (not only on redrive scan)** · M · ships_ui: no
`connector_dlq_record` (migration 0094) is persisted ONLY when an operator runs `DlqRedriver` scan —
between DLQ-write and next redrive the only durable copy is the 30-day Kafka topic. Inject
`DlqRecordRepository` into `DlqProducer` (`apps/stream-worker/src/infrastructure/kafka/DlqProducer.ts`)
and call `persist()` inside `send()` (fire-and-forget, idempotent on `deriveDlqId`). Extract the
brand_id/error-class derivation from `DlqRedriver.ts:209-233` into a shared helper to avoid drift.

**G4 — Auto-kick backfill ON CONNECT** · M · ships_ui: no (pairs with G6)
Backfill is manual-only (POST `/connectors/:id/backfill`). In `registerConnectors.ts` Shopify
OAuth-callback success and `ConnectWooCommerceCommand.execute()` success, call
`requestConnectorBackfill.execute({...})` right after the instance/sync_status persists, so connect
auto-starts history import. Guard with the existing `checkActiveJob` overlap-lock (reconnect-idempotent).

**G5 — Generic multi-resource backfill wired to a queue/claimer (retire dev CLI)** · L · ships_ui: no
`ingestion-backfill/run.ts` (the GENERIC products/customers/refunds/fulfillments driver) is only a
dev CLI with `INGEST_BACKFILL_BRAND_ID` env. Add a resource-backfill claimer in
`apps/stream-worker/src/main.ts` (mirror `startSyncRequestClaimer`): on a `backfill_job`/`backfill_plan`,
expand `backfillableResources(manifest)` into per-resource `resource_backfill_state` rows and dispatch
`ingestion-backfill run(...)` with brand_id from the SECURITY-DEFINER enumeration fn. Retire the env path.

**G6 — Mount the orphaned BackfillControl + progress/Sync UI + "Backfill running" badge** · M · ships_ui: YES
`apps/web/components/connectors/backfill-control.tsx` is FULLY built (trigger, queued/running/completed/
partial/failed, honest indeterminate progress, reconnect/already-running alerts, role gating) but
**never mounted**. Mount `<BackfillControl connectorId={...}/>` next to `<SyncNowControl/>` in
`marketplace-view.tsx` ConnectorTile (~line 506, gate to storefront category). Thread active backfill
status into `TileStatusIndicator` so a running import shows a distinct "Importing history" badge.
One-import wiring fix that turns on a dead, fully-tested feature.

**G7 — Quantitative latency histograms (vendor API / Kafka publish / webhook)** · M · ships_ui: YES (Grafana)
Latency exists only as OTel span duration; no histogram metrics. Add a `recordHistogram` helper to
`packages/observability/src/index.ts` (`createHistogram` on the meter), then: (a) vendor API latency —
emit `connector.api.latency_ms{name}` inside `CircuitBreaker._runWithTimeout` (it owns the vendor name
label and is on every outbound path); (b) Kafka publish latency — wrap `producer.send` in
`WebhookPipeline.ts:393` + bronze-bridge produce paths, emit `kafka.produce.latency_ms{topic}`;
(c) webhook latency — record `webhook.ingest.latency_ms{provider}` at span end. Add p95 panels to
`connector-health.json`.

**G8 — Incremental-sync-lag + OAuth-token-expiry gauges (proactive)** · M · ships_ui: YES (Grafana)
No per-connector "seconds since last sync" gauge and no "days until token expiry" gauge — expiry is
only seen once refresh/auth fails. Add an observable-gauge helper to `observability/index.ts`
(`meter.createObservableGauge`), then emit `connector_sync_lag_seconds{provider,connector_instance_id}`
(from `connector_sync_status.last_sync_at` in the ingest-scheduler tick) and
`connector_token_expiry_seconds{provider,connector_instance_id}` (from the token bundle in
`shopify-token-refresh`/`meta-token-refresh` jobs). Add panels + alert when expiry < 7 days.

### MEDIUM priority

**G9 — Connector VERSION dimension + upgrade lifecycle** · M · ships_ui: YES (reconnect-to-upgrade badge)
Version is entirely MISSING (dedup of three findings: Manager version mgmt, envelope `connector_version`,
backfill version-upgrade stage). Add `version` to `ConnectorDefinition` (`catalog/registry.ts`),
`manifestVersion`/`connectorVersion` to `IngestionManifest` + `CanonicalProvenance` (`CanonicalEvent.ts`),
`connector_instance.connector_version` column (new migration) stamped at connect time, stamp it in the
webhook + repull/backfill envelope builders, surface on the `/api/v1/connectors` tile, and add a
"reconnect to upgrade" state when catalog version > installed version (the Shopify scope-change reconnect
case). Optionally drive re-backfill on manifest-version increment.

**G10 — Periodic active health-probe monitor + wire the unreachable "Disabled" state** · M · ships_ui: no
`IConnector.health()` is defined but never invoked (health is reactive-only on repull error). Add a
stream-worker `jobs/connector-health-probe/run.ts` that iterates connected instances, resolves
`factory.tryResolve(provider).health(brandId)`, persists via `ConnectorInstanceHealthRepository` — OR
explicitly document health as reactive-only and remove the unused verb. Also wire the `Disabled`
health-state setter (currently unreachable).

**G11 — Generic enable/disable (pause) a connector** · M · ships_ui: YES (pause/resume button)
Only ad-account activate/deactivate exists; `Disabled` health state is declared but never set; the only
off-switch is disconnect (tears down to blocked). Add `connector_instance.disabled_at` (migration),
`ConnectorInstance.disable()/enable()` setting `health_state='Disabled'`, have `claim_due_repull_connectors`
+ `list_connectors_for_repull` exclude disabled rows (polling stops, connection kept), and add POST
`/api/v1/connectors/:id/disable` + `/enable`. Reuse the activate/deactivate transaction pattern. Surface
a pause/resume control on the tile.

**G12 — Tighten Open/Closed seams + thread live commands through IConnector + wire factory into composition root** · L · ships_ui: no
Dedup of "adding a connector needs framework changes", "concrete adapters are stubs", and "factory not
on the live path". Adding a CREDENTIAL connector is already catalog-only; full-lifecycle/OAuth ones still
need edits at hardcoded seams. (1) Replace `manifestFor()` ternary with a provider→manifest registry
consumed by the backfill driver; (2) make `registerAllWebhookRoutes` iterate a catalog-keyed strategy
registry instead of 6 inline blocks; (3) drive `PROVIDER_REPULL_RESOURCE`/`REPULL_DISPATCH` from the
manifest; (4) replace the NOT_WIRED stubs in `ShopifyConnectorAdapter`/`Ga4ConnectorAdapter` with
delegation to the existing live commands, add thin adapters for woo/razorpay/meta/google_ads/pixel, and
instantiate `buildConnectorFactory()` in `main.ts` so `factory.resolve(provider)` is the single live
resolution path.

**G13 — Apicurio schema-registry validation in ProcessEventUseCase** · M · ships_ui: no
Validation is Zod-local; the Apicurio FULL_TRANSITIVE check is an M2 stub (`ProcessEventUseCase.ts:17`).
Wire registered-subject schema validation (replace the stub), keeping Zod as the fast-path guard.

**G14 — Collector-lane occurred_at freshness / replay-window validation** · S · ships_ui: no
The collector/pixel lane has no replay-window check (webhook lane does). Add an occurred_at
freshness check to `ProcessEventUseCase` mirroring `ProviderRedisDedupAdapter.isWithinReplayWindow`,
quarantining stale/clock-skewed events with reason `replay_rejected` instead of silently landing them.

**G15 — Reactive OAuth refresh fallback on 401 (self-heal between crons)** · M · ships_ui: no
Proactive refresh is age-threshold + daily-cron only — a token enrolled already near expiry or a missed
cron window has no 401-driven self-heal. In the Meta/Google/GA4 runtime clients, on a provider 401 trigger
a one-shot re-exchange before failing (Google: refresh_token→access; Meta: hard alert), mirroring
`ShiprocketTokenProvider.invalidate()`. Keep the daily cron as the primary path.

**G16 — DLQ / failed-event review + replay UI (+ ops read endpoint)** · M · ships_ui: YES
No queryable read surface for `connector_dlq_record`/`silver_quarantine` and no management UI (only a
read-only pixel "Quarantined" count). (1) Add an internal-ops read in `apps/core` listing DLQ/quarantine
rows by source_topic/provider/error_class/redrive_count with payload + error_detail (global-ops scope,
consistent with the CLI design), plus a brand_admin-guarded replay/reprocess command. (2) Add a web route
`app/(dashboard)/data/quarantine/` (or a data/health tab) with a table + per-row/bulk Replay actions +
`use-quarantine.ts` hook + honest empty state. (Merges the Retry-domain "operator review surface" gap
with the UI-domain "DLQ review+replay" gap.)

**G17 — Per-connector observability UI + generic connector detail page** · M · ships_ui: YES
Data Health shows GLOBAL ingestion only; there is no per-connector throughput/lag/error panel and no
generic detail route (only a Shopify OAuth-callback page exists). (1) BFF/Trino read returning
per-`connector_instance` metrics over a window (events ingested, events/min, ingest lag, DLQ/quarantine
count, error count) keyed by brand_id + connector. (2) Add `app/(dashboard)/settings/connectors/[id]/page.tsx`
as the per-connector home composing HealthBadge/status, SyncNowControl, the newly-mounted BackfillControl,
sync-mode/cadence, OAuth/token detail, the observability panel, and the DLQ list. This gives G6/G16/G18 a
natural home and unblocks deeper operational surfacing without overloading the marketplace grid.

**G18 — Sync mode / cadence visibility (webhook vs poll, interval, next sync)** · M · ships_ui: YES
No file surfaces sync mode/cadence. Extend the marketplace tile / `GetConnectorStatusQuery` + catalog to
expose connect mode + poll interval, then render a line per connected tile: "Real-time (webhooks)" vs
"Polled every N min · Next sync ~HH:MM".

**G19 — Payments historical backfill (Razorpay settlements + Shopify transactions)** · L · ships_ui: no
No payment manifest exists; Razorpay/Gokwik have trailing-window incremental only. Add `RAZORPAY_MANIFEST`
with a `settlements`/`payments` `ResourceDescriptor` (date_window/page_token, backfillSupported:true, real
`maxBackfillWindowMs`) + a `RazorpaySettlementsFetcher` (`IResourcePageFetcher`), and a Shopify `transactions`
resource (Admin REST `/orders/{id}/transactions`). Register them in the resource-backfill claimer (G5).

**G20 — Producer compression on high-volume lanes** · S · ships_ui: no
No producer sets compression (collector explicitly `CompressionTypes.None`). Add compression
(GZIP built-in, or Snappy/Zstd if the kafkajs codec lib is present — validate before selecting) to the
collector drainer send and the stream-worker idempotent producer, configurable via `@brain/config`
(`KAFKA_PRODUCER_COMPRESSION`).

**G21 — Stamp resolved `region` as an envelope field** · S · ships_ui: no
`regionCode` flows through context (used for PII hashing/residency) but is not stamped on the envelope.
Stamp `deps.regionCode` as additive-optional `region` at `WebhookPipeline.ts:372` build + the collector/
repull builders, so regional residency is auditable on every Bronze record.

**G22 — Per-connector throughput + retry-count + API-quota metrics** · M · ships_ui: YES (Grafana)
Dedup of three observability PARTIALs. (a) Unify the per-source bronze write counters
(`bronzeBridges.ts:38-62`) into one `bronze_write_total{provider,brand_id}` for a per-connector events/sec
panel. (b) Emit `connector_retry_total{provider,reason}` at retry decision points
(`RetryCounterAdapter.increment`, 429 continue in vendor clients). (c) Parse vendor call-limit headers
(`X-Shopify-Shop-Api-Call-Limit`, Meta usage header) in the vendor clients and emit
`connector_api_quota_utilization_ratio{provider}`. Add panels to `connector-health.json`/`ingest-health.json`.

**G24 — Backfill-THEN-incremental sequencing (gate or ADR)** · M · ships_ui: no
Modes are lane-separated and dedup-safe, but incremental starts immediately on connect concurrent with
backfill — the spec's "history THEN incremental" is not enforced. Either gate `claim_due_repull_connectors`
to skip a connector whose primary-resource `resource_backfill_state` is not `completed`, OR document the
concurrent-safe design (dedup at Bronze makes order immaterial) as an intentional ADR divergence
(recommended).

### LOW priority

**G23 — Unified capability descriptor on ConnectorDefinition** · S · ships_ui: no
Capability metadata is real but SPREAD across catalog + manifest + factory/dispatch/webhook registries.
Add a `capabilities:{oauth,webhooks,backfill,incremental}` block (or a derived `CapabilitySummary` helper
in `catalog/index.ts`) and expose it on GET `/api/v1/connectors` so the marketplace reads capabilities from
one source.

**G25 — Resource dependency ordering (`dependsOn`)** · M · ships_ui: no
Add optional `dependsOn?:readonly string[]` (or `order:number`) to `ResourceDescriptor` and have the
resource-backfill claimer (G5) topologically order dispatch (orders → customers/products/payments).

**G26 — Additive envelope fields: `organization_id`, `environment`, `source_api_version`** · S · ships_ui: no
`organization_id` (derivable brand→org), `environment` (currently only the topic prefix), and upstream
`api_version` (used only outbound) are not stamped as first-class envelope fields. Add additive-optional
fields to `sample.collector.event.v1.ts`/`m1.events.v1.ts` if a consumer needs them without a join.

**G27 — Payload-size → DLQ with a structured reason** · S · ships_ui: no
Oversize is rejected at transport (Fastify 413) only. Add a per-event size guard in the validator path
emitting an `invalid`→DLQ outcome with reason `payload_too_large`, so oversize events are observable/replayable.

**G28 — Multi-replica Shiprocket token cache (Redis)** · S · ships_ui: no
`ShiprocketTokenProvider` cache is per-process in-memory. When run in >1 replica, back it with Redis keyed
by `connector_instance_id` (TTL<10d) behind the unchanged `getToken()/invalidate()` interface.

**G29 — Promote hardcoded retry/breaker literals into `@brain/config`** · S · ships_ui: no
`MAX_RETRY=5` and per-vendor `CircuitBreaker` literals → `packages/config/src/stream-worker.ts`
(`STREAM_MAX_RETRY` / per-source breaker settings), current values as defaults. No behavior change.

**G30 — Native change-token incremental + brand+entity webhook partition key** · M · ships_ui: no
If a connector exposes a native change-feed (Shopify bulk-operations / delta-token), add a fetcher that
persists the platform change token in `connector_cursor` (`page_token` strategy already supported).
Optionally switch `WebhookPipeline.ts:397` to `buildPartitionKey(brandId, mapped.eventId)` for strict
tenant+entity keying / more parallelism.

---

## (d) Divergence-OK notes (deliberate, correct — do not "fix")

- **Static-const catalog (ADR-CM-1)** — deploy-time registration over a runtime DB registry preserves
  Brain's auditable/reviewable invariants; metadata is still self-declared per connector in code.
- **`normalizeMetadata` is not an IConnector verb** — normalization is the separate `IMapper.map()`
  Single-Primitive (raw→canonical, money→minor units, PII-hash at boundary), reused across all lanes.
- **No single per-connector ExecutionMode enum** — execution model is declared per-RESOURCE via
  `IngestionManifest.ResourceKind` and realized by distinct subsystems (correct).
- **`trace_id` absent from the envelope** — rides `correlation_id` + Kafka W3C traceparent.
- **Collector accept-before-validate (D-1)** — stamps `received_at`, spools, defers Zod/consent to the
  consumer; correct back-pressure / no-loss design.
- **Collector producer non-idempotent + retries:0** — no-loss held by the durable spool + dedup; fails
  fast so the drainer re-drains. (Distinct from G2, which is the COMMERCE core producer.)
- **M1 lifecycle publisher fail-open** — lifecycle events are reconstructable from PG SoR; a Kafka blip
  must not break registration. (Commerce data is protected by spool/DLQ, not this path.)
- **mTLS / client-cert auth absent** — no current source needs it; add only when one lands (G-skip).
- **No IoC container** — manual constructor-DI composition root is idiomatic for this codebase.
- **Producer batching (linger) untuned** — KafkaJS built-in batching is correct vs the no-loss
  offset-after-write model at current volumes.
- **Backfill progress as a stateful API read, not a Prometheus gauge** — correct (per-job state, not a
  time-series).

---

## (e) Phased BUILD PLAN — waves (each ships a UI surface)

Ordered so each wave is independently shippable and surfaces stakeholder-visible UI per Brain's
"every build ships UI" rule. High-priority buildable gaps first.

### Wave 1 — Harden the no-loss spine + surface Failed Events (UI: DLQ/quarantine review)
`G2` (idempotent core producer / acks=all), `G3` (DLQ durable record at write-time), `G20` (compression),
`G16` (DLQ/failed-event review + replay UI + ops read endpoint).
**Why first:** closes "No event loss" on the live commerce entry point and makes failures *durable +
observable + replayable* — then surfaces them in a real UI. Low-effort, highest-risk-reduction.

### Wave 2 — Activate history import end-to-end (UI: backfill trigger + progress)
`G6` (mount BackfillControl + progress + "Backfill running" badge), `G4` (auto-kick backfill on connect),
`G5` (generic multi-resource backfill claimer), `G18` (sync mode/cadence visibility).
**Why:** the backfill backend + UI component already exist but are disconnected — wiring them turns on a
fully-built, invisible capability and gives users visible "import history" + cadence.

### Wave 3 — Quantitative observability + per-connector home (UI: connector detail page + dashboards)
`G7` (latency histograms), `G8` (sync-lag + token-expiry gauges), `G22` (throughput/retry/quota metrics),
`G17` (per-connector observability UI + generic `[id]` detail page).
**Why:** fills the entire quantitative-latency/lag/expiry side of the spec and gives every deeper surface
(backfill, DLQ, token) a real home — the connector detail page.

### Wave 4 — Lifecycle completeness (UI: version/pause/health on the detail page)
`G9` (connector version dimension + upgrade state), `G11` (generic enable/disable pause), `G10` (periodic
health probe + wire Disabled state), `G12` (tighten Open/Closed seams + thread IConnector + wire factory),
`G15` (reactive OAuth 401 refresh).
**Why:** completes the manager lifecycle (version, pause/resume, active health, single resolution path)
and renders version/pause/health controls on the detail page from Wave 3.

### Wave 5 — V4 raw-lane + validation hardening + payments history (UI: payments backfill on detail page)
`G1` (raw-lane verbatim producer — V4 normalization shift), `G13` (Apicurio schema validation),
`G14` (collector replay-window), `G19` (payments historical backfill), `G21` (region envelope field).
**Why:** moves normalization toward the Spark-Silver V4 target, hardens the collector validation lane to
webhook-lane parity, and adds payments history — all landing on the now-mature detail page.

> Low-priority gaps (G23–G30) are picked up opportunistically inside the wave that touches their files
> (e.g. G23 with G12, G25 with G5, G29 with G2/G3, G26 with G21).
