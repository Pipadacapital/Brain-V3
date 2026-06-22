# Connector Platform — Operations Design
**Doc version:** 2026-06-22 | **Branch:** feat/brain-replatform

Covers deliverables 14–18 of the Universal Real-Time Connector Platform design: Retry Strategy, Error Handling, Observability Design, Security Design, and UI Requirements.

Every claim is grounded in the actual repository. Statements are marked **[EXISTS]** (verified in code or config) or **[RECOMMENDED]** (gap identified in audit; implementation required).

---

## 14. Retry Strategy

### 14.1 Architecture — Kafka-native at-least-once with durable bounded retries

All connector events flow through a single Kafka pipeline before any Bronze write. The retry strategy is implemented at the consumer layer, not the producer layer, exploiting Kafka's inherent re-delivery-on-uncommitted-offset semantics.

```
Webhook / Repull
     |
     v
Redpanda topic: {env}.collector.event.v1
     |
     v
CollectorEventConsumer (autoCommit: false)
     |--[write success]-----------> commit offset + reset RetryCounter
     |--[parse error]-------------> DLQ direct (no retry) + commit
     |--[write error, count < 5]--> throw → KafkaJS re-delivers (no commit)
     |--[write error, count >= 5]--> DLQ + commit
     |
     v
  RetryCounterAdapter (Redis INCR, TTL 7d)
  Key: retry-counter:{groupId}:{topic}:{partition}:{offset}
```

### 14.2 Consumer retry loop — CollectorEventConsumer [EXISTS]

**File:** `apps/stream-worker/src/interfaces/consumers/CollectorEventConsumer.ts`

- `autoCommit: false` — offsets committed only after confirmed write or DLQ route.
- `MAX_RETRY = 5` (constant, line 28).
- On `ProcessEventUseCase` throw: `retryCounter.increment(retryScope, partition, offset)` → if count < MAX_RETRY: rethrow (KafkaJS re-delivers) → if count >= MAX_RETRY: route to `{topic}.dlq` via `DlqProducer`, then commit, then `retryCounter.reset(...)`.
- `retryScope = "{groupId}:{topic}"` — load-bearing scope preventing counter collision across the 10+ consumer groups sharing `dev.collector.event.v1`.
- `invalid` outcome (Zod parse failure) → DLQ directly, no retry, immediate commit.
- `quarantined` outcome (R3: consent absent / tenant unresolved) → `.quarantine` topic, immediate commit.

### 14.3 Durable retry counter — RetryCounterAdapter [EXISTS]

**File:** `apps/stream-worker/src/infrastructure/redis/RetryCounterAdapter.ts`

- Interface: `IRetryCounter` with `increment(scope, partition, offset): Promise<number>` and `reset(scope, partition, offset): Promise<void>`.
- Key format: `retry-counter:{scope}:{partition}:{offset}`.
- Atomic Redis `INCR` + `EXPIRE` on first sight (TTL = 7 days = `RETRY_COUNTER_TTL_SECONDS`).
- `lazyConnect: true`, `enableOfflineQueue: false`, `maxRetriesPerRequest: 3`.
- If Redis is unavailable: `INCR` throws → `eachMessage` throws → KafkaJS re-delivers without committing → transient delay, no silent loss.

### 14.4 Retry is pure KafkaJS re-delivery (no exponential backoff) [EXISTS / GAP]

**[EXISTS]** The retry re-delivery happens at KafkaJS poll cadence — there is no explicit sleep/delay between attempts. This is intentional for simplicity: poison messages reach MAX_RETRY quickly rather than parking the partition for minutes.

**[RECOMMENDED — GAP: no per-attempt backoff or jitter]** Transient errors (Postgres failover, Iceberg write contention) that resolve within seconds will be retried at full poll rate, potentially amplifying load. Recommended implementation: in the `catch` branch of `CollectorEventConsumer.eachMessage`, insert exponential backoff with jitter before rethrowing:

```typescript
const delayMs = Math.min(1000 * 2 ** (current - 1), 30_000)
  + Math.random() * 500; // jitter
await new Promise(r => setTimeout(r, delayMs));
throw err;
```

Cap at 30 s. This keeps MAX_RETRY=5 meaning ~2 minutes max park time for a transient error.

### 14.5 IdentityBridgeConsumer — volatile in-memory retry counter [GAP]

**File:** `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts`

**[EXISTS — INCORRECT]** `IdentityBridgeConsumer` implements MAX_RETRY=5 using a `Map<RetryKey, number>` (in-memory, line 28):

```typescript
private readonly retryCount = new Map<RetryKey, number>();
```

**[RECOMMENDED — CRITICAL GAP: P0]** A pod restart, deploy, OOM, or node drain resets this map to zero. A deterministically-failing identity event will retry forever, never reaching the DLQ, wedging its partition. Fix: wire `IRetryCounter` (the Redis-backed `RetryCounterAdapter`) into `IdentityBridgeConsumer` using the same `retryScope = "{groupId}:{topic}"` pattern already established in `CollectorEventConsumer`. This is a safety invariant, not an optimization.

### 14.6 Per-provider dispatch rate limiter — ConnectorRateLimiter [EXISTS]

**File:** `apps/stream-worker/src/infrastructure/redis/ConnectorRateLimiter.ts`

Redis fixed-window counter per provider, shared across all replicas:

| Provider | maxPerWindow | windowMs | Rationale |
|---|---|---|---|
| `meta` | 10 | 60 s | Meta Graph app-level quota (shared across all brands) |
| `google_ads` | 10 | 60 s | Developer-token daily ops quota |
| `shopify` | 100 | 60 s | Per-shop bucket — generous |
| `razorpay` | 60 | 60 s | Per-key |
| `gokwik` | 60 | 60 s | Per-key |

