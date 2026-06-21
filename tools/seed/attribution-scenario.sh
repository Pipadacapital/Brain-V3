#!/usr/bin/env bash
# attribution-scenario.sh — seed ONE attributable journey→order so attribution-reconcile produces a
# credit and the Data Quality attribution_confidence rises off D (dev only).
#
# reconcileAttribution credits a FINALIZED order whose brain_id resolves (via silver_touchpoint
# .stitched_brain_id) to a journey's brain_anon_id. Dev re-pull orders are provisional, carry no
# brain_id, and no journey is stitched — so attribution is 0 and attribution_confidence floors at D.
# This wires the minimal real chain:
#   1. pick a real touchpoint brain_anon_id (from silver_touchpoint) + a provisional order_id;
#   2. connector_journey_stitch_map: stitch that anon → the order under a synthetic brain_id;
#   3. realized_revenue_ledger: a 'finalization' row for the order with that brain_id;
#   4. rebuild silver_touchpoint (so stitched_brain_id populates);
#   5. run attribution-reconcile → writes attribution_credit_ledger → attribution_confidence > D.
#
# Prereqs: full stack up, silver built, dbt venv (.dbt-venv), touchpoints seeded (seed-touchpoints.mjs).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

BRAND="${BRAND_ID:-124e6af5-e6c5-4b85-bf43-7b36fa528101}"
BID="${SYNTH_BRAIN_ID:-a771b1d0-aaaa-4000-8000-000000000001}"
PW="$(grep -E '^DATABASE_URL=' .env | sed -E 's#^.*://[^:]+:([^@]+)@.*#\1#')"
psql() { docker exec -i -e PGPASSWORD="$PW" brainv3-postgres-1 psql -U brain -d brain -tAc "$1"; }

ANON="$(docker exec brainv3-starrocks-1 mysql -h127.0.0.1 -P9030 -uroot -N -e "SELECT brain_anon_id FROM brain_silver.silver_touchpoint LIMIT 1;" 2>/dev/null)"
ORDER="$(psql "SELECT order_id FROM realized_revenue_ledger WHERE brand_id='$BRAND' AND event_type='provisional_recognition' LIMIT 1")"
echo "[attr-seed] brand=$BRAND anon=$ANON order=$ORDER synth_brain=$BID"

psql "SET app.current_brand_id='$BRAND';
  INSERT INTO connector_journey_stitch_map (brand_id, order_id, stitched_anon_id, brain_id, created_at)
  VALUES ('$BRAND','$ORDER','$ANON','$BID',now()) ON CONFLICT DO NOTHING;
  INSERT INTO realized_revenue_ledger (ledger_event_id, brand_id, order_id, brain_id, event_type,
    amount_minor, currency_code, occurred_at, economic_effective_at, billing_posted_period, recognition_label, created_at)
  VALUES (gen_random_uuid(),'$BRAND','$ORDER','$BID','finalization',729700,'INR',now(),now(),'2026-06','finalized',now());" >/dev/null
echo "[attr-seed] stitch + finalization inserted"

( cd db/dbt && DBT_PROFILES_DIR=profiles ../../.dbt-venv/bin/dbt run --select silver_touchpoint >/dev/null ) && echo "[attr-seed] silver_touchpoint rebuilt"
( cd apps/core && pnpm exec tsx --env-file=../../.env src/jobs/attribution-reconcile.ts 2>&1 | tail -1 )
echo "[attr-seed] done — check Data Quality: attribution_confidence should be > D"
