# Feature Journal — feat-shopify-live-connector

> Deep Shopify LIVE connector: order webhooks (HMAC-first, primary) + COD 35-day re-pull (catch-up), both landing on the generic live streaming substrate (dev.collector.event.v1 → stream-worker-live → Bronze → ledger → dashboard). Shopify is the first source wired to the shared lane.

## 2026-06-17T20:40:00Z — Stage 2 Architecture (binding) — Architect
**Artifact:** 03-architecture-plan.md · **Paradigm:** tier-0 deterministic ($0/mo). All D-1..D-14 resolved.
**Bound seams (one-line ADRs):** A0 @brain/shopify-mapper pkg (frozen, first commit) · webhook receiver in core (direct-produce live lane, HMAC-first, SECURITY-DEFINER brand resolution) · registration dev-stub · re-pull job (SECURITY-DEFINER enumeration, SKIP-LOCKED overlap, resource='orders.repull', updated_at_min=now-35d, live lane) · LedgerWriter.writeReversal (D-13 new) · live-lane = generic substrate.
**D-6 (make-or-break):** per-state composite live event_id uuidV5FromOrderLive(brand,order,updatedAtMs) — distinct updated_at → distinct Bronze row (status changes land); backfill keeps its own namespace (no collision); Bronze insert-if-absent UNCHANGED; the LEDGER nets backfill+live rows via signed-sum.
**D-4:** SECURITY-DEFINER resolve_connector_by_shop_domain → brand_id from row, header=lookup-key-only post-HMAC; no connector→401.
**D-7:** SECURITY-DEFINER list_connectors_for_repull + GUC-after + no-GUC negative control (count===0 under brain_app).
**D-13:** ledger allows rto_reversal + realized_gmv_as_of subtracts it but NOTHING writes it today → new writeReversal (negative row, append-only, sale untouched).
**Migration:** 0026 (2 SECURITY DEFINER fns, additive, no table change).
**Tracks:** A@data-engineer(lead) ∥ B@backend-developer ∥ C@frontend-web-developer. A0 first → A∥B∥C. COMMIT PER SLICE.
**Decision:** GO for builders — Stage 3.
