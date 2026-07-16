#!/usr/bin/env bash
# prod-local-aws-bootstrap.sh — seed LocalStack so the stack can boot in PRODUCTION-FAITHFUL
# mode locally (NODE_ENV=production code paths against local Docker). Idempotent.
#
# Provisions, in LocalStack (docker-compose `core` profile, :4566):
#   • a KMS CMK + alias/brain-connector-secrets   (connector-secret + PII-vault DEK isolation)
#   • Secrets Manager: brain/jwt-signing-secret, brain/cookie-secret, brain/shopify-client-secret
#     (raw SEED_* values from .env.local-prod so the same secrets resolve)
#   • brand_keyring row for the dev brand: the deterministic dev DEK, KMS-WRAPPED, so the prod
#     KmsVaultKeyProvider unwraps the SAME 32-byte DEK the dev provider derives (PII continuity).
#
# After this, boot:  pnpm dev
# See docs/runbooks/RB-5 "prod-on-local". Requires: stack up (db + localstack), .dbt not needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

LS=brainv3-localstack-1
PG=brainv3-postgres-1
BRAND="${BRAND_ID:-124e6af5-e6c5-4b85-bf43-7b36fa528101}"
ALIAS="alias/brain-connector-secrets"
PW="$(grep -E '^DATABASE_URL=' .env.local-prod | sed -E 's#^.*://[^:]+:([^@]+)@.*#\1#')"
# NO -i: SQL always arrives as $1, never via stdin — and `docker exec -i` inside a
# `... | while read` loop SWALLOWS the loop's remaining stdin (the dev_secret migration
# below silently stopped after the first repointed connector secret; RECONNECT_REQUIRED
# for every connector after it on each restart).
psql() { docker exec -e PGPASSWORD="$PW" "$PG" psql -U brain -d brain -tAc "$1"; }
awsl() { docker exec "$LS" awslocal "$@"; }

echo "[prod-local] ensure LocalStack is up (core profile)"
docker compose --profile core up -d localstack >/dev/null
for i in $(seq 1 30); do curl -sf http://localhost:4566/_localstack/health >/dev/null 2>&1 && break; sleep 2; done

echo "[prod-local] KMS key + alias ($ALIAS)"
if ! awsl kms describe-key --key-id "$ALIAS" >/dev/null 2>&1; then
  KEYID=$(awsl kms create-key --description brain-connector-secrets --query KeyMetadata.KeyId --output text)
  awsl kms create-alias --alias-name "$ALIAS" --target-key-id "$KEYID" >/dev/null
fi
KEY_ARN=$(awsl kms describe-key --key-id "$ALIAS" --query KeyMetadata.Arn --output text)
echo "[prod-local]   key=$KEY_ARN"

echo "[prod-local] Secrets Manager (raw SEED_* values from .env.local-prod)"
for pair in "brain/jwt-signing-secret:SEED_JWT_SIGNING_SECRET" "brain/cookie-secret:SEED_COOKIE_SECRET" "brain/shopify-client-secret:SEED_SHOPIFY_CLIENT_SECRET"; do
  name="${pair%%:*}"; var="${pair#*:}"; val="$(grep -E "^${var}=" .env.local-prod | cut -d= -f2-)"
  awsl secretsmanager create-secret --name "$name" --secret-string "$val" >/dev/null 2>&1 \
    || awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$val" >/dev/null
  echo "[prod-local]   secret $name"
done

echo "[prod-local] SES: verify the sender identity (real SES rejects unverified senders)"
# In prod-local LocalStack runs SES (compose SERVICES includes 'ses'). Like real SES, it rejects
# sends from an unverified From address (MessageRejected). Verify the EMAIL_FROM_ADDRESS sender so
# transactional email (verification, invites, alerts) actually sends. Real prod verifies the
# domain/sender in SES once, out-of-band.
# `|| true`: EMAIL_FROM_ADDRESS may be absent from .env; under `set -e` a failed grep in this
# assignment would kill the whole bootstrap before the ad-platform secrets are seeded.
FROM_ADDR="$(grep -E '^EMAIL_FROM_ADDRESS=' .env.local-prod | cut -d= -f2- || true)"; FROM_ADDR="${FROM_ADDR:-noreply@brain.app}"
awsl ses verify-email-identity --email-address "$FROM_ADDR" >/dev/null 2>&1 \
  && echo "[prod-local]   verified sender $FROM_ADDR" \
  || echo "[prod-local]   WARN: could not verify sender $FROM_ADDR (SES may be disabled)"

