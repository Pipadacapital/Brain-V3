#!/usr/bin/env bash
#
# insights-demo-seed.sh — light up the Insight + Opportunity Engine / AI Copilot (/insights) with a
# coherent demo dataset, seeded into the V4 Gold lakehouse the engine's serving layer reads.
#
# ── BRAIN V4 (Phase 4/6b) ────────────────────────────────────────────────────────────────────────
# The dbt-internal StarRocks DB `brain_gold` is RETIRED. In V4 Gold is computed by Spark into the
# Iceberg Gold catalog (brain_gold_local.brain_gold.*) and SERVED to the app by the StarRocks async
# materialized views brain_serving.mv_gold_* (the metric-engine read path: withSilverBrand ->
# brain_serving.mv_gold_* -> metric-engine -> /api/v1/insights/briefing). So this seeder writes the
# Iceberg Gold base tables directly (via StarRocks' external Iceberg catalog) and then SYNC-refreshes
# the serving MVs so the briefing reflects the demo rows immediately — exactly the v4-refresh path.
#
# WHY DIRECT-TO-GOLD: the full medallion pipeline (Bronze Iceberg -> Silver -> Gold via Spark) needs a
# populated Bronze + the `brain_oltp_pg` StarRocks external catalog, which a fresh local box may not
# have. This seeder exercises the EXACT production read path with demo data — the same pattern the
# *.live tests use. It is a DEV/DEMO aid, not a substitute for the real pipeline (a Spark Gold build +
# `pnpm dev:v4-refresh` overwrites these tables and the MVs on the next cycle).
#
# Usage:
#   tools/seed/insights-demo-seed.sh <BRAND_UUID>
# Get a BRAND_UUID by registering + onboarding in the app, or:
#   docker exec brainv3-postgres-1 psql -U brain -d brain -tAc "SELECT brand_id FROM tenancy.brand LIMIT 1;"
set -euo pipefail

# MK-1..MK-4: seeds must NEVER masquerade as real data and must NEVER run in production.
[[ "${APP_ENV:-dev}" == prod* ]] && { echo "refusing: $0 writes synthetic demo data and must not run in production (APP_ENV=$APP_ENV)" >&2; exit 1; }

BRAND="${1:-}"
if [[ -z "$BRAND" ]]; then echo "usage: $0 <BRAND_UUID>" >&2; exit 2; fi
SR="docker exec -i brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot"

# V4 Gold catalog (external Iceberg) + serving DB (async MVs). Overridable for prod (Glue) parity.
GOLD_CATALOG="${GOLD_ICEBERG_CATALOG:-brain_gold_local}.brain_gold"
SERVING_DB="${SERVING_DB:-brain_serving}"

echo "Seeding /insights demo data for brand $BRAND into ${GOLD_CATALOG} (V4 Iceberg Gold) ..."

$SR <<SQL
-- Every mart carries a data_source column so synthetic demo rows are distinguishable from real ones
-- (MK-1..MK-4). The seeder stamps data_source='synthetic'; the /insights briefing aggregates this
-- synthetic-if-any and badges the surface. A real Spark Gold build overwrites these rows.
--
-- The Iceberg Gold base tables already exist (created by the Spark Gold jobs / Phase-2 DDL). We do NOT
-- create/alter them here (additive-only, never reshape the medallion). We write COLUMN-EXPLICIT INSERTs
-- against the real schemas so a column add never breaks this seeder.

-- Idempotent: clear any prior demo rows for this brand.
DELETE FROM ${GOLD_CATALOG}.gold_revenue_ledger   WHERE brand_id='$BRAND' AND data_source='synthetic';
DELETE FROM ${GOLD_CATALOG}.gold_executive_metrics WHERE brand_id='$BRAND' AND data_source='synthetic';
DELETE FROM ${GOLD_CATALOG}.gold_customer_scores   WHERE brand_id='$BRAND' AND data_source='synthetic';
DELETE FROM ${GOLD_CATALOG}.gold_cac               WHERE brand_id='$BRAND' AND data_source='synthetic';

-- Revenue: net prior ₹11.8L -> cur ₹9.676L (-18.0%); biggest driver = rto_reversal.
-- Money is bigint MINOR units + currency_code (never a float); brand_id is the tenant key.
INSERT INTO ${GOLD_CATALOG}.gold_revenue_ledger
 (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code, fee_minor,
  occurred_at, economic_effective_at, recognition_label, billing_posted_period, ingested_at, data_source, updated_at)