Key: `connector-ratelimit:{provider}:{windowIdx}` where `windowIdx = floor(now / windowMs)`.

**Fail-open**: Redis blip → `tryAcquire` returns `true` (admit). The per-page 429 backoff inside each provider client is the second defense line. A persistent Redis outage fires its own alert.

**[RECOMMENDED — GAP]** `shiprocket` and `shopflo` are missing from `DEFAULT_PROVIDER_LIMITS`. Both have undocumented API rate limits; add conservative defaults (60/60 s) until confirmed.

### 14.7 Backoff inside provider clients [RECOMMENDED]

**[RECOMMENDED]** No platform-enforced backoff exists for 429 responses from provider APIs during repull. Each provider client (`meta-spend-repull`, `google-ads-spend-repull`, etc.) must implement per-page exponential backoff with Retry-After header respect. Recommended pattern:

```
attempt 1: wait Retry-After (or 2s default)
attempt 2: 4s
attempt 3: 8s
give up: increment connector_auth_rejected_total / connector error counter, skip this page
```

This is currently unimplemented in the repull workers found under `apps/stream-worker/src/jobs/`.

---

## 15. Error Handling: DLQ, Replay, Idempotency, Circuit Breaker

### 15.1 Dead Letter Queue — DlqProducer [EXISTS]

**File:** `apps/stream-worker/src/infrastructure/kafka/DlqProducer.ts`

After MAX_RETRY=5 failures (or immediate on invalid/quarantine):

- Publishes to `{original_topic}.dlq` (e.g., `dev.collector.event.v1.dlq`).
- Stamps three forensic headers:
  - `x-dlq-reason`: human-readable error string (never includes PII or secret values — I-S09).
  - `x-dlq-original-topic`: original topic name (used by redriver to route back).
  - `x-dlq-ts`: ISO timestamp of DLQ write.
- DLQ topic created by `redpanda-init` with 30-day retention.
- Offset committed after DLQ produce confirmed — partition advances.

**[GAP — minor]** `DlqProducer` calls `kafka.producer()` with no options. The Kafka producer is not configured with `idempotent: true`. While DLQ writes are not high-frequency, a producer restart mid-write could theoretically produce a duplicate DLQ message (harmless: `DlqRedriver` is idempotent by design, but the duplicate counts against `x-redrive-count`). Recommended: add `{ idempotent: true, transactionalId: 'brain.dlq-producer' }`.

### 15.2 DLQ Redriver — operator replay tooling [EXISTS]

**File:** `apps/stream-worker/src/infrastructure/kafka/DlqRedriver.ts`

One-shot operator tool: drains a `.dlq` topic and republishes eligible messages to their original topic.

```
DlqRedriver.redrive(dlqTopic, opts)
  for each message in dlq:
    decideRedrive(dlqTopic, headers, maxRedrive, reasonFilter)
      → 'filtered'   : reasonFilter mismatch → skip (increment filtered)
      → 'exhausted'  : x-redrive-count >= maxRedrive → leave parked (dlq_redrive_exhausted_total)
      → 'redrive'    : publish to targetTopic with bumped x-redrive-count header
```

**Loop guard:** `DEFAULT_MAX_REDRIVE = 3`. Each redrive stamps `x-redrive-count` (incremented by `buildRedriveHeaders`). A genuinely-poison message exhausts its redrive budget and stays in the DLQ; transient-failure messages flush on the first pass.

**Pure functions (testable without broker):**
- `decideRedrive(dlqTopic, headers, maxRedrive, reasonFilter): RedriveDecision`
- `buildRedriveHeaders(source, nextCount, fromDlqTopic, nowIso): IHeaders`

**Forensic header chain preserved:** `x-dlq-original-topic`, `x-dlq-reason`, `x-dlq-ts` are forwarded; `x-redrive-from` and `x-redrive-ts` added per redrive pass.

**Dry-run mode:** `opts.dryRun = true` simulates without publishing. Returns full `RedriveReport`.

**Operator metrics emitted:** `dlq_redrive_total{target_topic}`, `dlq_redrive_exhausted_total{target_topic}`, `dlq_redrive_error_total{target_topic}`.

**[RECOMMENDED]** No HTTP trigger or CLI wrapper exists yet. Operators must invoke `DlqRedriver` programmatically. Recommended: add a `pnpm dlq:redrive --topic=dev.collector.event.v1.dlq --dry-run` CLI in `apps/stream-worker/src/cli/` so on-call can run redrive without a code change.

### 15.3 Idempotency — two-layer dedup [EXISTS]

**Layer 1 — Redis fast path (RedisDedupAdapter):**
- File: `apps/stream-worker/src/infrastructure/redis/RedisDedupAdapter.ts`
- `SET key '1' NX EX {TTL}` — atomic, no GET+SET race.
- Key: built by `buildDedupKey(brandId, eventId)` from `DedupPolicy.ts` (tenant-prefixed).
- TTL: 7 days (matches Redpanda retention).
- `checkAndClaim` (write-before-claim path): returns `isFirstSight: false` for duplicates → skip Bronze write, commit offset.
- `check` + `claim` (read-then-write path, R-08): fast-path check only; claim only after durable Bronze write succeeds. Redis failure on `claim()` is swallowed (best-effort — PK dedup is the durable gate).
- **[GAP]** `RedisDedupAdapter` in `apps/stream-worker/src/infrastructure/redis/` has `keyPrefix` hardcoded to `razorpay:dedup:` in an older copy at `apps/core/src/modules/connector/sources/payment/razorpay/infrastructure/RedisDedupAdapter.ts`. This namespace collision means Razorpay dedup keys could collide with Shopflo or WooCommerce events sharing the same Redis instance if those connectors incorrectly use the razorpay-specific copy. Ensure all consumers use the shared `buildDedupKey(brandId, eventId)` from `DedupPolicy.ts` exclusively.

