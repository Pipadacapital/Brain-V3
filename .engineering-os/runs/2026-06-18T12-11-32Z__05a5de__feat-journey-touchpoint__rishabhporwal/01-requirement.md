# Requirement: Phase 4 — Journey (silver.touchpoint: sessionize → first/last-touch + cart-stitch)

| Field | Value |
|-------|-------|
| **req_id** | `feat-journey-touchpoint` |
| **Title** | The journey Silver layer: sessionize SDK events into `silver.touchpoint` (first/last-touch, UTM/click-id), deterministically cart-stitch anon journeys to known orders, + a stakeholder-visible journey/first-touch surface |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18 |
| **Lane** | high_stakes (data plane, multi_tenancy, identity-adjacent) |
| **Roadmap** | D14 **Phase 4 — Journey** (now UNBLOCKED — the Silver tier landed). See docs/data-collection-platform/13-security-privacy-and-roadmap.md. Owned by the `attribution` module (currently a stub). |

## Why now
Phase 4 was gated on the Silver tier — which just shipped (dbt→StarRocks, `silver.order_state`,
the metric-engine Silver seam, replay-idempotent, per-brand isolation). Journey is the next
roadmap step and the prerequisite for Phase 5 (Attribution).

## Current state (verified)
- Silver tier LIVE: dbt models (staging→intermediate→mart) into StarRocks `brain_silver`; the
  `brain_oltp_pg` JDBC catalog + `brain_bronze_local` Iceberg catalog exist; `silver_order_state`
  materialized (10,933 rows); metric-engine `withSilverBrand` seam is the SOLE read path (I-ST01).
- Bronze has REAL SDK journey events: **page.viewed (94)** plus order.live/backfill, settlement,
  spend. So real touchpoints exist (thin but real) — enough to prove the pipeline; richer journeys
  may need clearly-labelled SYNTHETIC fixtures (be dev-honest).
- Identity graph is live (`feat-identity-graph`: brain_id mint/link/merge, `brain_id_alias`).
- The `attribution` module is a stub (index.ts public interface + .gitkeep, no impl) — this slice
  implements its first real capability.

## Deliverables (smallest valuable slice)
1. **`silver.touchpoint` (DERIVED Silver layer, owned by the attribution module):** sessionize SDK
   events (page.viewed + click/UTM/referrer/_fbc/_fbp where present) into sessions (30-min inactivity
   window) per brain_id / anon_id; capture **first-touch and last-touch** ordering per identity, with
   channel/source/medium/campaign (UTM) + click-ids. Built as a **dbt Silver mart** consistent with
   `silver.order_state` (reproducible from Bronze, replay-safe). The architect binds the source read
   (Bronze SDK events live in Postgres `bronze_events` → via the `brain_oltp_pg` JDBC catalog, or the
   Iceberg Bronze catalog) and reconciles vs the roadmap's "sessionize in stream-worker" note —
   prioritise replay-from-Bronze + Silver-tier consistency; NO journey microservice, NO Postgres-OLTP
   touchpoint table, NO probabilistic stitch.
2. **Deterministic cart-stitch:** link an anon journey (anon_id) to a known order/brain_id by reading
   `brain_anon_id` BACK from identity (NOT inferring) — a stitch map (additive migration mirroring
   `connector_razorpay_order_map`) populated from the existing Shopify order handler + `shopify-mapper`
   projecting `stitched_anon_id / click_ids / utms`. Deterministic only.
3. **metric-engine journey seam + UI (MANDATORY — stakeholder-visible):** a journey/first-touch surface
   — first-touch channel mix, touchpoints-per-order, **stitch hit-rate**, a touchpoint timeline for an
   order — computed in the metric-engine reading `silver.touchpoint` (the sole read path; non-additive
   math in metric-engine per ADR-004; UI never queries StarRocks). Honest empty + a clear "synthetic (dev)"
   label on any panel backed by synthetic journeys.

## Constraints
- **No new deployable / topic / envelope** (I-E05). Additive migrations + additive dbt marts only;
  non-additive math in metric-engine (ADR-004). dbt is the ETL writer (cross-brand by design, like the
  stream-worker / the order_state staging) — **per-brand isolation is enforced at the metric-engine read
  seam** (`withSilverBrand`), verified NON-INERT (brand A sees 0 of brand B's touchpoints; the mutation
  control must leak when the seam predicate is disabled). StarRocks engine row-policy stays the documented
  prod graduation.
- Replay-safe: re-running dbt yields the same `silver.touchpoint` (idempotent), reproducible from Bronze.
- Deterministic cart-stitch ONLY (read brain_anon_id back; **reject** any probabilistic/ML/fuzzy merge — D-5).
- Dev-honesty: real page.viewed events are thin (94). Prove the pipeline with REAL events; supplement with
  clearly-labelled SYNTHETIC journey fixtures for a richer demo; document the boundary (never fake coverage).

## Non-goals (follow-on)
- Phase 5 Attribution (credit ledger over touchpoints) — this slice produces the touchpoints it will read.
- Real-time stream-worker sessionization (if the architect picks the dbt-mart path now, the streaming path
  is a later optimization). Multi-session-window tuning; view-through. GA4/other journey sources.

## Build tracks (the architect will bind)
@data-engineer (the silver.touchpoint dbt mart: sessionize + first/last-touch from Bronze SDK events;
the cart-stitch map + additive migration; replay/idempotency; brand-scoped read) ∥ @backend-developer
(the metric-engine journey seam over silver.touchpoint — first-touch mix, stitch-hit-rate, touchpoint
timeline; tenant-scoped; register metrics) ∥ @frontend-web-developer (the journey/first-touch UI). Verify
isolation NON-INERT at the read seam + dbt replay-idempotency + deterministic stitch. Reuse the
silver.order_state pattern + the metric-engine Silver seam + the analytics UI.
