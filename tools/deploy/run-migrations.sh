#!/usr/bin/env bash
###############################################################################
# Prod DB migrations — ROUTINE path (GO-LIVE step 11). RUN BY THE OPERATOR.
#
# NON-DESTRUCTIVE (AUD-OPS-017): this only runs `pnpm migrate:up` (all of
# db/migrations, forward-only, advisory-locked). The Brain migrations REVOKE
# from brain_app and GRANT it least-priv — so they MUST run as a privileged
# owner (brainadmin with `-c role=brain`), NOT brain_app; the core chart's
# PreSync hook is disabled for exactly this reason
# (infra/helm/core/values-prod.yaml → migrations.enabled: false).
#
# FIRST BOOT of a fresh, EMPTY database needs the schema/role scaffolding
# first — that (destructive, guarded) path is tools/deploy/reset-and-migrate.sh.
# NEVER run the reset for a routine migration.
#
# Master password is read from the RDS-managed secret and only ever lives in a
# short-lived in-cluster secret; it is never printed.
###############################################################################
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

echo "[1/4] Fetching Aurora master password..."
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
# URL-encode the password for the DATABASE_URL connection string (the RDS-generated
# master password contains URL-special chars that otherwise break `new URL(...)`).
MPW_ENC=$(MPW="$MPW" python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['MPW'],safe=''))")

echo "[2/4] Creating short-lived brainadmin DATABASE_URL secret..."
kubectl -n stream-worker create secret generic migrate-admin-dburl \
  --from-literal=DATABASE_URL="postgres://brainadmin:${MPW_ENC}@${AUR}:5432/brain?sslmode=require" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "[3/4] Running migrations as brainadmin..."
kubectl -n stream-worker delete job db-migrate-once --ignore-not-found >/dev/null
# The migrate job MUST run on the CURRENTLY-DEPLOYED core image — that is the one
# carrying the newest db/migrations (the image and the migration files ship together,
# Dockerfile COPY . .). The digest hard-coded in db-migrate-job.yaml is only a
# placeholder; it goes stale on every deploy, and running a stale image SILENTLY skips
# new migrations (0129 was missed exactly this way, 2026-07-13). So substitute the live
# core Deployment's digest at apply time — the routine path can never migrate from the
# wrong image again.
CORE_IMG=$(kubectl -n core get deploy core -o jsonpath='{.spec.template.spec.containers[0].image}')
if [ -z "$CORE_IMG" ]; then echo "FATAL: could not read the live core image digest" >&2; exit 1; fi
echo "      migrating on live core image: ${CORE_IMG##*@}"
sed "s#brain-core-prod@sha256:[a-f0-9]*#${CORE_IMG#*/}#" "$SCRIPT_DIR/db-migrate-job.yaml" | kubectl apply -f -
kubectl -n stream-worker wait --for=condition=complete job/db-migrate-once --timeout=900s || true
echo "----- migration log (tail) -----"
kubectl -n stream-worker logs job/db-migrate-once --tail=40

echo "[4/4] Cleaning up the temp secret..."
kubectl -n stream-worker delete secret migrate-admin-dburl >/dev/null 2>&1 || true
echo "DONE — if the tail shows the migrations applied (no error), the schema is live."
