# 16 — DB / Platform Alignment Classification (consolidated)

> The merged Present / Equivalent / Missing / Raw-Only / Reject table across all four ground-map areas (collection, identity-journey, connectors-commerce, quality-db-security). Every row is justified against the actual repo. **Additions appear only where absolutely necessary** and are tagged `[ADD — justified]` with the seam they extend.
>
> Legend: **Present** = shipped, reuse as-is · **Equivalent** = a shipped seam serves the need, extend it · **Missing** = genuine net-new, build by extending a named seam · **Raw-Only** = already captured raw in Bronze, model later · **Reject** = would drift/duplicate, do not build.

## A. Collection — edge + pixel + Bronze + envelope

| Class | Item | Justification / seam |
|---|---|---|
| Present | `/collect` accept-before-validate edge (D-1), `collector_spool`, drainer (F-3 no-loss), `bronze_events` append-only + `(brand_id,event_id)` PK | `collect.route.ts`, `0015`, `0016`. Battle-tested. Surface, do not touch ordering. |
| Present | `CollectorEventV1` Zod contract + Avro `collector.event.v1.avsc` + `dev.collector.event.v1` topic | Single-source contract. New event_types ride `payload`/`event_name` additively (FULL_TRANSITIVE). |
| Present | Pixel install/verify/health (`0007`, `pixelRoutes.ts`), install UI | Real HTTP verify, idempotent get-or-create token. Reuse the `install_token` seam. |
| Equivalent | `packages/pixel-sdk` (`export {}` scaffold) | The designated seam for brain.js. **Extend this** — do not create a new SDK package. |
| Equivalent | Verification snippet + `install_token` (public id) | Reuse as the SDK identity anchor; do NOT treat token as a secret (R6). |
| Missing | brain.js capture SDK + served `/pixel.js` asset (snippet references a non-existent file) | Extend `pixel-sdk`; serve over per-tenant CNAME. No new deployable. |
| Missing `[ADD — justified]` | **Tenant-key binding: resolve `brand_id` from `install_token` at the drainer/consumer** | **Required for isolation (R2).** Extends the existing `pixel_installation` table (`UNIQUE(brand_id, install_token)`) — no new table. |
| Missing `[ADD — justified]` | **`consent_flags` additive-optional envelope field** | COMPLIANCE.md:105 build-gate. Additive to existing Zod+Avro contract — no new envelope. |
| Missing `[ADD — justified]` | **`quarantined` consumer outcome + quarantine sink** | COMPLIANCE mandates quarantine-not-drop. Extends `ProcessOutcome` enum + DLQ path — no new topic. |
| Missing | Client event queue + offline retry + `sendBeacon` transport | In-SDK; best-effort (not "no-loss" — see review M2). |
| Missing | Edge abuse protection (per-`install_token` rate-limit + origin allowlist) | Fastify plugin at the edge; reject-before-spool is NOT a D-1 violation. |
| Missing | Browser-origin → `bronze_events` E2E smoke (current fixture is Node-only, exits 0 offline) | The acceptance gate for Phase 1. Must fail-closed when collector unreachable. |
| Raw-Only | New SDK fields (anon-id, UTM, click-ids) in `payload` | Flow opaque through the edge; model downstream. Do NOT validate at the edge. |
| Reject | New `apps/core/src/modules/pixel` module | Pixel already lives under `connector/pixel/`. Pure drift. |
| Reject | New deployable / second ingest edge / new topic / new envelope / new pixel-sdk package | All seams exist and are complete. Duplication + drift. |
| Reject | RLS on `collector_spool` | Deliberately pre-brand-validation; would break accept-before-validate. |
| Reject | Edge-side validation / Apicurio call in `/collect` | Violates D-1, risks event loss. |

## B. Identity — Journey

