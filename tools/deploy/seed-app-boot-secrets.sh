#!/usr/bin/env bash
###############################################################################
# Seed the app-boot secrets core resolves at startup, and add the two required
# connector-secret env keys that core-env was missing. The Terraform-created
# secret SHELLS (brain/prod/app/{cookie,jwt-signing,meta-app}-secret) have no
# AWSCURRENT value → core FATALs ("can't find the specified secret value").
#
#  - cookie-secret / jwt-signing-secret : fresh 32-byte random (raw string; core
#    uses the SecretString directly as the signing key).
#  - meta-app-secret : PLACEHOLDER (non-empty so getSecret() doesn't throw). The
#    Meta/Google/Shopify connectors are reconnected in the UI post-launch, which
#    writes the real client secrets. Until then META_APP_SECRET /
#    GOOGLE_ADS_CLIENT_SECRET / SHOPIFY_CLIENT_SECRET resolve to this placeholder
#    (OAuth callbacks stay non-functional by design — nothing is connected yet).
#
# core-env additions: META_APP_SECRET + GOOGLE_ADS_CLIENT_SECRET (core throws
# fail-closed in prod if either env var is absent; both point at the meta-app
# placeholder ARN). Existing keys are preserved (read + merge, server-side).
#
# Generated values never print.
###############################################################################
set -euo pipefail
REGION=ap-south-1
META_ARN='arn:aws:secretsmanager:ap-south-1:380254378136:secret:brain/prod/app/meta-app-secret-TyIIBt'

echo "[1/3] Seeding cookie + jwt signing secrets (fresh random)..."
COOKIE=$(openssl rand -hex 32)
JWT=$(openssl rand -hex 32)
COOKIE="$COOKIE" aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id brain/prod/app/cookie-secret --secret-string "$COOKIE" >/dev/null
JWT="$JWT" aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id brain/prod/app/jwt-signing-secret --secret-string "$JWT" >/dev/null

echo "[2/3] Seeding meta-app-secret placeholder (reconnect in UI writes the real value)..."
PLACE=$(openssl rand -hex 24)
PLACE="$PLACE" aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id brain/prod/app/meta-app-secret --secret-string "$PLACE" >/dev/null

echo "[3/3] Adding META_APP_SECRET + GOOGLE_ADS_CLIENT_SECRET to core-env (preserve existing)..."
CUR=$(aws secretsmanager get-secret-value --region "$REGION" \
        --secret-id brain/prod/k8s/core-env --query SecretString --output text)
NEW=$(CUR="$CUR" META_ARN="$META_ARN" python3 -c '
import json, os
d = json.loads(os.environ["CUR"])
d["META_APP_SECRET"] = os.environ["META_ARN"]
d["GOOGLE_ADS_CLIENT_SECRET"] = os.environ["META_ARN"]  # placeholder until Google Ads is connected
print(json.dumps(d))
')
aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id brain/prod/k8s/core-env --secret-string "$NEW" >/dev/null
echo "DONE — cookie/jwt seeded, meta-app placeholder seeded, core-env has META_APP_SECRET + GOOGLE_ADS_CLIENT_SECRET."