**Layer 2 — Postgres Bronze ON CONFLICT (durable):**
- `bronze_events` table has a composite PK on `(brand_id, event_id)`.
- All Bronze writers use `INSERT ... ON CONFLICT DO NOTHING`.
- This is the durable dedup gate. A Redis blip skipping layer 1 never causes a duplicate Bronze row.

**Event ID generation (D-6):**
- Shopify live webhooks: `uuidV5FromOrderLive(brandId, orderId, updatedAtUtcMs)` — distinct per state-change timestamp, deterministic on replay.
- Backfill orders: same UUIDv5 derivation from stable natural keys.
- UUIDv5 is deterministic: the same event processed twice always produces the same event_id → ON CONFLICT DO NOTHING absorbs replay.

### 15.4 Offset commit discipline [EXISTS]

Kafka offsets are committed only after one of:
1. Bronze write confirmed (`outcome = 'written'`).
2. Dedup hit confirmed (`outcome = 'dedup_hit'` or `'pk_conflict'`).
3. DLQ produce confirmed (after MAX_RETRY=5 or `'invalid'`).
4. Quarantine produce confirmed (`'quarantined'`).

Never committed on write error. This is enforced in `CollectorEventConsumer` via `autoCommit: false` and explicit `consumer.commitOffsets([...])` calls at each terminal branch.

### 15.5 Circuit breaker — NOT IMPLEMENTED [GAP]

**[RECOMMENDED — GAP: P1]** No circuit breaker exists anywhere in the connector platform. A prolonged downstream outage (Postgres, Iceberg, provider API) causes all consumers to retry at MAX_RETRY cadence, exhausting DLQ budgets and flooding error logs. Recommended implementation using a sliding-window half-open pattern:

```
Per (consumer group, error type):
  CLOSED → normal operation
  count(errors in 60s window) > threshold → OPEN
  OPEN: fail fast for 30s, then enter HALF_OPEN
  HALF_OPEN: allow 1 probe → success → CLOSED / failure → OPEN
```

The circuit state can be stored in Redis (same infrastructure already wired) using a key like `circuit:{scope}:{error_class}` with a 30-second TTL for the open window. An open circuit should emit `connector_circuit_open_total{scope, error_class}` and fire the `BrainConnectorDispatchErrors` alert threshold (already live at >25% error rate for 5 minutes).

### 15.6 Quarantine topic [EXISTS]

Beyond the DLQ, `CollectorEventConsumer` routes R3-failed events (consent absent, tenant unresolved) to `{topic}.quarantine` via the same `DlqProducer` (reuses the existing producer, no new topic family). Quarantine events are preserved with their full payload for consent replay once the brand configures consent.

---

## 16. Observability Design

### 16.1 Metrics — live Prometheus alert rules [EXISTS]

**File:** `infra/observe/alerts/brain-slo.rules.yml`

All alerts are grounded in actually-emitted metrics. The following table documents every live rule:

| Alert | Severity | Metric(s) | Threshold | Window | Meaning |
|---|---|---|---|---|---|
| `BrainTargetDown` | critical | `up{job=~"brain.*"}` | == 0 | 2 min | Any Brain service pod down |
| `BrainCollectorErrorBudgetFastBurn` | critical | `collector_accept_total`, `collector_spool_full_total` | 14.4× burn rate | 5 min + 1 h | Multi-window SLO burn (fast) |
| `BrainCollectorErrorBudgetSlowBurn` | warning | same | 6× burn rate | 30 min + 6 h | Multi-window SLO burn (slow) |
| `BrainCollectorSheddingNow` | critical | `collector_spool_full_total` | > 0 for 2 min | 2 min | Collector spool full → shedding |
| `BrainDlqGrowing` | warning | `redpanda_kafka_log_size_bytes{topic=~".*\.dlq"}` | increasing for 10 min | 10 min | DLQ backlog accumulating |
| `BrainConsumerLagHigh` | warning | `redpanda_kafka_consumer_group_lag{group=~"stream-worker.*\|.*-bridge"}` | > 50 000 | 5 min | Consumer falling behind |
| `BrainIngestStale` | critical | `rate(redpanda_kafka_log_size_bytes[5m])`, `rate(bronze_write_total[5m])` | topic advancing + zero Bronze writes for 10 min | 10 min | Pipeline wedged: events arriving but not written |
| `BrainIngestSchedulerOverrun` | warning | `ingest_scheduler_dispatch_total` | stalled for 5 min | 5 min | Repull scheduler not dispatching |
| `BrainConnectorDispatchErrors` | warning | connector dispatch metrics | > 25% by provider | 5 min | Provider repull failure spike |
| `BrainConnectorRateLimited` | warning | `connector_ratelimit_*` | sustained for 5 min | 5 min | Provider rate-limit ceiling hit |
| `BrainDlqRedriveExhausted` | warning | `dlq_redrive_exhausted_total` | > 0 in 10 min | 10 min | Poison messages exhausting redrive budget |
| `BrainDlqRedriveErrors` | warning | `dlq_redrive_error_total` | > 0 in 5 min | 5 min | Redrive produce errors |
| `BrainConnectorAuthRejected` | warning | `connector_auth_rejected_total{provider}` | > 0 for 10 min | 10 min | OAuth token / credential rejected by provider |
| `BrainMetaTokenRefreshFailing` | warning | `meta_token_refresh_error_total` | > 0 for 15 min | 15 min | Meta proactive token refresh failing |
| `BrainSilverLag` | warning | `dq_silver_lag_breach_total` | > 0 in 30 min | 30 min | dbt Silver build behind freshness SLO |
| `BrainRevenueOverReversal` | critical | `revenue_over_reversal_total` | > 0 in 5 min | 5 min | Revenue reversal exceeds gross (ledger integrity) |

