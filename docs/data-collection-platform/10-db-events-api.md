# Data Collection Platform — D10/D11/D12: Database, Events & Contracts, API

**Cluster:** `10-db-events-api`
**Status:** Design (alignment-against-existing). **Date:** 2026-06-18.
**Author posture:** Architect / skeptical review board. Every line is classified against the shipped repo. **No new deployables, no new topics, no new envelope, no new RLS pattern, no new secrets store.** Additions are proposed ONLY where a canon-mandated capability has zero code and an existing seam can carry it.

**Source-of-truth read before asserting:** `db/migrations/0001–0027`, `.engineering-os/knowledge-base/{INVARIANTS,COMPLIANCE,METRICS,HLD}.md`, `docs/requirements/{06,07,08}`, `packages/contracts/src/**`, `infra/kafka/schemas/collector.event.v1.avsc`, `apps/collector/src/interfaces/rest/collect.route.ts`, `apps/core/src/modules/connector/pixel/interfaces/http/pixelRoutes.ts`, `apps/core/src/modules/frontend-api/internal/bff.routes.ts`.

**Legend:** **Present** = shipped, cite file. **Equivalent** = a seam exists that must be reused/extended (not duplicated). **Missing** = canon-mandated, zero code, build by extending a named seam. **Raw-Only** = lands raw in Bronze by design, do not model at the edge. **Reject** = would drift/duplicate; do not build.

---

## The one cross-cutting decision that governs all three sections

There are **two coexisting collector envelope shapes** and they must be **reconciled, never forked** (this is the highest-risk decision in the cluster — see §Summary):

- **Shape (a) — Zod `CollectorEventV1Schema`** (`packages/contracts/src/events/sample.collector.event.v1.ts`): `event_name` + ISO-8601 string `occurred_at`/`ingested_at` + `schema_version: '1'`. This is the **field-level source of truth** for naming/typing.
- **Shape (b) — Avro `collector.event.v1.avsc` + `bronze_events` + the fixture** (`infra/kafka/schemas/collector.event.v1.avsc`, `db/migrations/0016_bronze_events.sql`, `tools/pixel-fixture/send-event.mjs`): `event_type` + `timestamp-millis long` `occurred_at`/`ingested_at` + `schema_name`/`schema_version int` + `payload` as a **JSON string**. This is the **on-the-wire shape** that the BronzeRepository already consumes.

**Ruling (binds D11 + the SDK):** the SDK and every new event ride **shape (b) on the wire** (it is what Bronze parses today); the Zod schema in shape (a) stays the field-name/type authority and must be brought into byte-alignment with the Avro on the next additive contract change (rename Zod `event_name`→add `event_type`, `occurred_at` string→accept millis at the SDK boundary). Forking a second envelope to "fix" this is a **Reject** (I-E01, single-source contract, doc-07 §4). This reconciliation is additive-optional (FULL_TRANSITIVE) and is the only contract change the SDK strictly requires.

---

# D10 — Database & Canonical Model Alignment

The canonical model is **30 tables across `0001–0027`** (confirmed via the full `CREATE TABLE` list). Security/isolation primitives are mature. The genuine DB gaps are all in the **privacy/consent/erasure** and **data-quality grading** lanes — all canon-specified table-name-for-table-name in `COMPLIANCE.md` / `INVARIANTS.md` / `METRICS.md`, and all fillable by **extending** existing seams.

## D10.1 Present (shipped — do not touch)

| Capability | Table / file | Invariant |
|---|---|---|
| Accept-before-validate spool (no RLS by design) | `collector_spool` — `db/migrations/0015_collector_spool.sql` | I-ST02 |
| Bronze SoR, append-only by GRANT, `(brand_id,event_id)` PK | `bronze_events` — `0016` | I-S01, I-E02, I-ST04 |
| Identity graph (customer/identity_link/merge_event/alias/shared_utility/contact_pii/identity_audit) | `0017` | I-S01, I-S02 |
| Realized-revenue ledger, signed append-only, minor-units, single-currency trigger | `realized_revenue_ledger` — `0018`, `0027` | I-S07, I-E02 |
| Connector framework (instance/cursor/sync_status), `secret_ref`-only | `0006`, `0021`, `0025` | I-S09 |
| Backfill job progress (resumable, overlap-lock, append-by-grant) | `backfill_job` — `0022` | I-ST04 |
| SECURITY DEFINER enumeration fns (dispatch-only, `search_path` pinned) | `0026`, `0027` | I-S01 |
| Razorpay two-hop order map (RLS, raw payment-id internal-join-only) | `connector_razorpay_order_map` — `0027` | I-S02, C1 |
| Hash-chained append-only audit log (RLS-disabled cross-brand SoR) | `audit_log` — `0001` | I-S06 |
| Per-brand crypto-shred substrate (KMS-wrapped DEK, `is_active` toggle) | `brand_keyring` — `0001` | I-S05, I-S09 |
| Pixel installation/status (public `install_token`, RLS FORCE) | `pixel_installation` / `pixel_status` — `0007` | I-S01 |
| Per-brand salt ciphertext (hard-crash on miss) | `brand.identity_salt_ciphertext` — `0017` | I-S02 |
| RLS-FORCE + NN-1 two-arg fail-closed on **every** brand table + migration-time assertion | all brand tables | I-S01 |