| Class | Item | Justification / seam |
|---|---|---|
| Present | Deterministic mint/link/merge → `brain_id`, `brain_id_alias` union-find, phone-guard, identity graph (RLS-isolated) | `0017`, `IdentityResolver.ts`. Strong-only merge posture is correct. |
| Present | Per-brand salt hard-crash, centralized boundary hasher | `identity-core`, `SaltProvider.ts`. |
| Present | Identity→revenue link at data level (`realized_revenue_ledger.brain_id`) | `0018` §2. |
| Equivalent | `customer.anonymous_id` + inert `hashed_session_id` envelope field | Reuse as the anon-id/session seams; no new id authority. |
| Missing | anon-id (`brain_anon_id`) generation + 30-min session | Extend `pixel-sdk` + reuse `anonymous_id`. No schema change. |
| Missing | click-ids (`fbclid/gclid/ttclid`, `_fbc/_fbp`), UTMs, referrer/landing, device/geo capture | Journey signals, NOT merge keys (D-5). Ride `payload`. |
| Missing | sessionize → bot-filter → touchpoint → journey transform | Build in stream-worker (reuse `IdentityBridgeConsumer` shape). Gated on Silver tier. |
| Missing | Cross-session + journey/cart stitch | Reuse `brain_id_alias` re-pointing + `IdentityRepository.readState`. Deterministic read-back only. |
| Raw-Only | Behavioral/page-view/cart/clickstream events | Land raw in `bronze_events.payload`; modeled only when the stitch/sessionize slice ships. |
| Reject | Sessions/journey microservice or OLTP touchpoint table | HLD §54/§98: Journey is a DERIVED Silver layer OWNED BY attribution, never a service/store/OLTP table. |
| Reject | Probabilistic/ML identity merge; new parallel id authority | D-5 deterministic-first; `anonymous_id` already exists. |
| Reject | Promoting reserved weak `identifier_type` values (fp_cookie/device_id/ip/ua) to merge keys | Risks over-stitching; conflicts D-5. |

## C. Connectors — Commerce — Cart-stitch

| Class | Item | Justification / seam |
|---|---|---|
| Present | Connector framework (`connector_instance/cursor/sync_status`, RLS-FORCE, secret_ref-only NN-2), static catalog (ADR-CM-1) | A new connector = one `sources/` module + one mapper + additive `provider` CHECK. No platform gap. |
| Present | One append-only `realized_revenue_ledger` (17 event_types: 10 in `0018` + 7 settlement in `0027`), RTO/refund/chargeback, `realized_gmv_as_of()` | Read **both** migrations. Revenue-truth complete. |
| Present | Shopify live+backfill+repull, Razorpay settlement, SECURITY DEFINER enumeration fns | `0026`/`0027`. Same-code-path discipline. |
| Present | `connector_razorpay_order_map` (order-level stitch precedent) | Mirror for RLS + replay-upsert discipline on any new stitch table. |
| Equivalent | `shopify-mapper` (`ShopifyOrderShape` + `mapOrderToEvent`) | The natural insertion point for a `cart.attributes`/`note_attributes` parser — currently extracts none. **FROZEN (D-12)**: additive-only. |
| Missing | Cart-stitch: (1) `pixel-sdk` cart-attribute writer, (2) `shopify-mapper` parser, (3) `order_state` stitch columns | Extend three existing seams; mirror `connector_razorpay_order_map`. Deterministic read-back. |
| Missing `[ADD — justified]` | **`order_state` stitch columns** (`stitched_anon_id`, `stitched_click_ids`, `stitched_first_touch_utms`, `stitch_source`) | New additive migration, NN-1 RLS verbatim. Required to persist the stitch. |
| Raw-Only | Anon pre-purchase events; Shopify `cart.attributes`/`note_attributes` in raw order JSON | Already in Bronze raw; parsed for nothing stitch-related today. |
| Reject | `connector_definition` marketplace DB table | ADR-CM-1: static TS registry is SoR. Drift + duplication. |
| Reject | New deployable/topic for cart-stitch; order-recovery/abandoned-cart action | Decision-Engine/outbound concern, not collection. Not in TRIGGER-SURFACES. |
| Reject | Probabilistic cart-stitch; any `*_token/*_secret` column on connector tables | Deterministic-first; NN-2 (semgrep DDL scan). |

