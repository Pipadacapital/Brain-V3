# Phase 0 — Ingestion: Principal Review (Refined)

Read-only Principal review of the ALREADY-BUILT Phase 0 ingestion spine. Scope = the approved flow only:
**External sources + Universal Pixel → Fastify Collector → Apache Kafka (KRaft) → Spark Structured Streaming landing → Apache Iceberg Bronze.**
CARDINAL RULE held throughout: no business logic before Bronze; Bronze is immutable / replayable / auditable SoT.

Status date: 2026-06-28. EXTEND-not-rebuild. No code was edited.

> **WRITER NOTE (2026-07-05, ADR-0010):** the Spark-SS landing this review audited
> (`bronze_materialize.py` / `bronze_raw_landing.py`) has since been replaced by the Kafka Connect
> Iceberg sink and REMOVED from the codebase. §6/§7/§11/§13 rows referencing those files describe
> the then-current writer; the review's findings on them are historical evidence, not current
> state.

---

## 1. Verdict

**Phase 0 is ~85% built and architecturally sound — enterprise-grade where it counts.** The connector kernel (`@brain/connector-core`), the webhook security pipeline, the durable-spool collector, the two Spark-SS landers with offset-after-Iceberg-commit no-loss, idempotent MERGE dedup, append-only RAW Bronze, compaction/expiry, and crypto-shred erasure are all genuinely complete and well-reasoned. The CARDINAL RULE is honored in both landers (only receipt-lineage metadata is stamped; payload is verbatim). **Three headline gaps dominate the punch-list, all buildable-now, none requiring a redesign:**

