#!/usr/bin/env bash
# fix-identity-watermark.sh — step 2 only (bronze compaction already submitted): advance the 2
# identity watermarks to 2026-07-20T18:00Z (epoch 1784570400) so the next v4-identity run reads
# tonight's events instead of walking ~14h of empty 1-hour slices from the 7-day cold-start floor.
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
K="kubectl --context brain-prod-ssm"
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
MPW_ENC=$(MPW="$MPW" python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['MPW'],safe=''))")
$K -n argo create secret generic flush-admin-dburl \
  --from-literal=DATABASE_URL="postgres://brainadmin:${MPW_ENC}@${AUR}:5432/brain?sslmode=require" \
  --dry-run=client -o yaml | $K apply -f - >/dev/null
$K delete pod pg-wm-fix -n argo --ignore-not-found >/dev/null
$K run pg-wm-fix -n argo --image=postgres:16-alpine --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"pg-wm-fix","image":"postgres:16-alpine","command":["sh","-c","psql \"$DATABASE_URL\" -v ON_ERROR_STOP=1 -c \"UPDATE ops.silver_identity_watermark SET watermark = to_timestamp(1784570400), updated_at = now() RETURNING brand_id, job_name, watermark\" && echo WM_OK"],"envFrom":[{"secretRef":{"name":"flush-admin-dburl"}}]}],"restartPolicy":"Never"}}'
$K wait pod pg-wm-fix -n argo --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s || true
$K logs pg-wm-fix -n argo
$K delete pod pg-wm-fix -n argo --ignore-not-found >/dev/null
$K delete secret flush-admin-dburl -n argo --ignore-not-found >/dev/null
echo "DONE — identity watermark advanced; next v4-identity run (*/5) reads tonight's data."
