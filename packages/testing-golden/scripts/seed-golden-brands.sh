#!/usr/bin/env bash
# SPEC: WA.1.10 — seed the 3 fictional golden brands into the local stack's Postgres (§1.10)
#
# Idempotent (ON CONFLICT DO NOTHING everywhere): owner user → org → 3 brands →
# 3 pixel_installation rows whose install_token values are the FIXED constants the
# generator stamps into every pixel event (R2 tenant derivation resolves them) →
# 3 tenancy.brand_identity_salt rows (KMS-wrapped deterministic dev salt).
#
# Salt posture (matches tools/seed/prod-local-aws-bootstrap.sh provision_salt):
# the prod-on-local stream-worker resolves per-brand salts from
# tenancy.brand_identity_salt via KmsBrandSaltProvider and FAIL-CLOSES (D-2) on a
# missing row — every golden event would retry 5× then DLQ without one. The salt
# VALUE is resolveSaltHex(brandId)'s deterministic dev salt — the SAME salt the
# golden generator uses for its salted connector hashes (src/scenarios.ts), so
# identifier hashes are consistent and reproducible across stack rebuilds.
#
# Env: PG_CONTAINER (default brainv3-postgres-1), PG_USER/PG_DB (default brain/brain),
#      KMS_ALIAS (default alias/brain-connector-secrets), AWS_ENDPOINT_URL (default
#      http://localhost:4566 — LocalStack), SKIP_SALT_PROVISION=1 to skip.
set -euo pipefail

PG_CONTAINER="${PG_CONTAINER:-brainv3-postgres-1}"
PG_USER="${PG_USER:-brain}"
PG_DB="${PG_DB:-brain}"

# FIXED ids — MUST match packages/testing-golden/src/fixtures.ts
OWNER_USER_ID='00000000-90de-4002-8000-000000000002'
ORG_ID='00000000-90de-4001-8000-000000000001'

