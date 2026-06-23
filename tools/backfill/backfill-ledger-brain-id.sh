#!/usr/bin/env bash
#
# backfill-ledger-brain-id.sh — stamp brain_id onto historical realized_revenue_ledger rows.
#
# WHY: migration 0089 backfills from an EMBEDDED Bronze snapshot taken at author-time, so it is a
# no-op for any data ingested later. This tool reads the LIVE Bronze (StarRocks over the Iceberg
# collector_events) instead, so it works for whatever orders are actually in the lakehouse now.
#
# HOW (deterministic, no salt needed): connector order events (order.live.v1) carry the upstream-
# pre-hashed customer email under payload.properties.hashed_customer_email — the SAME 64-hex value the
# identity resolver stores in identity.identity_link as identifier_type='pre_hashed_email'. So we join
# the order's hashed email DIRECTLY to identity_link → brain_id and stamp it on the ledger.
#
# SAFETY: runs as superuser `brain` (the ledger is append-only to brain_app; brain_id is METADATA, not
# money — stamping it can't change any money math). Idempotent: only fills still-NULL brain_id rows.
# REQUIRES: identity resolution working first (migration 0095 — pre_hashed_* identifier types allowed).
#
# Usage: tools/backfill/backfill-ledger-brain-id.sh <BRAND_UUID>
set -euo pipefail

BRAND="${1:-}"
if [[ -z "$BRAND" ]]; then echo "usage: $0 <BRAND_UUID>" >&2; exit 2; fi
SR="docker exec -i brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N"
PG="docker exec -i brainv3-postgres-1 psql -U brain -d brain -v ON_ERROR_STOP=1"
TSV=/tmp/bf-ledger-brainid.tsv
SQL=/tmp/bf-ledger-brainid.sql

echo ">> Extracting (order_id, hashed_customer_email) from live Bronze for $BRAND ..."
$SR -e "SELECT get_json_string(payload,'\$.properties.order_id'),
               get_json_string(payload,'\$.properties.hashed_customer_email')
        FROM brain_bronze_local.brain_bronze.collector_events
        WHERE brand_id='$BRAND' AND event_type='order.live.v1'
          AND get_json_string(payload,'\$.properties.order_id') IS NOT NULL
          AND get_json_string(payload,'\$.properties.hashed_customer_email') IS NOT NULL" > "$TSV"
echo ">> $(wc -l < "$TSV") order→email tuples."

{
  echo "BEGIN;"
  echo "CREATE TEMP TABLE _bf_oe(order_id text, he text) ON COMMIT DROP;"
  # one INSERT per tuple; values are platform ids + 64-hex hashes (no quotes to escape).
  awk -F'\t' 'NF==2 && $1!="" && $2!="" { printf "INSERT INTO _bf_oe VALUES ('"'"'%s'"'"','"'"'%s'"'"');\n",$1,$2 }' "$TSV"
  echo "UPDATE billing.realized_revenue_ledger l"
  echo "   SET brain_id = il.brain_id"
  echo "  FROM _bf_oe b"
  echo "  JOIN identity.identity_link il"
  echo "    ON il.identifier_type='pre_hashed_email' AND il.identifier_value=b.he"
  echo "   AND il.is_active AND il.brand_id='$BRAND'"
  echo " WHERE l.brand_id='$BRAND' AND l.order_id=b.order_id AND l.brain_id IS NULL;"
  echo "SELECT count(*) FILTER (WHERE brain_id IS NOT NULL) AS stamped, count(*) AS total FROM billing.realized_revenue_ledger WHERE brand_id='$BRAND';"
  echo "COMMIT;"
} > "$SQL"

echo ">> Stamping brain_id on the ledger (idempotent, NULL-only) ..."
$PG < "$SQL" | tail -4
echo ">> Done. Re-run 'make insights-pipeline' to rebuild the customer marts."