**Alertmanager routing (existing):** `severity=critical` → PagerDuty + Slack; `severity=warning` → Slack.

### 16.2 Metrics — connector-specific gaps [RECOMMENDED]

**[RECOMMENDED — GAP]** The following metrics are referenced in the alert rules file or audit but are NOT yet emitted by the codebase:

| Metric | Source gap | Recommended emitter | Label(s) |
|---|---|---|---|
| `webhook_produce_failed_total` | No counter emitted when Kafka produce fails in `shopifyWebhookHandler` (the handler returns 500 but emits nothing) | `shopifyWebhookHandler.ts` produce catch block | `provider, topic` |
| `webhook_accepted_total` | No counter per accepted webhook | same handler, post-produce | `provider, topic` |
| `connector_sync_run_duration_seconds` | No histogram for repull run duration | `sync-request-claimer/run.ts` per dispatch | `provider` |
| `connector_backfill_pages_total` | No page counter in `shopify-backfill/run.ts` | per-page loop | `provider, brand_id` (hashed) |
| `dlq_redrive_total` | Emitted by `DlqRedriver.ts` but metric registration not verified in `@brain/observability` registry | verify `incrementCounter` registration | `target_topic` |

Add these counters/histograms via `@brain/observability`'s `incrementCounter` / `recordHistogram` (already wired in stream-worker's main.ts).

### 16.3 Traces — OTel SDK [EXISTS / GAP]

**[EXISTS]** OTel SDK is initialized in both `apps/core` and `apps/stream-worker`. Spans are emitted per request and per Kafka message. The OTel Collector pipeline is configured in `infra/observe/otel-collector.yml`.

**[EXISTS — PII redaction]** OTel Collector applies a `transform/redact_pii` processor (OTTL) before any export — drops `email`, `phone`, `phone_number`, `name`, `address`, `pan_number`, `card_number`, `cvv`, `upi_id`, and any attribute matching `.*email.*`, `.*phone.*`, `.*pan_.*`, `.*card_.*`. This is the second layer (SDK wrapper in `packages/observability/redact.ts` is the first layer).

**[GAP — P1: Spans are orphaned at Kafka boundaries]** When a webhook produces to Kafka and `CollectorEventConsumer` reads the same message, the trace context is NOT propagated through the Kafka message headers. Each side creates an independent root span. As a result, distributed traces cannot cross the webhook-to-consumer boundary.

Recommended fix:
1. In webhook handlers: extract the current OTel trace context and serialize it into a Kafka header (e.g., `traceparent`) using `@opentelemetry/api`'s `propagation.inject`.
2. In `CollectorEventConsumer.eachMessage`: extract the `traceparent` header and set it as the parent context via `propagation.extract` before creating the consumer span.

This makes the full `webhook → Kafka → consumer → Bronze write` path appear as a single trace.

**[GAP — P1: No Tempo backend]** The OTel Collector's trace pipeline exports only to the `debug` exporter (line 112 of `otel-collector.yml`). The `otlphttp/grafana` exporter is commented out. No Grafana Tempo (or equivalent) datasource is provisioned in `infra/observe/grafana/provisioning/datasources/datasources.yml` (only Prometheus + Loki). Traces are emitted but not retained.

Recommended: provision Grafana Tempo (or Grafana Cloud Traces) and uncomment/add the `otlphttp/grafana` exporter entry in `otel-collector.yml`.

### 16.4 Logs — structured logging [EXISTS]

**[EXISTS]** Both `apps/core` (Fastify/Pino) and `apps/stream-worker` use structured JSON logging. Logs are shipped to Loki via the OTel Collector `loki` exporter. PII redaction applied by OTel Collector processor (section 16.3).

**[EXISTS]** Key log fields per connector event:
- `request_id`, `correlation_id`, `brand_id` (never raw PII — MT-1).
- `event_id`, `partition`, `offset`, `topic`.
- `outcome` (written / dedup_hit / pk_conflict / invalid / quarantined / DLQ).

**Correlation ID thread:** `x-correlation-id` request header (or generated `randomUUID()`) flows through webhook handler into the `CollectorEventV1` envelope and is logged at every stage. This allows log correlation across the webhook → Kafka → consumer → Bronze write path without distributed tracing.

**[RECOMMENDED]** Add `x-correlation-id` as a Kafka message header (in addition to the envelope field) so the consumer can log it without deserializing the full envelope on error paths.

### 16.5 Dashboards — NOT provisioned [GAP]

**[EXISTS — config only]** Grafana file-based dashboard provider is declared at `infra/observe/grafana/provisioning/dashboards/dashboards.yml`.

**[GAP — P1]** No `.json` dashboard files exist under `infra/observe/grafana/provisioning/dashboards/`. Grafana has no dashboards for:
- Connector health overview (7-state per connector per brand).
- Ingest pipeline: lag, DLQ depth, Bronze write rate.
- Webhook throughput per provider.
- Repull scheduler: dispatch rate, errors per provider.
- Revenue ledger: gross, net, reversal rate.

**[RECOMMENDED]** Provision the following dashboards as Grafana JSON (committed to the repo) using the existing Prometheus + Loki datasources:

