# 17 — Final Recommendations (gated + phased)

> Every recommendation passes the five-question drift/duplication gate before it is allowed in:
> **(a) does it already exist in Brain? (b) does it duplicate? (c) does it drift? (d) is it actually required? (e) does it support the Decision Engine?**
> Recommendations that fail are listed in §REJECTED with the reason. Each accepted item names the **exact seam it extends** — no new deployable, package, topic, envelope, or RLS variant.

---

## Part 1 — The two blocking ADRs (must land before ANY SDK/ingest code)

These are design decisions, not builds. They gate Phase 1.

### ADR-1 — Envelope wire-shape reconciliation (resolves R1)
**Gate:** required (d) — the platform silently loses 100% of pixel events without it; supports DE (e) — DE reads an empty funnel otherwise.
**Decision needed:** the SDK and all new events emit **one** wire shape, enforced **in `ProcessEventUseCase`**, not in prose. Ground truth: `ProcessEventUseCase.ts:71` parses **shape (a)** (`CollectorEventV1Schema`: `event_name`, ISO-8601 `occurred_at`, no `event_type`/`payload`). The section docs ruled "emit shape (b)" — that is wrong against running code and would DLQ every event.
**Recommended resolution:** keep shape (a) as the wire contract (it is what the consumer parses today), bring the Avro `.avsc` + fixture into shape-(a) alignment additively, and **delete the false "emit shape (b)" guidance** from sections 01/03/10. Whichever shape is chosen, the consumer must parse it and a browser→Bronze E2E must prove a real row. **Do not fork a second envelope** (breaks Bronze idempotency + I-E01).

### ADR-2 — Client-side PII hashing posture (resolves H2 across sections)
**Gate:** required (d) — I-S02 forbids raw PII on the wire; sections 01/03/13 give **three contradicting answers**. Supports DE (e) via correct identity resolution.
**Decision needed:** one converged answer. **Recommended default:** the **browser sends NO raw PII and NO secret salt**; canonical salted hashing happens server-side in `identity-core`/`SaltProvider`. The browser may send an anon-id + behavior only. **Reject** section 03 §D3.4 option (a) (normalized-but-unhashed email/phone over TLS) outright — raw PII would land in the **un-RLS'd** `collector_spool.raw_body` (I-S02 + non-isolated-store violation). The secret brand salt must never reach the browser (public leak is catastrophic and irreversible).

---

## Part 2 — The three critical hardening items (must land before the SDK emits a real browser event)

### REC-1 — Bind `brand_id` to `install_token` at the drainer (resolves R2/C1/C2)
**Gate:** (a) no — no binding exists (grep confirmed); (b) no dup — extends `pixel_installation`; (c) no drift — bind happens at drain where `brand_id` is already first parsed, preserving D-1; (d) **required** — isolation VETO, the tenant key is currently taken from untrusted input; (e) yes — DE truth depends on un-poisoned Bronze.
**Build:** at the drainer/consumer (NOT the edge), resolve `brand_id := lookup(install_token)` via `pixel_installation` (`UNIQUE(brand_id, install_token)`); reject/quarantine any event whose body `brand_id` ≠ the token-resolved brand. Add an `audit_log` entry for rejected cross-brand attempts. The browser may *send* `brand_id` for partitioning; the server must *derive* the authoritative one. **The tenant key is never trusted from input.**

### REC-2 — Add `consent_flags` envelope field + `quarantined` outcome + wire the CI gate (resolves R3/H1)
**Gate:** (a) no — absent from contracts/avsc (grep empty); (b) no dup — additive to the single contract; (c) no drift — additive-optional, FULL_TRANSITIVE-safe; (d) **required** — COMPLIANCE.md:105 makes a missing flag **fail the build**; (e) yes — DE must not act on non-consented data.
**Build:** add `consent_flags` as an additive-optional field on the Zod+Avro envelope; add a `quarantined` `ProcessOutcome` + sink (quarantine-not-drop per COMPLIANCE); wire the `consent-propagation-test` CI gate before SDK ship. Consent is **captured** at the SDK; **enforcement** stays at the `can_contact()` chokepoint (Phase 5).

### REC-3 — Make idempotency-suppression observable (resolves R4)
**Gate:** (a) partial — `ON CONFLICT DO NOTHING` exists but is silent; (d) required — silent suppression is the worst class for a confidence product; (e) yes.
**Build:** emit a `dq.signal` / metric on every `ON CONFLICT (brand_id,event_id) DO NOTHING` so a forged/colliding `event_id` is observable, not silent. The DQ Freshness/Completeness runtime (Phase 4) must alarm on conflict-rate.

---

## Part 3 — High-severity design-arounds (block ship, not necessarily Phase 1)

