#!/usr/bin/env bash
###############################################################################
# Brain — prod secret seeding (GO-LIVE step 8). RUN BY THE OPERATOR.
#
# Idempotent. Creates the least-priv Aurora roles + seeds 6 of the 7
# brain/prod/k8s/* Secrets Manager entries. core-env is DEFERRED to the
# app-tier phase (it needs SHOPIFY_CLIENT_SECRET / JWT / COOKIE ARN wiring).
#
# Secrets never leave your machine/cluster: passwords are generated here,
# written to Aurora + Secrets Manager, and never printed.
#
# Prereqs: kubectl context = brain-prod (verified), aws authed to 380254378136,
# openssl + python3 available.
###############################################################################
set -euo pipefail

REGION=ap-south-1
AUR=brain-prod-postgres.cluster-cjy6iicow625.ap-south-1.rds.amazonaws.com
RDS_MASTER_SECRET='arn:aws:secretsmanager:ap-south-1:380254378136:secret:rds!cluster-7ea5a1e7-0ef1-4f59-87e5-565d0e1fc8f3-Ko57oN'
WAREHOUSE_BUCKET=brain-bronze-prod-380254378136

# In-cluster service coordinates (verified from charts)
export PGB="pgbouncer.pgbouncer.svc.cluster.local:6432"
export REDIS_URL="rediss://master.brain-prod-redis.5eykyx.aps1.cache.amazonaws.com:6379"
export KAFKA="brain-prod-kafka-kafka-bootstrap.kafka.svc.cluster.local:9092"
export TRINO_HOST="brain-prod-trino.trino.svc.cluster.local"
export TRINO_PORT="8080"
export AUR REGION WAREHOUSE_BUCKET

echo "[1/4] Fetching Aurora master password from its RDS-managed secret..."
MPW=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$RDS_MASTER_SECRET" \
      --query SecretString --output text | python3 -c "import json,sys;print(json.load(sys.stdin)['password'])")

echo "[2/4] Generating strong passwords (hex — URL-safe)..."
export APP_PW=$(openssl rand -hex 24)
export ICEBERG_PW=$(openssl rand -hex 24)
export NEO4J_PW=$(openssl rand -hex 24)

echo "[3/4] Creating least-priv Aurora roles (idempotent) via a one-shot psql pod..."
kubectl -n default run "pgseed-$$" --image=postgres:16 --restart=Never --rm -i --quiet \
  --env=PGPASSWORD="$MPW" --command -- \
  psql "host=$AUR user=brainadmin dbname=brain sslmode=require" -v ON_ERROR_STOP=1 <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='brain_app') THEN
    ALTER ROLE brain_app LOGIN PASSWORD '$APP_PW';
  ELSE
    CREATE ROLE brain_app LOGIN PASSWORD '$APP_PW';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='iceberg_catalog') THEN
    ALTER ROLE iceberg_catalog LOGIN PASSWORD '$ICEBERG_PW';
  ELSE
    CREATE ROLE iceberg_catalog LOGIN PASSWORD '$ICEBERG_PW';
  END IF;
END \$\$;
GRANT ALL ON DATABASE brain TO brain_app;
GRANT ALL ON SCHEMA public TO brain_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO brain_app;
-- PG16: brainadmin (rds_superuser, not superuser) can only CREATE DATABASE ...
-- OWNER iceberg_catalog if it is a member of that role. Grant the membership.
GRANT iceberg_catalog TO brainadmin;
SQL

# CREATE DATABASE cannot run inside a txn/DO block — do it conditionally, separately.
kubectl -n default run "pgseed2-$$" --image=postgres:16 --restart=Never --rm -i --quiet \
  --env=PGPASSWORD="$MPW" --command -- \
  bash -lc "psql 'host=$AUR user=brainadmin dbname=brain sslmode=require' -tAc \"SELECT 1 FROM pg_database WHERE datname='iceberg_catalog'\" | grep -q 1 || psql 'host=$AUR user=brainadmin dbname=brain sslmode=require' -c 'CREATE DATABASE iceberg_catalog OWNER iceberg_catalog'"

