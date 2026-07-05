> **SUPERSEDED by the ADR-0010 decommission (2026-07-05).** Bronze landing was cut over to the Kafka
> Connect Iceberg sink (`collector_events_connect` + the per-lane `*_raw_connect` tables) and the
> Spark-SS landing path this document decommissions was removed AT THE CODE LEVEL (bronze_landing /
> bronze_raw_landing / bronze_materialize / combined_bronze_sinks + their run scripts, tests, and the
> PG⇄Iceberg parity oracle are deleted; `BRONZE_SOURCE` no longer exists). The legacy Iceberg tables
> (`brain_bronze.events`, `collector_events`, the per-connector `*_raw`) are **RETAINED as history**
> until a separate data-retirement decision — nothing below should be executed as written. Kept only
> as the historical record of the (never-run) unified-events decommission plan.

# Phase 8 — Unified-Bronze decommission (RUN AFTER BAKE, NOT before)

Prereq: the unified `bronze_landing.py` sink is live (dev: `pnpm dev:up`; prod: the `bronze-landing`
CronWorkflow), `BRONZE_SOURCE=events` is set, and a bake window has confirmed:
- `brain_bronze.events` per-connector counts are stable and match Kafka;
- `silver_collector_event` output (brain_silver.silver_collector_event) is unchanged reading events vs the
  old collector_events (same `(brand_id,event_id)` admitted set — the gate parity check);
- every downstream mart + the health/DQ surfaces read correctly over events;
- **D4 security sign-off** for the collector lane (ungated pixel PII now physically lands in Bronze until
  retention — the same sign-off the raw flip required, now applies to the collector lane too).

Until ALL of the above hold, DO NOT run any step below — the legacy sinks + tables are the rollback path
(`BRONZE_SOURCE=legacy` + revert `tools/dev/dev-bronze-streaming.sh` / the Argo template).

## Step 1 — confirm no reader references remain (guard)
```bash
# Must return ONLY comments / this teardown doc — no live spark.table()/FROM against the old tables.
grep -rn "collector_events\b" db/iceberg/spark apps packages tools | grep -viE "events\b|teardown|# |//|events_raw"
grep -rn "_raw\b" db/iceberg/spark/silver | grep -viE "read_bronze|legacy_table|# "
```

## Step 2 — delete the superseded sink code (removes the rollback path — bake first!)
```
db/iceberg/spark/combined_bronze_sinks.py          # the old two-in-one dev process
db/iceberg/spark/bronze_materialize.py             # collector lane → collector_events
db/iceberg/spark/bronze_raw_landing.py             # 9 raw lanes → *_raw
db/iceberg/spark/bronze_raw_landing_test.py        # tests the deleted raw job
db/iceberg/spark/run-bronze-spike.sh               # run-scripts for the above
db/iceberg/spark/run-bronze-raw-landing.sh
```
(bronze_maintenance.py already imports bronze_landing — no change needed. Confirm nothing else imports
the deleted modules: `grep -rn "import bronze_materialize\|import bronze_raw_landing\|combined_bronze_sinks" db/iceberg/spark`.)

## Step 3 — drop the legacy Bronze tables (irreversible — bake first!)
```sql
-- via Trino (iceberg catalog). Run ONLY after Step 1 shows no readers + the bake is green.
DROP TABLE iceberg.brain_bronze.collector_events;
DROP TABLE iceberg.brain_bronze.shopify_orders_raw;
DROP TABLE iceberg.brain_bronze.woocommerce_orders_raw;
DROP TABLE iceberg.brain_bronze.meta_spend_raw;
DROP TABLE iceberg.brain_bronze.google_spend_raw;
DROP TABLE iceberg.brain_bronze.ga4_rows_raw;
DROP TABLE iceberg.brain_bronze.shiprocket_shipments_raw;
DROP TABLE iceberg.brain_bronze.gokwik_events_raw;
DROP TABLE iceberg.brain_bronze.shopflo_checkout_raw;
DROP TABLE iceberg.brain_bronze.razorpay_settlement_raw;
```

## Step 4 — retire the old checkpoints
Remove the old s3a/`/tmp` checkpoints (`bronze-spike-checkpoint`, `bronze-raw-landing-checkpoint`) — the
unified job uses a single fresh `bronze-landing-checkpoint`.

## Follow-ups NOT part of this decommission
- **G1**: the 7 raw-normalize jobs + `bronze_raw_retention.py` / `erasure_raw_delete.py` read legacy
  struct columns / per-`*_raw`-table identifier columns, not the `payload` JSON. Their events-native
  rewrite (parse identifiers from `payload`, per-`connector` predicates) is tracked separately; until then
  raw Silver marts don't populate and the GDPR raw jobs still target the (now-dropped) *_raw tables — so
  do Step 3 for the `*_raw` tables ONLY after that rewrite, OR keep the raw tables until G1 lands.
