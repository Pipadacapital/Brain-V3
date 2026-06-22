# Brain Universal Real-Time Connector Platform — Gap Analysis & Roadmap

> **Authoritative design doc.** Deliverables 20–23 of the connector-platform series: Database Changes, Pipeline Changes, Gap Analysis (current vs recommended), and Future Connector Strategy. Every claim below is grounded in the verified audits, the per-app official-API research, and the **verified gap register** (each register entry was independently checked against the real repo at `/Users/rishabhporwal/Desktop/Brain V3`). Items are clearly marked **EXISTS TODAY** vs **RECOMMENDED TO BUILD**, and the register's adversarial verdicts (`already-built`, `partial`, `real-gap`) are reproduced honestly — several headline gaps turned out to be smaller, already-built, or deferred-by-design than first claimed.

- **Date:** 2026-06-22
- **Branch context:** `feat/brain-replatform` (data disposable; A–G lakehouse re-platform complete)
- **Scope:** the 9 catalogued apps (Shopify, WooCommerce, Meta Ads, Google Ads, GA4, Razorpay, Shiprocket, GoKwik, Shopflo) and the connector framework that hosts them.

---

## 0. Reading guide — verdict vocabulary

The gap register applied an adversarial re-verification pass. Each entry carries a **verdict**:

| Verdict | Meaning |
|---|---|
| `real-gap` | Confirmed absent in the repo; the fix is genuinely net-new. |
| `partial` | The claim is partly built; only a narrower slice is missing. Severity usually corrected **down**. |
| `already-built` | The claimed gap is wrong — the capability exists (often via Phase G / payments-checkout-silver work). |

**`buildable`** = the code can be written and CI-smoke-tested now without external credentials.
**`blockedBy`** = an external dependency (partner credentials, undocumented vendor API shape) gates the prod cutover or real-network smoke.

`correctedSeverity` is used throughout this doc, not the original (inflated) severity.

---

## 1. The single root gap (everything else is downstream of it)

**EXISTS TODAY:** 8 connectors, each a hand-cloned vertical slice. There is **no** `IConnector` lifecycle contract and **no** neutral shared kernel. Verified:

- `apps/core/src/modules/connector/index.ts:12` — literal comment: *"Scope note: NO IConnector/BaseConnector/plugin registry (scope-defer — §2)."*
- The canonical entities `ConnectorInstance`, `ConnectorSyncStatus`, `ConnectorCursor` and their repository interfaces live under `sources/storefront/shopify/domain/` and are imported cross-source by every other connector (gokwik, shiprocket, razorpay, shopflo, meta, google) — **Shopify is the accidental base kernel**.
- `ConnectorInstance.create()` hardcodes a `*.myshopify.com` shop-domain validation that all non-Shopify connectors bypass by passing `shopDomain: ''`.
- Header comments confirm the copy-paste pattern verbatim: `ConnectShopfloCommand.ts:2` "Clone of ConnectRazorpayCommand", `ConnectShiprocketCommand.ts:9` "Mirror of ConnectGokwikCommand".

**Already mitigated (honest):** the most operationally dangerous surface — stream-worker dispatch — is **already** a data-driven `REPULL_DISPATCH` map (not a switch), with a coverage-asserting test (`sync-request-claimer/run.ts:50`). And the DB CHECK-per-provider anti-pattern was already removed in migration `0062` (ADR-CM-1). So the corrected severity of the root gap is **medium**, not critical: no active tenant-isolation/idempotency regression exists; the cost is forward extensibility.

This is `unified-connector-contract`, and Phase 1 builds it first because every per-app item rides it.

---

## 20. Database Changes

All connector tables already enforce the platform invariants and need **no** retrofit for security. The changes below are about **scale, observability, and multi-account** — each is a forward migration with a documented rollback, additive-then-cutover (never destructive single-shot).

### 20.1 What EXISTS TODAY (do not rebuild)

