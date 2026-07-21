#!/usr/bin/env bash
# pg-ingest-test-prep.sh — prep for the post-flush 20/20/20 e2e ingest test (2026-07-21).
# Admin needed because every brand-scoped table is RLS'd (app.current_brand_id) — brain_app can't
# even SELECT tenancy.brand. Same master-secret pattern as run-migrations.sh; password never printed.
#
# Does: (1) print brand + connector instances + pixel install tokens (needed for the pixel POSTs),
#       (2) force both connectors due now (next_repull_at = now()),
#       (3) enqueue ONE small Shopify backfill job (3-day window → small historical batch).
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
K="kubectl --context brain-prod-ssm"

echo "[1/3] Fetching Aurora master password (never printed)…"
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
MPW_ENC=$(MPW="$MPW" python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['MPW'],safe=''))")
$K -n argo create secret generic flush-admin-dburl \
  --from-literal=DATABASE_URL="postgres://brainadmin:${MPW_ENC}@${AUR}:5432/brain?sslmode=require" \
  --dry-run=client -o yaml | $K apply -f - >/dev/null

echo "[2/3] Recon + triggers as brainadmin…"
SQL="SELECT id AS brand_id, display_name, status FROM tenancy.brand;
SELECT id AS connector_instance_id, brand_id, provider, status, health_state, shop_domain, next_repull_at FROM connectors.connector_instance;
SELECT brand_id, install_token, target_host FROM pixel.pixel_installation;
UPDATE connectors.connector_instance SET next_repull_at = now(), updated_at = now() WHERE status = 'connected';
INSERT INTO jobs.backfill_job (id, brand_id, connector_instance_id, status, records_processed, created_at, updated_at, requested_window_ms)
  SELECT gen_random_uuid(), brand_id, id, 'queued', 0, now(), now(), 259200000
  FROM connectors.connector_instance WHERE provider = 'shopify' AND status = 'connected'
  RETURNING id AS backfill_job_id, connector_instance_id;"
$K delete pod pg-ingest-prep -n argo --ignore-not-found >/dev/null
$K run pg-ingest-prep -n argo --image=postgres:16-alpine --restart=Never \
  --overrides="{\"spec\":{\"containers\":[{\"name\":\"pg-ingest-prep\",\"image\":\"postgres:16-alpine\",\"command\":[\"sh\",\"-c\",\"psql \\\"\$DATABASE_URL\\\" -v ON_ERROR_STOP=1 -c \\\"$(echo "$SQL" | tr '\n' ' ' | sed 's/"/\\\\\\"/g')\\\" && echo PREP_OK\"],\"envFrom\":[{\"secretRef\":{\"name\":\"flush-admin-dburl\"}}]}],\"restartPolicy\":\"Never\"}}"
$K wait pod pg-ingest-prep -n argo --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s || true
$K logs pg-ingest-prep -n argo

echo "[3/3] Cleanup…"
$K delete pod pg-ingest-prep -n argo --ignore-not-found >/dev/null
$K delete secret flush-admin-dburl -n argo --ignore-not-found >/dev/null
echo "DONE — copy the brand_id / install_token / connector rows above back to Claude."
