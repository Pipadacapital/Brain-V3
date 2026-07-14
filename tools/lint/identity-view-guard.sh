#!/usr/bin/env bash
#
# identity-view-guard.sh — SANCTIONED identity-map accessor lint (BLOCKING CI gate).  SPEC: A.2.2 / AMD-07.
#
# Brain V4 invariant: silver_identity_map is BI-TEMPORAL (valid-time × system-time). A reader that touches
# the raw table directly can silently drop one axis (read is_current=true but ignore that the row was
# system-superseded) → corrupt point-in-time / replay answers. So EVERY read of silver_identity_map must go
# through a SANCTIONED accessor:
#   • Spark : _identity_views.identity_current / identity_asof / identity_raw
#   • Trino : iceberg.brain_serving.identity_current_v  /  iceberg.brain_serving.identity_asof
#
# This guard FAILS (exit 1) when a NON-allowlisted, NON-comment source line under the scan roots
# (db/iceberg/duckdb, db/iceberg/trino, db/trino/views, apps, packages) references silver_identity_map as a QUALIFIED table
# (`.silver_identity_map`) or a QUOTED table name (`"silver_identity_map"` / `'silver_identity_map'`).
#
# NOT a violation (so no false positives):
#   • the sanctioned accessors, the map writer, the raw serving projection, dependency manifests, and the
#     golden-baseline capture — all listed in tools/lint/identity-view-guard-allowlist.txt (each with a WHY).
#   • prose mentions in comments / python docstrings (stripped before matching).
#   • the JOB FILE reference `silver_identity_map.py` (a script name, not a table read).
#   • bare-word mentions (e.g. `print("... silver_identity_map absent")`) — not a qualified/quoted table ref.
#
# EXCLUDED from scanning: node_modules, .git, dist/.next/coverage build output, *.snap, and this guard's own
# self-test corpus. (Tests ARE scanned — a test that reads the raw map bypasses the accessor just as badly.)
#
# Usage:
#   tools/lint/identity-view-guard.sh            # scan the tree; exit 1 on any direct read
#   tools/lint/identity-view-guard.sh --selftest # prove the guard catches a violation + honors the allowlist
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0

ALLOWLIST_FILE="${IDENTITY_VIEW_ALLOWLIST:-tools/lint/identity-view-guard-allowlist.txt}"

# The read-pattern: silver_identity_map preceded by a dot (qualified table) or a quote (string table name),
# and followed by a NON-identifier boundary — which EXCLUDES `silver_identity_map.py` (the job file, a `.`
# follows) and `silver_identity_map_x` (an underscore follows).
READ_RE="[.'\"]silver_identity_map([^.a-zA-Z0-9_]|\$)"

# ── Allowlist ─────────────────────────────────────────────────────────────────────────────────────
# Load repo-relative paths (strip inline `# WHY` comments + blank/comment lines).
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
# Candidate files under the scan roots whose bytes contain the token. git grep honors .gitignore in a work
# tree; grep -rl is the fallback. (New/untracked files are picked up by the fallback and, once committed,
# by git grep in CI.)
candidate_files() {
  local roots=(db/iceberg/duckdb db/iceberg/trino db/trino/views apps packages)
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git grep -lE 'silver_identity_map' -- "${roots[@]}" 2>/dev/null || true
  else
    grep -rlE 'silver_identity_map' "${roots[@]}" 2>/dev/null | sed 's#^\./##' || true
  fi
}

