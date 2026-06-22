# H2 — Land the ledger in Iceberg Bronze; serve Gold from the lakehouse

DB-AUDIT H2 goal: PostgreSQL stops being the *analytical* source of truth for the realized-revenue
ledger. PG remains the transactional WRITE SoR (the stream-worker appends there); the analytical marts
read the lakehouse.

## What shipped (reversible, parity-proven)

1. **Ledger → Iceberg Bronze.** `db/iceberg/spark/revenue_ledger_materialize.py` (+ run script
   `run-revenue-ledger-materialize.sh`) is a Spark batch that materializes PG
   `billing.realized_revenue_ledger` → Iceberg `brain_bronze.revenue_ledger` with an idempotent
   `MERGE ON (brand_id, ledger_event_id)` (immutable rows; re-run never double-writes). Verified:
   2142 rows landed, exact parity with PG (count + signed `SUM(amount_minor)` = 610099183).
2. **Gold served from Iceberg (flag-gated).** `gold_revenue_ledger` gained a `ledger_source` var:
   - `ledger_source='pg'` (DEFAULT) → JDBC read-shim over PG (current behavior; money metric-engine
     reads stay green).
   - `ledger_source='iceberg'` → `brain_bronze.revenue_ledger` (PG no longer the analytical SoR).
   Both paths produce **byte-identical** gold (validated: 2142 / 610099183 either way). Default stays
   `pg` so nothing flips until the operational bake below — the same reversible rollout the Bronze-flip
   epic (RB-5) used.

## Operational flip (when ready)

1. Schedule `revenue_ledger_materialize.py` continuously (Argo CronWorkflow — same shape as
   `bronze_maintenance`), so the Iceberg copy stays fresh. (The fully event-sourced path — worker emits
   `ledger.event.v1` to the live topic, Spark streams it — is the later evolution; the batch materializer
   is the reversible first step.)
2. Bake the parity oracle for a window: `gold_revenue_ledger` built from `iceberg` must equal the `pg`
   build (count + per-brand signed sum). Already green in dev.
3. Flip `ledger_source=iceberg` (dbt var / env). The money metric-engine reads (`cod-mix`,
   `settlement-summary`, `blended-roas`) ride `gold_revenue_ledger`, so they follow automatically.
4. After the bake, the PG JDBC read-shim `silver_order_ledger_src` is analytics-dead (PG keeps only the
   write path).

## Follow-up (same proven pattern)

`gold_marketing_attribution` reads `attribution_credit_ledger` (currently data-starved — 0 rows). Applying
H2 to it is mechanical: a sibling materializer (`attribution_credit_ledger` → `brain_bronze.attribution_credit`)
+ the same `ledger_source` flip on that mart. Deferred only because there is no data to bake parity against yet.
