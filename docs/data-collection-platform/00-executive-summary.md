# 00 — Executive Summary

> One-read overview of the Brain Data Collection Platform design. Brain is an AI-Native Commerce OS, not a dashboard/CDP/BI/attribution tool. Everything in this cluster exists to feed the Decision Engine with **trustworthy first-party data**.

## 1. Purpose

Design the data-collection plane that turns raw storefront and commerce signal into Decision-Engine-grade truth, **by extending the already-shipped collector/pixel/Bronze spine** — no new deployable, package, topic, envelope, or RLS pattern.

## 2. The foundational chain (the order is the architecture)

```
first-party collection → identity → journey → revenue truth → attribution → confidence → decision intelligence
```

Each link feeds the next. A defect early (e.g. a poisoned or dropped event at collection) corrupts every downstream confidence number. This is why the collection plane's correctness bar is **higher** than its feature ambition.

## 3. What is Present vs Missing (crisp)

### PRESENT (shipped, battle-tested — surface/reuse, do NOT rebuild)
- **Edge → spool → drainer → Redpanda → Bronze backbone.** Accept-before-validate `/collect` (D-1), durable `collector_spool`, back-pressure drainer (F-3, no-loss), `bronze_events` append-only with `(brand_id,event_id)` PK idempotency. (`apps/collector`, `apps/stream-worker`, `0015`/`0016`.)
- **Identity engine (live).** Deterministic mint/link/merge into `brain_id`, `brain_id_alias` union-find re-pointing, phone-guard, per-brand salt, full RLS-isolated identity graph. Strong identifiers only (email/phone/storefront_customer_id). (`0017`, `IdentityResolver.ts`.)
- **Commerce truth (live).** One append-only `realized_revenue_ledger` (17 event_types), RTO/refund/chargeback/settlement modeled, `realized_gmv_as_of()` no-double-count, COD/prepaid recognition horizons. Shopify live+backfill+repull, Razorpay settlement. (`0018`/`0027`.)
- **Connector framework.** Static catalog registry (ADR-CM-1), `connector_instance/cursor/sync_status` (RLS-FORCE, secret_ref-only NN-2), same-code-path live+backfill+repull, DLQ.
- **Security substrate.** RLS-FORCE + NN-1 two-arg fail-closed on every brand table (migration-time assertions), non-owner `brain_app` (no BYPASSRLS), single boundary hasher (`identity-core`), per-brand salt hard-crash, hash-chained `audit_log`, append-only-by-GRANT on Bronze/ledger/audit, `brand_keyring` crypto-shred substrate.
- **Pixel install/verify/health** (`0007`, `pixelRoutes.ts`) + install UI.

### MISSING (genuine net-new — build by EXTENDING seams)
1. **brain.js capture SDK + served `/pixel.js` asset** — the snippet at `pixelRoutes.ts` references a file that does not exist; `packages/pixel-sdk` is `export {}`. (Extend `pixel-sdk`; no new package.)
2. **Tenant-key binding on ingest** — `brand_id` is currently client-stamped and trusted to the Bronze RLS GUC with **no server-side validation against `install_token`**. (Critical — see §5.)
3. **`consent_flags` envelope field + quarantine path + the CI gate** COMPLIANCE.md mandates. (Critical compliance — see §5.)
4. **anon-id + 30-min session + click-id/UTM capture** — reuse `customer.anonymous_id` + the inert `hashed_session_id` field; all ride `payload` additively.
5. **Client event queue + offline retry + `sendBeacon`** (best-effort browser edge).
6. **Sessionize → touchpoint → journey** transform in stream-worker, gated on the Silver tier (StarRocks/dbt/Iceberg) landing.
7. **Cart-stitch** (deterministic anon→known→order read-back) via `pixel-sdk` writer + `shopify-mapper` parser + additive `order_state` stitch columns.
8. **Consent enforcement (`can_contact()` real engine) + erasure orchestration** (`consent_record`/`consent_tombstone`/`pii_erasure_log`/`surrogate_brain_id`) — substrate exists, orchestration does not.
9. **DQ check-execution runtime + `dq_grade` store + Trust Score** — Zod contracts exist, no runtime.
10. **Edge abuse protection** (rate-limit/origin-allowlist) — not in code.