1. **brain-connector-health.json** — health_state breakdown per provider, `connector_auth_rejected_total` time series, `BrainConnectorRateLimited` gauge.
2. **brain-ingest-pipeline.json** — `bronze_write_total` rate, `redpanda_kafka_consumer_group_lag`, DLQ log size, `BrainIngestStale` indicator.
3. **brain-webhook-throughput.json** — `webhook_accepted_total`, `webhook_produce_failed_total`, p95/p99 response time (once Tempo is wired, this becomes a Trace explorer panel).
4. **brain-revenue-ledger.json** — gross revenue, net (post-settlement), reversal rate, `BrainRevenueOverReversal` alert state.

### 16.6 Observability architecture diagram

```
                    apps/core                   apps/stream-worker
                  ┌───────────────┐            ┌─────────────────────┐
Webhook/API  ───▶ │ Fastify/Pino  │            │ KafkaJS Consumer    │
                  │ OTel SDK      │            │ OTel SDK            │
                  └──────┬────────┘            └──────────┬──────────┘
                         │ OTLP gRPC                      │ OTLP gRPC
                         ▼                                ▼
                  ┌─────────────────────────────────────────────────┐
                  │               OTel Collector                     │
                  │  transform/redact_pii (PII drop, NN-6)          │
                  │  memory_limiter, batch                           │
                  └────────┬──────────────┬──────────────┬──────────┘
                           │              │              │
                     Prometheus        Loki          debug [GAP: no Tempo]
                           │              │
                      Grafana (alerts + dashboards [GAP: no .json files])
```

---

## 17. Security Design

### 17.1 Credential storage — ARN-only in Postgres (NN-2) [EXISTS]

**[EXISTS]** All connector credentials are stored as AWS Secrets Manager ARNs only. No `oauth_token`, `*_token`, `*_ciphertext`, `*_secret`, or `*_key` column exists in `connector_instance`. The column is `secret_ref` (ARN). This is enforced by:
- Migration schema (no credential-value columns).
- `ConnectShiprocketCommand.ts`, `HandleMetaOAuthCallbackCommand.ts`, `HandleGoogleAdsOAuthCallbackCommand.ts` all write only to `secret_ref`.
- `ISecretsManager` interface (`@brain/connector-secrets`) mediates all credential reads; raw values never reach Postgres.

**[EXISTS — KMS envelope encryption]** Every `CreateSecretCommand` issued for connector credentials uses:
- A per-brand CMK (Customer Managed Key) identified by `KmsKeyId`.
- Encryption context: `{ brand: brandId }` ensuring the key can only decrypt its own brand's secrets.
- Tags: `[{ Key: 'brand_id', Value: brandId }]` for cost allocation and access boundary.
- Never the AWS-managed default key.

**[GAP]** `META_APP_SECRET` and `GOOGLE_ADS_CLIENT_SECRET` are read from environment variables in the OAuth flow handlers. These are app-level credentials (not per-brand) but should also be stored in Secrets Manager to prevent exposure via environment variable leakage in process dumps or container inspection. Recommended: load them via `ISecretsManager.getAppSecret('meta_app_secret')` at startup.

**[GAP]** No `PutSecretValue` fallback: when a connector OAuth token is refreshed (Meta proactive refresh in `meta-token-refresh/run.ts`), the new token is written to Secrets Manager in staging/dev but prod write-back is not verified to complete before the old token expires. Recommended: add a verified round-trip test (write + read-back + validate) as part of the refresh job.

### 17.2 Tenant isolation — MT-1 + GUC + FORCE RLS [EXISTS]

**MT-1 invariant:** `brand_id` is ALWAYS resolved from a SECURITY DEFINER database function, never from HTTP request headers, body, or path parameters. Every webhook handler demonstrates this:

```
// shopifyWebhookHandler.ts — Step 2
SELECT connector_instance_id, brand_id, shop_domain, secret_ref
FROM resolve_connector_by_shop_domain($1)
```

The function is `SECURITY DEFINER` (runs as `brain`, bypasses FORCE RLS for the lookup) and returns the authoritative `brand_id` from `connector_instance`. The shop domain from the HTTP header is used only as a lookup key (after HMAC proof).

**GUC-before-query pattern:** Every brand-scoped DML is preceded by:
```sql
SET LOCAL app.current_brand_id = $1
```
executed inside a transaction, making the GUC transaction-local. Verified in `shopifyWebhookHandler.ts` (`archiveRawWebhook`, `touchSyncStatus`, `upsertStitchMap`).

**FORCE RLS:** Applied to `connector_instance`, `connector_sync_status`, `connector_webhook_raw_archive`, `connector_journey_stitch_map`, and all connector tables. Two-arg `current_setting('app.current_brand_id', TRUE)` fail-closed: if the GUC is not set, returns NULL → uuid cast fails → row filtered → 0 rows returned (not an error that reveals data).

**NN-1 pattern in policy:**
```sql
USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
```
The `TRUE` (missing-ok) argument is required. A single-arg call would throw if the GUC is not set — converting a missing-GUC programming error into a 500 rather than silently returning 0 rows.

### 17.3 Webhook authentication — HMAC-first [EXISTS]

Security order is immovable (NN-4 / ADR-LV-4). Implemented in all four webhook handlers:

| Handler | File | HMAC algorithm | Header |
|---|---|---|---|
| Shopify | `shopifyWebhookHandler.ts` | HMAC-SHA256, base64 | `X-Shopify-Hmac-Sha256` |
| WooCommerce | `woocommerceWebhookHandler.ts` | HMAC-SHA256, hex | `X-WC-Webhook-Signature` |
| GoKwik | (connector webhook handler) | provider-specific | provider header |
| Shopflo | (connector webhook handler) | provider-specific | provider header |

**Invariant:** HMAC validation is the FIRST operation. No DB write, no topic lookup, no event mapping happens before `timingSafeEqual` returns true. An invalid HMAC returns 401 immediately.

