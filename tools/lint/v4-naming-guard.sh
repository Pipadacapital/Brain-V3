#!/usr/bin/env bash
#
# v4-naming-guard.sh — Brain V4 architecture naming lint (BLOCKING CI gate).
#
# Brain V4 invariants this guard enforces (see CLAUDE.md + docs/architecture/v4/):
#   • Compute is Spark-on-Iceberg. dbt is REMOVED — the dbt-internal StarRocks DBs
#     `brain_gold` / `brain_silver` are RETIRED (db/starrocks/teardown/drop_dbt_internal_dbs.sql).
#   • Medallion lives in the Iceberg catalogs brain_{bronze,silver,gold}_local; Gold/Silver are
#     SERVED to the app ONLY by the StarRocks async MVs brain_serving.mv_* (or read directly from
#     the rest-Iceberg catalogs by Spark). No reader queries a bare brain_gold./brain_silver. DB.
#   • Features are RUNTIME — there is NO permanent feature-precompute table (no feature_customer_daily,
#     no brain_feature write). brain_feature is dead (db/starrocks/teardown/drop_dead_feature_db.sql).
#   • Trino is the SERVING engine (Brain V4 removes StarRocks). The app / BFF / metric-engine read
#     brain_serving.mv_* over TRINO (Iceberg). A Trino client (withTrinoBrand/createTrinoPool/TrinoPool)
#     in core serving code is now ALLOWED — R5 (which banned it) is RETIRED this wave.
#
# It FAILS (exit 1) when LIVE (non-test, non-comment) source contains any of:
#   R1  a bare `brain_gold.` / `brain_silver.` reference (the retired dbt StarRocks DBs).
#         — `brain_gold_local.` / `brain_silver_local.` (Iceberg catalogs), `rest.brain_*.`,
#           `{CATALOG}.brain_*.` (Spark Iceberg namespaces), `iceberg.brain_*.` (the Trino Iceberg
#           serving catalog), and `brain_serving.` are ALLOWED.
#   R2  a `dbt` INVOCATION in a script / CI workflow / compose file (dbt run|build|test|seed|…).
#         — the word "dbt" in a comment (explaining it was removed) is allowed.
#   R3  a permanent feature precompute table — a `feature_customer_daily` reference or a `brain_feature`
#         WRITE (CREATE/INSERT/MERGE/UPSERT/REFRESH/GRANT) in live code.
#   R4  a Gold/Silver read that is NOT via mv_* / rest-Iceberg — i.e. `FROM`/`JOIN brain_gold.` or
#         `brain_silver.` (a strict subset of R1, surfaced separately for a clearer message).
#   R5  RETIRED (this wave): Trino is now the SERVING path — a withTrinoBrand/createTrinoPool/TrinoPool
#         reference in apps/core/src serving code is ALLOWED. The previous ban (Trino as additive-only)
#         is removed. (Broader StarRocks-removal rules land in a later wave.)
#
# EXCLUDED from scanning (by design):
#   • test fixtures: *.test.ts, *.spec.ts, *.live.test.ts, tools/isolation-fuzz/**, **/test/**
#   • the teardown SQL that retires these DBs (db/starrocks/teardown/**) — it names them on purpose.
#   • this guard itself + its self-test corpus.
#   • node_modules, .git, build output (dist/.next/coverage), and the .engineering-os/ audit trail
#     (historical run artifacts are data, not live code).
#   • comments: line-leading // / # / -- / * and (for .py) lines inside docstrings (the Spark jobs
#     describe their Iceberg tables in prose as "brain_silver.<table>"; the executable code uses the
#     {CATALOG}.{NAMESPACE} vars — never a bare DB).
#
# Usage:
#   tools/lint/v4-naming-guard.sh            # scan the tree; exit 1 on any violation
#   tools/lint/v4-naming-guard.sh --selftest # prove the guard catches each rule (CI sanity)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0

# ── File selection ──────────────────────────────────────────────────────────────────────────────
# Build the candidate file set ONCE: only files whose raw bytes contain a token of interest
# (brain_gold / brain_silver / brain_feature / feature_customer_daily / dbt). Everything else can be
# skipped without per-line work — this keeps the guard fast on a large monorepo. Honors .gitignore via
# git grep when in a work tree; falls back to grep -rl otherwise.
candidate_files() { # $1 = extended-regex token
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git grep -lE "$1" -- \
      '*.ts' '*.tsx' '*.sh' '*.sql' '*.yml' '*.yaml' '*.py' '*.json' 'Makefile' '*.mk' 2>/dev/null || true
  else
    grep -rlE "$1" --include='*.ts' --include='*.tsx' --include='*.sh' --include='*.sql' \
      --include='*.yml' --include='*.yaml' --include='*.py' --include='*.json' \
      --include='Makefile' --include='*.mk' . 2>/dev/null | sed 's#^\./##' || true
  fi
}