echo "[prod-local] Secrets Manager: ad-platform app secrets (SEED_* from .env.local-prod)"
# core boot fail-closes in prod without META_APP_SECRET / GOOGLE_ADS_CLIENT_SECRET. Seed the raw
# SEED_* values from .env.local-prod under the Secrets Manager names the app references, so
# AwsSecretsProvider resolves them at startup.
for pair in "brain/meta-app-secret:SEED_META_APP_SECRET" "brain/google-ads-client-secret:SEED_GOOGLE_ADS_CLIENT_SECRET"; do
  name="${pair%%:*}"; var="${pair#*:}"; val="$(grep -E "^${var}=" .env.local-prod | cut -d= -f2-)"
  [ -z "$val" ] && { echo "[prod-local]   WARN: $var not in .env.local-prod — skipping $name"; continue; }
  awsl secretsmanager create-secret --name "$name" --secret-string "$val" >/dev/null 2>&1 \
    || awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$val" >/dev/null
  echo "[prod-local]   secret $name"
done

echo "[prod-local] Secrets Manager: prod ESO env-blob SHAPES (brain/prod/k8s/*) — AUD-PROD-014"
# Prod delivers every workload's env via External Secrets Operator from 7 flat-JSON blobs under
# brain/prod/k8s/* (key contract: infra/helm/external-secrets-config/README.md). Seed the SAME 7
# names into LocalStack so prod-on-local rehearses the exact ESO secret-shape contract (the
# go-live fill pass can be dry-run locally against real names). Values = the LOCAL substrate
# equivalents from .env.local-prod — SHAPE parity, not value parity (cluster DNS differs).
# ADDITIVE: the flat legacy names above (brain/jwt-signing-secret, brain/cookie-secret, ...)
# REMAIN the refs the running app resolves (.env.local-prod is unchanged) — nothing is repointed.
getv() { grep -E "^$1=" .env.local-prod | head -1 | cut -d= -f2- || true; }
# json-escape via python3 (values can carry &, ?, #, quotes — never hand-assemble JSON).
mkjson() { python3 -c 'import json,sys; a=sys.argv[1:]; print(json.dumps({a[i]: a[i+1] for i in range(0, len(a), 2)}))' "$@"; }
seed_json_secret() {
  local name="$1" json="$2"
  awsl secretsmanager create-secret --name "$name" --secret-string "$json" >/dev/null 2>&1 \
    || awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$json" >/dev/null
  echo "[prod-local]   secret $name"
}
DB_URL="$(getv DATABASE_URL)"; DB_USER_LOCAL="$(printf '%s' "$DB_URL" | sed -E 's#^.*://([^:]+):.*#\1#')"
seed_json_secret brain/prod/k8s/core-env "$(mkjson \
  DATABASE_URL "$DB_URL" \
  BRAIN_APP_DATABASE_URL "$(getv BRAIN_APP_DATABASE_URL)" \
  DATABASE_URL_DIRECT "$DB_URL" \
  REDIS_URL "$(getv REDIS_URL)" \
  KAFKA_BROKERS "$(getv KAFKA_BROKERS)" \
  DUCKDB_SERVING_HOST "$(getv DUCKDB_SERVING_HOST)" \
  ICEBERG_REST_URI "http://localhost:8181" \
  AWS_REGION "$(getv AWS_REGION)" \
  ICEBERG_WAREHOUSE "s3://brain-bronze/" \
  COLLECTOR_TOPIC "$(getv COLLECTOR_TOPIC)" \
  BACKFILL_TOPIC "prod.collector.order.backfill.v1" \
  TOPIC_ENV_PREFIX "prod" \
  NEO4J_URI "$(getv NEO4J_URI)" \
  NEO4J_USER "$(getv NEO4J_USER)" \
  NEO4J_PASSWORD "$(getv NEO4J_PASSWORD)" \
  AUDIT_CHECKPOINT_BUCKET "brain-audit")"
seed_json_secret brain/prod/k8s/web-env "$(mkjson \
  BFF_BASE_URL "$(getv NEXT_PUBLIC_API_BASE_URL)" \
  CORE_API_URL "$(getv NEXT_PUBLIC_API_BASE_URL)")"
seed_json_secret brain/prod/k8s/collector-env "$(mkjson \
  DATABASE_URL "$DB_URL" \
  REDIS_URL "$(getv REDIS_URL)" \
  KAFKA_BROKERS "$(getv KAFKA_BROKERS)" \
  PIXEL_CONSENT_DEFAULT "$(getv PIXEL_CONSENT_DEFAULT)")"
seed_json_secret brain/prod/k8s/stream-worker-env "$(mkjson \
  DATABASE_URL "$DB_URL" \
  KAFKA_BROKERS "$(getv KAFKA_BROKERS)" \
  DUCKDB_SERVING_HOST "$(getv DUCKDB_SERVING_HOST)" \
  NEO4J_URI "$(getv NEO4J_URI)" \
  NEO4J_USER "$(getv NEO4J_USER)" \
  NEO4J_PASSWORD "$(getv NEO4J_PASSWORD)" \
  META_APP_ID "$(getv META_APP_ID)" \
  META_APP_SECRET "$(getv META_APP_SECRET)")"