is_excluded() {
  case "$1" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .git/*) return 0 ;;
    */dist/*|*/.next/*|*/coverage/*|dist/*|.next/*|coverage/*) return 0 ;;
    *.snap) return 0 ;;
    tools/lint/identity-view-guard.sh) return 0 ;;
  esac
  return 1
}

flag() { # $1 file:line  $2 content
  printf '%s✖ [A2.2]%s %s\n      %s\n' "$RED" "$RST" "$1" "$2"
  violations=$((violations + 1))
}

# ── Comment / docstring stripping (same technique as v4-naming-guard) ─────────────────────────────
# Emit "<lineno>:<content>" for every line that is NOT a comment; for .py also drop docstring blocks.
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
        flag "$f:$l" "direct read of silver_identity_map — use the sanctioned accessor (Spark: identity_current/identity_asof/identity_raw; Trino: identity_current_v/identity_asof): ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files | sort -u)
}

# ── Self-test ──────────────────────────────────────────────────────────────────────────────────────
# Proves the guard FAILS on a direct-read fixture and PASSES on (a) an accessor-routed reader and
# (b) an allowlisted direct reader + comment/docstring/job-file mentions.
selftest() {
  local d; d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN

  # Violating fixture — a Spark job + a Trino view that read the raw table directly.
  cat > "$d/bad.py" <<'EOF'
idm = spark.table(f"{CATALOG}.{SILVER_NS}.silver_identity_map")
im = _read_silver(spark, "silver_identity_map", optional=True)
EOF
  cat > "$d/bad.sql" <<'EOF'
CREATE VIEW x AS SELECT brain_id FROM iceberg.brain_silver.silver_identity_map WHERE is_current;
EOF
  # Passing fixture — accessor-routed + only prose/job-file mentions.
  cat > "$d/good.py" <<'EOF'
"""This job reads brain_silver.silver_identity_map via the sanctioned accessor (docstring — allowed)."""
from _identity_views import identity_current, identity_asof
# silver_identity_map absent -> degrade (bare-word comment mention — allowed)
df = identity_current(spark)
JOBS = ("silver_identity_map.py")   # job-file name, not a table read — allowed
print("... silver_identity_map absent ...")
EOF

  local bad_hits=0 good_hits=0
  for f in "$d/bad.py" "$d/bad.sql"; do
    while IFS= read -r line; do
      printf '%s' "${line#*:}" | grep -qE "$READ_RE" && bad_hits=$((bad_hits + 1))
    done < <(noncomment_lines "$f")
  done
  while IFS= read -r line; do
    printf '%s' "${line#*:}" | grep -qE "$READ_RE" && good_hits=$((good_hits + 1))
  done < <(noncomment_lines "$d/good.py")

  local ok=1
  # bad.py has 2 direct reads, bad.sql has 1 → expect >= 3.
  if [ "$bad_hits" -lt 3 ]; then
    echo "${RED}SELFTEST FAIL: guard missed a direct read (bad_hits=$bad_hits, want >=3)${RST}"; ok=0
  fi
  if [ "$good_hits" -ne 0 ]; then
    echo "${RED}SELFTEST FAIL: guard false-positived on an accessor-routed/comment/job-file form (good_hits=$good_hits)${RST}"; ok=0
  fi

  # Prove the allowlist mechanism skips an otherwise-violating path.
  local tmp_allow; tmp_allow="$(mktemp)"
  echo "some/dir/reader.py   # WHY: sanctioned" > "$tmp_allow"
  ALLOWLIST_FILE="$tmp_allow" load_allowlist
  if is_allowlisted "some/dir/reader.py" && ! is_allowlisted "some/dir/other.py"; then :; else
    echo "${RED}SELFTEST FAIL: allowlist matcher wrong${RST}"; ok=0
  fi
  rm -f "$tmp_allow"

  if [ "$ok" -eq 1 ]; then
    echo "${GRN}✓ identity-view-guard self-test passed (catches direct reads; no false positives on accessor/comment/job-file forms; allowlist honored).${RST}"
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
  echo "${RED}identity-view-guard FAILED: allowlist '${ALLOWLIST_FILE}' missing (fail-closed).${RST}"
  exit 2
fi

echo "${YEL}identity-view-guard${RST} — scanning for direct silver_identity_map reads outside the sanctioned accessors (A.2.2)…"
scan

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}identity-view-guard FAILED: ${violations} direct read(s) of silver_identity_map.${RST}"
  echo "silver_identity_map is BI-TEMPORAL (valid-time × system-time, AMD-07). Read it ONLY through a"
  echo "sanctioned accessor: Spark _identity_views.identity_current / identity_asof / identity_raw, or the"
  echo "Trino views iceberg.brain_serving.identity_current_v / identity_asof. A genuinely-sanctioned reader"
  echo "goes in tools/lint/identity-view-guard-allowlist.txt with a WHY comment."
  exit 1
fi

echo "${GRN}✓ identity-view-guard passed — every silver_identity_map read goes through a sanctioned accessor.${RST}"
exit 0