## D10.2 Equivalent (reuse the seam — duplication = Reject)

| Need | Existing seam to extend | Note |
|---|---|---|
| Consent capture | `customer.ai_processing_consent` + `customer.resolution_consent` booleans (`0017`) | Coarse two-flag stand-in. **Do not retrofit these into a parallel scheme** — extend toward the canon `consent_record`/`consent_tombstone` (D10.3). |
| Anonymous-id binding | `customer.anonymous_id TEXT` + `customer.lifecycle_state='anonymous'` (`0017`) | Schema present, resolver never reads it. The cart-stitch + journey foundation writes here — no new id column (Reject net-new `session_id`/`device_id` authority). |
| Cart→order stitch precedent | `connector_razorpay_order_map` (`0027`) RLS + replay-upsert discipline | Mirror its shape for the stitch projection; it is the precedent, not a substitute. |
| Data-quality module | empty `apps/core/src/modules/data-quality/index.ts` (`export {}`) + Zod stubs `packages/contracts/src/dq/index.ts` | Extend this shell + stream-worker consumer pattern — **Reject a new DQ deployable.** |
| Erasure state | `customer.lifecycle_state='erased'` + `identity_audit.action='erase'` (`0017`) | State seam exists; orchestration does not (D10.3). |
| Prod PII vault path | `contact_pii.pii_value` (plaintext dev) → `pii_ciphertext` (prod KMS) | Documented dev-stand-in; do not add a second vault. |
| Prod secrets path | `dev_secret` (`0024`) → AWS Secrets Manager via `secret_ref` | Locked topology (I-S09); no new secrets store. |

## D10.3 Missing (canon-mandated, zero code — build by extending the named seam)

Every item below is a **new additive migration** (never a destructive change to `bronze_events`/ledger/`audit_log`/`identity_*` — I-E02), reusing the **NN-1 two-arg RLS template verbatim** (Reject any bespoke RLS variant).

| # | Table (canon name) | Seam / migration | Justification (invariant + why now) | Owner module |
|---|---|---|---|---|
| M1 | **`consent_record`** — append-only, 4 categories (analytics/marketing/personalization/ai_processing), PK `(brand_id,brain_id,category,effective_at)`, `source` forward-compat with a CMP | new migration; extends the `customer` consent columns | I-S03/I-S04. The coarse booleans cannot represent retroactive withdrawal or category granularity. The SDK captures consent-at-capture (D11) → needs a real sink. | `core`/identity |
| M2 | **`consent_tombstone`** + consent-suppressor consumer (fast-path, fail-closed, <15min) | new migration + `stream-worker` consumer (extend existing consumer pattern) | I-S03/I-S04. Withdrawal must propagate ≤15min; no structure exists. | data-quality/notification path |
| M3 | **`pii_erasure_log`** (`vault_shredded` gate) + `surrogate_brain_id` re-pointing | new migration; extends `brand_keyring.is_active` + `lifecycle_state='erased'` | I-S05. Substrate exists, orchestration absent; DPDP erasure is a hard legal requirement. | identity |
| M4 | **`dq_grade`** (per `(brand_id, surface, as_of)`, enum grade not float) + cost_confidence/effective_confidence stamping | new migration; extends `data-quality` module + `packages/metric-engine` | METRICS.md "70-line" gate; `effective_confidence=min(cost,attribution)`. Confidence is a first-class output — **but stamped as enum grades, money stays minor-units** (Reject new float columns here). | data-quality / metric-engine |
| M5 | **`silver.order_state` stitch columns** — `stitched_anon_id`, `stitched_click_ids`, `stitched_first_touch_utms`, `stitch_source` (docs-08 §35) | new additive migration; mirror `connector_razorpay_order_map` discipline | Journey-before-attribution; closes anon→known→order loop that feeds the Decision Engine. **Deterministic** (read `brain_anon_id` back, never infer — Reject probabilistic). | attribution (owns Silver) |

