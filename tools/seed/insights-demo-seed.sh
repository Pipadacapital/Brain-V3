#!/usr/bin/env bash
#
# insights-demo-seed.sh — light up the Insight + Opportunity Engine / AI Copilot (/insights) with a
# coherent demo dataset, seeded DIRECTLY into the StarRocks gold marts the engine reads.
#
# WHY DIRECT-TO-GOLD: the full medallion pipeline (Bronze Iceberg -> Silver -> Gold via dbt) needs a
# populated Bronze + the `brain_oltp_pg` StarRocks external catalog, which a fresh local box does not
# have. This seeder exercises the EXACT production read path (withSilverBrand -> brain_gold.* ->
# metric-engine -> /api/v1/insights/briefing) with demo data — the same pattern the *.live tests use.
# It is a DEV/DEMO aid, not a substitute for the real pipeline (which overwrites these tables on build).
#
# Usage:
#   tools/seed/insights-demo-seed.sh <BRAND_UUID>
# Get a BRAND_UUID by registering + onboarding in the app, or:
#   docker exec brainv3-postgres-1 psql -U brain -d brain -tAc "SELECT brand_id FROM tenancy.brand LIMIT 1;"
set -euo pipefail

BRAND="${1:-}"
if [[ -z "$BRAND" ]]; then echo "usage: $0 <BRAND_UUID>" >&2; exit 2; fi
SR="docker exec -i brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot"

echo "Seeding /insights demo data for brand $BRAND ..."

$SR <<SQL
CREATE TABLE IF NOT EXISTS brain_gold.gold_revenue_ledger (
  brand_id varchar(36), ledger_event_id varchar(64), currency_code varchar(8),
  event_type varchar(48), amount_minor bigint, occurred_at datetime
) ENGINE=OLAP DUPLICATE KEY(brand_id) DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES("replication_num"="1");
CREATE TABLE IF NOT EXISTS brain_gold.gold_executive_metrics (
  brand_id varchar(36), currency_code varchar(8), realized_value_minor bigint,
  total_orders bigint, terminal_orders bigint, rto_orders bigint
) ENGINE=OLAP DUPLICATE KEY(brand_id) DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES("replication_num"="1");
CREATE TABLE IF NOT EXISTS brain_gold.gold_customer_scores (
  brand_id varchar(36), brain_id varchar(64), currency_code varchar(8),
  lifetime_value_minor bigint, monetary_score int, churn_risk varchar(16)
) ENGINE=OLAP DUPLICATE KEY(brand_id) DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES("replication_num"="1");
CREATE TABLE IF NOT EXISTS brain_gold.gold_cac (
  brand_id varchar(36), currency_code varchar(8), acquisition_month varchar(7),
  new_customers bigint, acquisition_spend_minor bigint
) ENGINE=OLAP DUPLICATE KEY(brand_id) DISTRIBUTED BY HASH(brand_id) BUCKETS 1 PROPERTIES("replication_num"="1");

-- Idempotent: clear any prior demo rows for this brand.
DELETE FROM brain_gold.gold_revenue_ledger   WHERE brand_id='$BRAND';
DELETE FROM brain_gold.gold_executive_metrics WHERE brand_id='$BRAND';
DELETE FROM brain_gold.gold_customer_scores   WHERE brand_id='$BRAND';
DELETE FROM brain_gold.gold_cac               WHERE brand_id='$BRAND';

-- Revenue: net prior ₹11.8L -> cur ₹9.676L (-18.0%); biggest driver = rto_reversal.
INSERT INTO brain_gold.gold_revenue_ledger VALUES
 ('$BRAND','p1','INR','provisional_recognition', 120000000, DATE_SUB(NOW(), INTERVAL 45 DAY)),
 ('$BRAND','p2','INR','rto_reversal',             -2000000, DATE_SUB(NOW(), INTERVAL 44 DAY)),
 ('$BRAND','c1','INR','provisional_recognition', 118000000, DATE_SUB(NOW(), INTERVAL 15 DAY)),
 ('$BRAND','c2','INR','rto_reversal',            -21240000, DATE_SUB(NOW(), INTERVAL 12 DAY));

-- Exec: RTO 80/400 = 20%; AOV ₹5,000 -> leaked ₹4.0L.
INSERT INTO brain_gold.gold_executive_metrics VALUES ('$BRAND','INR', 215000000, 430, 400, 80);

-- CAC: ₹10,000 (2026-05) -> ₹12,500 (2026-06) = +25% MoM.
INSERT INTO brain_gold.gold_cac VALUES
 ('$BRAND','INR','2026-06', 40, 50000000),
 ('$BRAND','INR','2026-05', 40, 40000000);
SQL

# 12 high-churn customers (sum LTV ₹8.7L) + 8 VIPs (monetary_score=5, sum LTV ₹12L).
{
  for i in $(seq 1 12); do
    if [[ $i -le 6 ]]; then ltv=7000000; else ltv=7500000; fi
    echo "INSERT INTO brain_gold.gold_customer_scores VALUES ('$BRAND','churn-$i','INR',$ltv,2,'high');"
  done
  for i in $(seq 1 8); do
    echo "INSERT INTO brain_gold.gold_customer_scores VALUES ('$BRAND','vip-$i','INR',15000000,5,'low');"
  done
} | $SR

# brain_analytics is the app's read user — ensure it can read the (possibly newly-created) marts.
$SR -e "GRANT SELECT ON brain_gold.gold_revenue_ledger TO 'brain_analytics'; \
        GRANT SELECT ON brain_gold.gold_executive_metrics TO 'brain_analytics'; \
        GRANT SELECT ON brain_gold.gold_customer_scores TO 'brain_analytics'; \
        GRANT SELECT ON brain_gold.gold_cac TO 'brain_analytics';" 2>/dev/null || true

echo "Done. Open http://localhost:3000/insights (logged in as that brand) to see the briefing."
