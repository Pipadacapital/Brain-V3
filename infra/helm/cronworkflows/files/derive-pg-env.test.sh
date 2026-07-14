#!/usr/bin/env bash
# Unit test for derive-pg-env.sh — the DuckDB Silver/Gold cron PG-env derivation.
# Run: bash infra/helm/cronworkflows/files/derive-pg-env.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$here/derive-pg-env.sh"
rc=0

assert() { # label expected actual
  if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 — expected [$2] got [$3]"; return 1; fi
}

echo "case 1: DATABASE_URL_DIRECT — creds + explicit port + sslmode query"
(
  export DATABASE_URL_DIRECT="postgresql://brain:s3cr3t@aurora.prod.rds.amazonaws.com:5432/brain?sslmode=require"
  unset DATABASE_URL SILVER_PG_JDBC_URL 2>/dev/null || true
  . "$SCRIPT" >/dev/null
  assert "bronze jdbc keeps query" "jdbc:postgresql://aurora.prod.rds.amazonaws.com:5432/brain?sslmode=require" "${BRONZE_PG_JDBC_URL:-}" &&
  assert "silver host"  "aurora.prod.rds.amazonaws.com" "${SILVER_PG_HOST:-}" &&
  assert "silver port"  "5432"  "${SILVER_PG_PORT:-}" &&
  assert "silver db bare (no query)" "brain" "${SILVER_PG_DB:-}" &&
  assert "gold user"    "brain" "${GOLD_PG_USER:-}" &&
  assert "gold pass"    "s3cr3t" "${GOLD_PG_PASSWORD:-}"
) || rc=1

echo "case 2: fallback to DATABASE_URL, no explicit port → default 5432"
(
  unset DATABASE_URL_DIRECT SILVER_PG_JDBC_URL 2>/dev/null || true
  export DATABASE_URL="postgres://u:p@host.internal/brain"
  . "$SCRIPT" >/dev/null
  assert "port defaulted" "5432" "${SILVER_PG_PORT:-}" &&
  assert "host parsed"    "host.internal" "${BRONZE_PG_HOST:-}" &&
  assert "bronze jdbc"    "jdbc:postgresql://host.internal/brain" "${BRONZE_PG_JDBC_URL:-}" &&
  assert "gold user"      "u" "${GOLD_PG_USER:-}"
) || rc=1

echo "case 3: explicit SILVER_PG_JDBC_URL override — derivation is a no-op"
(
  export DATABASE_URL_DIRECT="postgresql://x:y@aurora:5432/brain"
  export SILVER_PG_JDBC_URL="jdbc:postgresql://override:5432/brain"
  unset BRONZE_PG_JDBC_URL 2>/dev/null || true
  . "$SCRIPT" >/dev/null
  assert "override untouched" "jdbc:postgresql://override:5432/brain" "${SILVER_PG_JDBC_URL:-}" &&
  assert "bronze NOT derived" "" "${BRONZE_PG_JDBC_URL:-}"
) || rc=1

echo "case 4: no source URL — no-op (compose defaults left intact for the jobs)"
(
  unset DATABASE_URL_DIRECT DATABASE_URL SILVER_PG_JDBC_URL BRONZE_PG_JDBC_URL 2>/dev/null || true
  . "$SCRIPT" >/dev/null
  assert "no-op" "" "${BRONZE_PG_JDBC_URL:-}"
) || rc=1

if [ "$rc" -eq 0 ]; then echo "PASS: all derive-pg-env cases"; else echo "FAIL: derive-pg-env"; fi
exit $rc
