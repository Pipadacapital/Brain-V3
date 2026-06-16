# Connector Ingestion — Epic / North-Star Plan

> Submitted by rishabhporwal 2026-06-17 via /requirement. This is the COMPLETE end-to-end
> connector-ingestion architecture (BRD 01, Functional Spec 02, Architecture 04, Contracts 06/07/08).
> It is an EPIC, decomposed into shippable slices. ~Half the spine is already shipped (see status).

## Shape
Connect (OAuth/creds) → Collector (accept→spool→ack) → Redpanda → Stream-worker
  → Bronze (Iceberg/S3, raw, 24mo) → dbt → Silver (canonical) → Gold (ledgers)
  → Analytics API → dashboards/AI/MCP
Governing principle: the SAME code path runs live ingestion and historical backfill — only the lane (topic + consumer group) differs.

## Status of the 10 sections
- §4 Collector accept-before-validate + spool + Redpanda · §6 Bronze — SHIPPED (feat-data-plane-ingest-spine)
- §5 envelope (event_id uuidv7, brand_id), dedup (brand_id,event_id), per-brand salt, brain_id_alias read-time re-point — SHIPPED (feat-identity-graph + spine)
- §6 Gold realized_revenue_ledger · §7 two-pass recognition + dual-date + clawback-by-reversal — SHIPPED (feat-realized-revenue-ledger)
- §6→Analytics metric engine (sole emitter, parity-gated) — SHIPPED (feat-metric-engine-parity)
- §9 isolation (brand_id envelope, RLS, isolation-fuzz) — SHIPPED (enforced across all slices)
- §1 Connect (Shopify OAuth + token storage) — PARTIAL (Shopify spike; SHOPIFY-VALIDATE-01 parked)
- REMAINING SLICES (each a high-stakes /requirement):
  1. Analytics API + dashboard — read-only GET /metrics?metric_id=realized_revenue → dashboard renders the number (or honest "no data yet"). COMPLETES the M1 vertical spine (the reconciling number ON SCREEN).
  2. Connector module + Integration Marketplace UI — generalized OAuth/creds connect/disconnect/refresh for Phase-1a sources; per-brand KMS token storage; 7 connector health states; truthful tiles.
  3. Shopify deep connector — real OAuth + backfill (Argo, 2-lane prod.backfill.*) + live-sync (webhooks 95%<30s, polling+cursor, late-data re-pull 35d orders) → real orders to Bronze→ledger.
  4. Razorpay-with-settlement (§7) — settlement-file ingestion, fees-net finalization, the realization horizon from actual settlement (Phase-1a must-have for an honest bill).
  5. Meta + Google Ads connectors (§3 polling+cursor spend) — spend truth.
  6. Silver layer (dbt/StarRocks canonical tables: order_state, settlement, shipment, marketing_spend) + rest of Gold (attribution_credit_ledger, channel_contribution, order_margin_fact).
  7. Connector health + tracking-dark detector + DQ gating (A+→D) (§8).
  8. Backfill progress UX + GET /connectors/{id}/jobs (§2).
  9. Marketplace phasing / "Coming Soon" stubs (§10).

## Phasing (from §10)
- Phase 1a deep: Shopify, Meta, Google Ads, Razorpay-with-settlement.
- Phase 1c deep: WooCommerce, Shiprocket/Delhivery, WhatsApp Cloud API, Klaviyo, GA4, HubSpot.
- 100+ catalogue: honest "Coming Soon" stubs. Phase 5: GCC (Salla/Zid/Noon/Tabby/Tamara).

## Full original submission
(see decision-log intake + the /requirement command args of 2026-06-17)
