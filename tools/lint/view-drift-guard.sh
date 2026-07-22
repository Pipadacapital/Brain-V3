#!/usr/bin/env bash
#
# view-drift-guard.sh — serving VIEW-DRIFT lint (BLOCKING CI gate).  ADR-0019 WS-5 D8.
#
# Brain V4 invariant: the app / BFF / metric-engine read Gold/Silver ONLY through the duckdb-serving views
# brain_serving.mv_* (local views the serving service applies from db/iceberg/duckdb/views/*.sql). If an
# endpoint references a brain_serving.mv_* view that views/*.sql does NOT define, the serving layer skips
# that view (continue-on-error, views.py) and every `POST /v1/query` against it 500s — which core
# fail-safes to an EMPTY chart (200 with no data). That is a SILENT-500 class: no build breaks, the page
# just shows nothing. ADR-0019 WS-5 converts it into an author-time CI failure.
#
# This guard FAILS (exit 1) when a NON-comment, NON-test source line under apps/** + packages/** references
# a STATIC `brain_serving.mv_<name>` that is NOT defined by a `CREATE [OR REPLACE] VIEW
# brain_serving.mv_<name>` in db/iceberg/duckdb/views/*.sql.
#
# NOT a violation (so no false positives):
#   • comments / python docstrings — stripped before matching (same technique as v4-naming-guard).
#   • test fixtures: *.test.ts, *.spec.ts (+ .tsx), **/test(s)/**, **/__tests__/** — a test that names a
#     phantom view (e.g. a "does not exist" error-path fixture) is not a live read.
#   • a DYNAMIC view name built by interpolation — `brain_serving.mv_metric_${name}_${grain}`
#     (semantic-metrics compiler): the `${` right after the captured prefix means the full name is
#     assembled at runtime, so there is no single static view to check. These are matched by their own
#     generator contract, not this guard. (A bare `mv_gold_` prefix with nothing after it is likewise not
#     a whole view name.)
#   • the semantic-metrics GENERATED tree (packages/semantic-metrics/src/generated/**): the compiled
#     mv_metric_* views + their catalog.json are the EXPANSION of exactly those dynamic names — a closed,
#     self-consistent generated set (each generated/views/*.sql defines the view its catalog references),
#     governed by the compiler's own contract, not this guard. Not authored endpoint code.
#
# EXCLUDED from scanning: node_modules, .git, dist/.next/coverage build output, *.snap, generated semantic
# views (packages/semantic-metrics/src/generated/**), this guard + its self-test corpus.
#
# Usage:
#   tools/lint/view-drift-guard.sh            # scan apps/** + packages/**; exit 1 on any drifted mv_ ref
#   tools/lint/view-drift-guard.sh --selftest # prove it catches a missing view + passes on the real tree
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0

VIEWS_DIR="${VIEW_DRIFT_VIEWS_DIR:-db/iceberg/duckdb/views}"

# A referenced serving view: `brain_serving.mv_<name>` where <name> is a maximal identifier run. We then
# reject DYNAMIC refs (the next char is `$`, i.e. `${...}` interpolation) in the scan below so a runtime-
# assembled name isn't treated as a single static view.
REF_RE='brain_serving\.mv_[a-zA-Z0-9_]+'

