#!/usr/bin/env bash
#
# deprecation-guard.sh — Wave-D semantic-layer DEPRECATION lint (BLOCKING CI gate).  SPEC: D.4.5 / D.5.
#
# Wave D introduces the `semantic_*` entity views + the compiled metric registry as the SINGLE naming /
# consumption authority (knowledge-base/semantic/deprecation-map.md). The legacy Gold/Silver marts listed
# there STAY LIVE and served (§0.5 ADDITIVE-ONLY — nothing is dropped/renamed), but they are FROZEN for
# NEW consumers: after this wave a new app/BFF/metric-engine reader must bind to the semantic entity /
# compiled metric view, never to a deprecated mart.
#
# This guard FAILS (exit 1) when a NON-allowlisted, NON-comment source line under the consumer scan roots
# (apps, packages) references a DEPRECATED mart as a whole identifier. The allowlist
# (tools/lint/deprecation-guard-allowlist.txt) is the grandfathered baseline: every file that already read
# a deprecated mart at the close of Wave D (they migrate route-by-route in D.3 behind `semantic.serving`).
# A file NOT in the allowlist that references a deprecated mart is a NEW consumer → blocked. This mirrors
# the file-level mechanism of identity-view-guard.sh (a "consumer" = a module/file).
#
# The semantic replacements (iceberg.brain_serving.semantic_* and the compiled mv_metric_* views) are NOT
# deprecated and are never flagged. The @brain/semantic-metrics package (the replacement authority itself)
# and the deprecation map are out of scope.
#
# EXCLUDED from scanning: node_modules, .git, dist/.next/coverage build output, *.snap, tests, this guard +
# its allowlist, and packages/semantic-metrics (the replacement). Comments/docstrings are stripped before
# matching (a prose mention of a legacy mart is not a consumer).
#
# Usage:
#   tools/lint/deprecation-guard.sh            # scan the tree; exit 1 on any NEW consumer of a deprecated mart
#   tools/lint/deprecation-guard.sh --selftest # prove the guard catches a NEW consumer + honors the allowlist
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0

ALLOWLIST_FILE="${DEPRECATION_ALLOWLIST:-tools/lint/deprecation-guard-allowlist.txt}"

# ── The deprecated marts (knowledge-base/semantic/deprecation-map.md — "Legacy mart / view" column) ──
# Each is frozen for NEW consumers; the semantic_* entity / compiled metric view is the replacement.
DEPRECATED_MARTS=(
  mv_gold_customer_360
  mv_gold_customer_scores
  mv_gold_customer_list
  mv_gold_customer_segments
  mv_silver_order_state
  mv_silver_order_line
  mv_gold_attribution_credit
  gold_contribution_margin
  mv_gold_contribution_margin
  mv_gold_product_detail
  mv_gold_product_costs
  mv_gold_campaign_performance
  mv_gold_campaign_attribution
  mv_gold_cac
  mv_gold_marketing_attribution
  mv_journey_events_current
  mv_gold_journey_timeline
)

# The match pattern: a deprecated mart appearing as a WHOLE identifier (bounded by a non-identifier char or
# line edge) — matches `FROM brain_serving.mv_gold_customer_360`, `'mv_silver_order_state'`, etc., but NOT a
# longer identifier that merely contains one as a substring.
_join() { local IFS='|'; echo "$*"; }
MARTS_ALT="$(_join "${DEPRECATED_MARTS[@]}")"
READ_RE="(^|[^A-Za-z0-9_])(${MARTS_ALT})([^A-Za-z0-9_]|\$)"