1. **The KRaft swap (#286) orphaned the Kafka-broker half of the alert set** — `BrainDlqGrowing` / `BrainConsumerLagHigh` / `BrainIngestStale` still key off `redpanda_kafka_*` metrics that no longer emit. These are now false-safety fantasy alerts. *Release-gating regression of the no-event-loss observability contract.*
2. **Tenant isolation on the read path is app-injected, not engine-enforced** — `${BRAND_PREDICATE}` is a SQL string the BFF injects; there is no Trino file-based-access-control row filter, so a direct Trino session can read cross-brand.
3. **`.quarantine` is a write-only black hole** — R2/R3 gate failures are produced to the quarantine topic but no consumer ever drains/re-evaluates them; a consent-granted-later or token-fixed event is parked forever.

Secondary but real: the unified `IConnector`/`ConnectorFactory` seam is proven-but-unadopted (two registered adapters throw `NOT_WIRED`), exponential backoff is absent (the "5 attempts" exists, the "backoff/5-min cap" does not), several spec docs are stale post-KRaft, and the nine `*.raw.v1` topics the raw lander subscribes to are not provisioned anywhere. The remaining missing connectors are overwhelmingly **SOURCE-BLOCKED** (need a real vendor API spec/credential) — building them empty would violate "no empty success state."

---

## 2. Spec-section coverage

| Section | Status | Key file(s) | The gap |
|---|---|---|---|
| §3 Source catalog | PARTIAL | `apps/core/src/modules/connector/catalog/registry.ts` | 10 sources built (all real, no stubs); ~13 missing are source-blocked; 1 buildable (Server-SDK / Custom-Events) |
| §4 Universal Pixel | PARTIAL | `packages/pixel-sdk/src/*`, `extensions/brain-web-pixel/src/index.js` | Funnel/session/attribution/consent/transport strong; gaps: DNT/GPC, vendor CMP adapters, browser-SDK purchase event, advanced engagement events, hashed-email-on-login bridge, default 2-yr cookie flag-gated OFF |
| §5 Connector lifecycle | PARTIAL | `connector/catalog/registry.ts`, `.../shopify/.../DisconnectCommand.ts` | register/configure/disconnect built; reversible **disable/enable (pause)** verb missing |
| §5 Auth layer (OAuth2/API-key/HMAC/JWT + vault + refresh) | BUILT | `connector/sources/*`, `@brain/connector-secrets`, `RedisOAuthStateStore` | Strongest area; KMS CMK per-write, NN-2 secretRef-only boundary |
| §5 Webhook receiver + verify | BUILT | `connector-core/.../WebhookPipeline.ts`, `IWebhookStrategy` | HMAC-first (NN-4), brand via SECURITY DEFINER (MT-1), dedup, fast-ack — most complete sub-area |
| §5 Polling scheduler | BUILT | `jobs/ingest-scheduler/run.ts` | Claim-based work queue, SKIP LOCKED, per-provider rate limiter |
| §5 Streaming connectors | MISSING (correct) | manifest `ResourceKind:'stream'` | No streaming upstream among the 9 sources — source-blocked, no action |
| §5 Historical backfill | PARTIAL | `connector-core/contracts/Backfill.ts`, `jobs/ingestion-backfill/run.ts` | Generic resumable engine live for shopify+woo only; other 7 use bespoke repull jobs; dev-CLI-triggered (no cron); legacy `shopify-backfill/` coexists |
| §5 Incremental cursor sync | BUILT | `ConnectorCursor` + `CursorStrategy` | Per-resource cursor advanced by repull + backfill |
| §5 Structural validator | BUILT | `CollectorEventV1Schema.parse()`, `assertManifestValid()` | No per-resource payload schema pre-map (acceptable for RAW Bronze) |
| §5 Envelope builder / metadata enricher | BUILT | `@brain/contracts` (doc-07 CollectorEventV1) | ingested_at/correlation_id/event_id/provenance + W3C trace inject |
| §5 Idempotent producer | BUILT (2 modes) | `apps/collector/.../kafka-producer.ts`, `createIdempotentProducer` | Collector deliberately NOT broker-idempotent (spool owns retry); webhook+backfill use idempotent producer |
| §5 Retry / DLQ manager | BUILT | `NoLoss.deliverWithNoLoss`, `PgDeadLetterSink`, `jobs/dlq-redrive/run.ts` | Complete loop incl. operator replay |
| §5 Health monitoring | BUILT | `healthSafety.ts`, `ConnectorInstanceHealthRepository` | 7-state→3-state, persisted column is truth |
| §5 ConnectorFactory / IConnector | PARTIAL | `connector-factory.ts`, `ShopifyConnectorAdapter.ts`, `Ga4ConnectorAdapter.ts` | Proven-but-unadopted; both registered adapters throw `NOT_WIRED`; live path is per-source commands |
| §6 Kafka KRaft broker/topology | BUILT | `docker-compose.yml:189-216` (apache/kafka:3.8.1) | Redpanda gone; service DNS `redpanda` kept intentionally |
| §6 Topic design/naming | BUILT | `infra/redpanda/topics.yml`, `infra/terraform/modules/redpanda/main.tf` | `{env}.{domain}.{event}.v{n}`; live/backfill/DLQ/quarantine lanes exist |
| §6 Replication/min-ISR/retention | BUILT (drift) | `main.tf:100-138` | RF=3, minISR=2, 730d; compression disagrees 3 ways; no `unclean.leader.election`; no quotas |
| §6 `*.raw.v1` topic provisioning | MISSING | `bronze_raw_landing.py:56-66` vs `docker-compose.yml:233-249` | 9 raw lanes subscribed but provisioned nowhere; auto-create OFF |
| §6 idempotent/acks=all (collector) | DISCREPANCY (by design) | `kafka-producer.ts:50-59` | `idempotent:false`, `retries:0` — spool+deterministic event_id is the idempotency layer; spec language inaccurate |
| §7 Spark-SS job topology | BUILT | `bronze_materialize.py`, `bronze_raw_landing.py` | Kafka Connect retired; Spark sole landing compute *(as of 2026-06-28 — since replaced by the Kafka Connect sink, ADR-0010)* |
| §7 Envelope extract + metadata | BUILT | `_project_bronze`, `project_raw` | Verbatim payload; receipt-lineage only — cardinal rule honored |
| §7 Exactly-once (offset-after-commit) | BUILT | `bronze_materialize.py:400-489` | Well-reasoned no-loss proof + self-heal of empty-trailing offsets |
| §7 Checkpoint durability | PARTIAL (infra) | `bronze_materialize.py:62-64` | Defaults to `file:///`; prod needs `s3a://` + hadoop-aws — cluster-gated |
| §7 Cold-start / micro-batch | BUILT | `:498-513`, `bronze_raw_landing.py:270-281` | Two-phase AvailableNow→processingTime; maxOffsetsPerTrigger caps |
| §7 Append-only + dedup-by-event_id | BUILT | `:375-396`, `bronze_raw_landing.py:215-234` | Collector MERGE on (brand_id,event_id); raw MERGE on physical (topic,partition,offset) |
| §8 Bronze schema | BUILT (drift) | `bronze_spec.json`, `bronze_table.sql` vs runtime `ensure_table()` | Runtime DDL is stripped: drops target-file-size, retention, object-storage, annotations |
| §8 Partition/bucket spec | BUILT (drift) | `bronze_table.sql:58` vs `bronze_spec.json:40` | `bucket(16)` vs `bucket(256)`; partition is `days(occurred_at)` not `date(received_at)` |
| §8 event_id type | DISCREPANCY | `bronze_table.sql:23`, `bronze_spec.json:12` | Annotated "UUID v4"/`uuid`; actual design is deterministic-derived `string` |
| §8 Parquet + compaction | BUILT | `bronze_maintenance.py`, `medallion_maintenance.py` | zstd, 128MB target, rewrite_data_files |
| §8 Expire-snapshots / retention | BUILT (no cron) | `bronze_maintenance.py`, `bronze_raw_retention.py` | Jobs exist; no Argo CronWorkflow pins the cadence |
| §8 Raw-table row TTL DELETE | PARTIAL (stub) | `bronze_raw_retention.py:60,78` | `_ = older_than` discarded; row-DELETE not implemented (only snapshot expiry) |
| §8 Append-only/immutability | BUILT | `write.upsert.enabled=false`, `brain.immutable=true` | Enforced by write path |
| §8 Time-travel | BUILT | `bronze_maintenance.py:69-82` | Erasure expires pre-deletion snapshots (RTBF not time-travel-recoverable) |
| §8 Encryption-at-rest | PARTIAL (infra) | `bronze_spec.json:75` | Per-brand KMS DEK hooks present; real KMS cluster-gated (MinIO plaintext local) |
| §8 Schema registry (Avro) | PARTIAL (intentional) | `docker-compose.yml:254-262` | Apicurio up; Bronze payload is verbatim JSON, schema_name/version hardcoded — deferred |
| §10 Retry→DLQ routing | BUILT | `CollectorEventConsumer.ts`, `RetryCounterAdapter.ts` | autoCommit:false, MAX_RETRY=5, Redis counter survives restart |
| §10 Transient-vs-permanent classify | PARTIAL | `CollectorEventConsumer.ts`, `ProcessEventUseCase.ts` | Binary invalid-vs-thrown only; no 4xx/5xx taxonomy |
| §10 Exponential backoff (5×/5min cap) | MISSING | `CollectorEventConsumer.ts:142,167` | No per-attempt delay, no 5-min ceiling, no delay-topic |
| §10 DLQ topic + metadata | BUILT (1 gap) | `infrastructure/kafka/DlqProducer.ts` | Inbound retry-count not stamped (only later x-redrive-count) |
| §10 DLQ persistence beyond retention | BUILT | `DlqRecordRepository.ts`, migration `0094` | UUIDv5 idempotency, RLS per-insert |
| §10 Replay | BUILT (CLI) | `DlqRedriver.ts`, `jobs/dlq-redrive/run.ts` | Loop-guard, dry-run, trace re-inject, Bronze-dedup-safe |
| §10 DLQ inspect/correct/replay UI | PARTIAL | `apps/web` (none) | Replay=CLI; "correct" (edit-then-replay) absent; no web surface |
| §10 Quarantine lane | PARTIAL | `CollectorEventConsumer.ts:103`, `ProcessEventUseCase.ts` | Produced-to, never consumed; no drain/re-evaluation path |
| §11 Tracing (Collector→Kafka→Spark) | BUILT / PARTIAL | `packages/observability/src/kafka-trace.ts` | TS legs linked; Spark stores trace_id as column, no continued span |
| §11 OTel SDK + PII guard | BUILT | `packages/observability/src/index.ts` | NN-6 redact before SDK; brand_id+correlation_id mandatory |
| §11 OTel→Jaeger/Tempo | BUILT | `infra/observe/tempo.yml`, `otel-collector.yml` | 3 Grafana dashboards |
| §11 Collector latency histogram | MISSING | `collect.route.ts`, `spool-backpressure.ts` | accept/spool-full counters exist; no p50/p95/p99 |
| §11 Kafka lag/throughput/under-replicated | MISSING / BROKEN | `infra/observe/prometheus.yml:28-35`, `alerts/brain-slo.rules.yml` | redpanda scrape disabled post-KRaft; 3 alerts key off non-existent `redpanda_kafka_*` |
| §11 Spark stream metrics | MISSING | `bronze_materialize.py`, `job_log.py` | No StreamingQueryListener (numInputRows/batchDuration/offset-lag) |
| §11 Iceberg commit/snapshot/file metrics | MISSING | `bronze_maintenance.py` | No `.snapshots`/`.files` metadata-table gauges |
| §11 Scrape targets `:9091`/`:9092` | BROKEN | `prometheus.yml`, `apps/{collector,stream-worker}/src/main.ts` | No `/metrics` server (OTLP-only) → dead targets, perpetual BrainTargetDown |
| §12 Auth on every endpoint | PARTIAL (by design) | `collect.route.ts` | Collector ingest endpoints intentionally unauthenticated; no edge rate-limit/abuse control |
| §12 Credential→tenant binding | BUILT | `ProcessEventUseCase.resolveBrandByInstallToken` | brand_id never from body; claimed≠derived → quarantine + audit |
| §12 Kafka tenant isolation (SASL/ACL/mTLS) | PARTIAL (infra) | `infra/` (none) | Isolation by-convention (brand field/key); broker-enforced version cluster-gated |
| §12 Bronze RLS / Trino row-filter | PARTIAL | `db/trino/views/mv_*.sql`, `bronze_spec.json` | `${BRAND_PREDICATE}` app-injected, not engine-enforced; no Trino FBAC rules |
| §12 TLS in-transit | PARTIAL (infra) | `infra/terraform/...` | At-rest strong (SSE-KMS, deny-unencrypted); in-transit relies on managed prod |
| §12 PII-in-Bronze restricted | BUILT (coarse) | `bronze_raw_landing.py`, `erasure_raw_delete.py`, migrations `0114/0115` | Prefix/IAM-coarse; no column-level PII classification |
| §13 Config/tuning | BUILT (minor) | `bronze_materialize.py`, `bronze_raw_landing.py` | MAX_RETRY=5, DEFAULT_MAX_REDRIVE=3 hardcoded (not env); ties to backoff gap |

---

## 3. Connector-catalog classification

Every spec source → **EXISTS** (real backend, not a stub) / **SOURCE-BLOCKED** (needs a real external API spec + credentials; do NOT scaffold empty) / **BUILDABLE** (no external dependency).

| Spec category | Source | Classification | Evidence / note |
|---|---|---|---|
| Commerce | Shopify | **EXISTS** (oauth) | `sources/storefront/shopify/*` — OAuth, webhooks, pixel install |
| Commerce | WooCommerce | **EXISTS** (credential) | `sources/storefront/woocommerce/*` — connect, HMAC, plugin install |
| Commerce | Shopflo | **EXISTS** (credential) | `sources/checkout/shopflo/*` (tiled under payments) |
| Commerce | Magento | **SOURCE-BLOCKED** | comment-only in `pixel/.../PixelInstaller.ts:7` |
| Commerce | Headless / Custom | **BUILDABLE** | `/v1/events`+`/batch` accept envelope; needs server SDK + API-key auth |
| Marketing | Meta Ads | **EXISTS** (oauth) | `sources/advertising/meta/*` |
| Marketing | Google Ads | **EXISTS** (oauth) | `sources/advertising/google/*` |
| Marketing | TikTok Ads | **SOURCE-BLOCKED** | comment-only; enum `paid_tiktok` in contracts |
| Marketing | LinkedIn Ads | **SOURCE-BLOCKED** | pixel captures `li_fat_id` but no connector |
| Marketing | Snapchat Ads | **SOURCE-BLOCKED** | 0 code hits |
| Payment | Razorpay | **EXISTS** (credential) | `sources/payment/razorpay/*` — settlement, dedup, order-map |
| Payment | GoKwik | **EXISTS** (credential) | `sources/checkout/gokwik/*` — RTO predict (AWB API does not exist) |
| Payment | Stripe | **SOURCE-BLOCKED** | 0 code hits |
| Payment | PayPal | **SOURCE-BLOCKED** | 0 code hits |
| Payment | Checkout.com | **SOURCE-BLOCKED** | 0 code hits |
| Logistics | Shiprocket | **EXISTS** (credential) | `sources/logistics/shiprocket` (JWT DEV-fixture, prod-on-creds) |
| Analytics | GA4 | **EXISTS** (oauth) | `sources/analytics/ga4/Ga4ConnectorAdapter.ts` |
| CRM | Salesforce | **SOURCE-BLOCKED** | 0 hits |
| CRM | HubSpot | **SOURCE-BLOCKED** | `coming_soon` tile only (`registry.ts:266`), no backend |
| CRM | Zoho | **SOURCE-BLOCKED** | 0 hits |
| Support | Zendesk / Freshdesk / Intercom | **SOURCE-BLOCKED** | 0 hits; no support/messaging backend |
| Behavioural | Pixel (browser + Web Pixel) | **EXISTS** | `packages/pixel-sdk` + `extensions/brain-web-pixel` |
| Behavioural | Server-SDK / Custom-Events-API | **BUILDABLE** | ingestion exists; only published SDK + API-key auth missing |
| Behavioural | Mobile-SDK | **SOURCE-BLOCKED** | 0 hits |

**Built: 10** (shopify, woocommerce, meta, google_ads, razorpay, gokwik, shopflo, shiprocket, ga4, pixel — matches the stated 9 connectors + pixel).
**Buildable (no upstream blocker): 1** — Server-SDK / Custom-Events-API.
**Source-blocked: 13** — do NOT scaffold; each needs a real vendor spec/credential/partner app. Building them empty violates "no empty success state."

---

## 4. Genuine buildable gaps (built + source-blocked EXCLUDED)

Only gaps with a real fix and no external-source blocker. Split into **cheap-formalizations** (config/doc/wiring, hours-scale) and **real builds** (new behavior/surface, days-scale). Each line = a buildable unit with files-touched and extend-vs-new.

### 4A. Cheap-formalizations (config / doc / wiring — low risk, high signal)

| # | Gap | Files touched | Extend/New |
|---|---|---|---|
| F1 | Provision the 9 `*.raw.v1` (+ DLQ) topics — subscribed but declared nowhere | `infra/redpanda/topics.yml`, `infra/terraform/modules/redpanda/main.tf`, `docker-compose.yml` (redpanda-init) | extend |
| F2 | Re-point dead alerts: add Kafka JMX-exporter sidecar scrape; re-key `BrainDlqGrowing`/`BrainConsumerLagHigh`/`BrainIngestStale` off `redpanda_kafka_*` → JMX metrics | `infra/observe/prometheus.yml`, `infra/observe/alerts/brain-slo.rules.yml`, `docker-compose.yml` | extend + new sidecar |
| F3 | Delete dead `:9091`/`:9092` Prometheus scrape jobs (no `/metrics` server; OTLP-only) | `infra/observe/prometheus.yml` | extend |
| F4 | Converge runtime `ensure_table()` TBLPROPERTIES with canonical `bronze_table.sql` (target-file-size, metadata codec, retention, object-storage, annotations) | `db/iceberg/spark/bronze_materialize.py` | extend |
| F5 | Fix `bucket(16)`→`bucket(256)`; correct "UUID v4"→deterministic; reconcile `uuid` vs `string` type | `db/iceberg/bronze_table.sql`, `db/iceberg/bronze_spec.json` | extend |
| F6 | Single-source compression (pick lz4) across producer / topics.yml / terraform; pin `unclean.leader.election.enable=false` | `apps/collector/.../kafka-producer.ts`, `infra/redpanda/topics.yml`, `infra/terraform/modules/redpanda/main.tf` | extend |
| F7 | Reconcile stale spec docs: "partition by received_at"→`occurred_at`/`kafka_timestamp`; "idempotent producer"→spool-level idempotency + deterministic event_id + acks=all; Redpanda/UUIDv4 mentions post-KRaft | `packages/contracts/src/events/sample.collector.event.v1.ts`, phase-0 spec doc | extend |
| F8 | Stamp `x-dlq-retry-count` on DLQ messages; hoist `MAX_RETRY`/`DEFAULT_MAX_REDRIVE`/backoff to config | `apps/stream-worker/.../DlqProducer.ts`, `CollectorEventConsumer.ts`, `DlqRedriver.ts` | extend |
| F9 | Reconcile pixel `event_id` random-vs-deterministic (capture.ts mints `env.uuid()`); decide server-side derivation or document exemption | `packages/pixel-sdk/src/capture.ts`, `extensions/brain-web-pixel/src/index.js`, contract | extend |
| F10 | IP-handling at collector edge: confirm/strip — make IP-anonymization explicit | `apps/collector/src/interfaces/rest/collect.route.ts` | extend |

### 4B. Real builds (new behavior / surface)

Ordered by value. R1–R3 are the headline gaps from §1.

| # | Gap | Files touched | Extend/New |
|---|---|---|---|
| R1 | **Quarantine drain/re-evaluation job** — mirror `DlqRedriver`: re-run R2/R3 gate, promote to live topic on pass. (Today `.quarantine` is write-only.) | NEW `apps/stream-worker/src/jobs/quarantine-redrive/`, reuse `ProcessEventUseCase`, `DlqRedriver` pattern | new (reuses engine) |
| R2 | **Trino file-based access-control row filters** on `brand_id` for `brain_serving.mv_*` — make `${BRAND_PREDICATE}` engine-enforced, not app-injected | NEW `db/trino/access-control/rules.json` (+ catalog config), `db/trino/views/mv_*.sql` | new |
| R3 | **Exponential backoff (5 attempts / 5-min cap)** on the consumer — tiered retry-topic ladder or delay keyed off `retryCounter.increment()` | `apps/stream-worker/.../CollectorEventConsumer.ts`, `ProcessEventUseCase.ts`; possibly new delay topics in F1 set | extend (+ topics) |
| R4 | **Spark `StreamingQueryListener`** → push numInputRows/processedRowsPerSecond/batchDuration/offset-lag to OTLP/pushgateway; + Iceberg `.snapshots`/`.files` gauges in maintenance | `db/iceberg/spark/bronze_materialize.py`, `bronze_raw_landing.py`, `bronze_maintenance.py`, `job_log.py` | extend |
| R5 | **DLQ inspect/correct/replay web UI** over `connector_dlq_record` (engine exists; only "correct" + UI missing) — BFF endpoint + guarded replay button + edit-payload-then-replay | NEW `apps/web` DLQ page, NEW BFF endpoint, extend `DlqRedriver` for corrected-payload path | new (reuses engine) |
| R6 | **Edge guard on collector** — install_token-presence check + per-IP/per-token rate-limit (anon flood → quarantine flood today) | `apps/collector/src/interfaces/rest/collect.route.ts`, NEW edge rate-limit middleware | extend + new |
| R7 | **Implement raw-table row-level TTL DELETE** (currently discarded `_ = older_than` stub) so D4's "raw PII gone after 7 days" is real, not snapshot-expiry-only | `db/iceberg/spark/bronze_raw_retention.py` | extend |
| R8 | **Collector latency histogram** (p50/p95/p99) on accept path | `apps/collector/.../collect.route.ts` | extend |
| R9 | **Adopt `IConnector`/`ConnectorFactory`** — replace the two `NOT_WIRED` reference adapters with delegating wiring to existing commands; converges the "1× engineering / plugin-only" claim | `connector/.../connector-factory.ts`, `ShopifyConnectorAdapter.ts`, `Ga4ConnectorAdapter.ts` | extend (pure delegation) |
| R10 | **Reversible disable/enable lifecycle verb** (pause without secret teardown) | NEW `SetConnectorEnabledCommand`, `ConnectorInstanceHealthRepository` (Disabled state already exists) | new (small) |
| R11 | **Onboard live-API connectors (meta/google/razorpay/ga4) to `IngestionManifest` + `runResumableBackfill`**, retiring bespoke repull jobs; schedule generic backfill on a cron; retire legacy `shopify-backfill/`. (gokwik-awb + shiprocket stay source-blocked.) | `jobs/ingestion-backfill/run.ts`, per-source fetchers, NEW Argo CronWorkflow | extend + new cron |
| R12 | **Server-SDK / Custom-Events-API** — thin published server SDK + API-key/install-token auth over the existing `/v1/events`+`/batch` (only buildable catalog source) | NEW `packages/server-sdk`, extend `apps/collector` auth path | new |
| R13 | **Pixel buildable gaps** — DNT/GPC read; vendor CMP adapters (OneTrust/Cookiebot/IAB-TCF) vs generic `window.__brainConsent`; browser-SDK purchase/transaction event (today Web-Pixel-only); advanced engagement events (rage/dead-click, scroll, form — MEMORY claims these exist but grep finds none); hashed-email-on-login bridge; default the 2-yr anon cookie (flag-gated OFF → Safari/ITP exposure) | `packages/pixel-sdk/src/{consent,capture,identity,attribution}.ts`, `extensions/brain-web-pixel/src/index.js`, `apps/collector/.../collect.route.ts` | extend |

**Infra-blocked-on-cluster (NOT in the buildable list; listed for completeness — do NOT stub):** KMS-at-rest per-brand DEK + S3-prefix + Lake Formation/Glue grants; durable `s3a://` Spark checkpoint + hadoop-aws; Kafka mTLS/SASL + in-transit TLS for PG/Redis; Argo CronWorkflows for bronze/raw/medallion maintenance (manifests buildable now in F1/R11 vicinity, but only *run* on the cluster). The hooks (object-storage prefix, KMS spec) are already in `bronze_spec.json`.

---

## 5. Recommended build-wave ordering

**Wave 0 — release-gating + cheap (do first, mostly parallel).**
Restore the no-event-loss observability contract and silence false safety.
- F2 (re-point dead Kafka alerts + JMX sidecar) — **highest priority, release-gating.**
- F1 (provision the 9 raw topics) — unblocks the raw lander's declared home; F3, F6 ride alongside.
- F3, F5, F6, F7, F9, F10 — independent doc/config fixes, fully parallelizable across reviewers.
*Parallelism: all of Wave 0 is parallel; F1↔F6 touch the same topic files so sequence those two.*

**Wave 1 — tenant safety + no-loss completeness.**
- R2 (Trino row-filter — engine-enforced isolation) — independent, parallel.
- R1 (quarantine drain) — independent, parallel.
- R3 (exponential backoff) — depends on F1/F8 if it uses delay topics; otherwise parallel.
- R7 (raw row TTL DELETE) — independent, parallel.
*Parallelism: R1, R2, R7 fully parallel; R3 sequences after F1/F8 only if topic-laddered.*

**Wave 2 — observability depth + operator surface.**
- R4 (Spark StreamingQueryListener + Iceberg gauges) — parallel.
- R8 (collector latency histogram) — parallel.
- R5 (DLQ inspect/correct/replay UI) — parallel; benefits from F8 (`x-dlq-retry-count`) landing first.
- R6 (collector edge guard) — parallel.
*Parallelism: R4, R6, R8 independent; R5 after F8.*

**Wave 3 — connector-platform convergence + reach (lowest urgency).**
- R9 (adopt IConnector/ConnectorFactory) — pure delegation, parallel.
- R10 (disable/enable verb) — small, parallel.
- R11 (manifest-onboard live-API connectors + backfill cron + retire legacy) — parallel per-connector.
- R12 (Server-SDK / Custom-Events) — the one buildable new catalog source, parallel.
- R13 (pixel buildable gaps) — multiple independent sub-tasks (DNT/GPC, CMP adapters, purchase event, engagement events, email-hash bridge, default cookie), fully parallelizable across SDK files.

**Cross-cutting parallelization note:** Waves are gated by *risk*, not hard dependency — Wave 0's F2/F1 should land before anyone trusts the alert board, and F1/F8 must precede the topic-laddered/UI items (R3 if laddered, R5). Everything else within and across waves is independent enough to fan out to separate engineers. Do **not** spend any wave on source-blocked connectors or infra-cluster items.