VALUES
 ('$BRAND','demo-p1','demo-o1',NULL,'provisional_recognition', 120000000,'INR',0, DATE_SUB(NOW(), INTERVAL 45 DAY), DATE_SUB(NOW(), INTERVAL 45 DAY),'provisional',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY),'%Y-%m'),NOW(),'synthetic',NOW()),
 ('$BRAND','demo-p2','demo-o1',NULL,'rto_reversal',             -2000000,'INR',0, DATE_SUB(NOW(), INTERVAL 44 DAY), DATE_SUB(NOW(), INTERVAL 44 DAY),'finalized', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 44 DAY),'%Y-%m'),NOW(),'synthetic',NOW()),
 ('$BRAND','demo-c1','demo-o2',NULL,'provisional_recognition', 118000000,'INR',0, DATE_SUB(NOW(), INTERVAL 15 DAY), DATE_SUB(NOW(), INTERVAL 15 DAY),'provisional',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 15 DAY),'%Y-%m'),NOW(),'synthetic',NOW()),
 ('$BRAND','demo-c2','demo-o2',NULL,'rto_reversal',            -21240000,'INR',0, DATE_SUB(NOW(), INTERVAL 12 DAY), DATE_SUB(NOW(), INTERVAL 12 DAY),'finalized', DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 12 DAY),'%Y-%m'),NOW(),'synthetic',NOW());

-- Exec: RTO 80/400 = 20%; AOV ₹5,000 -> leaked ₹4.0L.
INSERT INTO ${GOLD_CATALOG}.gold_executive_metrics
 (brand_id, currency_code, total_orders, realized_value_minor, distinct_customers, terminal_orders,
  delivered_orders, rto_orders, cancelled_orders, refunded_orders, data_source, updated_at)
VALUES ('$BRAND','INR', 430, 215000000, 380, 400, 320, 80, 20, 10,'synthetic',NOW());

-- CAC: ₹10,000 (2026-05) -> ₹12,500 (2026-06) = +25% MoM.
INSERT INTO ${GOLD_CATALOG}.gold_cac
 (brand_id, acquisition_month, currency_code, new_customers, acquisition_spend_minor, data_source, updated_at)
VALUES
 ('$BRAND','2026-06','INR', 40, 50000000,'synthetic',NOW()),
 ('$BRAND','2026-05','INR', 40, 40000000,'synthetic',NOW());
SQL

# 12 high-churn customers (sum LTV ₹8.7L) + 8 VIPs (monetary_score=5, sum LTV ₹12L).
{
  for i in $(seq 1 12); do
    if [[ $i -le 6 ]]; then ltv=7000000; else ltv=7500000; fi
    echo "INSERT INTO ${GOLD_CATALOG}.gold_customer_scores (brand_id, brain_id, currency_code, scored_on, lifetime_orders, lifetime_value_minor, days_since_last_order, recency_score, frequency_score, monetary_score, churn_risk, data_source, computed_at) VALUES ('$BRAND','demo-churn-$i','INR',CURDATE(),2,$ltv,200,1,2,2,'high','synthetic',NOW());"
  done
  for i in $(seq 1 8); do
    echo "INSERT INTO ${GOLD_CATALOG}.gold_customer_scores (brand_id, brain_id, currency_code, scored_on, lifetime_orders, lifetime_value_minor, days_since_last_order, recency_score, frequency_score, monetary_score, churn_risk, data_source, computed_at) VALUES ('$BRAND','demo-vip-$i','INR',CURDATE(),8,15000000,10,5,4,5,'low','synthetic',NOW());"
  done
} | $SR

# SYNC-refresh the serving MVs so the /insights briefing (which reads brain_serving.mv_gold_*) reflects
# the demo rows immediately — the same deterministic refresh tools/dev/v4-refresh-loop.sh performs.
for mv in mv_gold_revenue_ledger mv_gold_executive_metrics mv_gold_customer_scores mv_gold_cac; do
  $SR -e "REFRESH MATERIALIZED VIEW ${SERVING_DB}.${mv} WITH SYNC MODE;" 2>/dev/null \
    && echo "  ✓ refreshed ${SERVING_DB}.${mv}" \
    || echo "  ⚠ could not refresh ${SERVING_DB}.${mv} (does the MV exist? run the mv/ DDL)"
done

echo "Done. Open http://localhost:3000/insights (logged in as that brand) to see the briefing."
