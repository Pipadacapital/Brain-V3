#!/usr/bin/env bash
# fix-serving-and-identity.sh — two post-flush accelerations (2026-07-21):
#  (1) submit ONE bronze-maintenance run NOW from the cron's own spec (unmodified) — compacts the
#      fragmented collector_events_connect that is 500-ing recent-events/data-health/tracking.
#  (2) advance the 2 identity watermarks to tonight (2026-07-20T18:00Z). The flush emptied
#      ops.silver_identity_watermark, so the identity job cold-started at now-7d and walks 1h
#      slices per */5 run (≈14h of empty slices before reaching tonight's data). Advancing the
#      watermark makes the next run read tonight's events directly. Admin needed (RLS).
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
K="kubectl --context brain-prod-ssm"

echo "[1/2] Submitting bronze-maintenance from the cron spec (unmodified)…"
$K get cronworkflow bronze-maintenance -n argo -o json | python3 -c "
import json,sys
cw=json.load(sys.stdin)
wf={'apiVersion':'argoproj.io/v1alpha1','kind':'Workflow',
    'metadata':{'generateName':'bronze-maint-manual-','namespace':'argo','labels':{'app.kubernetes.io/part-of':'brain'}},
    'spec':cw['spec']['workflowSpec']}
json.dump(wf, sys.stdout)
" | $K create -f -

echo "[2/2] Advancing identity watermarks to 2026-07-20T18:00Z…"
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
echo "DONE — bronze compaction submitted + identity watermark advanced."
