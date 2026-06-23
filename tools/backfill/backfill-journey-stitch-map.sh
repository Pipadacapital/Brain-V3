#!/usr/bin/env bash
#
# backfill-journey-stitch-map.sh — populate connector_journey_stitch_map (order → journey anon → brain_id)
# so silver_touchpoint.stitched_order_id/brain_id fill and gold_attribution_paths (multi-touch /
# channel-ROAS-by-path) lights up.
#
# DETERMINISTIC, NOT GUESSED (Brain rule: journey-before-attribution, never guess attribution):
# the canonical live stitch reads brain_anon_id BACK from the order's checkout note_attributes
# (StitchMapWriter) — historical repulled orders DON'T carry it. The honest deterministic fallback used
# here is the IDENTITY GRAPH: identity resolution already linked each journey anon → a brain_id
# (identity_link type 'anon_id'), and the order ledger already carries brain_id. We stitch an order to
# its customer's journey anon ONLY via that identity link — and ONLY where it is UNAMBIGUOUS (verified:
# every resolved customer has exactly ONE anon, so anon↔customer is certain; no time-based guessing).
# Customers with no resolved anon stay unstitched (honest NULL).
#
# MATCH: silver_touchpoint stores the RAW anon; identity_link stores the salted hash. We re-derive the
# dev-salt hash (identical to identity-core.resolveDevSaltHex + 0089) to bridge them. In prod the salt
# is KMS-derived → the hash won't match → ZERO rows (no-op; the live note_attributes path is authoritative).
#
# Usage: tools/backfill/backfill-journey-stitch-map.sh <BRAND_UUID>
set -euo pipefail

BRAND="${1:-}"
if [[ -z "$BRAND" ]]; then echo "usage: $0 <BRAND_UUID>" >&2; exit 2; fi
SR="docker exec -i brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N"
PG="docker exec -i brainv3-postgres-1 psql -U brain -d brain -v ON_ERROR_STOP=1"
TSV=/tmp/bf-stitch-anons.tsv
SQL=/tmp/bf-stitch.sql

echo ">> Extracting distinct raw journey anons from silver_touchpoint for $BRAND ..."
$SR -e "SELECT DISTINCT brain_anon_id FROM brain_silver.silver_touchpoint
        WHERE brand_id='$BRAND' AND brain_anon_id IS NOT NULL" > "$TSV"
echo ">> $(wc -l < "$TSV") distinct anons."

{
  echo "BEGIN;"
  echo "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
  echo "CREATE TEMP TABLE _anon(raw_anon text) ON COMMIT DROP;"
  awk 'NF>0 { gsub(/'"'"'/,"",$1); printf "INSERT INTO _anon VALUES ('"'"'%s'"'"');\n",$1 }' "$TSV"
  # raw_anon → brain_id via the identity graph (re-derived dev-salt hash, type='anon_id').
  cat <<SQL
CREATE TEMP TABLE _anon_brain ON COMMIT DROP AS
SELECT a.raw_anon, il.brain_id
FROM _anon a
JOIN identity.identity_link il
  ON il.brand_id = '$BRAND' AND il.identifier_type = 'anon_id' AND il.is_active = TRUE
 AND il.brain_id IS NOT NULL
 AND il.identifier_value = encode(digest(
       encode(digest('brain-dev-identity-salt-v1||' || lower('$BRAND'), 'sha256'), 'hex')
       || '||' || btrim(a.raw_anon), 'sha256'), 'hex');

-- Stitch each of the customer's orders to their (single, unambiguous) journey anon.
INSERT INTO connectors.connector_journey_stitch_map (brand_id, order_id, stitched_anon_id, brain_id)
SELECT '$BRAND', l.order_id, ab.raw_anon, ab.brain_id
FROM _anon_brain ab
JOIN billing.realized_revenue_ledger l
  ON l.brand_id = '$BRAND' AND l.brain_id = ab.brain_id
GROUP BY l.order_id, ab.raw_anon, ab.brain_id
ON CONFLICT (brand_id, order_id) DO UPDATE
  SET stitched_anon_id = EXCLUDED.stitched_anon_id,
      brain_id         = COALESCE(EXCLUDED.brain_id, connector_journey_stitch_map.brain_id);

SELECT count(*) AS stitched_orders, count(DISTINCT stitched_anon_id) AS journeys
FROM connectors.connector_journey_stitch_map WHERE brand_id = '$BRAND';
SQL
  echo "COMMIT;"
} > "$SQL"

echo ">> Upserting stitch rows (deterministic, identity-graph based) ..."
$PG < "$SQL" | tail -4
echo ">> Done. Re-run 'make insights-pipeline' to rebuild silver_touchpoint + gold_attribution_paths."
