#!/usr/bin/env bash
# prod-local-aws-bootstrap.sh — seed LocalStack so the stack can boot in PRODUCTION-FAITHFUL
# mode locally (NODE_ENV=production code paths against local Docker). Idempotent.
#
# Provisions, in LocalStack (docker-compose `core` profile, :4566):
#   • a KMS CMK + alias/brain-connector-secrets   (connector-secret + PII-vault DEK isolation)
#   • Secrets Manager: brain/jwt-signing-secret, brain/cookie-secret, brain/shopify-client-secret
#     (values copied from the dev base `.env` so the same secrets resolve)
#   • brand_keyring row for the dev brand: the deterministic dev DEK, KMS-WRAPPED, so the prod
#     KmsVaultKeyProvider unwraps the SAME 32-byte DEK the dev provider derives (PII continuity).
#
# After this, boot the prod profile:  APP_ENV=prod pnpm dev   (loads .env.prod)
# See docs/runbooks/RB-5 "prod-on-local". Requires: stack up (db + localstack), .dbt not needed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

LS=brainv3-localstack-1
PG=brainv3-postgres-1
BRAND="${BRAND_ID:-124e6af5-e6c5-4b85-bf43-7b36fa528101}"
ALIAS="alias/brain-connector-secrets"
PW="$(grep -E '^DATABASE_URL=' .env | sed -E 's#^.*://[^:]+:([^@]+)@.*#\1#')"
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

echo "[prod-local] Secrets Manager (values from dev .env)"
for pair in "brain/jwt-signing-secret:JWT_SIGNING_SECRET" "brain/cookie-secret:COOKIE_SECRET" "brain/shopify-client-secret:SHOPIFY_CLIENT_SECRET"; do
  name="${pair%%:*}"; var="${pair#*:}"; val="$(grep -E "^${var}=" .env | cut -d= -f2-)"
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
psql "INSERT INTO brand_keyring (brand_id, kms_key_id, wrapped_dek_b64, key_version, is_active)
      VALUES ('$BRAND','$KEY_ARN','$WRAPPED',1,true)
      ON CONFLICT (brand_id) DO UPDATE SET kms_key_id=EXCLUDED.kms_key_id,
        wrapped_dek_b64=EXCLUDED.wrapped_dek_b64, is_active=true;" >/dev/null
echo "[prod-local]   keyring provisioned"
echo "[prod-local] DONE — boot with:  APP_ENV=prod pnpm dev"
