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
psql() { docker exec -i -e PGPASSWORD="$PW" "$PG" psql -U brain -d brain -tAc "$1"; }
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

echo "[prod-local] brand_keyring for $BRAND (KMS-wrapped dev DEK, for PII continuity)"
WRAPPED=$(cd apps/core && cat > ._wrap.mjs <<EOF
import { deriveDevVaultDek } from '@brain/identity-core';
import { KMSClient, EncryptCommand } from '@aws-sdk/client-kms';
const dek = Buffer.from(deriveDevVaultDek('$BRAND'));
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
      VALUES ('$BRAND','$KEY_ARN','$WRAPPED',1,true)
      ON CONFLICT (brand_id) DO UPDATE SET kms_key_id=EXCLUDED.kms_key_id,
        wrapped_dek_b64=EXCLUDED.wrapped_dek_b64, is_active=true;" >/dev/null
echo "[prod-local]   keyring provisioned"

echo "[prod-local] migrate connector secrets dev_secret → Secrets Manager (prod 'reconnect')"
# In dev the connector tokens live in PG dev_secret (LocalSecretsManager); in prod the worker reads
# them from Secrets Manager (AwsSecretsManager). Copy them verbatim so the prod-mode ingest repull
# resolves its tokens — same secret NAME, raw value (getShopifyToken returns SecretString as-is).
# NOTE: no `grep -v '^$'` here — on a fresh/empty DB dev_secret has 0 rows, and grep exits 1 on
# empty input which (under `set -o pipefail`) would kill the whole bootstrap before salt-seeding.
# The in-loop empty-name guard below already skips blank lines.
psql "SELECT name || E'\t' || secret_value FROM dev_secret" | while IFS=$'\t' read -r name val; do
  [ -z "$name" ] && continue
  awsl secretsmanager create-secret --name "$name" --secret-string "$val" >/dev/null 2>&1 \
    || awsl secretsmanager put-secret-value --secret-id "$name" --secret-string "$val" >/dev/null 2>&1
  echo "[prod-local]   secret $name"
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
