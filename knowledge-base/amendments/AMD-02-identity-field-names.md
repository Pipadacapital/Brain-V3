<!-- SPEC: 0.4 -->
# AMD-02 — Identity field names (A.1.4)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-06, WA-09

## Conflicting spec text
> §A.1.4 "Each connector […] writes `email_sha256`, `phone_sha256`, `platform_customer_id` into the Silver canonical envelope (new optional Avro fields, BACKWARD)."

## Ground truth (delta-plan evidence)
Live names are `hashed_customer_email` / `hashed_customer_phone` / `storefront_customer_id` across the resolver + Silver jobs (shopify-mapper/index.ts:412–446, woocommerce-mapper/index.ts:313–389, gokwik-mapper/index.ts:145–155, silver_shopify_order_normalize.py:74–123). Shopflo additionally carries legacy names `customer_email_hash`/`phone_hash` (shopflo-mapper/index.ts:255–288). A canonical `pre_hashed_identifiers` slot exists but is populated by ZERO mappers.

## Candidate resolutions
### R1 — Amend spec to adopt the existing names (adopted)
Keep `hashed_customer_email` / `hashed_customer_phone` / `storefront_customer_id` as the canonical names; move all 4 mappers onto the canonical `pre_hashed_identifiers` slot as the single carrying mechanism; unify Shopflo's legacy names onto the convention. Interop-space plain hashes (AMD-01) get their own `pre_hashed_*` identifier types.
- Trade-offs: spec vocabulary diverges from mParticle-style names; documented mapping needed in Wave D semantic layer.

### R2 — Introduce spec names verbatim
Creates a second parallel namespace in identity links plus a migration of every existing link row and stitch key.
- Trade-offs: duplicate fields for the same value, migration risk on a live graph, violates additive rule in spirit.

## RECOMMENDED resolution (BINDING)
**R1.** Additive (no rename of live fields), preserves all existing identity links; the only change is convergence onto the already-existing canonical slot.
