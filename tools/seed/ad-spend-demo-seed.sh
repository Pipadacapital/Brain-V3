#!/usr/bin/env bash
#
# ad-spend-demo-seed.sh — seed CLEARLY-LABELLED sample ad spend into billing.ad_spend_ledger so the
# CAC + blended-ROAS insights light up end-to-end through the REAL path (ad_spend_ledger →
# silver_marketing_spend → gold_cac / metric-engine), WITHOUT a live Meta/Google OAuth connection.
#
# This is a DEV/DEMO aid only. Real ad spend arrives via the Meta/Google ad connectors (OAuth in the
# UI) → the meta-spend-repull / google-ads-spend-repull jobs → SpendLedgerConsumer → ad_spend_ledger.
# Every row here is marked platform-suffixed '_sample' + campaign_name '[SAMPLE]' so it is unmistakable
# and easy to delete. Idempotent: clears prior sample rows for the brand first.
#
# Usage: tools/seed/ad-spend-demo-seed.sh <BRAND_UUID>
set -euo pipefail

BRAND="${1:-}"
if [[ -z "$BRAND" ]]; then echo "usage: $0 <BRAND_UUID>" >&2; exit 2; fi
PG="docker exec -i brainv3-postgres-1 psql -U brain -d brain -v ON_ERROR_STOP=1"
SQL=/tmp/ad-spend-demo.sql

echo ">> Generating 40 days of sample ad spend (meta + google) for $BRAND ..."
{
  echo "BEGIN;"
  echo "DELETE FROM billing.ad_spend_ledger WHERE brand_id='$BRAND' AND spend_event_id LIKE 'sample-%';"
  for i in $(seq 0 39); do
    d=$(date -v-"$i"d +%Y-%m-%d 2>/dev/null || date -d "-$i day" +%Y-%m-%d)
    # meta: ₹3,000/day; google: ₹2,000/day (minor units).
    echo "INSERT INTO billing.ad_spend_ledger (brand_id, spend_event_id, platform, level, level_id, campaign_id, campaign_name, stat_date, spend_minor, currency_code, impressions, clicks, occurred_at, raw_event_id) VALUES ('$BRAND','sample-meta-$d','meta','campaign','c-meta','c-meta','[SAMPLE] Meta Prospecting','$d',300000,'INR',12000,340,'${d}T12:00:00Z','sample-meta-$d');"
    echo "INSERT INTO billing.ad_spend_ledger (brand_id, spend_event_id, platform, level, level_id, campaign_id, campaign_name, stat_date, spend_minor, currency_code, impressions, clicks, occurred_at, raw_event_id) VALUES ('$BRAND','sample-google-$d','google_ads','campaign','c-goog','c-goog','[SAMPLE] Google Brand','$d',200000,'INR',8000,210,'${d}T12:00:00Z','sample-google-$d');"
  done
  echo "SELECT count(*) AS sample_spend_rows, sum(spend_minor) AS total_minor FROM billing.ad_spend_ledger WHERE brand_id='$BRAND' AND spend_event_id LIKE 'sample-%';"
  echo "COMMIT;"
} > "$SQL"

$PG < "$SQL" | tail -4
echo ">> Done. Re-run 'make insights-pipeline' to rebuild gold_cac + silver_marketing_spend, then /insights shows CAC + blended ROAS."
