#!/usr/bin/env bash
#
# spark-guard-suite.sh — run the Spark-tier Python guard/parity suite (BLOCKING CI gate).
# AUD-IMPL-008 (subsumes AUD-ID-10): these guards encode the platform's core invariants —
# probabilistic-identity quarantine (§1.4), collector-gate admission (CRIT-4 anti-starvation),
# unmerge versioned-copy (A.2.4), attribution projection parity, erasure payload-path, x-lang
# identity hashing interop — but historically ran in NO CI workflow, so two of them sat red
# and unnoticed (AUD-IMPL-009 / AUD-IMPL-010). This runner makes the whole suite a PR gate.
#
# WHAT IT RUNS
#   Every db/iceberg/spark/**/*_test.py, each as a plain `python3 <file>` (every guard is
#   self-executing: plain-script checks or a `__main__` that re-execs itself under pytest).
#   The suite is PySpark-FREE by design — jobs are AST/source-parsed, never imported — so it
#   needs only python3 + pytest and finishes in seconds.
#
# EXCLUDED (each with a WHY):
#   • _identity_normalization_xlang_test.py — needs a generated TS corpus
#     (`pnpm --filter @brain/identity-normalization exec tsx src/a52-gen-corpus.ts`) plus pip
#     `phonenumbers`; it is the cross-language interop proof, not a pure static guard. It runs
#     in the spark image build context (db/iceberg/spark/Dockerfile pins phonenumbers).
#
# Usage:
#   tools/lint/spark-guard-suite.sh             # run the suite; exit 1 if ANY guard fails
#   tools/lint/spark-guard-suite.sh --selftest  # prove the runner fails on a red guard and
#                                               # passes on a green one (synthetic corpus)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'

# Overridable for the self-test only (mirrors the *_ALLOWLIST override convention of the
# sibling guards) — CI always runs against the real tree.
SUITE_ROOT="${SPARK_GUARD_SUITE_ROOT:-db/iceberg/spark}"

# Excluded test files (basename match), each documented in the header above.
EXCLUDE=(
  "_identity_normalization_xlang_test.py"
)

is_excluded() { # $1 = basename
  local e
  for e in "${EXCLUDE[@]}"; do [ "$1" = "$e" ] && return 0; done
  return 1
}

run_suite() {
  local failures=() ran=0 f base out code
  while IFS= read -r f; do
    base="$(basename "$f")"
    if is_excluded "$base"; then
      echo "${YEL}[spark-guard-suite] SKIP  $f (documented exclusion)${RST}"
      continue
    fi
    ran=$((ran + 1))
    if out="$(python3 "$f" 2>&1)"; code=$?; [ $code -eq 0 ]; then
      echo "${GRN}[spark-guard-suite] PASS  $f${RST}"
    else
      echo "${RED}[spark-guard-suite] FAIL  $f (exit $code)${RST}"
      echo "$out" | tail -25 | sed 's/^/    /'
      failures+=("$f")
    fi
  done < <(find "$SUITE_ROOT" -name "*_test.py" -not -path "*/node_modules/*" | sort)

  if [ "$ran" -eq 0 ]; then
    echo "${RED}[spark-guard-suite] FAIL — no *_test.py found under $SUITE_ROOT (discovery broken?)${RST}"
    return 1
  fi
  if [ "${#failures[@]}" -gt 0 ]; then
    echo "${RED}[spark-guard-suite] FAILED ${#failures[@]}/$ran guard file(s):${RST}"
    printf '    %s\n' "${failures[@]}"
    return 1
  fi
  echo "${GRN}[spark-guard-suite] OK — all $ran guard files green.${RST}"
  return 0
}

selftest() {
  local tmp rc
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  cat > "$tmp/green_guard_test.py" <<'PY'
import sys
sys.exit(0)
PY
  cat > "$tmp/red_guard_test.py" <<'PY'
import sys
print("synthetic red guard", file=sys.stderr)
sys.exit(1)
PY
  # excluded name must be skipped even though it would fail
  cat > "$tmp/_identity_normalization_xlang_test.py" <<'PY'
import sys
sys.exit(2)
PY

  # 1) red guard present → suite must FAIL and name the file
  rc=0
  out="$(SPARK_GUARD_SUITE_ROOT="$tmp" "${BASH_SOURCE[0]}" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ] || ! grep -q "red_guard_test.py" <<<"$out"; then
    echo "${RED}[spark-guard-suite] SELFTEST FAIL — a red guard did not fail the suite${RST}"
    echo "$out"
    return 1
  fi
  if ! grep -q "SKIP.*_identity_normalization_xlang_test.py" <<<"$out"; then
    echo "${RED}[spark-guard-suite] SELFTEST FAIL — documented exclusion was not skipped${RST}"
    echo "$out"
    return 1
  fi

  # 2) only green guards → suite must PASS
  rm "$tmp/red_guard_test.py"
  if ! SPARK_GUARD_SUITE_ROOT="$tmp" "${BASH_SOURCE[0]}" > /dev/null 2>&1; then
    echo "${RED}[spark-guard-suite] SELFTEST FAIL — a green corpus did not pass${RST}"
    return 1
  fi

  echo "${GRN}[spark-guard-suite] SELFTEST OK — red guard fails the suite, exclusions skip, green passes.${RST}"
  return 0
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
else
  run_suite
fi