## D. Quality — DB — Security / Privacy / Consent

| Class | Item | Justification / seam |
|---|---|---|
| Present | RLS-FORCE + NN-1 two-arg fail-closed on every brand table + migration-time assertions | The locked pattern. Any new table reuses it verbatim. |
| Present | Non-owner `brain_app` (no BYPASSRLS), GUC builder, boundary hasher, per-brand salt hard-crash | `packages/db`, `identity-core`. |
| Present | PII vault `contact_pii` (elevated `send_service` RLS), `brand_keyring` crypto-shred substrate, hash-chained `audit_log`, append-only-by-GRANT on Bronze/ledger/audit, BIGINT minor-units + no-float assertion | `0001`/`0017`/`0018`. Mature. |
| Present | SECURITY DEFINER enumeration fns (`0026`) | Sanctioned cross-tenant no-GUC seam. |
| Present | COMPLIANCE.md + INVARIANTS.md (I-S01..I-S10) | Ratified blueprint; design conforms table-name-for-table-name. |
| Equivalent | Empty `data-quality` bounded context + `packages/contracts/src/dq` Zod stubs | Extend these for the DQ runtime — not a new module/app. |
| Equivalent | `customer.ai_processing_consent`/`resolution_consent` booleans | Coarse stand-in; reuse the `customer` row when modeling real consent. |
| Equivalent | `can_contact()` pass-through stub (`notification.service.impl.ts:171` returns true) | The chokepoint seam exists; enforcement is the Missing work. |
| Equivalent | `lifecycle_state='erased'` + `brand_keyring.is_active` | The erasure state-machine seam to extend; orchestration is Missing. |
| Missing `[ADD — justified]` | `consent_record` (append-only, four-category, PK `(brand_id,brain_id,category,effective_at)`) | COMPLIANCE + I-S03/I-S04. Extends `customer` consent. NN-1 verbatim. |
| Missing `[ADD — justified]` | `consent_tombstone` + consent-suppressor consumer (<15min withdrawal SLA) | I-S03/I-S04. |
| Missing `[ADD — justified]` | `pii_erasure_log` + crypto-shred orchestrator + `surrogate_brain_id` re-pointing | I-S05. Extends `brand_keyring.is_active`. |
| Missing `[ADD — justified]` | `dq_grade` store + DQ check-execution runtime (stream-worker pattern) + Trust Score | METRICS.md. NN-1 verbatim, append-only-by-GRANT. |
| Missing | Real `can_contact()` compliance engine; CAPI-deletion consumer | I-S04. Extends the existing chokepoint. |
| Missing | Retention TTL, audit WORM S3 anchor, prod KMS `pii_ciphertext`, `payment_method` PCI lint | COMPLIANCE §Retention/§4. Gated on Iceberg (Phase-3). |
| Raw-Only | `collector_spool.raw_body`, DLQ messages, NLQ redacted text | Keep as raw forensic capture; do not promote. |
| Reject | Standalone DQ deployable; second consent model; per-table bespoke RLS; second hashing util; new secrets store; RLS on `audit_log`/`brand_keyring`; `dq_grade` as OLTP floats | Each duplicates/drifts a locked primitive. Confidence is a metric-engine enum output, not OLTP floats. |

## Summary

The platform is **mature on the security substrate, identity, commerce-truth, and connectors**. The genuine net-new surface is: **the brain.js SDK, the ingest tenant-key binding + consent_flags + quarantine (the three critical hardening items), cart-stitch, the journey transform (Silver-gated), and the DQ/consent/erasure completion.** Every `[ADD — justified]` row extends a named, shipped seam — no new deployable, package, topic, envelope, or RLS variant is proposed anywhere.
