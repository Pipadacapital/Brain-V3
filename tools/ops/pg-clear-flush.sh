#!/usr/bin/env bash
# pg-clear-flush.sh — PG half of the 2026-07-20 prod data flush (owner-approved table list).
# Mirrors tools/deploy/run-migrations.sh's admin pattern: fetch the Aurora master password from
# the RDS-managed secret → short-lived in-cluster secret → one psql pod → cleanup. The password
# is never printed and the secret is deleted at the end.
#
# CLEARS (derived/queue/cursor state only): connectors.{connector_cursor,connector_sync_status,
# connector_sync_run,connector_dlq_record,connector_webhook_raw_archive,connector_journey_stitch_map,
# connector_razorpay_order_map}, jobs.{backfill_job,resource_backfill_state}, ops.{identity_export_state,
# silver_customer_identity,silver_identity_link,silver_identity_watermark,silver_journey_stitch,
# restitch_pending,journey_reversion_pending,scoped_recompute_request,stitch_conflict_review,
# erasure_request_queue,ops_ml_prediction_log}, identity.contact_pii.
# KEEPS: connectors.connector_instance (connections/OAuth), ops.migration_state, ops.saved_segment,
# ops.brand_identity_priority, identity.pii_erasure_log, audit.*, all app/IAM/tenancy tables.
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
K="kubectl --context brain-prod-ssm"

echo "[1/4] Fetching Aurora master password (never printed)…"
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
MPW_ENC=$(MPW="$MPW" python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['MPW'],safe=''))")

echo "[2/4] Creating short-lived flush-admin-dburl secret in argo…"
$K -n argo create secret generic flush-admin-dburl \
  --from-literal=DATABASE_URL="postgres://brainadmin:${MPW_ENC}@${AUR}:5432/brain?sslmode=require" \
  --dry-run=client -o yaml | $K apply -f - >/dev/null

echo "[3/4] Running approved DELETEs as brainadmin…"
SQL='DELETE FROM connectors.connector_cursor; DELETE FROM connectors.connector_sync_status;
DELETE FROM connectors.connector_sync_run; DELETE FROM connectors.connector_dlq_record;
DELETE FROM connectors.connector_webhook_raw_archive; DELETE FROM connectors.connector_journey_stitch_map;
DELETE FROM connectors.connector_razorpay_order_map; DELETE FROM jobs.backfill_job;
DELETE FROM jobs.resource_backfill_state; DELETE FROM ops.identity_export_state;
DELETE FROM ops.silver_customer_identity; DELETE FROM ops.silver_identity_link;
DELETE FROM ops.silver_identity_watermark; DELETE FROM ops.silver_journey_stitch;
DELETE FROM ops.restitch_pending; DELETE FROM ops.journey_reversion_pending;
DELETE FROM ops.scoped_recompute_request; DELETE FROM ops.stitch_conflict_review;
DELETE FROM ops.erasure_request_queue; DELETE FROM ops.ops_ml_prediction_log;
DELETE FROM identity.contact_pii;'
$K delete pod pg-clear-admin -n argo --ignore-not-found >/dev/null
$K run pg-clear-admin -n argo --image=postgres:16-alpine --restart=Never \
  --overrides="{\"spec\":{\"containers\":[{\"name\":\"pg-clear-admin\",\"image\":\"postgres:16-alpine\",\"command\":[\"sh\",\"-c\",\"psql \\\"\$DATABASE_URL\\\" -v ON_ERROR_STOP=1 -a -c '$(echo "$SQL" | tr '\n' ' ')' && echo PG_CLEAR_OK\"],\"envFrom\":[{\"secretRef\":{\"name\":\"flush-admin-dburl\"}}]}],\"restartPolicy\":\"Never\"}}"
$K wait pod pg-clear-admin -n argo --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s || true
$K logs pg-clear-admin -n argo

echo "[4/4] Cleanup (pod + admin secret)…"
$K delete pod pg-clear-admin -n argo --ignore-not-found >/dev/null
$K delete secret flush-admin-dburl -n argo --ignore-not-found >/dev/null
echo "DONE — PG derived state cleared; connections kept."
