#!/usr/bin/env bash
#
# backfill-ledger-brain-id.sh — stamp brain_id onto historical realized_revenue_ledger rows.
#
# WHY: migration 0089 backfills from an EMBEDDED Bronze snapshot taken at author-time, so it is a
# no-op for any data ingested later. This tool reads the LIVE Bronze over the duckdb-serving HTTP
# API — the ADR-0010 lift view brain_bronze.collector_events_connect_lifted (the Kafka Connect sink
# is the ONLY Bronze writer; the view lifts brand_id/event_type over the truly-raw connect table) —
# so it works for whatever orders are actually in the lakehouse now. NOTE: rows landed by the
# RETIRED Spark sinks live in the legacy brain_bronze.events/collector_events tables (data kept,
# not served) and are NOT visible through this view.
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
# duckdb-serving is the serving engine (Trino removed, ADR-0014); POST /v1/query → {columns,data},
# flattened to TSV (tab-separated, no header) for the awk stage below.
SERVING_URL="${DUCKDB_SERVING_URL:-http://localhost:8091}"
serving_tsv() { # $1 = sql → stdout TSV rows
  python3 - "$1" "$SERVING_URL" <<'PY'
import json, sys, urllib.error, urllib.request
sql, url = sys.argv[1], sys.argv[2]
req = urllib.request.Request(
    url + "/v1/query",
    data=json.dumps({"sql": sql}).encode(),
    headers={"Content-Type": "application/json"},
)
try:
    with urllib.request.urlopen(req) as resp:
        body = json.load(resp)
except urllib.error.HTTPError as e:  # surface the DuckDB message, not just the status
    sys.stderr.write(f"[backfill-ledger] duckdb-serving HTTP {e.code}: {e.read().decode(errors='replace')[:500]}\n")
    sys.exit(1)
for row in body.get("data") or []:
    sys.stdout.write("\t".join("" if v is None else str(v) for v in row) + "\n")
PY
}
PG="docker exec -i brainv3-postgres-1 psql -U brain -d brain -v ON_ERROR_STOP=1"
TSV=/tmp/bf-ledger-brainid.tsv
SQL=/tmp/bf-ledger-brainid.sql

echo ">> Extracting (order_id, hashed_customer_email) from live Bronze (connect lift view) for $BRAND ..."
serving_tsv "SELECT json_extract_string(payload,'\$.properties.order_id'),
               json_extract_string(payload,'\$.properties.hashed_customer_email')
        FROM brain_bronze.collector_events_connect_lifted
        WHERE brand_id='$BRAND' AND event_type='order.live.v1'
          AND json_extract_string(payload,'\$.properties.order_id') IS NOT NULL
          AND json_extract_string(payload,'\$.properties.hashed_customer_email') IS NOT NULL" > "$TSV"
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
echo ">> Done. Re-run 'ONESHOT=1 pnpm dev:v4-refresh' to rebuild the customer marts."