**Gated / not-yet (do not build in this cluster):** retention TTL/Iceberg partition-expiry, audit-log S3-Object-Lock WORM checkpoint, prod KMS ciphertext wiring, `payment_method` PCI table — all canon-specified but gated on the Iceberg/StarRocks tier landing or on a later phase. Flag, do not build.

## D10.4 Raw-Only (captured raw in Bronze — do not model at the edge)

- `collector_spool.raw_body` (`0015`) — the accept-before-validate landing. New SDK fields land here opaque (I-ST02).
- All behavioral/pageview/cart/clickstream events → `bronze_events.payload` JSONB (`0016`), modeled later in the stream, never at the edge.
- Shopify order `cart.attributes` / `note_attributes` → raw in Bronze on `order.*.v1`; parsed only by the stitch parser slice (M5), not at ingest.
- DLQ forensic messages on `dev.collector.event.v1.dlq` — keep raw, do not promote to a quarantine table.

## D10.5 Reject (would drift/duplicate)

- New `connector_definition` marketplace DB table — ADR-CM-1 makes the static TS registry the SoR.
- A second consent model parallel to `consent_record`/`consent_tombstone`.
- Per-table bespoke RLS variant or a new GUC name — NN-1 two-arg template is locked.
- RLS on `collector_spool`, `audit_log`, or `brand_keyring` — all intentionally RLS-exempt by design.
- A `*_token`/`*_secret`/`*_ciphertext` plaintext column on any connector table — I-S09, semgrep DDL gate.
- A touchpoint/session table in **Postgres OLTP** — HLD mandates Iceberg→dbt→StarRocks Silver; sessionization belongs in stream-worker writing Silver.
- `OFFSET` pagination on any growable table — keyset/cursor only (INVARIANTS anti-pattern).

---

# D11 — Events & Contracts

