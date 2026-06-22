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
2. **Gold served from Iceberg (now the DEFAULT).** `gold_revenue_ledger` / `gold_marketing_attribution`
   read `brain_bronze.*` via `ledger_source` (default **`iceberg`** — PG is no longer the analytical SoR;
   `ledger_source='pg'` is the reversible escape). Both paths produce **byte-identical** gold (2142 /
   610099183), parity-proven. Full project build green 140/140 (full-refresh AND steady-state incremental).

   **Adapter fix that unblocked the default flip:** the dbt-starrocks `sync_all_columns` schema-sync
   fired on the PG→Iceberg source switch (column type `char(3)`→`string`) and emitted
   `ALTER TABLE … DROP COLUMN … CASCADE`, which StarRocks rejects (`Unexpected input 'cascade'`). Fixed by
   setting `on_schema_change='append_new_columns'` on the incremental ledger marts (never drops →
   no invalid CASCADE). **A source flip / fresh env requires a one-time `--full-refresh`** (the table's
   column types change PG↔Iceberg) + the Iceberg tables populated first (run-ledger-bronze-refresh.sh);
   steady-state incrementals are then clean.

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

## Second mart — gold_marketing_attribution (DONE, same pattern)

`attribution_credit_ledger` → Iceberg `brain_bronze.attribution_credit` via the sibling Spark batch
`attribution_credit_materialize.py` (+ `run-attribution-credit-materialize.sh`), idempotent
`MERGE ON (brand_id, credit_id)`. `gold_marketing_attribution` gained the same `ledger_source` var
('pg' default | 'iceberg'); both paths build clean. The attribution ledger is currently data-starved
(0 rows), so parity is trivially 0==0 and the table is established for when journeys flow — the flip is
the same one-var operational step as the revenue mart, gated on the same parity bake.
