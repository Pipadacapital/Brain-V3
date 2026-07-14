#!/usr/bin/env bash
###############################################################################
# FIRST-BOOT-ONLY destructive DB reset + migrate (AUD-OPS-017). RUN BY THE
# OPERATOR, ONCE, against a FRESH database — never for a routine migration
# (that is tools/deploy/run-migrations.sh).
#
# WHAT IT DOES: DROPs EVERY user schema in the `brain` DB (CASCADE), recreates
# the public schema + the `brain` owner-role scaffolding the migrations need
# (they REVOKE from brain_app and do `ALTER DEFAULT PRIVILEGES FOR ROLE brain`),
# then delegates to run-migrations.sh to re-migrate cleanly as brainadmin.
#
# GUARD: it REFUSES to run if ANY user table contains rows (only the
# `public.pgmigrations` bookkeeping table is exempt, so a failed partial
# first-boot migration can be retried). Overriding the guard requires
#   FORCE_DESTRUCTIVE_RESET=yes-i-mean-it
# — which permanently destroys all tenant data. There is no undo.
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

if [ "${FORCE_DESTRUCTIVE_RESET:-}" = "yes-i-mean-it" ]; then
  echo "[2/4] FORCE_DESTRUCTIVE_RESET=yes-i-mean-it — SKIPPING the data-presence guard."
else
  echo "[2/4] Data-presence guard: checking every user table is empty..."
  if ! kubectl -n stream-worker run pg-reset-guard --image=postgres:16 --restart=Never --rm -i --quiet \
    --env=PGPASSWORD="$MPW" --command -- \
    psql "host=$AUR user=brainadmin dbname=brain sslmode=require" -v ON_ERROR_STOP=1 <<'SQL'
-- Refuse the reset if any user table has rows: this script exists ONLY for the
-- first boot of a fresh DB. public.pgmigrations (migration bookkeeping, not
-- tenant data) is exempt so a failed partial first-boot run can be retried.
DO $$
DECLARE r record; has_rows boolean; offenders text := '';
BEGIN
  FOR r IN SELECT schemaname, tablename FROM pg_tables
           WHERE schemaname NOT IN ('pg_catalog','information_schema')
             AND schemaname NOT LIKE 'pg\_%'
             AND NOT (schemaname = 'public' AND tablename = 'pgmigrations')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', r.schemaname, r.tablename) INTO has_rows;
    IF has_rows THEN offenders := offenders || format(' %s.%s', r.schemaname, r.tablename); END IF;
  END LOOP;
  IF offenders <> '' THEN
    RAISE EXCEPTION 'DATA PRESENT — refusing destructive reset. Non-empty tables:%', offenders;
  END IF;
END $$;
SQL
  then
    echo ""
    echo "REFUSED: the database contains data. This script is FIRST-BOOT-ONLY."
    echo "  - For a routine migration run: tools/deploy/run-migrations.sh"
    echo "  - To destroy ALL data anyway (no undo): FORCE_DESTRUCTIVE_RESET=yes-i-mean-it $0"
    exit 1
  fi
fi

echo "[3/4] Resetting the brain schema (DROP all user schemas) as brainadmin..."
kubectl -n stream-worker run pg-reset --image=postgres:16 --restart=Never --rm -i --quiet \
  --env=PGPASSWORD="$MPW" --command -- \
  psql "host=$AUR user=brainadmin dbname=brain sslmode=require" -v ON_ERROR_STOP=1 <<'SQL'
-- free locks: drop other connections to the brain DB (app pods reconnect after)
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='brain' AND pid <> pg_backend_pid();
-- wipe all user schemas
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

echo "[4/4] Delegating to the routine migration path..."
exec "$SCRIPT_DIR/run-migrations.sh"