seed_json_secret brain/prod/k8s/pgbouncer-env "$(mkjson \
  DB_USER "$DB_USER_LOCAL" \
  DB_PASSWORD "$PW")"
# iceberg-rest chart contract: EXACTLY jdbc-user / jdbc-password (compose parity values).
seed_json_secret brain/prod/k8s/iceberg-rest-catalog-db "$(mkjson jdbc-user user jdbc-password password)"
# neo4j chart contract: EXACTLY NEO4J_AUTH = neo4j/<password>.
seed_json_secret brain/prod/k8s/neo4j-auth "$(mkjson NEO4J_AUTH "neo4j/$(getv NEO4J_PASSWORD)")"

# Keyrings for ALL brands, not just the seed dev brand. Every Docker restart mints a NEW CMK
# behind the alias, so every wrapped_dek_b64 encrypted by the OLD CMK fails KMS Decrypt with
# IncorrectKeyException — which broke the per-brand salt fetch (identity-bridge D-2 fail-closed)
# and with it journey-stitch-from-identity for every runtime-created brand. The dev DEK is
# DETERMINISTIC (deriveDevVaultDek(brand_id)), so re-wrapping with the current CMK is lossless:
# previously-encrypted PII stays decryptable. Brand list = existing keyring rows ∪ active brands
# ∪ the seed $BRAND (fresh DB fallback).
provision_keyring() {
  local B="$1"
  local WRAPPED
  WRAPPED=$(cd apps/core && cat > ._wrap.mjs <<EOF
import { deriveDevVaultDek } from '@brain/identity-core';
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';
const dek = Buffer.from(deriveDevVaultDek('$B'));
const c = new KMSClient({ region: 'us-east-1' });
const r = await c.send(new EncryptCommand({ KeyId: '$KEY_ARN', Plaintext: dek }));
process.stdout.write(Buffer.from(r.CiphertextBlob).toString('base64'));
EOF
AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test node_modules/.bin/tsx ._wrap.mjs; rm -f ._wrap.mjs)
  # Guard: an empty WRAPPED means the KMS-wrap helper failed (e.g. @aws-sdk/client-kms not
  # resolvable from apps/core). Inserting an empty wrapped_dek_b64 silently corrupts the keyring
  # and breaks the PII vault at runtime — fail loudly here instead.
  if [ -z "$WRAPPED" ]; then
    echo "[prod-local]   ✗ KMS DEK wrap produced no output — refusing to insert an empty keyring." >&2
    echo "[prod-local]     Ensure @aws-sdk/client-kms is a dependency of apps/core (pnpm install)." >&2
    exit 1
  fi
  psql "INSERT INTO brand_keyring (brand_id, kms_key_id, wrapped_dek_b64, key_version, is_active)
        VALUES ('$B','$KEY_ARN','$WRAPPED',1,true)
        ON CONFLICT (brand_id) DO UPDATE SET kms_key_id=EXCLUDED.kms_key_id,
          wrapped_dek_b64=EXCLUDED.wrapped_dek_b64, is_active=true;" >/dev/null
  echo "[prod-local]   keyring provisioned for $B"
}