**`ShopifyHmac.validateWebhook`** uses Node.js `crypto.timingSafeEqual` to prevent timing attacks. `WooCommerceHmac` follows the same pattern.

### 17.4 OAuth state nonce — Redis atomic Lua GET+DEL [EXISTS]

OAuth state nonces are stored in Redis using an atomic Lua GET+DEL script (in `OAuthStateNonce.ts`). This prevents:
- State reuse (nonce deleted on first validation).
- Race conditions (atomic GET+DEL — no window between check and delete).
- CSRF (nonce is random, not guessable).

The nonce is set with a short TTL (10 minutes) at OAuth initiation and deleted at callback validation.

### 17.5 RBAC — connector operations [EXISTS / GAP]

**[EXISTS]** The `RequestConnectorSyncCommand` enforces role checks. The RBAC model for connector operations:

| Operation | Allowed roles |
|---|---|
| View connector status | `owner`, `brand_admin`, `manager`, `analyst` |
| Trigger sync (sync-now) | `owner`, `brand_admin`, `manager` |
| Trigger backfill | `owner`, `brand_admin` |
| Connect / disconnect connector | `owner`, `brand_admin` |
| View raw webhook archive | `owner`, `brand_admin` |
| Rotate webhook secret | `owner`, `brand_admin` |

**[GAP]** No HTTP route exists for `RotateWebhookSecretCommand`. Rotating Shopify webhook secret requires:
1. Generate new secret via `crypto.randomBytes(32).toString('hex')`.
2. Update the Shopify app webhook subscription via API (`PUT /admin/api/{version}/webhooks/{id}.json`).
3. Store new secret in Secrets Manager via `PutSecretValue`.
4. Return success. Old secret auto-expires (Shopify allows a grace period for in-flight webhooks). Recommended: implement `POST /api/v1/connectors/shopify/rotate-secret` with `owner | brand_admin` guard.

### 17.6 Auditing — WORM audit log [EXISTS]

**[EXISTS]** `audit_log` table with FORCE RLS is the append-only WORM audit trail (migration 0067, `DbAuditWriter`). Every connector connect/disconnect/backfill/sync operation writes an audit record with:
- `tenant_id` (brand_id), `actor_id`, `action`, `resource_type`, `resource_id`, `occurred_at`, `metadata` (jsonb, PII-free).
- Written by `brain_app` with `role: 'audit_reader'` GUC to bypass the audit_log FORCE RLS INSERT re-check (the fix landed in `db-audit-remediation` — register/login 500 was this bug).

### 17.7 PII boundary — connector mappers [EXISTS]

**[EXISTS]** PII hashing happens in the mapper layer before any event leaves the webhook handler scope. `mapOrderToEvent` (from `@brain/shopify-mapper`) applies `hashIdentifier(email, saltHex)` / `hashIdentifier(phone, saltHex)` where `saltHex` is the per-brand AES-256-GCM vault-derived salt (KMS-unwrapped DEK via `@brain/identity-core`). Raw email/phone/address never reach Kafka, Bronze, or any downstream.

**[EXISTS — three-layer PII defense:]**
1. Mapper layer: hash PII before event production.
2. OTel SDK wrapper (`packages/observability/redact.ts`): drop PII from span attributes.
3. OTel Collector `transform/redact_pii`: drop PII from all telemetry signals before export.

**I-S07 invariant:** Money is stored and transmitted as BIGINT minor units expressed as string. No `parseFloat` in mapper packages. Verified in `@brain/shopify-mapper` and `@brain/razorpay-mapper`.

### 17.8 Dev/prod secret boundary [EXISTS]

**[EXISTS]** `dev_secret` table: a `DO` block in the migration fails if `app.env = 'production'`. `LocalSecretsManager` (used in dev/test) throws if `NODE_ENV = 'production'`. The prod path always uses `AwsSecretsManager` backed by AWS Secrets Manager + KMS.

### 17.9 Security architecture diagram

```
Request (Webhook / OAuth callback / API)
         │
         ▼
  [1] HMAC-first (timingSafeEqual)           ← if invalid: 401, stop
         │
         ▼
  [2] SECURITY DEFINER fn lookup             ← brand_id from DB row only (MT-1)
         │
         ▼
  [3] SET LOCAL app.current_brand_id = $1   ← GUC txn-local
         │
         ▼
  [4] FORCE RLS (two-arg current_setting)   ← fail-closed
         │
         ▼
  [5] Write to connector table              ← WORM audit_log side-write
         │
         ▼
  [6] PII hashed at mapper layer            ← raw PII never reaches Kafka
         │
         ▼
  [7] Produce to Kafka (brand_id as key)    ← per-tenant partition isolation
         │
         ▼
  [8] Bronze ON CONFLICT DO NOTHING         ← durable dedup gate (PK)
```

---

## 18. UI Requirements

### 18.1 Marketplace — ConnectorsList + tile grid [EXISTS / GAP]

**[EXISTS]** `CONNECTOR_CATALOG` in `apps/core/src/modules/connector/catalog/registry.ts` defines 11 connector entries across 7 categories: storefront (Shopify, WooCommerce), ads (Meta, Google Ads), payments (Razorpay, GoKwik, Shopflo), logistics (Shiprocket), messaging (WhatsApp — coming_soon), crm (HubSpot — coming_soon), analytics (GA4 — coming_soon).

**[EXISTS]** `ConnectMethod` types: `'oauth'` | `'credential'` | `'coming_soon'`. Availability: `'available'` | `'coming_soon'`.

**[EXISTS]** The marketplace tile grid renders these entries with health badges and a connect CTA. Per ADR-CM-1: catalog is a static TypeScript const, not a DB table. Catalog changes are code deploys.

