#!/usr/bin/env bash
# SPEC: WA.1.10 — seed the 3 fictional golden brands into the local stack's Postgres (§1.10)
#
# Idempotent (ON CONFLICT DO NOTHING everywhere): owner user → org → 3 brands →
# 3 pixel_installation rows whose install_token values are the FIXED constants the
# generator stamps into every pixel event (R2 tenant derivation resolves them).
#
# identity_salt_ciphertext stays NULL — the SAME posture as every live local brand
# (verified: all 8 existing brands are NULL; salts resolve via resolveSaltHex).
#
# Env: PG_CONTAINER (default brainv3-postgres-1), PG_USER/PG_DB (default brain/brain)
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

echo "[seed-golden-brands] 3 golden brands seeded (idempotent)."