# Same restart-wipe class for tenancy.brand_identity_salt: the prod-mode SaltProvider
# (KmsBrandSaltProvider) KMS-unwraps wrapped_salt_b64 — ciphertexts from the OLD CMK fail with
# IncorrectKeyException and the D-2 guard fail-closes identity hashing (journey-stitch, repulls).
# The local salt VALUE is the deterministic dev salt (resolveSaltHex, same one this script seeds
# into .env.local-prod below — hash continuity), so re-wrapping with the current CMK is lossless.
provision_salt() {
  local B="$1"
  local WRAPPED
  WRAPPED=$(cd apps/core && cat > ._wrapsalt.mjs <<EOF
import { resolveSaltHex } from '@brain/identity-core';
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';
const salt = Buffer.from(resolveSaltHex('$B'), 'hex');
if (salt.length !== 32) { throw new Error('dev salt is not 32 bytes'); }
const c = new KMSClient({ region: 'us-east-1' });
const r = await c.send(new EncryptCommand({ KeyId: '$KEY_ARN', Plaintext: salt }));
process.stdout.write(Buffer.from(r.CiphertextBlob).toString('base64'));
EOF
AWS_ENDPOINT_URL=http://localhost:4566 AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test NODE_ENV='' node_modules/.bin/tsx ._wrapsalt.mjs; rm -f ._wrapsalt.mjs)
  if [ -z "$WRAPPED" ]; then
    echo "[prod-local]   ✗ KMS salt wrap produced no output — refusing to insert an empty salt row." >&2
    exit 1
  fi
  psql "INSERT INTO tenancy.brand_identity_salt (brand_id, kms_key_id, wrapped_salt_b64, key_version, is_active)
        VALUES ('$B','$KEY_ARN','$WRAPPED',1,true)
        ON CONFLICT (brand_id) DO UPDATE SET kms_key_id=EXCLUDED.kms_key_id,
          wrapped_salt_b64=EXCLUDED.wrapped_salt_b64, is_active=true;" >/dev/null
  echo "[prod-local]   identity salt provisioned for $B"
}

echo "[prod-local] brand_keyring + brand_identity_salt re-wrap for ALL brands (KMS-wrapped, PII continuity)"
ALL_BRANDS=$(psql "SELECT brand_id FROM brand_keyring UNION SELECT brand_id FROM tenancy.brand_identity_salt UNION SELECT id FROM list_active_brand_ids() UNION SELECT '$BRAND'::uuid")
for B in $ALL_BRANDS; do
  [ -z "$B" ] && continue
  provision_keyring "$B"
  provision_salt "$B"
done

echo "[prod-local] migrate connector secrets dev_secret → Secrets Manager (prod 'reconnect')"
# In dev the connector tokens live in PG dev_secret (LocalSecretsManager); in prod the worker reads
# them from Secrets Manager (AwsSecretsManager). Copy them verbatim so the prod-mode ingest repull
# resolves its tokens — same secret NAME, raw value (getShopifyToken returns SecretString as-is).
# NOTE: no `grep -v '^$'` here — on a fresh/empty DB dev_secret has 0 rows, and grep exits 1 on
# empty input which (under `set -o pipefail`) would kill the whole bootstrap before salt-seeding.
# The in-loop empty-name guard below already skips blank lines.
psql "SELECT name || E'\t' || secret_value FROM dev_secret" | while IFS=$'\t' read -r name val; do
  [ -z "$name" ] && continue
  if awsl secretsmanager create-secret --name "$name" --secret-string "$val" >/dev/null 2>&1 \
    || awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$val" >/dev/null 2>&1; then
    echo "[prod-local]   secret $name"
  else
    echo "[prod-local]   WARN: secret $name failed create AND put — token will 404 (reconnect required)"
  fi
  # Re-point connector_instance.secret_ref to the freshly-created ARN. LocalStack appends a NEW random
  # 6-char suffix on every create-secret, and getShopifyToken/etc. fetch by the FULL ARN — so the stale
  # ARN in secret_ref (captured before the restart) would 404 (verified: GetSecretValue by old ARN →
  # ResourceNotFound). Match the row by the suffix-stripped NAME and rebind to the new ARN so a restored
  # token actually resolves — this is what makes `dev:secrets-snapshot` durable across Docker restarts.
  case "$name" in
    brain/connector/*)
      newarn="$(awsl secretsmanager describe-secret --secret-id "$name" --query ARN --output text 2>/dev/null | tr -d '\r')"
      if [ -n "$newarn" ] && [ "$newarn" != "None" ]; then
        psql "UPDATE connectors.connector_instance SET secret_ref='$newarn', updated_at=now()
              WHERE secret_ref LIKE '%:secret:${name}-%' OR secret_ref='$name';" >/dev/null 2>&1 || true
      fi
      ;;
  esac
done

echo "[prod-local] seed per-brand identity salts → .env.local-prod (prod has no dev-salt fallback)"
# resolveSaltHex returns the deterministic dev salt ONLY when NODE_ENV!='production'. In prod it
# needs IDENTITY_SALT_<BRAND_NODASHES_UPPER>, else the D-2 guard hard-crashes PII hashing in the
# identity bridge AND the ingest repull mapper (so "Sync now" produces nothing). Seed each brand's
# salt = its SAME deterministic dev value, preserving hash continuity with the existing data.
ENV_PROD="$(pwd)/.env.local-prod"
for B in $(psql "SELECT id FROM brand"); do
  [ -z "$B" ] && continue
  KEY="IDENTITY_SALT_$(echo "$B" | tr -d '-' | tr '[:lower:]' '[:upper:]')"
  SALT=$(cd apps/core && NODE_ENV='' node_modules/.bin/tsx -e \
    "import('@brain/identity-core').then(m=>process.stdout.write(m.resolveSaltHex(process.argv[1])))" "$B" 2>/dev/null)
  [ ${#SALT} -ne 64 ] && { echo "[prod-local]   WARN: salt for $B not 64-hex, skipping"; continue; }
  if grep -q "^${KEY}=" "$ENV_PROD" 2>/dev/null; then
    sed -i '' "s|^${KEY}=.*|${KEY}=${SALT}|" "$ENV_PROD"
  else
    printf '%s=%s\n' "$KEY" "$SALT" >> "$ENV_PROD"
  fi
  echo "[prod-local]   salt $KEY"
done

echo "[prod-local] DONE — boot with:  pnpm dev"