**[GAP]** As the catalog grows (100+ connectors is the stated scale), a flat tile grid without filtering becomes unusable. Required: category filter tabs + search-by-name input with client-side filtering. No accessibility (axe-core) audit has been run on the marketplace page.

**Recommended marketplace tile spec:**

```
┌──────────────────────────────────────────────────────────┐
│  [Search connectors...]          [Filter by category ▼]  │
├──────────────────────────────────────────────────────────┤
│  Storefront (2)   Ads (2)   Payments (3)   Logistics (1) │
│  Messaging (1)   CRM (1)   Analytics (1)                 │
├──────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐         │
│  │ [Shopify]  │  │[Meta Ads]  │  │[Razorpay]  │         │
│  │ ● Healthy  │  │ ◐ Delayed  │  │ ✗ Failed   │         │
│  │ [Connected]│  │ [Manage]   │  │ [Reconnect]│         │
│  └────────────┘  └────────────┘  └────────────┘         │
└──────────────────────────────────────────────────────────┘
```

Health badge: 7 states mapped via `HEALTH_TO_SAFETY` in `healthSafety.ts`:
- Healthy → green dot (safe)
- Delayed / RateLimited → amber dot (degraded)
- Failed / Disconnected / TokenExpired / Disabled → red dot (blocked)

### 18.2 Connect / install flows [EXISTS]

**OAuth connectors (Shopify, Meta, Google Ads):**
1. User clicks "Connect" → `InitiateMetaOAuthCommand` / `InitiateGoogleAdsOAuthCommand` / Shopify OAuth initiation.
2. Redis-atomic nonce stored (TTL 10 min).
3. User redirected to provider OAuth consent screen.
4. Provider redirects to callback (`/api/v1/connectors/{provider}/oauth/callback`).
5. `HandleMetaOAuthCallbackCommand` / `HandleGoogleAdsOAuthCallbackCommand` validates state nonce, exchanges code for token, stores token ARN in `connector_instance.secret_ref`.
6. UI receives redirect to connector detail with health=`Healthy`.

**Credential connectors (Razorpay, GoKwik, Shopflo, Shiprocket, WooCommerce):**
1. User clicks "Connect" → inline credential form rendered (API key / consumer key+secret / webhook URL).
2. `POST /api/v1/connectors/{provider}/connect` → `ConnectShiprocketCommand` / equivalent.
3. Credential stored in Secrets Manager, ARN written to `connector_instance.secret_ref`.
4. Webhook endpoint URL displayed to user for manual registration in provider dashboard.

**[RECOMMENDED]** Show the webhook URL and registration instructions inline on the credential form completion step (not just on the connector detail page). This reduces the "where do I go next" support burden.

### 18.3 Health and sync dashboard — per-connector detail page [GAP]

**[EXISTS]** `connector_sync_status` table has a single mutable row per connector with `state`, `last_sync_at`, `health_state` (7-state), `safety_rating` (3-state). The `GetPixelHealthQuery` provides a pattern for reading health.

**[GAP — P1]** No per-connector detail / run-history page exists in the frontend. Operators cannot see:
- When the last sync ran and whether it succeeded.
- A history of sync runs (start time, end time, records pulled, status).
- Which error caused a `Failed` / `Disconnected` health state.

**[GAP]** `connector_sync_status` stores only a single mutable row (no per-run history). Cannot show run history without a `connector_sync_run` table:

```sql
CREATE TABLE connector.connector_sync_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id        uuid NOT NULL REFERENCES org.brands(id),
  connector_instance_id uuid NOT NULL REFERENCES connector.connector_instance(id),
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  status          text NOT NULL CHECK (status IN ('running','success','failed','rate_limited')),
  records_pulled  integer,
  error_message   text,
  pages_fetched   integer
);
```

**Recommended per-connector detail page spec:**

```
┌──────────────────────────────────────────────────────────┐
│  < Back   Shopify — mystore.myshopify.com                 │
│           ● Healthy · Last synced: 2 minutes ago         │
├──────────────────────────────────────────────────────────┤
│  [Sync Now]           [Backfill]         [Disconnect]    │
├──────────────────────────────────────────────────────────┤
│  Sync Runs                                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │ 2026-06-22 14:30  ✓ Success  312 records  2.1s      │ │
│  │ 2026-06-22 14:00  ✓ Success  87 records   0.9s      │ │
│  │ 2026-06-22 13:30  ✗ Failed   —            rate lim  │ │
│  └─────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  Live Event Log (last 50 webhook events)                 │
│  [Loki query: {connector_instance_id="..."}]             │
└──────────────────────────────────────────────────────────┘
```

### 18.4 Sync-now control — RBAC enforcement [EXISTS / GAP]

**[EXISTS]** `RequestConnectorSyncCommand` enforces role checks before enqueuing a sync request.

**[EXISTS — RBAC matrix for sync-now]:**
- `owner` / `brand_admin` / `manager` → can trigger sync.
- `analyst` → read-only (no trigger).

**[RECOMMENDED]** The sync-now button must be conditionally rendered based on the session user's role (not just hidden — the API must also enforce). The current implementation enforces at the API layer; the UI should reflect this by disabling (not hiding) the button for `analyst` with a tooltip: "Only managers and above can trigger syncs."

**Sync-now flow:**
1. User clicks [Sync Now] → `POST /api/v1/connectors/{id}/sync` → `RequestConnectorSyncCommand`.
2. `connector_sync_status` updated: `state = 'syncing'`, `last_triggered_at = now()`.
3. UI shows spinner on the connector tile / detail page.
4. `ingest-scheduler` picks up the queued dispatch on next tick (via `claim_due_repull_connectors()`).
5. On completion: `connector_sync_status.state = 'connected'`, `health_state = 'Healthy'` (or error).
6. UI polls `/api/v1/connectors/{id}/status` (or SSE) and updates badge.