## 4. Recommended build sequence (each phase EXTENDS shipped work, ships through the Engineering OS pipeline)

- **Phase 1 — Collection Foundation (the smallest valuable slice).** Resolve the two blocking ADRs (wire-shape, PII-hashing), bind `brand_id` to `install_token` at the drainer, add `consent_flags` + quarantine, then ship a minimal brain.js that captures anon-id + page/cart events to the existing `/collect` with a real browser→Bronze E2E. **This is the gate for everything else.**
- **Phase 2 — Identity/Journey capture.** click-id/UTM/referrer capture, session anchoring, cart-stitch writer + parser.
- **Phase 3 — Journey transform (Silver).** Sessionize → touchpoint in stream-worker, gated on the Silver tier landing.
- **Phase 4 — DQ + Confidence.** DQ runtime, `dq_grade`, Trust Score, `effective_confidence` widening (dark-launched).
- **Phase 5 — Privacy completion.** Real `can_contact()`, consent_tombstone suppressor, erasure orchestration, Iceberg-gated Bronze compaction.

Full detail + drift gate per recommendation in `17-final-recommendations.md`.

## 5. Top 5 risks (the design must be built AROUND these — all grounded to code)

| # | Risk | Severity | Grounding |
|---|------|----------|-----------|
| **R1** | **Wrong wire shape silently DLQs every real SDK event.** Design docs rule "SDK emits shape (b) — what Bronze parses." FALSE: `ProcessEventUseCase.ts:71` parses **shape (a)** Zod (`event_name`, ISO `occurred_at`; no `event_type`/`payload`). A shape-(b) event → `invalid` → DLQ **without retry**. The cited proof (`pixel-fixture`) emits shape (b) and only proves HTTP 200, never a Bronze row. | CRITICAL | `ProcessEventUseCase.ts:71`, `sample.collector.event.v1.ts:25-86`, `send-event.mjs:37-50` |
| **R2** | **Client-stamped `brand_id` is the sole tenant key, never validated.** `BronzeRepository.ts:63` sets the RLS GUC **from the event's own `brand_id`** — RLS is satisfied by construction for any brand the caller claims. `install_token` is public. → cross-brand write-injection / funnel poisoning. No `install_token`→`brand_id` lookup exists in the ingest path (grep confirmed). | CRITICAL (isolation VETO) | `BronzeRepository.ts:63-79`, `kafka-producer.ts` (`?? 'unknown'`), grep: no `pixel_installation` lookup in ingest |
| **R3** | **`consent_flags` absent → COMPLIANCE CI-gate violation.** COMPLIANCE.md:105 mandates `consent_flags` on every customer-domain event (missing flag **fails the build**) + quarantine-not-drop. Absent from `contracts` + `.avsc` (grep empty). The consumer has no `quarantined` outcome. | CRITICAL (compliance P0 VETO) | `COMPLIANCE.md:105,149`, grep: zero `consent_flags` in contracts/avsc |
| **R4** | **Client-controlled `event_id` idempotency = silent suppression.** `ON CONFLICT (brand_id,event_id) DO NOTHING` with both keys client-chosen → a forged/replayed `event_id` pre-suppresses a real event; the drop is **silent** (no signal, no DLQ). | HIGH | `BronzeRepository.ts:77`, PK `0016` |
| **R5** | **Commerce-truth edge cases corrupt the ledger silently.** Single-currency BEFORE-INSERT trigger hard-fails multi-currency (Shopify Markets) orders → DLQ at retry 5, revenue vanishes. Ledger dedup truncates `occurred_at::date` → two distinct same-day same-type events collide. Mutating the FROZEN `shopify-mapper` (D-12) for cart-stitch risks fleet-wide ledger corruption. | HIGH | `0018:104,145`, `shopify-mapper` (D-12 frozen) |

**None of these require a new deployable.** R1/R2 are fixed by reconciling the envelope in `ProcessEventUseCase` and binding `brand_id` to the already-issued `install_token` at the drainer. R3 by the already-named `consent_flags` field + wiring the already-specified CI gate. They are extensions of existing seams — but **load-bearing, and must land before the SDK emits a single real browser event.**

See `16-db-alignment-classification.md` for the full Present/Equivalent/Missing/Raw-Only/Reject table and `17-final-recommendations.md` for the gated, phased roadmap.