| Table | Status | Evidence |
|---|---|---|
| `connectors.connector_instance` | ENABLE+FORCE RLS, two-arg fail-closed GUC, REVOKE ALL / minimal GRANT, NN-1 migration assertion; `secret_ref` is the **only** credential field (NN-2 — ARN only, no token bytes) | `0006_connector.sql:19,35,42-50,106-132` |
| `connectors.connector_sync_status` | FORCE RLS, single mutable row per connector, FK covering index | `0006:53`, `0025`, `0068:22` |
| `connectors.connector_cursor` | FORCE RLS, doubles as `sync.request` sentinel queue | `0006:82` |
| `connectors.connector_razorpay_order_map` | FORCE RLS, raw `razorpay_payment_id` for join only | `0027:104-113` |
| `connectors.connector_journey_stitch_map` | FORCE RLS, deterministic anon→brain_id stitch | `0031` |
| `connectors.connector_webhook_raw_archive` | FORCE RLS, **append-only** (SELECT+INSERT grant only), `body_sha256` dedup, PII-redacted body | `0050:26,43-76` |
| `jobs.backfill_job` | FORCE RLS, **append-only run ledger**, overlap-lock via partial index + `FOR UPDATE SKIP LOCKED` | `0022:27,53`, `0023` |
| Per-provider SECURITY DEFINER enumeration fns (7) | `search_path=public` pinned, dispatch-only return, migration-time `prosecdef`/grant assertions | `0026,0027,0029,0030,0059,0060` |
| Generic work-queue claim fn | `claim_due_repull_connectors(batch,interval)` — already **provider-agnostic** (`WHERE status='connected'`, no provider filter) | `0053:30-56` |
| Money-ledger partitioning | `realized_revenue_ledger`, `ad_spend_ledger`, `send_log`, `identity_audit`, `decision_log`, `tax_ledger`, `dq_check_result` all RANGE-partitioned + born-secure via `maintain_time_partitions()` + child-RLS lockdown | `0073-0078`, `0080`, `0084` |
| Provider de-hardcode | DB CHECK constraint **dropped** (ADR-CM-1) — a new provider is a catalog row + handler, **never** a migration | `0062:22-23` |

### 20.2 What is RECOMMENDED TO BUILD

#### (a) `connector_provider_config JSONB` on `connector_instance` — *(Phase 1c, `data-driven-provider-discovery`, corrected: medium)*

**Current:** 6 sparse nullable per-provider identifier columns added via separate migrations — `razorpay_account_id` (0027), `ad_account_id` (0029), `shopflo_merchant_id` + `gokwik_appid` (0030), `shiprocket_channel_id` (0059), `woocommerce_site_url` (0060). The 8th connector still needs a new `ADD COLUMN` + a new enumeration function.