### 18.5 Backfill control [EXISTS / GAP]

**[EXISTS]** `PgBackfillJobRepository` and the backfill trigger command exist. Shopify backfill worker is implemented at `apps/stream-worker/src/jobs/shopify-backfill/run.ts`.

**[GAP]** No UI surface for backfill trigger. Recommended: Add [Backfill] button on the connector detail page, visible only to `owner` / `brand_admin`. On click:
1. Show modal: "Backfill will re-import all historical orders. This may take several minutes and will not create duplicates. Continue?"
2. `POST /api/v1/connectors/{id}/backfill` with optional `{ since: '2026-01-01' }` date picker.
3. Show progress: poll `GET /api/v1/connectors/{id}/backfill/status` and display `pages_fetched`, `records_imported`.

### 18.6 Connector logs / monitoring — raw webhook archive [EXISTS / GAP]

**[EXISTS]** `connector_webhook_raw_archive` table (migration 0050) stores structure-visible, PII-safe redacted webhook bodies with `body_sha256` dedup (ON CONFLICT DO NOTHING). Written in `shopifyWebhookHandler.ts` after HMAC + brand resolution, fire-and-forget.

**[GAP]** No UI surface reads from `connector_webhook_raw_archive`. Recommended: on the connector detail page, add a "Raw Webhooks" tab showing the last 100 entries:
- `received_at`, `topic`, `correlation_id`, link to expand `redacted_body` JSON.
- Only visible to `owner` / `brand_admin`.

**[GAP]** `connector_webhook_raw_archive` is currently unpartitioned. At high webhook volume (Shopify + WooCommerce combined), this table will grow unboundedly. Add `PARTITION BY RANGE(received_at)` with monthly partitions and a 90-day retention trigger (via the existing `partition_maintenance` job at `apps/stream-worker/src/jobs/partition-maintenance.ts`).

### 18.7 Connector health monitoring — live dashboard in Grafana [GAP]

**[RECOMMENDED — GAP: P1]** Platform-level connector health monitoring (as opposed to per-brand UI) must be visible to the SRE team in Grafana. Required panels for the `brain-connector-health.json` dashboard:

| Panel | Query | Type |
|---|---|---|
| Connectors by health_state | Count per `(provider, health_state)` from `connector_sync_status` via Postgres datasource | Bar chart |
| Auth rejections | `rate(connector_auth_rejected_total[5m])` | Time series |
| DLQ depth | `redpanda_kafka_log_size_bytes{topic=~".*\.dlq"}` | Time series |
| Consumer lag | `redpanda_kafka_consumer_group_lag{group=~"stream-worker.*"}` | Time series |
| Bronze write rate | `rate(bronze_write_total[1m])` | Time series |
| BrainIngestStale indicator | Alert state | Stat |

### 18.8 Accessibility requirements [RECOMMENDED]

**[RECOMMENDED]** No axe-core or WCAG 2.1 AA audit has been run on any connector UI surface. Required before GA:
- Health badge colors must not convey state by color alone (add icon: ●/◐/✗ + aria-label).
- Connect modal: `aria-labelledby`, `aria-describedby`, focus-trap on open, Escape closes.
- Marketplace search input: `aria-label="Search connectors"`, results region with `aria-live="polite"`.
- Sync-now / backfill confirmation dialogs: role="dialog", focus returns to trigger on close.
- Run `axe-core` in CI via `@axe-core/react` on all connector page components. Gate on 0 critical violations.

---

## Summary — Gap Priority Matrix

| ID | Gap | Severity | Deliverable |
|---|---|---|---|
| G1 | `IdentityBridgeConsumer` uses volatile in-memory retry counter | P0 critical | 14, 15 |
| G2 | Spans orphaned at Kafka boundaries (no traceparent propagation) | P1 | 16 |
| G3 | No Tempo backend — traces not retained | P1 | 16 |
| G4 | No Grafana dashboards provisioned (0 .json files) | P1 | 16, 18 |
| G5 | No circuit breaker anywhere in the connector platform | P1 | 15 |
| G6 | `webhook_produce_failed_total` and `webhook_accepted_total` not emitted | P1 | 16 |
| G7 | No per-connector detail / run-history page in frontend | P1 | 18 |
| G8 | No `connector_sync_run` table (history impossible) | P1 | 18 |
| G9 | `META_APP_SECRET` / `GOOGLE_ADS_CLIENT_SECRET` from env, not Secrets Manager | P1 | 17 |
| G10 | No `RotateWebhookSecretCommand` HTTP route | P2 | 17 |
| G11 | No backfill UI trigger | P2 | 18 |
| G12 | No raw webhook archive UI surface | P2 | 18 |
| G13 | `shiprocket` / `shopflo` missing from `DEFAULT_PROVIDER_LIMITS` | P2 | 14 |
| G14 | No exponential backoff with jitter on consumer retry | P2 | 14 |
| G15 | `DlqProducer` not idempotent (no `transactionalId`) | P3 | 15 |
| G16 | `RedisDedupAdapter` razorpay-namespaced copy (namespace collision risk) | P2 | 15 |
| G17 | `connector_webhook_raw_archive` unpartitioned | P2 | 18 |
| G18 | No axe-core a11y audit on connector UI surfaces | P2 | 18 |
| G19 | No DLQ redrive CLI (operator must invoke programmatically) | P2 | 15 |
| G20 | No Meta token refresh prod write-back verified round-trip | P2 | 17 |
