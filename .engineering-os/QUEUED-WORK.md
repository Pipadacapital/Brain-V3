# Queued work (Stakeholder-approved, run in order)

1. **Shopify validate-sync spike (SHOPIFY-VALIDATE-01)** — PARKED 2026-06-16 by rishabhporwal,
   blocked on Shopify store access (not available at queue time). The de-risking spike for
   the M1 ingestion build: confirm we can pull real Boddactive order/refund data and that its
   shape matches what Bronze + the realized-revenue ledger will need, BEFORE building the
   Collector→Bronze pipeline.
   - Code is already built + committed on branch `feat/shopify-sync-validation`
     (commit `c981c96`): `ISecretsManager.getShopifyToken`, `ShopifyAdminClient`, the dev-only
     `GET /api/v1/dev/shopify/validate-sync` (NODE_ENV != production), and the standalone
     `tools/shopify-spike/pull-orders.mjs`. Typecheck green; NOT yet run against a real store.
   - To unblock: whitelist `http://localhost:3001/api/v1/connectors/shopify/callback` in the
     "Codebiba X Bodd" Shopify app, connect Boddactive via Settings → Connectors, then hit
     `GET /api/v1/dev/shopify/validate-sync` (the in-memory dev token requires connecting AFTER
     core last restarted). Report: currency/timezone, `financial_status` mix (COD signal),
     refund shape, payment gateways, customer email/phone coverage, order volume.
   - Findings feed the ingestion design (identity core + realized-revenue ledger, M1 steps 5–6).
   - Resume: `git checkout feat/shopify-sync-validation`, reconnect store, run the endpoint.

## Completed

1. ✅ **Dev email-token surfacing (LOW-DEV-TOKEN-01)** — done 2026-06-16 on branch
   `feat/dev-email-token` (merged to master). Backend captures the verify/reset/invite token at
   send time (in-memory, dev-only) and exposes `GET /api/v1/dev/last-email-link?email=` — gated
   to NODE_ENV != production. `/verify-email` shows a one-click "Verify now (dev)" button. Also
   fixed a latent prod bug: the verify/reset/invite email links pointed at 404 paths.