# Is this path excluded from scanning entirely?
is_excluded() {
  case "$1" in
    node_modules/*|*/node_modules/*) return 0 ;;
    .git/*) return 0 ;;
    */dist/*|*/.next/*|*/coverage/*|dist/*|.next/*|coverage/*) return 0 ;;
    .engineering-os/*|.eos-workflows/*) return 0 ;;
    db/starrocks/teardown/*) return 0 ;;            # names the retired DBs on purpose
    tools/lint/v4-naming-guard.sh) return 0 ;;      # this guard + its self-test corpus
    tools/lint/v4-naming-guard.selftest.*) return 0 ;;
    tools/isolation-fuzz/*) return 0 ;;             # tenant-isolation fuzz fixtures
    *.test.ts|*.spec.ts|*.test.tsx|*.spec.tsx) return 0 ;;
    */test/*|*/tests/*|*/__tests__/*) return 0 ;;
    *.snap) return 0 ;;
  esac
  return 1
}

# Print a violation and bump the counter.
flag() { # $1 rule  $2 file:line  $3 message
  printf '%s✖ [%s]%s %s\n      %s\n' "$RED" "$1" "$RST" "$2" "$3"
  violations=$((violations + 1))
}

# ── Comment / docstring stripping ─────────────────────────────────────────────────────────────────
# Emit "<lineno>:<content>" for every line that is NOT a comment. For .py we also drop lines that fall
# inside a triple-quoted docstring (the Spark jobs describe Iceberg tables in prose there).
noncomment_lines() { # $1 = file
  local f="$1"
  case "$f" in
    *.py)
      awk '
        {
          line=$0
          stripped=line; sub(/^[ \t]*/,"",stripped)
          n3=gsub(/"""/,"&"); s3=gsub(/'"'"''"'"''"'"'/,"&")
          if (indoc) {
            # inside a multi-line docstring; the closing delimiter ends it (after this line).
            if (n3 % 2 == 1 || s3 % 2 == 1) { indoc=0 }
            next
          }
          # A line that OPENS a docstring without closing it → enter doc mode (skip the whole block).
          if (n3 % 2 == 1 || s3 % 2 == 1) { indoc=1; next }
          # A line whose stripped content STARTS with a triple-quote is a (single-line) docstring → skip.
          if (stripped ~ /^("""|'"'"''"'"''"'"')/) next
          if (stripped ~ /^#/) next                 # whole-line python comment
          printf "%d:%s\n", NR, line
        }
      ' "$f"
      ;;
    *)
      # generic: drop whole-line comments for //, #, --, and * (jsdoc/sql block bodies)
      awk '
        { stripped=$0; sub(/^[ \t]*/,"",stripped) }
        stripped ~ /^(\/\/|#|--|\*|\/\*)/ { next }
        { printf "%d:%s\n", NR, $0 }
      ' "$f"
      ;;
  esac
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R1 + R4: bare retired-dbt-DB references (brain_gold. / brain_silver.) in live code.
#   Allowed forms are masked out first: *_local. catalogs, rest./{CATALOG}. Iceberg namespaces.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_dead_db_refs() {
  local f l content masked
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      # Mask the ALLOWED forms so they cannot trigger:
      #   brain_gold_local. / brain_silver_local. (Iceberg catalogs)
      #   rest.brain_gold. / rest.brain_silver.   (Spark rest catalog namespace)
      #   {CATALOG}.brain_*. / {catalog}.brain_*. (Spark f-string catalog)
      masked="$content"
      masked="${masked//brain_gold_local/__CAT__}"
      masked="${masked//brain_silver_local/__CAT__}"
      # mask the Iceberg-namespace part of a 3-part catalog.namespace.table path:
      #   __CAT__.brain_gold. , rest.brain_silver. , iceberg.brain_gold. (Trino serving catalog) ,
      #   {CATALOG}.brain_gold. , {catalog}.brain_silver.
      masked="$(printf '%s' "$masked" | sed -E 's/(__CAT__|rest|iceberg|\{CATALOG\}|\{catalog\})\.brain_(gold|silver)/__NS__/g')"
      # Now any remaining bare brain_gold. / brain_silver. is a retired-DB reference (3-part / table ref).
      if printf '%s' "$masked" | grep -qE 'brain_(gold|silver)\.'; then
        # R4 sub-classification: an actual read (FROM/JOIN) gets the clearer message.
        if printf '%s' "$masked" | grep -qiE '(FROM|JOIN)[[:space:]]+brain_(gold|silver)\.'; then
          flag R4 "$f:$l" "reads Gold/Silver from the RETIRED dbt DB — use brain_serving.mv_* (serving) or the rest-Iceberg catalog: ${content#"${content%%[![:space:]]*}"}"
        else
          flag R1 "$f:$l" "bare brain_gold./brain_silver. is the RETIRED dbt StarRocks DB (V4 removed dbt) — use brain_serving.mv_*, the *_local Iceberg catalog, or a {CATALOG}.namespace: ${content#"${content%%[![:space:]]*}"}"
        fi
      # Also catch the DATABASE-NAME form (no trailing dot): CREATE/DROP/USE/IN DATABASE brain_gold,
      # USE brain_silver. brain_gold_local / brain_silver_local were masked to __CAT__ above so they
      # cannot trigger here.
      elif printf '%s' "$masked" | grep -qiE '((CREATE|DROP|IN|USE)[[:space:]]+DATABASE[[:space:]]+|USE[[:space:]]+)brain_(gold|silver)([^_a-zA-Z]|$)'; then
        flag R1 "$f:$l" "names the RETIRED dbt StarRocks DB brain_gold/brain_silver (V4 dropped both — db/starrocks/teardown/) — V4 serving is brain_serving, operational state is brain_ops: ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <({ candidate_files 'brain_(gold|silver)\.'; candidate_files '(DATABASE|USE)[[:space:]]+brain_(gold|silver)([^_a-zA-Z]|$)'; } | sort -u)
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R2: dbt invocations in scripts / CI / compose.
#   Matches a real command (`dbt run|build|test|seed|compile|deps|snapshot|parse|ls|docs|debug|clean`)
#   or `pnpm|npm|npx|uv|poetry|python -m dbt`, on a NON-comment line. The bare word "dbt" in prose is OK.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_dbt_invocations() {
  local f l content
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE '(^|[^[:alnum:]_./-])dbt[[:space:]]+(run|build|test|seed|compile|deps|snapshot|parse|ls|docs|debug|clean|source|run-operation)([[:space:]]|$)'; then
        flag R2 "$f:$l" "dbt INVOCATION — dbt is removed in Brain V4 (Spark is sole compute): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE '(pnpm|npm|npx|uv|poetry|python|python3)[[:space:]]+(run[[:space:]]+)?(-m[[:space:]]+)?dbt([[:space:]]|$)'; then
        flag R2 "$f:$l" "dbt INVOCATION via a runner — dbt is removed in Brain V4: ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files '\bdbt\b' | grep -E '\.(sh|yml|yaml|mk)$|Makefile|package\.json' || true)
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R3: permanent feature precompute — feature_customer_daily, or a brain_feature WRITE.
#   V4 features are runtime; there is no permanent feature table.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_feature_precompute() {
  local f l content
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE 'feature_customer_daily'; then
        flag R3 "$f:$l" "feature_customer_daily is a RETIRED feature-precompute table — V4 features are RUNTIME (fold from the Silver spine): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qiE '(CREATE[[:space:]]+(TABLE|DATABASE)|INSERT[[:space:]]+INTO|MERGE[[:space:]]+INTO|UPSERT|REPLACE[[:space:]]+INTO|GRANT[[:space:]].*ON|REFRESH[[:space:]]+MATERIALIZED).*brain_feature'; then
        flag R3 "$f:$l" "WRITE to the RETIRED brain_feature DB — V4 has no permanent feature store: ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files 'brain_feature|feature_customer_daily')
}