**Binding constraints:** ONE envelope (`CollectorEventV1` / `collector.event.v1.avsc`), ONE collector topic family (`{env}.collector.event.v1`), Apicurio **FULL_TRANSITIVE** additive-optional only, ONE authoritative producer per event (doc-07 §3 H4). New `event_type`s ride the **existing** `payload`+`event_type` fields with **no envelope change** (additive). **Reject** any new topic or envelope for SDK/journey/identity-foundation events — doc-07 §0 F6 (don't over-granularize) and the single-source-contract rule forbid it.

## D11.1 The envelope (Present) — reuse, do not re-spec

`infra/kafka/schemas/collector.event.v1.avsc` carries `event_id`, `brand_id` (tenant key, I-S01), `occurred_at`/`ingested_at` (millis), `schema_name`/`schema_version`, `partition_key=brand_id:event_id`, `correlation_id`, `event_type` (router discriminator), `payload` (opaque JSON string, no raw PII I-S02), `collector_version` (additive-optional). Registered on collector startup with backoff (`packages/events` `registerSchema`, FULL_TRANSITIVE). **Partition key = `brand_id:event_id`** (`buildPartitionKey`). This is the only wire envelope; everything below is a new `event_type` value inside it.

## D11.2 Event family classification

Each row: **purpose · producer (single) · consumers · schema ownership · versioning · replay**. All replay from Bronze (I-E02); all dedup on `(brand_id,event_id)` (I-ST04).

### Pixel lifecycle — **Present**
| Event | Producer | Consumers | Schema | Replay |
|---|---|---|---|---|
| `pixel.installed`, `pixel.verified` | `connector/pixel` module | Home/dashboard, notification | `packages/contracts/src/events/m1.events.v1.ts` (M1 domain envelope, separate from collector wire envelope by design — these are control-plane facts, not Bronze events) | control-plane; not Bronze-materialized |

**Do not** route these through `collector.event.v1` — they are M1 domain events on the `EventEnvelopeBase` shape. Present and shipped.

### Tracking / behavioral — **Equivalent + Raw-Only**
| Event (`event_type`) | Producer | Consumers | Schema ownership | Versioning | Replay |
|---|---|---|---|---|---|
| `page_view`, `add_to_cart`, `checkout`, `search`, `identify` | **Brain Pixel SDK** (extend `packages/pixel-sdk`) → `/collect` | stream-worker→Bronze; identity (strong-id extract); journey foundation (M5) | `payload` is opaque at envelope; field-level schema is the per-`event_type` Zod in `packages/contracts` (additive) | `event_type` is a payload field; new types are additive-optional, **no `.v` bump** | from Bronze |

These **Raw-Only** through the edge (D10.4). Capture itself is **Missing** (SDK is a stub) — build by extending `packages/pixel-sdk`, emit wire-shape (b), hash PII client-side (D-10) before POST to the **existing** `/collect`. **Reject** a new topic per behavioral type (doc-07 F6).

### Commerce — **Present**
`connector.order.upserted.v1`, `connector.settlement.received.v1`, `connector.shipment.updated.v1`, `connector.ad_spend.synced.v1` — producer `connector`, consumers finance/ledger + identity + attribution + DQ (doc-07 §3). `finance.{ledger.recognized,finalized,refund.recorded,rto.recorded,chargeback.recorded}.v1` — producer = the single ledger writer (`LedgerWriter.ts`), normalized finance facts (doc-07 F1). Shipped. **Reject** new wire events for reversals — they are ledger `event_type` discriminators / normalized facts, one producer.

### Connector lifecycle — **Present**
`connector.connected.v1`, `connector.health.changed.v1` — producer `connector`, consumers recommendation/notification/DQ. `cmd.connector.backfill.requested.v1` — producer = job-orchestration internal REST trigger (doc-07 F4), not tenant-facing. Shipped.

### Data-quality — **Missing (contract Equivalent)**
| Event | Producer | Consumers | Schema | Versioning |
|---|---|---|---|---|
| `dq.signal.raised.v1` | stream-worker / data-quality | recommendation, notification, DQ grade | new domain payload; extend `packages/contracts/src/dq` (today: Zod stubs only, "no live DQ logic ships") | `.v1`, additive |
| `dq.grade.updated.v1` | data-quality | billing cap gate, analytics rendering | binds to `dq_grade` table (D10.3 M4) | `.v1`, additive |

Contracts exist as **Equivalent** stubs; the runtime + emit path is **Missing** — build as a stream-worker consumer pattern feeding `dq_grade`. **Reject** a DQ deployable.

### Verification — **Present (control-plane)**
`pixel.verified` (real HTTP HEAD/GET, not simulated — `VerifyPixelCommand.ts`) + `connector.health.changed.v1`. These ARE the verification events. No new verification topic needed.

### Journey-foundation — **Missing**
| Event | Producer | Consumers | Schema | Replay |
|---|---|---|---|---|
| (no new wire event) — journey is a **derived Silver projection**, not a topic | stream-worker `sessionize` step (HLD pipeline, unbuilt) | attribution (owns `silver.touchpoint`) | reuse `anonymous_id` + `hashed_session_id` envelope seams | rebuilt from Bronze |

**Critical:** journey emits **no new event** — HLD §54/§98 makes `silver.touchpoint`/`behavior_event` derived layers **owned by attribution, never a service/store/topic**. The "events" are the existing collection events re-projected. Sessionization is a stream-worker step writing Silver. **Reject** a journey/session topic or OLTP table. Gated on the StarRocks/dbt tier landing.

### Identity-foundation — **Present**
`identity.resolution.requested.v1` (internal trigger fact, stream-worker), `identity.brain_id.minted.v1`, `alias.repointed.v1`, `identity.merge.{proposed,committed,unmerge.committed}.v1` — producer `identity`, deterministic, shipped (`IdentityResolver.ts`, doc-07 §13). **Reject** probabilistic merge events (D-5).

### Consent / privacy — **Missing**
| Event | Producer | Consumers | Schema | Replay |
|---|---|---|---|---|
| `privacy.consent.granted.v1` / `consent.withdrawn.v1` | collection (CMP via Collector) / core | consent-suppressor, CAPI-deletion, audit | `consent_flags` envelope extension (doc-07 §4, customer-domain only) + `consent_record` (D10.3 M1) | from Bronze; withdrawal retroactive (I-S04) |
| `privacy.erasure.requested.v1` | identity (from privacy API) | crypto-shred job, mart re-projection, CAPI-deletion | binds `pii_erasure_log` (D10.3 M3) | replay-safe, idempotent erasure |

## D11.3 Schema-governance rules (all families)
- Single producer per event (H4); consumers use event-carried state, never reach the producer's tables.
- FULL_TRANSITIVE: add optional-with-default only; rename/type-change/remove → new `.v{n+1}` topic + dual-read.
- Bronze materialization = the replay SoR; a correction is a new fact, never an edit (I-E02).
- DLQ on schema-validation failure → `dev.collector.event.v1.dlq`, forensic headers, MAX_RETRY=5.

---

# D12 — API Design

**Topology (locked, doc-06 §0):** **Collector** owns the ingest surface (`/collect`, `/webhook/{connector}`) — separately rate-limited, accept-before-validate, never a schema 4xx. **Core monolith** owns all `/api/v1/*`. **Stream-worker** has NO HTTP API. **Frontend** reaches core only via the `frontend-api` BFF. **Analytics API is the sole DB read path** (I-ST01) — verification/health/diagnostics reads route through it or the owning module, never a parallel read engine. **Reject** any new API deployable or a published "BFF API" contract (the BFF returns composed view-models, doc-06 finding 2).

**Conventions (mandatory, doc-06 §1):** snake_case JSON matching the registry/envelope/DB; money `*_minor: integer`+`currency_code`; `X-Brand-Id` non-null asserted (missing tenant = hard error, never default-to-all); `Idempotency-Key` on every mutation; `X-Correlation-Id` echoed; **cursor/keyset pagination only** (no OFFSET); guarded reads return `409 NON_FINALIZED_ON_GUARDED_ENDPOINT` + `recognition_label`/`as_of`/`confidence`.

## D12.1 Tracking / ingest — **Present**
| Endpoint | Deployable | Status |
|---|---|---|
| `POST /collect` → `200 {accepted,received_at}` (accept-before-validate, D-1) | Collector | Present — `collect.route.ts` |
| `POST /v1/events` (alias) → `202` | Collector | Present |
| `POST /webhook/{connector}` (HMAC, 202) | Collector | Present (Shopify/Razorpay handlers) |

No change. The SDK POSTs to the **existing** `/collect`. **Reject** a second ingest edge.

## D12.2 Verification / health / diagnostics — **Present + one Missing**
| Endpoint | Owner | Status |
|---|---|---|
| `GET /api/v1/pixel/installation` (snippet+token, idempotent get-or-create) | `connector/pixel` | Present — `pixelRoutes.ts` |
| `POST /api/v1/pixel/verify` (real HTTP presence check) | `connector/pixel` | Present |
| `GET /api/v1/pixel/health` (real `pixel_status`) | `connector/pixel` | Present |
| `GET /api/v1/connectors/{id}/jobs`, `…/jobs/{jobId}` (job visibility) | connector | Present (doc-06 §3.5) |
| `GET /api/v1/jobs`, `…/{jobRunId}` (platform job monitoring) | job-orchestration | Present (doc-06 §3.15) |
| `GET /api/v1/pixel/diagnostics` — **event-flow health** (last event ts, accepted-vs-dropped, DQ grade for the pixel surface) | `connector/pixel` + Analytics API read | **Missing** — extend `pixelRoutes.ts`, read via Analytics API (I-ST01); binds `dq_grade` (D10.3 M4). Mirrors Elevar/Littledata "data-layer health" check. |

## D12.3 Connectors / status / admin — **Present**
| Endpoint | Owner | Status |
|---|---|---|
| `GET /api/v1/connectors` (marketplace list), `POST /connectors {type}` (connect) | connector | Present — `connector.api.v1.ts` |
| Shopify OAuth `…/install`, `…/callback`; `GET /connectors/{id}/status` | connector | Present |
| `POST /connectors/{id}/sync|backfill` → emits command | connector→job-orchestration | Present |

No new connector admin surface. **Reject** a `connector_definition` CRUD API (static registry is SoR).

## D12.4 Support / consent / privacy — **Present-read + Missing-enforcement**
| Endpoint | Owner | Status |
|---|---|---|
| `GET /customers/{brainId}/consent` (consent read) | identity-resolves / analytics-serves | Present (doc-06 §3.6) — but reads coarse booleans until `consent_record` (M1) lands |
| `POST /privacy/erasure-requests`, `GET …[/{requestId}]` | privacy (identity) | Present contract (doc-06 §3.16) — but orchestration (M3) **Missing** |
| Consent withdrawal → `consent.withdrawn` event + retroactive suppression | core / consent-suppressor | **Missing** enforcement (I-S03/S04) — `can_contact()` is a pass-through stub (`notification.service.impl.ts`); build the chokepoint, do not add a parallel one (I-ST05). |

## D12.5 API security / governance — **Present**
Authentik/JWT + revocation + RLS GUC assertion + webhook HMAC + MCP read-only scoping (I-S08). MCP surface is read-only by invariant — **Reject** any write tool. Every list is cursor-paginated, tenant-scoped, audited. Collector throughput/abuse protection + query-cost guardrails + cache freshness + SLO targets are specified (doc-06 §8.9/§1.13–1.15).

## D12.6 Reject (API)
- A separate "Attribution API" / "Customer API" read engine — one read path through Analytics API (I-ST01).
- A published BFF contract surface — BFF returns view-models only.
- Edge-side validation / Apicurio call in `/collect` — violates D-1, risks event loss.
- Treating `install_token` as a secret — it is a public tracking id (`0007`).
- Text-to-SQL / raw-query API — registry-bound `metric_id` only (I-S08).

---

## Competitor benchmarks used
- **Elevar / Littledata (server-side GTM, data-layer health):** informed the **`GET /api/v1/pixel/diagnostics`** event-flow-health endpoint (D12.2) — genuinely better operator UX than a binary verified/not-verified, and it passes the no-drift gate (extends the existing pixel module + reads via Analytics API, no new surface). Did **not** adopt their client-side data-layer transform model (Brain is accept-before-validate, edge does no transform).
- **Shopify Web Pixels API / Customer Events + Meta CAPI:** confirmed the `cart.attributes`/`note_attributes` server-side recovery pattern for the stitch columns (D10.3 M5) — deterministic read-back, which matches Brain's deterministic-first posture (vs Black Crow / probabilistic stitch, explicitly rejected for this phase).

---

## 10-line summary

1. **D10 net-new (Missing) tables — all additive migrations, NN-1 RLS verbatim, extending existing seams:** `consent_record` (M1), `consent_tombstone`+suppressor (M2), `pii_erasure_log`+`surrogate_brain_id` (M3), `dq_grade`+confidence stamping (M4), `silver.order_state` stitch columns (M5).
2. **D11 net-new events:** `dq.signal.raised.v1` / `dq.grade.updated.v1` (runtime, not just stubs); `privacy.consent.{granted,withdrawn}.v1` + `privacy.erasure.requested.v1`. All ride the existing envelope/topic additively — no new topic, no new envelope.
3. **Journey-foundation emits NO new event/table** — it is a derived Silver projection owned by attribution, sessionized in stream-worker; gated on the StarRocks/dbt tier.
4. **Identity-foundation + commerce + connector + pixel-lifecycle + verification events are all Present** — shipped, deterministic, single-producer.
5. **D12 net-new API:** one endpoint — `GET /api/v1/pixel/diagnostics` (event-flow health), extending `pixelRoutes.ts`, reading via the Analytics API. Consent/privacy read contracts exist; their **enforcement** (`can_contact()`, erasure orchestration) is the Missing work, built on the existing chokepoint — never a parallel one.
6. **Everything else is Present or Equivalent** — the edge→spool→drainer→Bronze backbone, ledger, identity graph, connector framework, RLS-FORCE isolation are mature; reuse, do not redesign.
7. **No new deployable, topic, envelope, RLS pattern, or secrets store is proposed** anywhere in the cluster.
8. **The SDK (separate cluster)** extends `packages/pixel-sdk`, emits wire-shape (b), hashes PII client-side (D-10), POSTs to existing `/collect`.
9. **Competitor borrow:** Elevar/Littledata data-layer-health → the diagnostics endpoint; Shopify Web Pixels/Meta CAPI → server-side stitch read-back (deterministic, not probabilistic).
10. **HIGHEST-RISK DECISION: the dual collector-envelope reconciliation** (Zod `event_name`/ISO-string shape (a) vs Avro/Bronze `event_type`/millis shape (b)). The SDK and all new events MUST emit shape (b) (what Bronze parses today) and the Zod schema must be brought into byte-alignment additively — forking a second envelope to paper over the divergence would silently break Bronze idempotency and the single-source contract (I-E01). This must be resolved in the first SDK contract change, before any real browser event ships.