**Recommended:**
```sql
ALTER TABLE connectors.connector_instance
  ADD COLUMN connector_provider_config JSONB NOT NULL DEFAULT '{}'::jsonb;
-- backfill the 6 fat columns into the JSONB; keep columns until all reads cut over
-- then ONE generic enumeration replaces the 7 per-provider fns:
CREATE FUNCTION connectors.list_connectors_for_repull(p_provider text)
  RETURNS TABLE(connector_instance_id uuid, brand_id uuid, provider text)
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT connector_instance_id, brand_id, provider
    FROM connectors.connector_instance
    WHERE provider = p_provider AND status = 'connected';
  $$;
```
Reversible: new column + backfill, reads switched behind a flag, old columns dropped only after parity. This permanently retires the per-provider enumerate surface that caused the silent-miss class (see 22.1 #2).

#### (b) `connector_sync_run` per-run history ledger — *(Phase 1d, `sync-run-history-ledger`, confirmed: high)*

**Current (verified real-gap):** `connector_sync_status` is **one mutable row** overwritten each run (`state`, `last_sync_at`, `last_error`). Every repull job (`shopify-repull/run.ts:362-403`, `meta-spend-repull/run.ts:272-302`, …) destructively `UPDATE`s it. No run start/end, no `records_fetched`, no error sequence, no consecutive-failure counter. `backfill_job` has a per-run ledger; the **incremental/live repull path does not**. Debugging a silent freshness regression ("connected, `last_sync_at` updated, data wrong") is currently blind.

**Recommended:**
```sql
CREATE TABLE connectors.connector_sync_run (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              uuid NOT NULL,
  connector_instance_id uuid NOT NULL,
  job_type              text NOT NULL,         -- 'live_repull' | 'backfill' | 'webhook'
  status                text NOT NULL,         -- 'running' | 'completed' | 'failed'
  records_fetched       bigint NOT NULL DEFAULT 0,
  error                 text,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
) PARTITION BY RANGE (started_at);             -- born-secure via maintain_time_partitions() (0080/0084)
-- APPEND-ONLY (no DELETE grant), ENABLE+FORCE RLS, two-arg fail-closed GUC

ALTER TABLE connectors.connector_sync_status
  ADD COLUMN consecutive_failure_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN first_failure_at timestamptz;     -- reset to 0/NULL on success; drives circuit-breaking
```

#### (c) Partition `connector_webhook_raw_archive` + new `connector_dlq_record` — *(Phase 1e, `webhook-archive-partition-dlq-pg`, confirmed: high)*

**Current (verified real-gap):** `connector_webhook_raw_archive` (0050) is the **only** un-partitioned high-cardinality append-only heap — every sibling (`identity_audit`, `decision_log`, `send_log`) was partitioned in 0075-0077; this one was missed. At 10k brands / billions of webhook events it becomes a full-table-scan heap with no retention. Separately, the DLQ is **Kafka-topic-only** (`DlqProducer.ts` has zero PG writes) — not queryable by brand/connector, gone after 30d Kafka retention.

**Recommended:**
```sql
-- mirror 0075: RANGE(received_at)-partition the archive (required before the
-- Phase-2 generic pipeline writes archive for ALL providers, not just Shopify)
CREATE TABLE connectors.connector_webhook_raw_archive_part (...) PARTITION BY RANGE (received_at);

-- new queryable, forensic, RLS-safe DLQ record (the 30d Kafka window becomes a soft re-drive window)
CREATE TABLE connectors.connector_dlq_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL, connector_instance_id uuid,
  source_topic text NOT NULL, dlq_reason text NOT NULL,
  payload_sha256 text NOT NULL, dlq_ts timestamptz NOT NULL DEFAULT now(),
  redriven_at timestamptz, status text NOT NULL DEFAULT 'pending'
) PARTITION BY RANGE (dlq_ts);                  -- FORCE RLS, born-secure
```

#### (d) Multi-account: drop `UNIQUE(brand_id, provider)` → `UNIQUE(brand_id, provider, account_key)` — *(Phase 1f, `multi-account-per-provider`, corrected: medium, confirmed real-gap)*

**Current (verified):** `0006_connector.sql:35` enforces `connector_instance_brand_provider_unique UNIQUE (brand_id, provider)`, annotated KNOWN-CM-01 and never modified across 91 migrations. The save() UPSERT keys `ON CONFLICT (brand_id, provider)`, so a brand's **second** Shopify store / Meta ad account / Razorpay account silently overwrites the first. Both OAuth callbacks take only the first account (`HandleMetaOAuthCallbackCommand.ts:239` → `data.data?.[0]`; `HandleGoogleAdsOAuthCallbackCommand.ts:219` → `resourceNames?.[0]`).

**Recommended:**
```sql
ALTER TABLE connectors.connector_instance
  DROP CONSTRAINT connector_instance_brand_provider_unique,
  ADD COLUMN account_key text NOT NULL DEFAULT '__single__',  -- sentinel for single-account
  ADD CONSTRAINT connector_instance_brand_provider_account_unique
    UNIQUE (brand_id, provider, account_key);
```
Gated behind a backfill that sets `account_key='__single__'` for all existing rows **before** the constraint flip. Meta/Google callbacks must enumerate **all** accessible accounts.

### 20.3 Index / partitioning summary

| Concern | Action | Phase |
|---|---|---|
| `connector_provider_config` GIN (if JSONB key lookups grow) | optional, add when needed | 1c |
| `connector_sync_run` RANGE(started_at) + child RLS lockdown | new | 1d |
| `connector_webhook_raw_archive` RANGE(received_at) | retrofit (mirror 0075) | 1e |
| `connector_dlq_record` RANGE(dlq_ts) + FORCE RLS | new | 1e |
| `connector_cursor(brand_id, updated_at DESC)` | low-priority freshness index (register low-sev item) | deferred |

---

## 21. Pipeline Changes

### 21.1 What EXISTS TODAY (single-pipeline mandate holds)

- **All** producers (pixel collector, 4 webhook handlers, 8 repull/backfill jobs) emit to Kafka **before** any Bronze write — no raw-event bypass. Live topic `{env}.collector.event.v1`; backfill topic isolated.
- **All** consumers `autoCommit=false`, offset-after-write (D-7), durable Redis retry counter, DLQ routing.
- Spark→Iceberg Bronze sink is a true second consumer of the same live topic (not a bypass); PG Bronze retired.
- `REPULL_DISPATCH` is a declarative provider→`run()` map with a coverage test.
- Partition key is `brand_id:event_id` everywhere (per-tenant ordering).

### 21.2 Conformance defects — RECOMMENDED FIX (Phase 0, `single-pipeline-idempotency-conformance`, confirmed: high)

Three verified defects against the **no-event-loss** invariant:

1. **Producer idempotency off.** `apps/collector/src/infrastructure/kafka-producer.ts:51` explicitly `idempotent: false`; all 8 repull/backfill jobs + `DlqProducer.ts:18` call `kafka.producer()` with no options. **Fix:** `idempotent: true` + `acks: -1` on every KafkaJS producer. A broker retry can otherwise duplicate high-value ledger events.
2. **`IdentityBridgeConsumer` uses a volatile in-memory `Map` retry counter** (`IdentityBridgeConsumer.ts:28`), not the durable Redis `RetryCounterAdapter` that `ConsentSuppressor`/`Backfill` consumers receive (`main.ts:259` omits the 5th arg). A pod restart resets the count; a poison identity event can wedge the partition. **Fix:** inject `retryCounter`.
3. **Backfill topic name mismatch.** `docker-compose.yml:226` creates `dev.collector.event.v1.backfill`; code consumes `dev.collector.order.backfill.v1` (`main.ts:121`, `ORDER_BACKFILL_V1_TOPIC_SUFFIX`). Dev relies on implicit auto-create. **Fix:** correct the `rpk topic create` line.

Plus add **full jitter** to all vendor-API exponential backoffs (Meta/Google/Kafka) to break synchronized thundering-herd at scale.

### 21.3 Dispatch silent-miss — RECOMMENDED FIX (Phase 0, `shiprocket-woocommerce-never-dispatched`, corrected: medium)

**Verified:** `enumerateConnectedConnectors` (`sync-request-claimer/run.ts:99-133`) enumerates only shopify/razorpay/ads/gokwik. **Honest correction:** the **scheduled** ingest path (`ingest-scheduler` → `claim_due_repull_connectors`) is provider-agnostic and DOES poll Shiprocket + WooCommerce. Only the **Sync-Now (on-demand)** button silently no-ops for those two. **Fix:** two mirror-of-gokwik query blocks calling `list_shiprocket_connectors_for_repull()` (0059) and `list_woocommerce_connectors_for_repull()` (0060) — functions + grants already exist, **no migration** — plus a coverage test asserting every `REPULL_DISPATCH` key is reachable from the enumerate path (kills the silent-miss class).

### 21.4 Generic webhook pipeline — RECOMMENDED BUILD (Phase 2a, `generic-webhook-pipeline`, corrected: medium)

**Current:** 4 bespoke handlers (Shopify 453 / Razorpay 474 / Shopflo 407 / WooCommerce 290 LOC) + 4 HMAC VOs. Verified drift: Shopify lacks the replay-window age gate the others have; raw-archive is Shopify-only; `RedisDedupAdapter.ts:27` hardcodes `keyPrefix='razorpay:dedup:'` so Shopflo + WooCommerce collide in that namespace; no OTel span per handler; no `webhook_produce_failed_total`; no per-path rate limit.

**Recommended:** a `WebhookPipeline` (Template-Method) running the common steps (raw-body → HMAC verify → replay/dedup → brand resolve → idempotent Kafka produce → raw-archive → sync_status touch), delegating only signature-verify + payload-map to a per-provider Strategy. One `HmacConfig` primitive parameterized by `(header, algorithm, encoding)` replaces 4 VOs (Shopify base64, Razorpay hex, WooCommerce base64). Generalize raw-archive to all providers (writes to the now-partitioned table from 20.2c), provider-scope the dedup prefix, add `webhook_produce_failed_total` + `startSpan('webhook.ingest')` + per-IP sliding-window rate limit on `/api/v1/webhooks/*`.

### 21.5 Health-state operational transitions — RECOMMENDED FIX (Phase 2b, `health-state-operational-transitions`, corrected: medium)

**Honest correction:** `recordConnectorAuthRejected` and the `connector_auth_rejected_total` counter **are** wired in all four repull jobs (shopify-repull:239, meta:158+208, google:157+185, shiprocket:177) — the claim they were missing for Shopify/Shiprocket is **false**. The **real** gap: `connector_instance.health_state` is never flipped to `TokenExpired`/`RateLimited` — repull auth branches only call `setSyncState()` (writes `connector_sync_status`), so the BFF foundation-health gate (`bff.routes.ts:186,215`) reads stale `Healthy` on an expired token. **Fix:** add `markTokenExpired()`/`markRateLimited()` to the `ConnectorInstance` entity (mirror `markError()`), call a shared `updateConnectorInstanceHealth` helper from each repull's auth/rate-limit branch via the unified `IConnector.health()` hook; threshold transitions read `consecutive_failure_count` from 20.2b.

### 21.6 Observability — RECOMMENDED BUILD (Phase 2c, `observability-trace-and-circuit-breaker`, corrected: low)

**Honest corrections:** an OTel Collector, Grafana, Loki, Prometheus **are** provisioned (`docker-compose` `observe` profile); the `correlation_id` Kafka header **is** written by the collector and survives in the event body + logs. **Real gaps:** (a) consumers never `propagation.extract()` the header into a span (spans orphaned at topic boundaries); (b) **no Tempo** datasource — traces export to `debug` only; (c) **no circuit breaker / deadline** on vendor clients — `ingest-scheduler/run.ts:79-111` `await run(...)` has no timeout, so one hung Meta/Google call stalls the tick (the `inFlight` guard prevents re-entry, so it degrades rather than cascades — hence low); (d) **no Grafana dashboard JSON** files. **Fix:** `propagation.extract()` in each consumer; wire Tempo; wrap each vendor client in an Open/HalfOpen/Closed breaker with a `Promise.race` deadline as an `IConnector.sync()` base guarantee; author Ingest-Health / Connector-Health / Revenue-Integrity dashboards + the `BrainWebhookProduceFailing` alert.

### 21.7 Per-app pipeline adds (Phase 3)

| Item | Pipeline change |
|---|---|
| `connector-pre-hashed-identity` (high) | Secondary extraction block in `ResolveIdentityUseCase.execute()` reads `hashed_customer_email`/`hashed_customer_phone`/`customer_email_hash` as already-hashed `tier='strong'` identifiers (skip re-hash). Closes the multi-connector brain_id stitch hole for Shopify/WooCommerce/Shopflo order+checkout events. |
| `shopify-compliance-token-lifecycle` (high) | 3 GDPR webhook handlers (redact → existing `erase_customer` SECURITY DEFINER path) + `app/uninstalled` (invalidate secret → Disconnected) + a Shopify token-refresh job (prepares for the 2026-04-01 / 2027-01-01 expiring-offline-token mandate). |
| `razorpay-event-coverage-disputes-refunds` (medium) | Extend the Razorpay Strategy/mapper to ingest `refund.processed/failed`, full `payment.dispute.*` (dispute.lost = revenue reversal), `order.paid`, `payment.authorized` into `settlement.live.v1` with entity_type discriminators; old-secret grace window on rotation. |
| `meta-async-insights-throttle` (medium) | Async `ad_report_run` path + sync fallback; add throttle code **80000** (Ads Insights, currently catches only 80004) + platform code 4; parse `X-Business-Use-Case-Usage`/`X-App-Usage` and honor `estimated_time_to_regain_access`; centralize triplicated `GRAPH_API_VERSION`. |
| `woocommerce-onboarding-backfill-resilience` (corrected: **low**) | Add the missing `woocommerce` case to `credentialFieldsFor` (`marketplace-view.tsx:218` currently falls through to `RAZORPAY_FIELDS` → UI connect fails); 429/5xx retry-backoff in `WooCommerceClient`; configurable backfill depth; webhook auto-registration + capability probe. |
| `feature-materialization-scheduling-eval-gate` (medium) | Wire `feature-materialization` into a declared Argo CronWorkflow + Redis TTL (~25-26h) + `last_materialized_at` sentinel + freshness alarm; enforce an eval-metrics baseline in `promote-model.ts` before production promotion; author + mount `litellm.config.yaml` per-tenant `virtual_key max_budget`. |

---

## 22. Gap Analysis — current vs recommended

### 22.0 Verified gap register

| # | id | title | sev (corrected) | verdict | buildable | blocker |
|---|---|---|---|---|---|---|
| 1 | `unified-connector-contract` | No IConnector contract / neutral kernel / factory | medium | partial | yes | — |
| 2 | `shiprocket-woocommerce-never-dispatched` | Shiprocket/Woo absent from on-demand enumerate | medium | partial | yes | — |
| 3 | `data-driven-provider-discovery` | Per-provider enumerate + fat-column non-scaling | medium | partial | yes | — |
| 4 | `multi-account-per-provider` | UNIQUE(brand,provider) blocks 2 stores/accounts | medium | real-gap | yes | — |
| 5 | `generic-webhook-pipeline` | 4 bespoke handlers + drift | medium | partial | yes | — |
| 6 | `shared-mapper-contract` | No IMapper<TRaw,TCanonical> | medium | real-gap | yes | — |
| 7 | `sync-run-history-ledger` | No per-run history; single mutable row | **high** | real-gap | yes | — |
| 8 | `health-state-operational-transitions` | health_state never flips Expired/RateLimited | medium | partial | yes | — |
| 9 | `shopify-compliance-token-lifecycle` | Missing GDPR webhooks + app/uninstalled + token refresh | **high** | real-gap | yes | — |
| 10 | `ga4-connector-build` | GA4 catalog-only, zero code | medium | real-gap | **no** | live GA4 property creds |
| 11 | `connector-pre-hashed-identity` | Pre-hashed email/phone not consumed | **high** | real-gap | yes | — |
| 12 | `single-pipeline-idempotency-conformance` | Producer idempotency off; IdentityBridge no durable counter; topic mismatch | **high** | real-gap | yes | — |
| 13 | `secrets-prod-rotation-app-secrets` | App secrets in env; meta refresh no prod seam; storeSecret throws on reconnect; rotate route unwired | **high** | real-gap | yes | — |
| 14 | `webhook-archive-partition-dlq-pg` | Archive unpartitioned; DLQ Kafka-only | **high** | real-gap | yes | — |
| 15 | `meta-async-insights-throttle` | Sync-only Insights; wrong BUC code; header-blind | medium | real-gap | yes | — |
| 16 | `silver-settlement-entity` | No Silver settlement mart | **low** | **already-built** | yes | — |
| 17 | `razorpay-event-coverage-disputes-refunds` | Disputes/settled-refunds unhandled | medium | real-gap | yes | — |
| 18 | `woocommerce-onboarding-backfill-resilience` | UI field bug, no retry, fixed depth | **low** | partial | yes | — |
| 19 | `observability-trace-and-circuit-breaker` | Trace stitch break; no Tempo; no breaker; no dashboards | **low** | partial | yes | — |
| 20 | `shiprocket-gokwik-live-clients-webhooks` | Live clients synthetic; no Shiprocket webhook; GoKwik checkout unimpl | low | partial | **no** | partner creds + undocumented APIs |
| 21 | `feature-materialization-scheduling-eval-gate` | No scheduler/TTL; no eval baseline; no litellm cap | medium | real-gap | partial | litellm config authoring |

### 22.1 Missing / partial — by category

**Missing services:** *None.* The connector platform correctly lives inside `core` (connect/webhook/contract) + `stream-worker` (sync/backfill). No new service is warranted — adding one would violate the locked topology (an ADR-gated decision, and none is needed here).

**Missing/changed tables:** `connector_provider_config` JSONB (20.2a), `connector_sync_run` (20.2b), `connector_webhook_raw_archive` partitioning (20.2c), `connector_dlq_record` (20.2c), `account_key` + new UNIQUE (20.2d). All additive-then-cutover.

**Missing APIs / contracts:**
- `IConnector` lifecycle interface + `ConnectorFactory` + neutral `@brain/connector-core` kernel (gap 1).
- `IMapper<TRaw, TCanonicalEvent>` + `CanonicalEvent` (gap 6) — verified real: no `@brain/connector-core` package exists; `hashToUuidShaped` is copy-pasted verbatim into all 7 mapper packages (flagged "IDENTICAL").
- `POST /api/v1/connectors/razorpay/:id/rotate-webhook-secret` — `RotateWebhookSecretCommand` exists but is wired to **no route** (gap 13).
- `ISecretsManager.updateSecret` / `PutSecretValue` — `AwsSecretsManager.storeSecret` only calls `CreateSecretCommand` (verified, lines 77,151) → throws `ResourceExistsException` on reconnect + on webhook-secret rotation (gap 13).
- GA4 OAuth/Data-API client + `ga4.session.v1` event + `ga4-mapper` (gap 10) — buildable but smoke-blocked on live GA4 creds.

**Missing pipelines / jobs:**
- Generic webhook pipeline (gap 5), async Meta Insights (gap 15), Shopify token-refresh job (gap 9), GA4 repull (gap 10), DLQ-record write path (gap 14), feature-materialization Argo cron (gap 21).
- **Silent-miss class** (gap 2): on-demand enumerate omits Shiprocket/WooCommerce. (Scheduled path works — honest.)

**Missing observability:**
- Kafka-boundary trace stitch + Tempo backend + vendor circuit breaker + Grafana dashboards (gap 19, corrected low).
- `health_state` operational transitions feeding the foundation-health tier (gap 8).

**Missing UI:**
- Per-connector detail page `/settings/connectors/[id]` with run-history/error-timeline (rides gap 7). Verified absent (`settings/connectors/` has only `page.tsx` + `shopify/`).
- WooCommerce credential form case (gap 18) — `marketplace-view.tsx:218` falls through to Razorpay fields, so UI connect fails today.
- Per-instance multi-account tiles + Razorpay rotate-secret admin action (gaps 4, 13).
- GA4 tile connect flow (flip `coming_soon`, gap 10).

**Missing schemas (events):**
- `ga4.session.v1` (gap 10). Razorpay event-type **additions** within `settlement.live.v1` (gap 17, non-breaking). Everything else is a compile-time TS interface (`IConnector`/`IMapper`), not an Avro/proto change — additive per api-discipline.

### 22.2 Honest "already-built" callouts (do NOT rebuild)

- **`silver-settlement-entity` (gap 16) — already-built / deliberately deferred.** `computeSettlementSummary` (`packages/metric-engine/src/settlement-summary.ts:108-120`) reads `brain_gold.gold_revenue_ledger` via `withSilverBrand`, **not** PG. `gold_revenue_ledger.sql:46` defaults `ledger_source='iceberg'`. The real payments-Silver gap (`silver_checkout_signal`) is **already MERGED** (PR #211). A `silver_settlement` mart would have **zero readers** = speculative scaffolding (documented deferral in `payments-checkout-silver.md`). Corrected to **low**.
- **DB CHECK-per-provider** — already removed (0062).
- **Stream-worker dispatch** — already a data-driven map (`REPULL_DISPATCH`).
- **`connector_auth_rejected_total`** — already wired in all four repull jobs (refutes part of gap 8).
- **Scheduled ingestion of Shiprocket/WooCommerce** — already works (refutes part of gap 2).
- **Shiprocket live HTTP poll client** — already built + env-gated (`NODE_ENV=production || SHIPROCKET_LIVE=1`); refutes part of gap 20.

### 22.3 Deferred (externally blocked)

| id | What's buildable now | What's blocked |
|---|---|---|
| `ga4-connector-build` | All source (OAuth/SA connect, `ga4-repull` runReport poll, `ga4-mapper`, `ga4.session.v1`) on the Phase-1 contract following the `google-ads-spend-repull` pattern | Real-network smoke + prod-sim need a live GA4 property credential (GCP OAuth client OR service-account JSON, `analytics.readonly`). GA4 is **supplementary** web-analytics, **not** a revenue SoR — low product risk to defer. |
| `shiprocket-gokwik-live-clients-webhooks` | Shiprocket tracking-webhook receiver (pattern established by the 4 existing handlers); GoKwik RTO-Predict checkout seam draftable | Shiprocket `x-api-key` token value + shipments-list endpoint/field confirmation need a live account; GoKwik AWB live client + checkout RTO-Predict blocked on partner credentials + undocumented read API. |
| `feature-materialization-scheduling-eval-gate` (partial) | Argo cron + Redis TTL + freshness alarm + eval-baseline guard in `promote-model.ts` all buildable now | `litellm.config.yaml` per-tenant `virtual_key` provisioning must be authored + mounted (no external creds for dev). |

---

## 23. Future Connector Strategy — adding connector #10 … #100 with zero core changes

The Phase-1 foundation converts every connector from an **8-edit-point vertical clone** into a **mechanical 1x extension**. After Phases 1–2, adding a connector is:

### 23.1 The connector-addition checklist (target state)

```
1. Catalog entry         → CONNECTOR_CATALOG (registry.ts): id, category, connectMethod, availability
2. IConnector impl       → implement authenticate/validate/connect/sync/backfill/webhook/health/disconnect
                           (inherits tenant-isolation, idempotency, secret-handling, run-history,
                            health transitions, circuit-breaker from the base)
3. IMapper impl          → raw → CanonicalEvent (money-minor-units I-S07 + PII-hash I-S02 + provenance
                            are COMPILE-TIME obligations of the IMapper type; shared hashToUuidShaped)
4. Webhook Strategy       → (if inbound) one signature-verify + one payload-map; the WebhookPipeline
                            supplies raw-body/replay/dedup/brand-resolve/produce/archive/rate-limit/trace
5. REPULL_DISPATCH entry  → one line (if scheduled)
6. provider_config JSONB  → write provider-specific identifiers (NO new column, NO new enumerate fn)
```

**No DB migration. No new SECURITY DEFINER function. No new fat column. No edit to `enumerateConnectedConnectors`.** Discovery is data-driven (20.2a); enumeration is the single generic function; dispatch is the declarative map; the contract supplies all cross-cutting concerns.

### 23.2 Why each Phase-1/2 piece is a 1x-enabler

| Foundation piece | What a new connector inherits for free |
|---|---|
| `IConnector` + `ConnectorFactory` (gap 1) | Lifecycle, tenant isolation, secret-ARN-only storage, idempotency — no copy-paste |
| `@brain/connector-core` neutral kernel | `ConnectorInstance`/`SyncStatus`/`Cursor` with **no** Shopify-specific validation; no accidental base |
| `IMapper<TRaw,TCanonical>` (gap 6) | Compile-time guarantee the new mapper emits canonical Bronze (no silent wrong-shape) |
| `connector_provider_config` + generic enumerate (20.2a) | Discovery without a migration or a new SQL fn |
| `connector_sync_run` + `health()` hook (20.2b, gap 8) | Run-level observability + degraded/expired/rate-limited states uniformly, can't be forgotten |
| `WebhookPipeline` (gap 5) | Replay/dedup/archive/rate-limit/trace inherited; only verify+map are per-provider |
| Circuit breaker on `sync()` (gap 19) | A hung vendor call can't stall the scheduler |
| Multi-account `account_key` (gap 4) | Two stores / two ad accounts modeled by the same triple-key |
| Idempotent producers (gap 12) | No duplicate-storm, no poison-wedge — base guarantees |

### 23.3 Downstream analytics get the connector for free

Because every connector emits **canonical Bronze** (enforced by `IMapper`), a new source flows into Silver entity marts (orders, customers, shipments, touchpoints, marketing-spend, checkout-signals), identity resolution (pre-hashed identifiers, gap 11), attribution, and the feature store **with zero downstream code**. Health/safety uniformity (gap 8) feeds the recommendation confidence gate. This is the structural reason a usage-based connector catalog can scale to 100+ without Nx engineering cost.

### 23.4 What still needs human/partner work per connector

The contract removes the *engineering* 1x→Nx tax, **not** the per-vendor reality:
- **Auth specifics** — OAuth app registration, developer tokens, App Review (Meta `ads_read`, Google Ads Basic/Standard tier, Shopify App Store compliance webhooks).
- **Undocumented API shapes** — GoKwik AWB read, Shiprocket tracking webhook payload keys (confirm against a live account).
- **Vendor quirks** — Meta sync→async Insights at scale, Razorpay recon-as-revenue-truth, WooCommerce host fragility, GA4 token-cost quotas.

These are captured in the per-app official-API research and remain per-connector judgment, but they no longer cost a framework rewrite.

---

## Implementation Plan (phased)

### Phase 0 — Stop the bleeding *(no-event-loss + silent-miss quick wins; pure-code, S/M, reversible)*

| id | sev | verdict | change |
|---|---|---|---|
| `single-pipeline-idempotency-conformance` | high | real-gap | producer `idempotent:true`+`acks:-1`; durable Redis counter into `IdentityBridgeConsumer`; fix backfill topic name; jitter |
| `shiprocket-woocommerce-never-dispatched` | medium | partial | 2 enumerate query blocks + coverage test (no migration) |
| `secrets-prod-rotation-app-secrets` | high | real-gap | wire rotate route (RBAC+audit); idempotent `storeSecret` (PutSecretValue fallback); app-secrets→ARN + crash-fail Zod; meta token-refresh prod write-back seam; Meta `fb_exchange_token`→POST body |

**Risk:** Low — all additive or behind existing seams; per-service canary + auto-rollback (collector, stream-worker, core).

### Phase 1 — Connector platform foundation *(contract + kernel + DB model)*

Order: **1a** `unified-connector-contract` (extract `@brain/connector-core`, define `IConnector` + factory, re-point imports) → **1b** `shared-mapper-contract` (`IMapper`, extract `hashToUuidShaped`) → **1c** `data-driven-provider-discovery` (`connector_provider_config` JSONB + generic enumerate) → **1d** `sync-run-history-ledger` → **1e** `webhook-archive-partition-dlq-pg` → **1f** `multi-account-per-provider`.

**Risk:** Medium — kernel extraction touches ~12 cross-source import sites + 7 connect commands; staged (kernel package with re-exports → re-point per source → delete re-exports), each step compiling. Migrations additive-then-cutover; multi-account UNIQUE swap gated behind an `account_key` backfill. Always-on live-suite + drift-guard + per-service canary.

### Phase 2 — Pipeline hardening on the foundation

| id | sev | change |
|---|---|---|
| `generic-webhook-pipeline` | medium | Template-Method pipeline + `HmacConfig`; fix Shopify replay gate, dedup-prefix collision, generalize archive, add metric+span+rate-limit |
| `health-state-operational-transitions` | medium | `markTokenExpired/markRateLimited` via `IConnector.health()`; fixes stale foundation-health tier |
| `observability-trace-and-circuit-breaker` | low | `propagation.extract()` in consumers; Tempo; vendor circuit breaker + deadline; Grafana dashboards |

**Risk:** Medium — webhook refactor migrates provider-by-provider behind the pipeline with the old handler as fallback until each cutover passes a real-network webhook smoke; circuit-breaker is fail-fast-safe.

### Phase 3 — Per-app coverage + AI-platform gates *(buildable, no external creds)*

`connector-pre-hashed-identity` (high) · `shopify-compliance-token-lifecycle` (high) · `razorpay-event-coverage-disputes-refunds` (medium) · `meta-async-insights-throttle` (medium) · `woocommerce-onboarding-backfill-resilience` (low) · `feature-materialization-scheduling-eval-gate` (medium).

**Risk:** Low–Medium — each is an additive Strategy/mapper/handler on the Phase-2 pipeline; failure isolated to one provider. eval-gate is fail-safe (only blocks bad promotions).

### Quick wins

1. `single-pipeline-idempotency-conformance` — 3 config/code conformance fixes, S, immediately reversible.
2. `shiprocket-woocommerce-never-dispatched` — 2 mirror-of-gokwik blocks + coverage test, no migration, S.
3. `connector-pre-hashed-identity` — single additive extraction block, no schema change, M, high leverage (LTV/CAC attribution).
4. Secrets rotate-route + idempotent `storeSecret` — unblocks prod reconnect + webhook-secret rotation, M.

### Deferred (externally blocked)

- `ga4-connector-build` — draft on the Phase-1 contract; gate smoke/merge on live GA4 credentials.
- `shiprocket-gokwik-live-clients-webhooks` — build the Shiprocket webhook handler + GoKwik checkout seam against the contract; gate prod cutover + field-confirmation on partner access.

---

## Appendix — invariant conformance (all preserved by this plan)

| Invariant | How the plan upholds it |
|---|---|
| Tenant isolation at every layer | FORCE RLS + two-arg fail-closed GUC on all new tables (`connector_sync_run`, `connector_dlq_record`, partitioned archive); brand_id from DB row / state-nonce, never payload |
| No event loss | Phase 0 idempotent producers + durable retry counter + DLQ-record persistence |
| Bronze is SoR / single pipeline | All new sources emit canonical Bronze via Kafka before any write; `IMapper` enforces shape |
| Money as minor units + currency | `IMapper` makes I-S07 a compile-time obligation |
| Deterministic-first / cost-routing | Connectors are deterministic logic; only the AI-platform gate (Phase 3f) touches model spend (per-tenant cap) |
| Replay/backfill/dedup/retry | Deterministic `uuidV5` event_ids + Bronze `ON CONFLICT DO NOTHING` retained; run-history enables forensic replay |
| Contract-defined interfaces | `IConnector` + `IMapper` are the additive TS contracts; protos/event schemas only gain additive `settlement.live.v1` entity-types + new `ga4.session.v1` |
