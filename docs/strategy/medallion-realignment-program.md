# Brain — Medallion Realignment Program (destructive re-platform)

**Authorized:** 2026-06-24. Make the implementation strictly match the stated medallion architecture;
**delete the wrong implementation + data** once each correct replacement is verified. Decisions taken:
- **B = remove revenue from PostgreSQL entirely** (billing/invoicing also reads the lakehouse).
- **C = rebuild identity on Neo4j as the system-of-record** (supersede ADR-0003).

## Method — sequenced build → cut-over → delete (never big-bang)

Each epic: (1) build the correct lakehouse/Neo4j implementation, (2) verify at parity on the real
Bronze data, (3) cut readers over, (4) **then delete** the wrong implementation + its PG data. The app
stays working throughout; dev data is disposable, so deletions are cheap once readers are cut over.
**The money path (revenue/invoicing) is deleted only after the lakehouse SoR is proven at parity.**

Grounding fact: Bronze already holds the raw commerce events — `brain_bronze.collector_events` contains
`order.live.v1` (999), `gokwik.awb_status.v1` (245), pixel events. So Silver can be rebuilt FROM Bronze;
no new ingestion is required.

## Epic 1 — Revenue & recognition: Silver-from-Bronze, remove from PG  *(keystone)*
1. `stg_order_events` — parse `order.live.v1` from `bronze_iceberg.collector_events` (this slice).
2. `silver_order_recognition` — recognition AS a Silver transform over Bronze: provisional (on order
   event), prepaid finalization (occurred_at + prepaid horizon, no reversal), COD recognition (join
   `gokwik.awb_status.v1`/shipment delivered), reversals (financial_status refunded/cancelled, RTO).
   Brand horizons read from `tenancy.brand` via the JDBC catalog (operational config — legitimately PG).
3. Cut `gold_revenue_ledger` + `silver_order_state` to read `silver_order_recognition` (not the PG shim).
4. Rewrite GMV metering / invoicing to read the lakehouse revenue entity.
5. **Delete:** `billing.realized_revenue_ledger` (+ partitions), `ad_spend_ledger`, `tax_ledger`, the
   measurement-module PG writers (`PgLedgerRepository`, `LedgerWriter`), the `revenue-finalization` job,
   migrations' PG-ledger DDL. Verify parity oracle green before each delete.

## Epic 2 — Attribution: Silver/Gold transform, delete PG ledger
Port the deterministic + Markov math (`@brain/metric-engine`, already pure) into a Silver/Gold transform
over `silver_touchpoint` + the new Silver orders → `gold_marketing_attribution`. **Delete:**
`billing.attribution_credit_ledger`, `reconcile-attribution` + data-driven jobs, `@brain/attribution-writer`
PG path, migrations 0096/0097's PG-ledger dependence.

## Epic 3 — Identity: Neo4j SoR, delete PG identity
Rewrite `IdentityResolver` to write Neo4j (deterministic merge + per-brand isolation), build Neo4j
readers (Customer 360, list-customers, merge-admin, erase-customer, `silver_customers`/`gold_customer_*`,
the journey stitch). Migrate brain_ids. **Delete:** `identity.*` PG tables + the `IdentityRepository` PG
path; supersede ADR-0003. Largest/riskiest — staged last.

## Epic 4 — Cleanup
Stitch → Silver entity (anon↔order via the Neo4j graph), delete `connector_journey_stitch_map` + the
stitch job. Move materialized ledgers out of the `brain_bronze` namespace into Silver. `ml.prediction_log`
→ lakehouse; drop the redundant PG `dq_check_result` copy; drop StarRocks `*__dbt_backup` cruft.

## Order of operations
Epic 1 → Epic 2 (depends on Silver orders) → Epic 4 stitch needs Epic 3 → Epic 3 (identity, independent
but largest). Each epic is multiple commits; nothing destructive lands before its replacement is verified.
