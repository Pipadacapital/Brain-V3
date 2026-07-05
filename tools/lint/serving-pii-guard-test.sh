#!/usr/bin/env bash
#
# serving-pii-guard-test.sh — self-test for tools/lint/serving-pii-guard.sh (CI sanity).
#
# Builds a temp fixture views dir and proves the guard:
#   1. FAILS (exit 1) on a view that PROJECTS raw PII (SELECT c.email …, bare + aliased forms).
#   2. PASSES (exit 0) on a view that projects only hashed/derived forms (email_sha256,
#      *_hash, hashed_*, has_*, email_domain), even when raw-PII words appear in `--`
#      comments and in the WHERE clause (only the SELECT list is in scope).
#   3. Fails CLOSED (exit 2) on a missing/empty views dir.
#
# Usage: tools/lint/serving-pii-guard-test.sh   (runnable directly; CI runs it before the guard)
#
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$DIR/serving-pii-guard.sh"

RED=$'\033[31m'; GRN=$'\033[32m'; RST=$'\033[0m'
fails=0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bad" "$TMP/good" "$TMP/empty"

# ── Violating fixture: projects raw PII (bare ref, qualified ref, and AS-alias forms) ──────────
cat > "$TMP/bad/mv_bad_raw_pii.sql" <<'EOF'
-- fixture: a serving view that leaks raw PII into its output schema (MUST flag)
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_bad_raw_pii AS
SELECT
  brand_id,
  c.email,
  c.contact_phone_raw AS phone,
  first_name,
  concat(c.line1, c.city) AS shipping_address
FROM iceberg.brain_gold.gold_customer_360 c;
EOF

# ── Passing fixture: hashed/derived forms only; PII words confined to comments + WHERE ─────────
cat > "$TMP/good/mv_good_hashed.sql" <<'EOF'
-- fixture: email / phone / address appear here in a comment — comments are stripped, no flag
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_good_hashed AS
SELECT
  brand_id,
  email_sha256,            -- hashed form (allowlisted exact name)
  c.phone_sha256,
  c.customer_email_hash,   -- *_hash suffix
  device_id_hashed,        -- *_hashed suffix
  hashed_customer_email,   -- hashed_* prefix (live mv_silver_return form)
  has_email,               -- boolean presence flag
  has_address,             -- boolean presence flag (live mv_silver_checkout_signal form)
  email_domain,
  address_normalized_hash
FROM iceberg.brain_silver.silver_identity_map c
WHERE c.email IS NOT NULL  -- raw ref OUTSIDE the SELECT list: filtered on, never projected
GROUP BY brand_id, email_sha256, c.phone_sha256, c.customer_email_hash, device_id_hashed,
         hashed_customer_email, has_email, has_address, email_domain, address_normalized_hash;
EOF

check() { # $1 label  $2 views_dir  $3 expected_exit  $4 must_contain (optional, grep -F over output)
  local label="$1" dir="$2" want="$3" needle="${4:-}" out rc
  set +e
  out="$(VIEWS_DIR="$dir" "$GUARD" 2>&1)"
  rc=$?
  set -e
  if [ "$rc" -ne "$want" ]; then
    echo "${RED}SELFTEST FAIL [$label]: expected exit $want, got $rc${RST}"
    printf '%s\n' "$out" | sed 's/^/      /'
    fails=$((fails + 1))
    return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$out" | grep -qF "$needle"; then
    echo "${RED}SELFTEST FAIL [$label]: output missing '$needle'${RST}"
    printf '%s\n' "$out" | sed 's/^/      /'
    fails=$((fails + 1))
    return
  fi
  echo "${GRN}✓ [$label] exit=$rc as expected${needle:+ (output mentions '$needle')}${RST}"
}

check "violating view fails"            "$TMP/bad"        1 "mv_bad_raw_pii.sql"
check "flags bare column ref (email)"   "$TMP/bad"        1 "'email'"
check "flags AS alias (phone)"          "$TMP/bad"        1 "'phone'"
check "flags expr alias (shipping_address)" "$TMP/bad"    1 "'shipping_address'"
check "hashed/derived view passes"      "$TMP/good"       0 "no raw-PII column projected"
check "empty views dir fails closed"    "$TMP/empty"      2 ""
check "missing views dir fails closed"  "$TMP/does-not-exist" 2 ""

echo ""
if [ "$fails" -gt 0 ]; then
  echo "${RED}serving-pii-guard self-test FAILED: $fails assertion(s).${RST}"
  exit 1
fi
echo "${GRN}✓ serving-pii-guard self-test passed (catches raw-PII projections; no false positives on hashed/derived forms, comments, or WHERE refs).${RST}"
exit 0
