# Requirement: Ad Connectors (Meta + Google Ads) — Slice 1: connect + spend ingestion + Spend/ROAS UI

| Field | Value |
|-------|-------|
| **req_id** | `feat-ad-connectors` |
| **Title** | Meta Ads + Google Ads deep connectors — OAuth connect + trailing-window spend/hierarchy ingestion + a Spend/ROAS UI |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-18T02:21:09Z |
| **Lane** | high_stakes (connectors, money, multi_tenancy, pii, secrets/oauth, schema_proto, outbound) |
| **Source research** | `docs/data-collection-platform/research-ad-platforms.md` (branch docs/ad-platforms-research) |

## Why now

The Phase-1a "spend truth" connectors. Shopify (orders) + Razorpay (settlement) are shipped;
Meta + Google Ads bring **ad spend + campaign performance** — the other half of the unit
economics (ROAS/CAC). This is **Slice 1**: connect + spend ingestion + a stakeholder-visible
Spend/ROAS surface. CAPI / conversion-feedback + full click-id→order attribution are a
**follow-on slice** (consent-heavy).

## The research that drives the design (verified)

- **Restatement = the COD re-pull pattern again.** Spend is fixed at click time; conversions
  RESTATE (back-attribute to the click date over the conversion window — Google 1–90d default
  30d; Meta up to 28d-click). → a **trailing ~28-day re-read cursor**, identical to the
  Shopify/Razorpay re-pull we shipped. The cursor is never "final" inside the window.
- **Google throttling:** daily ops-quota by token tier (Explorer 2,880/day) + per-CID/per-token
  QPS bucket. Branch on `RESOURCE_EXHAUSTED` (daily) vs `RESOURCE_TEMPORARILY_EXHAUSTED` (QPS).
  `GoogleAdsService.SearchStream`, 1 query = 1 op, OAuth + approved developer token.
- **Meta:** Ads Insights API; Jan-2026 removes 7d/28d view-through windows → build against the
  surviving set; tiered retention bounds backfill depth.
- **Metric choice:** Google `metrics.conversions` vs `all_conversions`, click-date vs
  conversion-date anchored — store raw in Bronze, pick canonical in Silver/Gold.

## Deliverables (Slice 1)

1. **Connect (OAuth) for Meta + Google Ads** — flip the catalog entries (`meta`, `google_ads`)
   from `coming_soon` → `available`; register their OAuth dispatch (the dispatch table is
   OAuth-only today — Shopify is registered; add Meta + Google); the OAuth callback exchanges
   the code for tokens, brand from the signed state (never the body), tokens stored via the
   secrets seam (never logged), connector_instance created (provider='meta'|'google_ads').
2. **Spend ingestion (the trailing re-pull):** a stream-worker job per platform — a paged/
   streamed API client (Meta Insights / Google SearchStream) + a **trailing ~28-day re-read**
   cursor in connector_cursor (per connector, brand), overlap-locked, throttle-aware
   (Google two-error backoff). Canonical mapping: campaign/adset(ad group)/ad/creative
   hierarchy + spend (BIGINT minor units + currency, timezone-aware) → Bronze (raw) → the
   ledger/spend (append-only). Reuse the Shopify/Razorpay re-pull + SECURITY DEFINER
   enumeration patterns.
3. **Spend/ROAS UI (MANDATORY — stakeholder-visible):** the marketplace Meta/Google tiles
   become connectable (OAuth flow); a **Spend / ROAS analytics section** (spend over time by
   platform/campaign, blended with realized revenue for a first ROAS read) — reuse the
   analytics UI (shadcn/Recharts/KpiTile, BFF + metric-engine sole-read-path, honest empty).

## Constraints

- **Reuse the connector framework** — connector_instance/cursor/sync_status, the trailing-window
  re-pull job pattern, the OAuth dispatch, the secrets seam, the marketplace. **No new
  deployable/topic/envelope.** Additive migrations only.
- Per-brand isolation (RLS FORCE, verify under brain_app); money BIGINT minor units (no float);
  PII/ad-identifiers hashed at the boundary; tokens never logged; consent/DPDP respected.
- **Dev-honesty:** real OAuth needs real app credentials + public callback (platform follow-up);
  in dev prove the connect + the ingestion with the test/sandbox accounts or synthetic fixtures,
  and be HONEST about the dev boundary (as Shopify/Razorpay were).

## Non-goals (follow-on slices)

- CAPI / Google Enhanced Conversions / offline conversion **upload** (the feedback loop — consent-heavy).
- Full click-id→order **deterministic attribution** join (depends on the pixel/collection — Phase 4/5).
- SKAN/iOS-ATT modeling; incrementality. Non-Meta/Google ad platforms (TikTok/Snap/Pinterest).

## Build tracks (the architect will bind)

@backend-developer (OAuth connect + callback + token storage + catalog/dispatch wiring) ∥
@data-engineer (the per-platform sync jobs + API clients + trailing-window cursor + canonical
mapping + spend ledger + migration) ∥ @frontend-web-developer (the connectable tiles + the
Spend/ROAS UI). Verify isolation under brain_app. Reuse the connector-lifecycle fixtures.