# R5 — RETIRED this wave. Trino is now the Brain V4 SERVING engine, so a Trino client in
# apps/core/src serving code is ALLOWED (no scan). The previous additive-only ban is removed.

# ── Self-test ──────────────────────────────────────────────────────────────────────────────────────
# Proves the guard FAILS on a known-bad corpus (one line per rule) and PASSES on the allowed forms.
selftest() {
  local d; d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN

  # ── Bad corpus (must trigger) ──────────────────────────────────────────────
  cat > "$d/bad.sql" <<'EOF'
SELECT * FROM brain_gold.gold_revenue_ledger;
SELECT * FROM brain_silver.silver_touchpoint;
INSERT INTO brain_feature.feature_customer_daily VALUES (1);
CREATE DATABASE IF NOT EXISTS brain_silver;
GRANT SELECT ON ALL TABLES IN DATABASE brain_gold TO 'brain_analytics'@'%';
EOF
  cat > "$d/bad.sh" <<'EOF'
#!/usr/bin/env bash
dbt run --select gold
SELECT brain_anon_id FROM brain_silver.silver_touchpoint
EOF

  # ── Good corpus (must NOT trigger) ────────────────────────────────────────
  cat > "$d/good.sql" <<'EOF'
-- legacy note: brain_gold.gold_revenue_ledger was the dbt DB (now retired)
SELECT * FROM brain_serving.mv_gold_revenue_ledger;
SELECT * FROM brain_gold_local.brain_gold.gold_revenue_ledger;
CREATE OR REPLACE VIEW iceberg.brain_serving.mv_gold_revenue_ledger AS SELECT * FROM iceberg.brain_gold.gold_revenue_ledger;
EOF
  cat > "$d/good.py" <<'EOF'
"""
This Spark job WRITES Iceberg brain_silver.silver_touchpoint (prose docstring — allowed).
"""
fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
df = spark.table("rest.brain_silver.silver_touchpoint")
# dbt was removed in V4 (comment mentioning dbt — allowed)
EOF

  local fail_bad=0 fail_good=0

  # ── Check bad.sql + bad.sh catch R1/R2/R3 ─────────────────────────────────
  for f in "$d/bad.sql" "$d/bad.sh"; do
    local hits; hits=0
    while IFS= read -r line; do
      local content="${line#*:}" masked
      masked="${content//brain_gold_local/__CAT__}"; masked="${masked//brain_silver_local/__CAT__}"
      masked="$(printf '%s' "$masked" | sed -E 's/(__CAT__|rest|iceberg|\{CATALOG\}|\{catalog\})\.brain_(gold|silver)/__NS__/g')"
      printf '%s' "$masked" | grep -qE 'brain_(gold|silver)\.|feature_customer_daily' && hits=$((hits+1))
      printf '%s' "$masked" | grep -qiE '((CREATE|DROP|IN|USE)[[:space:]]+DATABASE[[:space:]]+|USE[[:space:]]+)brain_(gold|silver)([^_a-zA-Z]|$)' && hits=$((hits+1))
      printf '%s' "$content" | grep -qE '(^|[^[:alnum:]_./-])dbt[[:space:]]+run' && hits=$((hits+1))
    done < <(noncomment_lines "$f")
    [ "$hits" -gt 0 ] || { echo "${RED}SELFTEST FAIL: guard missed a violation in $(basename "$f")${RST}"; fail_bad=1; }
  done

  # R5 RETIRED — no Trino-serving-path check (Trino is the V4 serving engine; allowed in core).

  # ── Check good.sql + good.py produce NO false positives ───────────────────
  for f in "$d/good.sql" "$d/good.py"; do
    local hits; hits=0
    while IFS= read -r line; do
      local content="${line#*:}" masked
      masked="${content//brain_gold_local/__CAT__}"; masked="${masked//brain_silver_local/__CAT__}"
      masked="$(printf '%s' "$masked" | sed -E 's/(__CAT__|rest|iceberg|\{CATALOG\}|\{catalog\})\.brain_(gold|silver)/__NS__/g')"
      printf '%s' "$masked" | grep -qE 'brain_(gold|silver)\.|feature_customer_daily' && hits=$((hits+1))
    done < <(noncomment_lines "$f")
    [ "$hits" -eq 0 ] || { echo "${RED}SELFTEST FAIL: guard false-positived on allowed form in $(basename "$f")${RST}"; fail_good=1; }
  done

  if [ "$fail_bad" -eq 0 ] && [ "$fail_good" -eq 0 ]; then
    echo "${GRN}✓ v4-naming-guard self-test passed (catches R1/R2/R3 on the bad corpus; no false positives on allowed forms; R5 retired — Trino is the V4 serving engine).${RST}"
    return 0
  fi
  return 1
}

# ── Main ────────────────────────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

echo "${YEL}v4-naming-guard${RST} — scanning the tree for retired-dbt / non-V4 naming…"
scan_dead_db_refs
scan_dbt_invocations
scan_feature_precompute

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}v4-naming-guard FAILED: ${violations} violation(s).${RST}"
  echo "Brain V4: Spark is sole compute; medallion lives in the brain_*_local Iceberg catalogs;"
  echo "Gold/Silver are served ONLY via brain_serving.mv_* (or read from rest-Iceberg by Spark);"
  echo "dbt and the dbt-internal brain_gold/brain_silver DBs are REMOVED; features are RUNTIME."
  echo "Trino is the V4 serving engine (R5 retired); brain_serving.mv_* are Trino views over Iceberg."
  exit 1
fi

echo "${GRN}✓ v4-naming-guard passed — no retired-dbt-DB refs, no dbt invocations, no feature precompute.${RST}"
exit 0