# ── Allowlist ─────────────────────────────────────────────────────────────────────────────────────
load_allowlist() {
  ALLOW=()
  [ -f "$ALLOWLIST_FILE" ] || return 0
  local p
  while IFS= read -r p; do
    p="${p%%#*}"                        # drop trailing WHY comment
    p="${p#"${p%%[![:space:]]*}"}"      # ltrim
    p="${p%"${p##*[![:space:]]}"}"      # rtrim
    [ -z "$p" ] && continue
    ALLOW+=("$p")
  done < "$ALLOWLIST_FILE"
}

is_allowlisted() { # $1 = repo-relative path
  local e
  for e in "${ALLOW[@]:-}"; do [ "$e" = "$1" ] && return 0; done
  return 1
}

# ── File selection ──────────────────────────────────────────────────────────────────────────────
candidate_files() {
  local roots=(apps packages)
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git grep -lE "${MARTS_ALT}" -- "${roots[@]}" 2>/dev/null || true
  else
    grep -rlE "${MARTS_ALT}" "${roots[@]}" 2>/dev/null | sed 's#^\./##' || true
  fi
}

is_excluded() {
  case "$1" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .git/*) return 0 ;;
    */dist/*|*/.next/*|*/coverage/*|dist/*|.next/*|coverage/*) return 0 ;;
    *.snap) return 0 ;;
    packages/semantic-metrics/*) return 0 ;;   # the replacement authority (defines the migration target)
    tools/lint/deprecation-guard.sh) return 0 ;;
    *.test.ts|*.spec.ts|*.test.tsx|*.spec.tsx) return 0 ;;
    */test/*|*/tests/*|*/__tests__/*) return 0 ;;
  esac
  return 1
}

flag() { # $1 file:line  $2 content
  printf '%s✖ [D.4.5]%s %s\n      %s\n' "$RED" "$RST" "$1" "$2"
  violations=$((violations + 1))
}

# ── Comment / docstring stripping (same technique as identity-view-guard) ─────────────────────────
noncomment_lines() { # $1 = file
  local f="$1"
  case "$f" in
    *.py)
      awk '
        {
          line=$0
          stripped=line; sub(/^[ \t]*/,"",stripped)
          n3=gsub(/"""/,"&"); s3=gsub(/'"'"''"'"''"'"'/,"&")
          if (indoc) { if (n3 % 2 == 1 || s3 % 2 == 1) { indoc=0 } next }
          if (n3 % 2 == 1 || s3 % 2 == 1) { indoc=1; next }
          if (stripped ~ /^("""|'"'"''"'"''"'"')/) next
          if (stripped ~ /^#/) next
          printf "%d:%s\n", NR, line
        }
      ' "$f"
      ;;
    *)
      awk '
        { stripped=$0; sub(/^[ \t]*/,"",stripped) }
        stripped ~ /^(\/\/|#|--|\*|\/\*)/ { next }
        { printf "%d:%s\n", NR, $0 }
      ' "$f"
      ;;
  esac
}

# ── Scan ──────────────────────────────────────────────────────────────────────────────────────────
scan() {
  local f l content
  while IFS= read -r f; do
    is_excluded "$f" && continue
    is_allowlisted "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE "$READ_RE"; then
        flag "$f:$l" "NEW consumer of a DEPRECATED mart — bind to the semantic entity / compiled metric view instead (see knowledge-base/semantic/deprecation-map.md): ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files | sort -u)
}

# ── Self-test ──────────────────────────────────────────────────────────────────────────────────────
selftest() {
  local d; d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN

  # Violating fixture — a NEW consumer that reads a deprecated mart directly.
  cat > "$d/bad.ts" <<'EOF'
const sql = `SELECT * FROM brain_serving.mv_gold_customer_360 WHERE brand_id = ?`;
const q2 = `FROM iceberg.brain_serving.mv_silver_order_state`;
EOF
  # Passing fixture — a consumer that reads the SEMANTIC replacement + only a prose mention of a legacy mart.
  cat > "$d/good.ts" <<'EOF'
// migrated off mv_gold_customer_360 — this reader now binds the semantic entity (comment mention allowed)
const sql = `SELECT * FROM iceberg.brain_serving.semantic_customer WHERE brand_id = ?`;
const cols = mv_gold_customer_360_migrated_flag; // longer identifier, not the bare mart — allowed
EOF

  local bad_hits=0 good_hits=0
  while IFS= read -r line; do
    printf '%s' "${line#*:}" | grep -qE "$READ_RE" && bad_hits=$((bad_hits + 1))
  done < <(noncomment_lines "$d/bad.ts")
  while IFS= read -r line; do
    printf '%s' "${line#*:}" | grep -qE "$READ_RE" && good_hits=$((good_hits + 1))
  done < <(noncomment_lines "$d/good.ts")

  local ok=1
  if [ "$bad_hits" -lt 2 ]; then
    echo "${RED}SELFTEST FAIL: guard missed a NEW deprecated-mart consumer (bad_hits=$bad_hits, want >=2)${RST}"; ok=0
  fi
  if [ "$good_hits" -ne 0 ]; then
    echo "${RED}SELFTEST FAIL: guard false-positived on the semantic replacement / comment / longer-identifier form (good_hits=$good_hits)${RST}"; ok=0
  fi

  # Prove the allowlist mechanism grandfathers an otherwise-violating path.
  local tmp_allow; tmp_allow="$(mktemp)"
  echo "some/dir/legacy-reader.ts   # WHY: grandfathered consumer (migrates in D.3)" > "$tmp_allow"
  ALLOWLIST_FILE="$tmp_allow" load_allowlist
  if is_allowlisted "some/dir/legacy-reader.ts" && ! is_allowlisted "some/dir/new-reader.ts"; then :; else
    echo "${RED}SELFTEST FAIL: allowlist matcher wrong${RST}"; ok=0
  fi
  rm -f "$tmp_allow"

  if [ "$ok" -eq 1 ]; then
    echo "${GRN}✓ deprecation-guard self-test passed (catches NEW deprecated-mart consumers; no false positives on semantic/comment/longer-identifier forms; allowlist honored).${RST}"
    return 0
  fi
  return 1
}

# ── Main ────────────────────────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

load_allowlist
if [ ! -f "$ALLOWLIST_FILE" ]; then
  echo "${RED}deprecation-guard FAILED: allowlist '${ALLOWLIST_FILE}' missing (fail-closed).${RST}"
  exit 2
fi

echo "${YEL}deprecation-guard${RST} — scanning apps/ + packages/ for NEW consumers of a Wave-D deprecated mart (D.4.5)…"
scan

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}deprecation-guard FAILED: ${violations} NEW consumer(s) of a deprecated mart.${RST}"
  echo "The legacy marts stay live but are FROZEN for new consumers (§0.5 additive; Wave-D §D.4.5). Bind a"
  echo "new reader to the semantic entity (iceberg.brain_serving.semantic_*) or the compiled metric view"
  echo "(iceberg.brain_serving.mv_metric_*) instead — see knowledge-base/semantic/deprecation-map.md for the"
  echo "legacy→semantic mapping. A genuinely-grandfathered existing consumer goes in"
  echo "tools/lint/deprecation-guard-allowlist.txt with a WHY comment."
  exit 1
fi

echo "${GRN}✓ deprecation-guard passed — no NEW consumer of a deprecated mart (existing readers migrate in D.3).${RST}"
exit 0