echo "[4/4] Seeding Secrets Manager (6 entries; core-env deferred to app tier)..."
# Verifies every write: refuses an empty payload, then reads back AWSCURRENT length.
put() {
  local id="$1" val="$2"
  if [ -z "$val" ] || [ "$val" = "{}" ]; then echo "  FATAL: empty JSON for $id (a builder failed)"; exit 1; fi
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$id" --secret-string "$val" >/dev/null
  local n; n=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$id" --query 'length(SecretString)' --output text 2>/dev/null || echo 0)
  if [ "${n:-0}" -gt 0 ] 2>/dev/null; then echo "  seeded $id (AWSCURRENT len=$n)"; else echo "  FATAL: $id has no AWSCURRENT value after put"; exit 1; fi
}

PGBOUNCER=$(python3 -c 'import json,os;print(json.dumps({"DB_USER":"brain_app","DB_PASSWORD":os.environ["APP_PW"]}))')
put brain/prod/k8s/pgbouncer-env "$PGBOUNCER"

NEO4J=$(python3 -c 'import json,os;print(json.dumps({"NEO4J_AUTH":"neo4j/"+os.environ["NEO4J_PW"]}))')
put brain/prod/k8s/neo4j-auth "$NEO4J"

ICEBERGDB=$(python3 -c 'import json,os;print(json.dumps({"jdbc-user":"iceberg_catalog","jdbc-password":os.environ["ICEBERG_PW"]}))')
put brain/prod/k8s/iceberg-rest-catalog-db "$ICEBERGDB"

COLLECTOR=$(python3 <<'PY'
import json, os
print(json.dumps({
 "DATABASE_URL": "postgres://brain_app:%s@%s/brain" % (os.environ["APP_PW"], os.environ["PGB"]),
 "REDIS_URL": os.environ["REDIS_URL"],
 "KAFKA_BROKERS": os.environ["KAFKA"],
}))
PY
)
put brain/prod/k8s/collector-env "$COLLECTOR"

STREAMWORKER=$(python3 <<'PY'
import json, os
print(json.dumps({
 "BRAIN_APP_DATABASE_URL": "postgres://brain_app:%s@%s:5432/brain?sslmode=require" % (os.environ["APP_PW"], os.environ["AUR"]),
 "REDIS_URL": os.environ["REDIS_URL"],
 "KAFKA_BROKERS": os.environ["KAFKA"],
 "TRINO_HOST": os.environ["TRINO_HOST"],
 "TRINO_PORT": os.environ["TRINO_PORT"],
 "NEO4J_URI": "bolt://neo4j.neo4j.svc.cluster.local:7687",
 "NEO4J_USER": "neo4j",
 "NEO4J_PASSWORD": os.environ["NEO4J_PW"],
 "AWS_REGION": os.environ["REGION"],
 "COLLECTOR_TOPIC": "prod.collector.event.v1",
}))
PY
)
put brain/prod/k8s/stream-worker-env "$STREAMWORKER"

WEB=$(python3 <<'PY'
import json
print(json.dumps({
 "BFF_BASE_URL": "http://core.core.svc.cluster.local:3001",
 "CORE_API_URL": "http://core.core.svc.cluster.local:3001",
}))
PY
)
put brain/prod/k8s/web-env "$WEB"

echo
echo "DONE. Seeded: pgbouncer-env, neo4j-auth, iceberg-rest-catalog-db, collector-env, stream-worker-env, web-env."
echo "DEFERRED: core-env (needs SHOPIFY_CLIENT_SECRET / JWT_SIGNING_SECRET / COOKIE_SECRET ARN wiring — app-tier phase)."
echo "DB roles brain_app + iceberg_catalog created; iceberg_catalog DB ensured; pgcrypto/uuid-ossp extensions present."