- **REC-4 — Keep the edge stateless; do NOT `Set-Cookie` on `/collect`** (resolves H1-cookie). Mint anon-id client-side; accept ITP's cap as a known limitation, or use a separate `/p/id` endpoint outside accept-before-validate (Architect ADR). Bolting visitor-state onto `/collect` breaks D-1 and the stateless edge.
- **REC-5 — Hard-forbid array/batched POST bodies** until drainer fan-out is built+tested (resolves H1-batch/C3). One spool row per POST → one Kafka message per row; an array silently loses N−1 events and collapses onto the `unknown:unknown` partition.
- **REC-6 — Route malformed/missing-tenant-key events to DLQ, not the `unknown:unknown` partition** (resolves H4). A missing `brand_id` is unroutable, not raw data — quarantine it; one buggy SDK flood otherwise head-of-line-blocks the live consumer fleet-wide.
- **REC-7 — Model click-id loss honestly** (resolves H2/H3). Capture click-ids at first landing, persist first-party immediately, and split `stitch_source` into `none_organic` vs `none_clickid_expected_but_missing` so DQ down-grades the loss. Do not conflate the 85–90% cart-attribute-stitch figure with click-id capture rate (materially lower under Safari/sandbox).
- **REC-8 — Flag commerce-truth edge cases** (resolves R5): multi-currency (single-currency trigger hard-fails Shopify Markets → DLQ; document as M1 limitation or model `fx_rate_id`), date-truncated ledger dedup collisions, bundle double-count, subscription rebill states. Any `shopify-mapper` change is **strictly additive** with a byte-identical-ledger regression test run under `brain_app` (not superuser).
- **REC-9 — Add per-`install_token` rate-limiting + origin allowlist at the edge** (resolves M1/H6). Reject-before-spool is not a D-1 violation; protects the shared spool from noisy-neighbor floods.

---

## Part 4 — Phased roadmap (each phase EXTENDS shipped work, ships through the Engineering OS pipeline as vertical slices)

### Phase 1 — Collection Foundation (the gate for everything)
1. Land **ADR-1** (wire shape) + **ADR-2** (PII hashing).
2. **REC-1** (`install_token`→`brand_id` binding) + **REC-2** (`consent_flags` + quarantine + CI gate) + **REC-3** (observable dedup) + **REC-6** (malformed→DLQ).
3. Minimal **brain.js** in `packages/pixel-sdk`: anon-id + page/cart events, one-event-per-POST (REC-5), client-side hashing per ADR-2, POST to existing `/collect`.
4. Serve the **`/pixel.js` asset** over the per-tenant CNAME.
5. **Browser-origin → `bronze_events` E2E** that fails-closed when the collector is unreachable (closes the inert-probe gap) — the acceptance gate.
6. **REC-9** (edge rate-limit) before real-storefront rollout.

*Slice-1 (thinnest end-to-end): one real browser `page.viewed` event → token-bound `brand_id` → Bronze row, asserted under `brain_app`, with a negative control (a mismatched-`brand_id` event is quarantined, a malformed event is DLQ'd).*

### Phase 2 — Identity / Journey capture
click-id/UTM/referrer capture (REC-7), session anchoring (reuse `anonymous_id`/`hashed_session_id`), cart-stitch writer (`pixel-sdk`) + parser (`shopify-mapper`, additive, regression-tested per REC-8) + `order_state` stitch columns.

### Phase 3 — Journey transform (Silver)
Sessionize → touchpoint in stream-worker, owned by attribution, gated on the Silver tier (StarRocks/dbt/Iceberg) landing. No new OLTP table, no new topic.

### Phase 4 — DQ + Confidence
DQ check-execution runtime (extends `data-quality` shell + `dq` Zod contracts), `dq_grade` store, Trust Score, `effective_confidence = min(cost, attribution, dq)` **dark-launched one billing period** with a per-brand impact report before it gates anything.

### Phase 5 — Privacy completion
`consent_record` → real `can_contact()` engine → `consent_tombstone` suppressor + CAPI-deletion → `pii_erasure_log` + crypto-shred orchestrator + `surrogate_brain_id`; Iceberg-gated Bronze compaction. Ship `contact_pii` crypto-shred now (DPDP-sufficient for plaintext PII); document the pre-Iceberg Bronze-hash-persistence limitation in the DPA rather than overclaim I-S05 end-to-end.

---

## REJECTED (failed the gate)

| Rejected item | Failed gate | Reason |
|---|---|---|
| New SDK deployable / second ingest edge | (a)(c) | Collector/spool/drainer/Bronze complete; SDK is a static asset on the storefront CNAME. New deployable = drift. |
| New `pixel-sdk` package / new `modules/pixel` | (a)(b) | `packages/pixel-sdk` + `connector/pixel/` already exist. Duplication. |
| New event envelope / topic for SDK or new events | (a)(b)(c) | `CollectorEventV1` + `dev.collector.event.v1` carry arbitrary `event_type`+`payload` additively. A fork breaks Bronze idempotency (I-E01). |
| Emit wire-shape (b) per current docs | (d) | FALSE against `ProcessEventUseCase.ts:71`; would DLQ every event. Superseded by ADR-1. |
| `Set-Cookie` anon-id on `/collect` | (c) | Breaks D-1 stateless edge. → REC-4. |
| SDK array/batched POST | (c)(d) | Silent N−1 loss against one-row-per-POST drainer. → REC-5 (forbidden until fan-out). |
| Client-hashed PII with browser salt / raw PII over TLS | (c)(d) | Salt leak catastrophic; raw PII in un-RLS'd spool. Superseded by ADR-2. |
| Sessions/journey microservice or OLTP touchpoint table | (a)(c) | HLD §54/§98: derived Silver layer owned by attribution. |
| Probabilistic identity/cart-stitch merge | (c) | D-5 deterministic-first. |
| Standalone DQ deployable; second consent model; per-table RLS; second hasher; new secrets store; RLS on `audit_log`/`brand_keyring`; `dq_grade` as OLTP floats; `connector_definition` DB table; order-recovery/abandoned-cart action | (a)(b)(c)(e) | Each duplicates/drifts a locked primitive or is an outbound/Decision-Engine concern, not collection. |

**Net:** every accepted recommendation extends a shipped seam. The three critical hardening items (REC-1/2/3) + two ADRs are the load-bearing gate; nothing requires a new deployable.