# ── Defined-view set ────────────────────────────────────────────────────────────────────────────────
# Every `CREATE [OR REPLACE] VIEW brain_serving.mv_<name>` in the views dir. Populated once into DEFINED.
load_defined_views() {
  DEFINED=" "
  local name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    DEFINED="${DEFINED}${name} "
  done < <(
    grep -rhoE 'CREATE[[:space:]]+(OR[[:space:]]+REPLACE[[:space:]]+)?VIEW[[:space:]]+brain_serving\.mv_[a-zA-Z0-9_]+' \
      "$VIEWS_DIR"/*.sql 2>/dev/null | grep -oE 'mv_[a-zA-Z0-9_]+' | sort -u
  )
}

is_defined() { # $1 = mv_ name
  case "$DEFINED" in *" $1 "*) return 0 ;; *) return 1 ;; esac
}

# ── File selection ──────────────────────────────────────────────────────────────────────────────
candidate_files() {
  local roots=(apps packages)
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git grep -lE 'brain_serving\.mv_' -- "${roots[@]}" 2>/dev/null || true
  else
    grep -rlE 'brain_serving\.mv_' "${roots[@]}" 2>/dev/null | sed 's#^\./##' || true
  fi
}

is_excluded() {
  case "$1" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .git/*) return 0 ;;
    */dist/*|*/.next/*|*/coverage/*|dist/*|.next/*|coverage/*) return 0 ;;
    *.snap) return 0 ;;
    # semantic-metrics GENERATED tree — compiled mv_metric_* views + catalog.json (the runtime-assembled
    # family's expansion; governed by the compiler contract, not this guard). Not authored endpoint code.
    */semantic-metrics/src/generated/*) return 0 ;;
    tools/lint/view-drift-guard.sh) return 0 ;;
    *.test.ts|*.spec.ts|*.test.tsx|*.spec.tsx) return 0 ;;
    */test/*|*/tests/*|*/__tests__/*) return 0 ;;
  esac
  return 1
}

flag() { # $1 file:line  $2 mv-name  $3 content
  printf '%s✖ [WS5-D8]%s %s\n      references brain_serving.%s but views/ defines no such view: %s\n' \
    "$RED" "$RST" "$1" "$2" "$3"
  violations=$((violations + 1))
}

# ── Comment / docstring stripping (same technique as v4-naming-guard / identity-view-guard) ─────────
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
        { line=$0; stripped=line; sub(/^[ \t]*/,"",stripped) }
        inblock { if (line ~ /\*\//) inblock=0; next }
        (stripped ~ /^\/\*/) && line !~ /\*\// { inblock=1; next }
        stripped ~ /^(\/\/|#|--|\*|\/\*)/ { next }
        { printf "%d:%s\n", NR, line }
      ' "$f"
      ;;
  esac
}

# ── Scan ──────────────────────────────────────────────────────────────────────────────────────────
# For each candidate line, pull every static brain_serving.mv_<name> ref. A ref is DYNAMIC (skipped) when
# the character immediately after the captured name is `$` — a `${...}` interpolation assembling the name.
scan() {
  local f l content ref name after
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      # Each occurrence on the line (grep -o) → the mv_ name; then check the char after it in `content`.
      while IFS= read -r ref; do
        [ -z "$ref" ] && continue
        name="${ref#brain_serving.}"
        # DYNAMIC guard: if `${name}$` appears (name immediately followed by `$`), it's an interpolation
        # prefix (mv_metric_${…}) — not a whole static view. Skip.
        after="${content#*"$ref"}"
        case "$after" in
          '$'*) continue ;;   # brain_serving.mv_foo${…} — runtime-assembled
        esac
        is_defined "$name" && continue
        flag "$f:$l" "$name" "${content#"${content%%[![:space:]]*}"}"
      done < <(printf '%s' "$content" | grep -oE "$REF_RE")
    done < <(noncomment_lines "$f")
  done < <(candidate_files | sort -u)
}

# ── Self-test ──────────────────────────────────────────────────────────────────────────────────────
# Proves the guard FAILS on a missing-view reference and PASSES on (a) a defined-view reference,
# (b) a comment/docstring mention, and (c) a dynamic ${…}-assembled name.
selftest() {
  local d; d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN

  # A views dir that defines exactly one view.
  mkdir -p "$d/views"
  cat > "$d/views/mv_gold_defined.sql" <<'EOF'
CREATE OR REPLACE VIEW brain_serving.mv_gold_defined AS SELECT 1;
EOF
  VIEWS_DIR="$d/views" load_defined_views

  is_defined "mv_gold_defined" || { echo "${RED}SELFTEST FAIL: defined-view set missing mv_gold_defined${RST}"; return 1; }
  is_defined "mv_gold_phantom" && { echo "${RED}SELFTEST FAIL: is_defined true for a phantom view${RST}"; return 1; }

  # Bad reader — references a view the corpus does NOT define.
  cat > "$d/bad.ts" <<'EOF'
const rows = await scope.runScoped(`SELECT * FROM brain_serving.mv_gold_phantom WHERE brand_id = ?`, []);
EOF
  # Good reader — references the defined view, mentions a phantom ONLY in a comment, and builds a
  # dynamic name by interpolation (must NOT be treated as a static missing view).
  cat > "$d/good.ts" <<'EOF'
// legacy note: brain_serving.mv_gold_phantom used to exist (comment mention — allowed)
const a = `SELECT * FROM brain_serving.mv_gold_defined WHERE brand_id = ?`;
const view = `brain_serving.mv_metric_${name}_${grain}`; // dynamic — assembled at runtime
EOF

  # Drive the scan logic over the two fixtures directly (mirror scan()).
  local bad_hits=0 good_hits=0 f l content ref name after
  for f in "$d/bad.ts" "$d/good.ts"; do
    while IFS= read -r line; do
      content="${line#*:}"
      while IFS= read -r ref; do
        [ -z "$ref" ] && continue
        name="${ref#brain_serving.}"
        after="${content#*"$ref"}"
        case "$after" in '$'*) continue ;; esac
        if ! is_defined "$name"; then
          case "$f" in *bad.ts) bad_hits=$((bad_hits+1)) ;; *) good_hits=$((good_hits+1)) ;; esac
        fi
      done < <(printf '%s' "$content" | grep -oE "$REF_RE")
    done < <(noncomment_lines "$f")
  done

  local ok=1
  if [ "$bad_hits" -lt 1 ]; then
    echo "${RED}SELFTEST FAIL: guard missed the missing-view reference (bad_hits=$bad_hits)${RST}"; ok=0
  fi
  if [ "$good_hits" -ne 0 ]; then
    echo "${RED}SELFTEST FAIL: guard false-positived on a defined-view/comment/dynamic form (good_hits=$good_hits)${RST}"; ok=0
  fi

  if [ "$ok" -eq 1 ]; then
    echo "${GRN}✓ view-drift-guard self-test passed (catches a missing view; no false positives on defined/comment/dynamic refs).${RST}"
    return 0
  fi
  return 1
}

# ── Main ────────────────────────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

load_defined_views
if [ "$DEFINED" = " " ]; then
  echo "${RED}view-drift-guard FAILED: no brain_serving.mv_* views found in '${VIEWS_DIR}' (fail-closed).${RST}"
  exit 2
fi

echo "${YEL}view-drift-guard${RST} — every brain_serving.mv_* an endpoint references must be defined in ${VIEWS_DIR}/*.sql (WS-5 D8)…"
scan

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}view-drift-guard FAILED: ${violations} drifted brain_serving.mv_* reference(s).${RST}"
  echo "An endpoint references a serving view that db/iceberg/duckdb/views/*.sql does not define. That view"
  echo "is skipped by the serving layer (views.py continue-on-error) and every read against it 500s →"
  echo "core fail-safes to an EMPTY chart (a silent failure). Either add the missing"
  echo "views/mv_<name>.sql (CREATE OR REPLACE VIEW brain_serving.mv_<name> AS …) or repoint the reader"
  echo "to an existing view. (ADR-0019 WS-5 D8.)"
  exit 1
fi

echo "${GRN}✓ view-drift-guard passed — every referenced brain_serving.mv_* view is defined in ${VIEWS_DIR}.${RST}"
exit 0