AURORA_ID='a0a0a0a0-0001-4000-8000-000000000a01'
AURORA_TOKEN='a0a0a0a0-1001-4000-8000-00000000f001'
BAZAAR_ID='b0b0b0b0-0002-4000-8000-000000000b02'
BAZAAR_TOKEN='b0b0b0b0-1002-4000-8000-00000000f002'
CEDAR_ID='c0c0c0c0-0003-4000-8000-000000000c03'
CEDAR_TOKEN='c0c0c0c0-1003-4000-8000-00000000f003'

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" <<SQL
-- Golden fixture owner (no real login: sentinel password hash)
INSERT INTO iam.app_user (id, email, email_normalized, password_hash, status)
VALUES ('${OWNER_USER_ID}', 'golden-fixtures-owner@example.test', 'golden-fixtures-owner@example.test',
        '!golden-fixture-no-login', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO tenancy.organization (id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step)
VALUES ('${ORG_ID}', 'Golden Fixtures Org', 'golden-fixtures', '${OWNER_USER_ID}', 'IN', 'complete', 4)
ON CONFLICT DO NOTHING;

INSERT INTO tenancy.brand (id, organization_id, display_name, domain, status, region_code, currency_code, timezone)
VALUES
  ('${AURORA_ID}', '${ORG_ID}', 'Aurora Athletics (golden)', 'aurora-athletics.golden.test', 'active', 'IN', 'INR', 'Asia/Kolkata'),
  ('${BAZAAR_ID}', '${ORG_ID}', 'Bazaar Bloom (golden)',     'bazaar-bloom.golden.test',     'active', 'IN', 'INR', 'Asia/Kolkata'),
  ('${CEDAR_ID}',  '${ORG_ID}', 'Cedar & Sand (golden)',     'cedar-and-sand.golden.test',   'active', 'KW', 'KWD', 'Asia/Kuwait')
ON CONFLICT DO NOTHING;

INSERT INTO pixel.pixel_installation (id, brand_id, install_token, target_host, installed_at)
VALUES
  ('a0a0a0a0-2001-4000-8000-00000000e001', '${AURORA_ID}', '${AURORA_TOKEN}', 'aurora-athletics.golden.test', now()),
  ('b0b0b0b0-2002-4000-8000-00000000e002', '${BAZAAR_ID}', '${BAZAAR_TOKEN}', 'bazaar-bloom.golden.test',     now()),
  ('c0c0c0c0-2003-4000-8000-00000000e003', '${CEDAR_ID}',  '${CEDAR_TOKEN}',  'cedar-and-sand.golden.test',   now())
ON CONFLICT DO NOTHING;

SELECT b.display_name, b.currency_code, pi.install_token
FROM tenancy.brand b JOIN pixel.pixel_installation pi ON pi.brand_id = b.id
WHERE b.id IN ('${AURORA_ID}', '${BAZAAR_ID}', '${CEDAR_ID}');
SQL

# ── identity salt provisioning (D-2 fail-closed guard needs a row per brand) ──
# Mirrors tools/seed/prod-local-aws-bootstrap.sh provision_salt: KMS-wrap the
# deterministic dev salt under the LocalStack CMK. ON CONFLICT DO NOTHING keeps
# an existing (bootstrap-re-wrapped) row authoritative.
if [ "${SKIP_SALT_PROVISION:-0}" != "1" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
  KMS_ALIAS="${KMS_ALIAS:-alias/brain-connector-secrets}"
  AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}"
  export AWS_ENDPOINT_URL AWS_REGION="${AWS_REGION:-us-east-1}" \
         AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"

  for B in "$AURORA_ID" "$BAZAAR_ID" "$CEDAR_ID"; do
    HAS_ROW="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc \
      "SELECT 1 FROM tenancy.brand_identity_salt WHERE brand_id = '${B}'")"
    if [ "$HAS_ROW" = "1" ]; then
      echo "[seed-golden-brands]   salt row exists for $B — leaving it authoritative"
      continue
    fi
    WRAPPED_AND_ARN="$(cd "$REPO_ROOT/apps/core" && cat > ._wrapsalt_golden.mjs <<EOF
import { resolveSaltHex } from '@brain/identity-core';
import { KMSClient, EncryptCommand, DescribeKeyCommand } from '@aws-sdk/client-kms';
const salt = Buffer.from(resolveSaltHex('$B'), 'hex');
if (salt.length !== 32) { throw new Error('dev salt is not 32 bytes'); }
const c = new KMSClient({ region: process.env.AWS_REGION });
const k = await c.send(new DescribeKeyCommand({ KeyId: '$KMS_ALIAS' }));
const r = await c.send(new EncryptCommand({ KeyId: k.KeyMetadata.Arn, Plaintext: salt }));
process.stdout.write(Buffer.from(r.CiphertextBlob).toString('base64') + '\t' + k.KeyMetadata.Arn);
EOF
NODE_ENV='' node_modules/.bin/tsx ._wrapsalt_golden.mjs; rm -f ._wrapsalt_golden.mjs)"
    WRAPPED="${WRAPPED_AND_ARN%%$'\t'*}"
    KEY_ARN="${WRAPPED_AND_ARN##*$'\t'}"
    if [ -z "$WRAPPED" ] || [ -z "$KEY_ARN" ]; then
      echo "[seed-golden-brands] ✗ KMS salt wrap failed for $B — refusing to insert an empty salt row." >&2
      exit 1
    fi
    docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -c \
      "INSERT INTO tenancy.brand_identity_salt (brand_id, kms_key_id, wrapped_salt_b64, key_version, is_active)
       VALUES ('${B}', '${KEY_ARN}', '${WRAPPED}', 1, true)
       ON CONFLICT (brand_id) DO NOTHING;" >/dev/null
    echo "[seed-golden-brands]   identity salt provisioned for $B"
  done
fi

echo "[seed-golden-brands] 3 golden brands seeded (idempotent)."
