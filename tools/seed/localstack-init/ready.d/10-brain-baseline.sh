#!/bin/bash
# 10-brain-baseline.sh — LocalStack READY-hook: re-seed the AWS-side baseline on EVERY container
# start (LocalStack community wipes KMS/Secrets Manager state on restart — persistence is Pro-only).
#
# WHY: 2026-07-17 e2e validation reproduced POST /bff/onboarding/provision → 500 INTERNAL_ERROR
# because a docker restart (~16 min earlier) had wiped ALL KMS aliases; provisionBrandCrypto
# (NODE_ENV=production path) could not encrypt against alias/brain-connector-secrets until someone
# manually ran tools/seed/prod-local-aws-bootstrap.sh. This hook makes the AWS-side recovery
# HANDS-OFF: LocalStack executes /etc/localstack/init/ready.d/*.sh inside the container whenever it
# reaches READY — i.e. on every `docker compose up` / restart — so the alias + baseline secrets
# always exist by the time the app talks to :4566.
#
# SCOPE — this hook seeds ONLY what can be done inside the container (awslocal + the mounted
# .env.local-prod). It is the exact AWS-side subset of tools/seed/prod-local-aws-bootstrap.sh:
#   • KMS CMK + alias/brain-connector-secrets (idempotent — keeps an existing alias)
#   • Secrets Manager flat app secrets from SEED_* values (jwt/cookie/shopify/meta/google-ads)
#   • SES sender identity verification
# The PG-DEPENDENT recovery steps still live in `pnpm bootstrap` (host-side, needs psql + node):
#   • dev_secret → Secrets Manager connector-token restore (+ secret_ref repoint)
#   • brand_keyring / brand_identity_salt DEK re-wrap against the (possibly new) KMS key
# After a restart, existing brands' wrapped DEKs reference the OLD (wiped) key until bootstrap
# re-wraps them — unchanged behavior; this hook removes the "new provision 500s" failure mode.
#
# Mounted by docker-compose.yml (localstack service):
#   ./tools/seed/localstack-init/ready.d → /etc/localstack/init/ready.d:ro
#   ./.env.local-prod                    → /etc/brain/.env.local-prod:ro
set -u

ALIAS="alias/brain-connector-secrets"
ENVFILE="/etc/brain/.env.local-prod"

echo "[brain-init] ready.d baseline seed starting"

# ── KMS key + alias (idempotent: never replaces an existing alias) ─────────────────────────────
if ! awslocal kms describe-key --key-id "$ALIAS" >/dev/null 2>&1; then
  KEYID=$(awslocal kms create-key --description brain-connector-secrets \
            --query KeyMetadata.KeyId --output text)
  awslocal kms create-alias --alias-name "$ALIAS" --target-key-id "$KEYID"
  echo "[brain-init] created KMS key $KEYID + $ALIAS"
else
  echo "[brain-init] $ALIAS already present"
fi

# ── Secrets Manager flat app secrets (SEED_* values from the mounted .env.local-prod) ──────────
getv() { grep -E "^$1=" "$ENVFILE" 2>/dev/null | head -1 | cut -d= -f2-; }

seed_secret() {
  local name="$1" val="$2"
  [ -z "$val" ] && { echo "[brain-init] WARN: no value for $name — skipped"; return 0; }
  awslocal secretsmanager create-secret --name "$name" --secret-string "$val" >/dev/null 2>&1 \
    || awslocal secretsmanager put-secret-value --secret-id "$name" --secret-string "$val" >/dev/null
  echo "[brain-init] secret $name"
}

if [ -f "$ENVFILE" ]; then
  seed_secret brain/jwt-signing-secret        "$(getv SEED_JWT_SIGNING_SECRET)"
  seed_secret brain/cookie-secret             "$(getv SEED_COOKIE_SECRET)"
  seed_secret brain/shopify-client-secret     "$(getv SEED_SHOPIFY_CLIENT_SECRET)"
  seed_secret brain/meta-app-secret           "$(getv SEED_META_APP_SECRET)"
  seed_secret brain/google-ads-client-secret  "$(getv SEED_GOOGLE_ADS_CLIENT_SECRET)"

  # SES sender identity (real SES rejects unverified From addresses; LocalStack mirrors that).
  FROM_ADDR="$(getv EMAIL_FROM_ADDRESS)"; FROM_ADDR="${FROM_ADDR:-noreply@brain.app}"
  awslocal ses verify-email-identity --email-address "$FROM_ADDR" >/dev/null 2>&1 \
    && echo "[brain-init] verified SES sender $FROM_ADDR" \
    || echo "[brain-init] WARN: could not verify SES sender $FROM_ADDR"
else
  echo "[brain-init] WARN: $ENVFILE not mounted — only the KMS alias was ensured"
fi

echo "[brain-init] ready.d baseline seed done (run 'pnpm bootstrap' for the PG-dependent restore)"
