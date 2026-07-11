#!/usr/bin/env bash
###############################################################################
# Prod DB migrations (GO-LIVE step 11). RUN BY THE OPERATOR.
#
# The Brain migrations REVOKE from brain_app and GRANT it least-priv — so they
# MUST run as a privileged owner (brainadmin), NOT brain_app. A prior partial
# run as brain_app left brain_app-owned tables, so this resets the brain schema
# (the DB is fresh — no real data) and re-migrates cleanly as brainadmin.
#
# Master password is read from the RDS-managed secret and only ever lives in a
# short-lived in-cluster secret; it is never printed.
###############################################################################
set -euo pipefail
REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'

echo "[1/5] Fetching Aurora master password..."
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")
# URL-encode the password for the DATABASE_URL connection string (the RDS-generated
# master password contains URL-special chars that otherwise break `new URL(...)`).
MPW_ENC=$(MPW="$MPW" python3 -c "import urllib.parse,os;print(urllib.parse.quote(os.environ['MPW'],safe=''))")

echo "[2/5] Resetting the brain schema (fresh DB) as brainadmin..."
kubectl -n stream-worker run pg-reset --image=postgres:16 --restart=Never --rm -i --quiet \
  --env=PGPASSWORD="$MPW" --command -- \
  psql "host=$AUR user=brainadmin dbname=brain sslmode=require" -v ON_ERROR_STOP=1 <<'SQL'
-- free locks: drop other connections to the brain DB (app pods reconnect after)
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='brain' AND pid <> pg_backend_pid();
-- wipe all user schemas from the partial run
DO $$ DECLARE s text; BEGIN
  FOR s IN SELECT nspname FROM pg_namespace
           WHERE nspname NOT IN ('pg_catalog','information_schema') AND nspname NOT LIKE 'pg\_%'
  LOOP EXECUTE format('DROP SCHEMA IF EXISTS %I CASCADE', s); END LOOP;
END $$;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO brainadmin;
GRANT USAGE, CREATE ON SCHEMA public TO brain_app;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
-- The migrations own objects as role `brain` (dev's postgres superuser) and do
-- `ALTER DEFAULT PRIVILEGES FOR ROLE brain ... TO brain_app`. Create it, give it
-- what the migrations need, and let brainadmin SET ROLE to it (the migration job
-- injects `-c role=brain`) so objects are owned by brain and the grants apply.
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='brain') THEN CREATE ROLE brain NOLOGIN; END IF; END $$;
GRANT rds_superuser TO brain;
GRANT brain TO brainadmin;
GRANT ALL ON DATABASE brain TO brain;
GRANT ALL ON SCHEMA public TO brain;
ALTER SCHEMA public OWNER TO brain;
SQL

echo "[3/5] Creating short-lived brainadmin DATABASE_URL secret..."
kubectl -n stream-worker create secret generic migrate-admin-dburl \
  --from-literal=DATABASE_URL="postgres://brainadmin:${MPW_ENC}@${AUR}:5432/brain?sslmode=require" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "[4/5] Running migrations as brainadmin..."
kubectl -n stream-worker delete job db-migrate-once --ignore-not-found >/dev/null
kubectl apply -f tools/deploy/db-migrate-job.yaml
kubectl -n stream-worker wait --for=condition=complete job/db-migrate-once --timeout=900s || true
echo "----- migration log (tail) -----"
kubectl -n stream-worker logs job/db-migrate-once --tail=40

echo "[5/5] Cleaning up the temp secret..."
kubectl -n stream-worker delete secret migrate-admin-dburl >/dev/null 2>&1 || true
echo "DONE — if the tail shows the migrations applied (no error), the schema is live."
