<!-- SPEC:C.2.4 -->
# AMD-24 — `gold_product_costs`: PG upload SOURCE vs Iceberg COGS DIMENSION

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-07
**Relates:** Wave C · C.2.4 (COGS cost sheet) — WC-C4 (upload path) × WC-C2/C3 (measurement facts)

## The collision (two objects, one name — discovered on the shared branch)
Wave C landed **two** `gold_product_costs`, in different catalogs, from two parallel agents:

1. **PG `public.gold_product_costs`** (this WC-C4 delivery — `db/migrations/0126_gold_product_costs.sql`):
   the brand-uploaded, bi-temporal, versioned per-SKU cost sheet fed by the CSV ingest endpoint
   `POST /api/v1/costs/product-sheet`. Schema is the **spec C.2.4 contract verbatim**:
   `{brand_id, sku, cost_minor, currency_code, valid_from, valid_to}` (+ lineage + RLS + no-overlap EXCLUDE).

2. **Iceberg `brain_gold.gold_product_costs`** (WC-C2/C3 sibling — `db/iceberg/spark/gold/gold_product_costs.py`,
   view `db/trino/views/mv_gold_product_costs.sql`): the materialized COGS **dimension** that
   `gold_measurement_costs.py` / `gold_order_economics.py` join order lines against. It emits the SAME
   spec columns (`cost_minor, currency_code, valid_from, valid_to`) but currently **sources from
   `billing.cost_input WHERE scope='sku' AND cost_type='cogs'`** — and its own docstring states: *"a
   future … CSV cost-sheet ingest lands the SAME rows."*

There is **no physical clash** (distinct catalogs) and **no schema conflict** (both carry the spec
contract). The only gap: the Iceberg dimension's ETL does not yet read the PG cost sheet, so brand CSV
uploads do not yet flow into COGS.

## Candidate resolutions
### R1 — Two-layer: PG cost sheet is the SOURCE, Iceberg is the materialized DIMENSION (adopted)
- Keep both, exactly as the ad_spend precedent (PG `ad_spend` write-SoR → `silver_marketing_spend`
  read dimension). PG `gold_product_costs` is the app-written **source of record** for brand-uploaded
  unit costs; Iceberg `brain_gold.gold_product_costs` is the Spark-materialized **serving/COGS
  dimension** with the identical spec schema.
- **Convergence wiring (one additive line, owned by the Iceberg-dimension job / Wave D):** the Spark
  `gold_product_costs.py` source query should read the PG cost sheet
  (`SELECT brand_id, sku, cost_minor, currency_code, valid_from, valid_to FROM public.gold_product_costs`)
  and UNION it with the `billing.cost_input`-derived rows (cost-sheet rows WIN on the same
  (brand, sku, currency, validity) — an explicit upload is more authoritative than a rate default).
  This is purely additive (adds a source; removes nothing) and is left to the dimension's owner to fold
  in to avoid a cross-agent edit race on a live shared file.
- Trade-off: same name in two stores can read as a duplicate on a naive grep — mitigated by this AMD +
  the migration/service headers naming the relationship.

### R2 — Rename the PG table (e.g. `product_cost_sheet`)
- Trade-off: diverges from the spec, which names the CSV-ingest table `gold_product_costs` and gives it
  exactly the PG table's schema; and the PG table is already applied + covered by tests/endpoint.

## RECOMMENDED resolution (BINDING)
**R1.** Both objects stand; the PG table is the upload source of record, the Iceberg table is the
materialized COGS dimension. The dimension's ETL folds in the PG cost sheet as an additive UNION
(cost-sheet-wins) at integration time — no revenue/parity impact (C.4 deltas come from captured costs,
per `knowledge-base/gates/wave-c-c4-parity-note.md`).
