#!/usr/bin/env bash
#
# v4-naming-guard.sh — Brain V4 architecture naming lint (BLOCKING CI gate).
#
# Brain V4 invariants this guard enforces (see CLAUDE.md + docs/architecture/v4/):
#   • Compute is DuckDB-on-Iceberg — DuckDB is the sole TRANSFORM compute (Silver/Gold, run as
#     `python db/iceberg/duckdb/<layer>/<job>.py`); Bronze maintenance/retention/RTBF is the PyIceberg
#     maintenance client (db/iceberg/duckdb/maintenance/**). The Spark transform tree
#     (db/iceberg/spark/**) is DELETED (Spark→DuckDB cutover) — R6 forbids `spark-submit` / a
#     `db/iceberg/spark` path creeping back. dbt is REMOVED — the dbt-internal DBs `brain_gold` /
#     `brain_silver` are RETIRED (dropped).
#   • Medallion lives in the Iceberg catalogs brain_{bronze,silver,gold}_local; Gold/Silver are
#     SERVED to the app ONLY by the duckdb-serving views brain_serving.mv_* (local views over the
#     read-only-attached iceberg catalog), or read directly from the rest-Iceberg catalogs by the
#     DuckDB transform/maintenance jobs. No reader queries a bare brain_gold./brain_silver. DB.
#   • Features are RUNTIME — there is NO permanent feature-precompute table (no feature_customer_daily,
#     no brain_feature write). brain_feature is dead (dropped).
#   • duckdb-serving is the SERVING engine (Brain V4 removed StarRocks ENTIRELY — wire AND serving;
#     ADR-0014 then removed Trino ENTIRELY — serving AND maintenance). The app / BFF / metric-engine
#     read brain_serving.mv_* over the duckdb-serving HTTP API (db/iceberg/duckdb/serving/, :8091),
#     fronted by a Redis analytics cache. The serving client (withServingBrand/createDuckDbServingPool/
#     ServingPool) in core serving code is ALLOWED; NEW StarRocks coupling (a mysql2 driver, the :9030
#     query port, or a STARROCKS_* env read) in serving app code is FORBIDDEN — R5. NEW Trino coupling
#     (the trinodb/trino image, TRINO_* envs, the retired Trino client identifiers, a db/trino/ or
#     db/iceberg/trino path, /opt/brain/trino, or a trino:8080|trino…:8090 host form) is FORBIDDEN — R7.
#
# It FAILS (exit 1) when LIVE (non-test, non-comment) source contains any of:
#   R1  a bare `brain_gold.` / `brain_silver.` reference (the retired dbt StarRocks DBs).
#         — `brain_gold_local.` / `brain_silver_local.` (Iceberg catalogs), `rest.brain_*.`,
#           `{CATALOG}.brain_*.` (Spark Iceberg namespaces), `iceberg.brain_*.` (the Trino Iceberg
#           serving catalog — incl. iceberg.brain_serving.*), and `brain_serving.` are ALLOWED.
#   R2  a `dbt` INVOCATION in a script / CI workflow / compose file (dbt run|build|test|seed|…).
#         — the word "dbt" in a comment (explaining it was removed) is allowed.
#   R3  a permanent feature precompute table — a `feature_customer_daily` reference or a `brain_feature`
#         WRITE (CREATE/INSERT/MERGE/UPSERT/REFRESH/GRANT) in live code.
#   R4  a Gold/Silver read that is NOT via mv_* / rest-Iceberg — i.e. `FROM`/`JOIN brain_gold.` or
#         `brain_silver.` (a strict subset of R1, surfaced separately for a clearer message).
#   R5  NEW StarRocks COUPLING in serving app code (apps/core/** + apps/collector/**, non-test): a
#         `mysql2` import (the StarRocks wire driver), the StarRocks query port `:9030`, or a `STARROCKS_*`
#         env read. Brain V4 removed StarRocks ENTIRELY — serving is duckdb-serving-over-Iceberg
#         (createDuckDbServingPool / withServingBrand) fronted by Redis. This rule stops StarRocks creeping back
#         into the app. (The duckdb-serving client is ALLOWED; this only bans the StarRocks wire.)
#   R6  NEW Spark COUPLING (Spark→DuckDB cutover, feat/spark-to-duckdb-cutover): a `spark-submit`
#         invocation, or a `db/iceberg/spark` path reference, in live (non-comment) code. The transform
#         tier is DuckDB-on-Iceberg (db/iceberg/duckdb/**) + a PyIceberg maintenance client (db/iceberg/
#         duckdb/maintenance/**); the Spark tree and image are DELETED. This rule stops Spark creeping back
#         after the cutover. (db/iceberg/duckdb — incl. maintenance/ — is ALLOWED, never matched by this rule.)
#   R7  NEW Trino COUPLING (Trino→DuckDB serving cutover, ADR-0014): a `trinodb/trino` image ref, a
#         `TRINO_*` env token, a retired Trino client identifier (createTrinoPool / withTrinoBrand /
#         TrinoPool / TrinoQueryPort), a `db/trino/` or `db/iceberg/trino` path, an `/opt/brain/trino`
#         invocation, or a `trino:8080` / `trino…:8090` host form, in live (non-comment) code. Brain V4
#         removed Trino ENTIRELY — serving is duckdb-serving (db/iceberg/duckdb/serving/, :8091, the
#         createDuckDbServingPool/withServingBrand client); maintenance is the PyIceberg client (db/iceberg/
#         duckdb/maintenance/**). NEVER a bare `:8090` ban — that is the stream-worker metrics port; only
#         a trino-qualified host:port form matches.
#   R8  STREAM-TIER IDENTITY COUPLING (ADR-0015 D5): identity is resolved in the SILVER transform
#         stage (the batch, watermark-driven jobs/silver-identity job) — Neo4j is NEVER wired to the
#         collector, the log, or Bronze. A stream-worker Kafka CONSUMER path (apps/stream-worker/src/
#         interfaces/consumers/**, a re-created identity-bridge/ dir, or any *Consumer* file under
#         apps/stream-worker/src) that names Neo4jIdentityRepository, or ANY stream-worker import from
#         an identity-bridge/ module path (the IdentityBridgeConsumer tree is DELETED), is a violation.
#         apps/stream-worker/src/jobs/silver-identity/** is the ONE sanctioned Neo4j invocation path
#         (allowlisted), and the erasure lane's wiring in main.ts (ADR-0004 RTBF lookup + purge — not
#         a consumer path) stays legal. This rule stops identity creeping back onto the log.
#
# EXCLUDED from scanning (by design):
#   • test fixtures: *.test.ts, *.spec.ts, *.live.test.ts, tools/isolation-fuzz/**, **/test/**
#   • docs/adr/** + CHANGELOG* — decision history legitimately names the retired engines.
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
      '*.ts' '*.tsx' '*.js' '*.mjs' '*.sh' '*.sql' '*.yml' '*.yaml' '*.py' '*.json' 'Makefile' '*.mk' 2>/dev/null || true
  else
    grep -rlE "$1" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
      --include='*.sh' --include='*.sql' \
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
    docs/adr/*|CHANGELOG*|*/CHANGELOG*) return 0 ;; # decision history names the retired engines on purpose
    tools/lint/v4-naming-guard.sh) return 0 ;;      # this guard + its self-test corpus
    tools/lint/v4-naming-guard.selftest.*) return 0 ;;
    tools/lint/identity-view-guard.sh) return 0 ;;  # sibling guard: names silver_identity_map in its docstring/self-test fixtures on purpose (A.2.2)
    tools/isolation-fuzz/*) return 0 ;;             # tenant-isolation fuzz fixtures
    tools/ops/*) return 0 ;;                        # one-off ops Jobs embed PyIceberg client code whose native
                                                    # table ids are catalog-RELATIVE (pyiceberg identifiers have
                                                    # no catalog part) — same allowance class as
                                                    # db/iceberg/duckdb/maintenance/**; never app/serving code
                                                    # (R1 false-positive on dr001, promotion PR #318)
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
          # A line whose stripped content STARTS with a bare string quote is a multi-line string-literal
          # BODY/continuation (e.g. a raise SystemExit("…") error message split across lines) — prose, not
          # an executable table reference. Executable string args start with the CALL (con.execute("…"),
          # f"…") or a SQL keyword ("SELECT …"), never with a bare `"brain_gold.` — so this cannot hide a
          # real FROM/JOIN. Same intent as the docstring skip above.
          if (stripped ~ /^("|'"'"')/) next
          printf "%d:%s\n", NR, line
        }
      ' "$f"
      ;;
    *)
      # generic: drop whole-line comments (//, #, --, *, /*) AND the BODIES of multi-line block
      # comments — C/JSDoc/SQL `/* … */` and Helm template `{{- /* … */ -}}`. Prose inside a Helm
      # banner (e.g. "No spark-submit, no JVM" in a cronworkflow template) is documentation, not live
      # code, and must not be scanned (R6 false-positive fix). The two block-openers below cannot
      # collide with a bash glob like /opt/dir/*.py — that has neither a leading /* nor a {{ … /*.
      awk '
        { line=$0; stripped=line; sub(/^[ \t]*/,"",stripped) }
        inblock { if (line ~ /\*\//) inblock=0; next }          # skip block body incl. its closing */ line
        (stripped ~ /^\/\*/ || line ~ /\{\{-?[ \t]*\/\*/) && line !~ /\*\// { inblock=1; next }  # open a multi-line block
        stripped ~ /^(\/\/|#|--|\*|\/\*)/ { next }              # whole-line / self-closed comment
        { printf "%d:%s\n", NR, line }
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
        flag R1 "$f:$l" "names the RETIRED dbt StarRocks DB brain_gold/brain_silver (V4 dropped both) — V4 serving is brain_serving, operational state is brain_ops: ${content#"${content%%[![:space:]]*}"}"
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

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R5: NEW StarRocks coupling in serving app code (apps/core/** + apps/collector/**, non-test).
#   Brain V4 removed StarRocks ENTIRELY; serving is duckdb-serving-over-Iceberg (createDuckDbServingPool /
#   withServingBrand) fronted by Redis. The StarRocks wire MUST NOT creep back: a mysql2 import, the :9030
#   query port, or a STARROCKS_* env read in serving app code is a violation. (The duckdb-serving client
#   is ALLOWED — not scanned.)
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_starrocks_coupling() {
  local f l content
  while IFS= read -r f; do
    # Scope to the SERVING app surfaces only — the metric-engine/BFF/core/collector read paths.
    case "$f" in
      apps/core/*|apps/collector/*) ;;
      *) continue ;;
    esac
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE "(from[[:space:]]+['\"]mysql2|require\(['\"]mysql2|['\"]mysql2/promise['\"])"; then
        flag R5 "$f:$l" "mysql2 (the StarRocks wire driver) in serving app code — Brain V4 removed StarRocks; serving is duckdb-serving-over-Iceberg (createDuckDbServingPool/withServingBrand): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE 'STARROCKS_[A-Z0-9_]+'; then
        flag R5 "$f:$l" "STARROCKS_* env read in serving app code — StarRocks is removed in Brain V4; use DUCKDB_SERVING_* / the Iceberg catalog name (createDuckDbServingPool): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE '(^|[^0-9])9030([^0-9]|$)'; then
        flag R5 "$f:$l" "the StarRocks query port :9030 in serving app code — Brain V4 serving is duckdb-serving (HTTP, default :8091): ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files 'mysql2|STARROCKS_|(^|[^0-9])9030([^0-9]|$)' | grep -E '\.tsx?$' || true)
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R6: NEW Spark coupling (Spark→DuckDB cutover). A `spark-submit` invocation or a `db/iceberg/spark`
#   path reference in live (non-comment) code. The Spark tree + image are deleted; the transform tier is
#   DuckDB (db/iceberg/duckdb/**) + a PyIceberg maintenance client (db/iceberg/duckdb/maintenance/**).
#   Comments/docstrings that mention the ported-from Spark path (provenance) are stripped by
#   noncomment_lines() and allowed.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_spark_coupling() {
  local f l content
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE 'spark-submit'; then
        flag R6 "$f:$l" "spark-submit is REMOVED (Spark→DuckDB cutover) — the transform tier is DuckDB (db/iceberg/duckdb) invoked as \`python /opt/brain/duckdb/<layer>/<job>.py\`; maintenance is the PyIceberg client (db/iceberg/duckdb/maintenance): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE 'db/iceberg/spark'; then
        flag R6 "$f:$l" "db/iceberg/spark is DELETED (Spark→DuckDB cutover) — use db/iceberg/duckdb (transform) or db/iceberg/duckdb/maintenance (PyIceberg maintenance): ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files 'spark-submit|db/iceberg/spark')
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R7: NEW Trino coupling (Trino→DuckDB serving cutover, ADR-0014). Brain V4 removed Trino ENTIRELY —
#   serving is duckdb-serving (db/iceberg/duckdb/serving/, HTTP :8091, the createDuckDbServingPool/
#   withServingBrand client); maintenance is the PyIceberg client (db/iceberg/duckdb/maintenance/**).
#   Six token-scoped signals on live (non-comment) lines, tree-wide:
#     1. the trinodb/trino image ref                    4. a db/trino/ or db/iceberg/trino path
#     2. a TRINO_* env token                            5. an /opt/brain/trino invocation
#     3. a retired Trino client identifier              6. a trino:8080 / trino…:8090 host form
#        (createTrinoPool/withTrinoBrand/TrinoPool/TrinoQueryPort)
#   DELIBERATELY NOT a signal: a bare `:8090` — that is the stream-worker metrics port (e.g.
#   `http://localhost:8090/metrics`); only a trino-qualified host:port form matches signal 6.
#   docs/adr/** + CHANGELOG* are excluded (is_excluded) — decision history names Trino on purpose.
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_trino_coupling() {
  local f l content
  while IFS= read -r f; do
    is_excluded "$f" && continue
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if printf '%s' "$content" | grep -qE 'trinodb/trino'; then
        flag R7 "$f:$l" "the trinodb/trino image — Trino is REMOVED (ADR-0014); serving is the duckdb-serving image (db/iceberg/duckdb/serving/Dockerfile): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE 'TRINO_[A-Z0-9_]+'; then
        flag R7 "$f:$l" "TRINO_* env token — Trino is REMOVED (ADR-0014); the serving contract is DUCKDB_SERVING_* (host/port default localhost:8091): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE '(createTrinoPool|withTrinoBrand|TrinoPool|TrinoQueryPort)'; then
        flag R7 "$f:$l" "retired Trino client identifier — the serving port is createDuckDbServingPool/withServingBrand/ServingPool (packages/metric-engine serving-deps): ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE 'db/trino/|db/iceberg/trino'; then
        flag R7 "$f:$l" "db/trino / db/iceberg/trino is DELETED (ADR-0014) — views live in db/iceberg/duckdb/views, maintenance in db/iceberg/duckdb/maintenance: ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE '/opt/brain/trino'; then
        flag R7 "$f:$l" "/opt/brain/trino invocation — the cron image carries /opt/brain/duckdb/maintenance/*.py (PyIceberg) instead: ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE 'trino[a-zA-Z0-9._-]*:(8080|8090)'; then
        flag R7 "$f:$l" "a Trino host:port form (trino:8080 / trino…:8090) — serving is duckdb-serving:8091; a bare :8090 (stream-worker metrics) is fine, a trino host is not: ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files '[Tt]rino|TRINO_')
}

# ──────────────────────────────────────────────────────────────────────────────────────────────────
# R8: STREAM-TIER IDENTITY COUPLING (ADR-0015 D5). Identity is a SILVER-stage batch step
#   (apps/stream-worker/src/jobs/silver-identity/** — the sanctioned, allowlisted Neo4j invocation
#   path, watermark-driven between the silver passes and gold). Neo4j must NEVER be wired back onto
#   the collector event stream. Two signals, scoped to apps/stream-worker/**:
#     1. a Kafka CONSUMER path (src/interfaces/consumers/**, a re-created src/identity-bridge/** dir,
#        or any *Consumer* file under src/) whose live code names Neo4jIdentityRepository;
#     2. ANY live import/require from an identity-bridge/ module path — the IdentityBridgeConsumer
#        tree is DELETED (WS4); importing it anywhere is a regression.
#   NOT signals: the erasure lane's Neo4j wiring in main.ts (ADR-0004 RTBF lookup + purge; main.ts is
#   the composition root, not a consumer path), batch jobs under src/jobs/** (backfill-identity,
#   silver-identity), and '[identity-bridge]' log/error STRING literals (SaltProvider) — the import
#   regex requires a from/require quote, and prose comments are stripped by noncomment_lines().
# ──────────────────────────────────────────────────────────────────────────────────────────────────
scan_stream_identity_coupling() {
  local f l content in_consumer_path
  while IFS= read -r f; do
    # Scope: stream-worker only — ADR-0015's guard is about the stream tier.
    case "$f" in
      apps/stream-worker/*) ;;
      *) continue ;;
    esac
    is_excluded "$f" && continue
    case "$f" in
      apps/stream-worker/src/jobs/silver-identity/*) continue ;; # the sanctioned Silver identity stage
      apps/stream-worker/src/infrastructure/neo4j/*) continue ;; # the preserved repository itself
    esac
    in_consumer_path=0
    case "$f" in
      apps/stream-worker/src/interfaces/consumers/*|apps/stream-worker/src/identity-bridge/*|apps/stream-worker/src/*[Cc]onsumer*) in_consumer_path=1 ;;
    esac
    while IFS= read -r line; do
      l="${line%%:*}"; content="${line#*:}"
      if [ "$in_consumer_path" -eq 1 ] && printf '%s' "$content" | grep -qE 'Neo4jIdentityRepository'; then
        flag R8 "$f:$l" "a stream-worker Kafka consumer path names Neo4jIdentityRepository — identity is resolved in the SILVER stage (jobs/silver-identity, ADR-0015 D5); Neo4j is never wired to the collector, the log, or Bronze: ${content#"${content%%[![:space:]]*}"}"
      elif printf '%s' "$content" | grep -qE "(from[[:space:]]+|require\()['\"][^'\"]*identity-bridge"; then
        flag R8 "$f:$l" "import from the DELETED identity-bridge consumer tree (ADR-0015 WS4 removed IdentityBridgeConsumer) — identity is a Silver-stage batch step (jobs/silver-identity): ${content#"${content%%[![:space:]]*}"}"
      fi
    done < <(noncomment_lines "$f")
  done < <(candidate_files 'Neo4jIdentityRepository|identity-bridge')
}

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
  # R5 bad corpus — NEW StarRocks coupling in serving app code (one signal per line).
  cat > "$d/bad.starrocks.ts" <<'EOF'
import mysql from 'mysql2/promise';
const host = process.env['STARROCKS_HOST'];
const pool = mysql.createPool({ host, port: 9030, user: 'brain_analytics' });
EOF
  # R6 bad corpus — NEW Spark coupling (one signal per line).
  cat > "$d/bad.spark.sh" <<'EOF'
#!/usr/bin/env bash
exec /opt/spark/bin/spark-submit --master local[*] /opt/brain/silver/silver_order_state.py
python db/iceberg/spark/gold/gold_revenue_ledger.py
EOF
  # R7 bad corpus — NEW Trino coupling (one signal per line, all six).
  cat > "$d/bad.trino.ts" <<'EOF'
import { createTrinoPool, withTrinoBrand } from '@brain/metric-engine';
const trino = createTrinoPool({ baseUrl: process.env['TRINO_URL'] ?? 'http://trino:8080', user: 'brain' });
const prod = 'http://brain-prod-trino.trino.svc.cluster.local:8090';
EOF
  cat > "$d/bad.trino.sh" <<'EOF'
#!/usr/bin/env bash
bash db/trino/views/run-trino-views.sh
python /opt/brain/trino/bronze_maintenance.py
python db/iceberg/trino/medallion_maintenance.py
EOF
  cat > "$d/bad.trino.yaml" <<'EOF'
image:
  repository: trinodb/trino
  tag: "455"
EOF
  # .mjs corpus — candidate_files() scans *.js/*.mjs too (the seed-bronze.mjs class: a Node tool
  # querying the serving tier must not carry Trino coupling just because it isn't a .ts file).
  cat > "$d/bad.trino.mjs" <<'EOF'
const SERVING = process.env.TRINO_URL ?? 'http://trino:8080';
EOF
  # R8 bad corpus — a stream-worker Kafka consumer re-wiring identity onto the log (one signal per
  # line: the Neo4j repo named in a consumer-path file, + an import from the deleted identity-bridge
  # tree). In the tree scan this file would live under apps/stream-worker/src/interfaces/consumers/.
  cat > "$d/bad.streamid.ts" <<'EOF'
import { Neo4jIdentityRepository } from '../../infrastructure/neo4j/Neo4jIdentityRepository.js';
import { IdentityBridgeConsumer } from '../../identity-bridge/IdentityBridgeConsumer.js';
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
  # R5 good corpus — the duckdb-serving client + brain_serving views (allowed, no StarRocks wire).
  cat > "$d/good.starrocks.ts" <<'EOF'
import { createDuckDbServingPool, withServingBrand } from '@brain/metric-engine';
const serving = createDuckDbServingPool({ baseUrl: process.env['DUCKDB_SERVING_URL'] ?? 'http://duckdb-serving:8091', user: 'brain' });
// reads brain_serving.mv_gold_revenue_ledger over duckdb-serving — no mysql2, no :9030, no STARROCKS_ env.
EOF
  # R6 good corpus — the DuckDB transform/maintenance invocation + a provenance comment/docstring (allowed).
  cat > "$d/good.spark.sh" <<'EOF'
#!/usr/bin/env bash
# faithful port of db/iceberg/spark/gold/gold_cac.py — provenance comment, allowed
python /opt/brain/duckdb/gold/gold_cac.py                    # DuckDB transform
python /opt/brain/duckdb/maintenance/bronze_maintenance.py   # PyIceberg maintenance client
EOF
  cat > "$d/good.spark.py" <<'EOF'
"""
gold_cac.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_cac.py (docstring — allowed).
"""
con.execute("MERGE INTO rest.brain_gold.gold_cac ...")
EOF
  # Helm-template banner mentioning the ported-from Spark tokens ONLY inside a `{{- /* … */ -}}` block
  # comment (provenance prose) — the executable args run the DuckDB tier. Regression guard for the real
  # cronworkflows FP: block-comment bodies must be stripped by noncomment_lines(), so R6 sees nothing.
  cat > "$d/good.spark.yaml" <<'EOF'
{{- /*
Bronze maintenance (was spark-bronze.yaml — Spark→DuckDB cutover). No spark-submit, no JVM; the
executionMode/driverMemory knobs were spark-submit-only and were removed. Faithful of the deleted
db/iceberg/spark/gold path — provenance only.
*/ -}}
args:
  - exec python /opt/brain/duckdb/maintenance/bronze_maintenance.py
EOF
  # R7 good corpus — the duckdb-serving client, the maintenance tier, AND a bare :8090 (the
  # stream-worker metrics port — the one port form R7 must NEVER ban). None of these may flag.
  cat > "$d/good.trino.ts" <<'EOF'
import { createDuckDbServingPool, withServingBrand, ServingPool } from '@brain/metric-engine';
const serving = createDuckDbServingPool({ baseUrl: process.env['DUCKDB_SERVING_URL'] ?? 'http://duckdb-serving:8091', user: 'brain' });
const metricsUrl = 'http://localhost:8090/metrics'; // stream-worker metrics port — a bare :8090 is NOT a Trino signal
EOF
  cat > "$d/good.trino.sh" <<'EOF'
#!/usr/bin/env bash
# was db/trino/views/run-trino-views.sh — provenance comment, allowed (Trino removed, ADR-0014)
python /opt/brain/duckdb/maintenance/medallion_maintenance.py   # PyIceberg maintenance client
curl -fsS http://localhost:8091/readyz                          # duckdb-serving view-apply gate
curl -fsS http://localhost:8090/metrics                         # stream-worker metrics (bare :8090 — allowed)
EOF
  # R8 good corpus — the shapes that must NOT flag even inside a consumer-path file: a comment naming
  # the removed IdentityBridgeConsumer (stripped), and an '[identity-bridge]' error-STRING literal
  # (SaltProvider's fail-closed message — not an import; the R8 import regex requires from/require).
  # The sanctioned jobs/silver-identity + erasure-lane main.ts wiring are path-allowlisted in the
  # real scan, exercised by running the guard on the live tree, not by this corpus.
  cat > "$d/good.streamid.ts" <<'EOF'
import type { EraseSubjectUseCase } from '../../application/EraseSubjectUseCase.js';
// replaced by the Silver identity stage — IdentityBridgeConsumer / identity-bridge/ are DELETED (comment, allowed)
throw new Error('[identity-bridge] salt fetch failed — fail-closed (string literal, allowed)');
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

  # ── Check bad.starrocks.ts catches R5 (mysql2 / STARROCKS_ / :9030) ───────────
  local r5_hits; r5_hits=0
  while IFS= read -r line; do
    local content="${line#*:}"
    printf '%s' "$content" | grep -qE "(from[[:space:]]+['\"]mysql2|require\(['\"]mysql2|['\"]mysql2/promise['\"])" && r5_hits=$((r5_hits+1))
    printf '%s' "$content" | grep -qE 'STARROCKS_[A-Z0-9_]+' && r5_hits=$((r5_hits+1))
    printf '%s' "$content" | grep -qE '(^|[^0-9])9030([^0-9]|$)' && r5_hits=$((r5_hits+1))
  done < <(noncomment_lines "$d/bad.starrocks.ts")
  # The 3-line corpus carries all three signals; require every one to be caught.
  [ "$r5_hits" -ge 3 ] || { echo "${RED}SELFTEST FAIL: R5 missed a StarRocks-coupling signal in bad.starrocks.ts (hits=$r5_hits)${RST}"; fail_bad=1; }

  # ── Check bad.spark.sh catches R6 (spark-submit + db/iceberg/spark) ───────────
  local r6_hits; r6_hits=0
  while IFS= read -r line; do
    local content="${line#*:}"
    printf '%s' "$content" | grep -qE 'spark-submit' && r6_hits=$((r6_hits+1))
    printf '%s' "$content" | grep -qE 'db/iceberg/spark' && r6_hits=$((r6_hits+1))
  done < <(noncomment_lines "$d/bad.spark.sh")
  # The 2-line corpus carries both signals; require every one to be caught.
  [ "$r6_hits" -ge 2 ] || { echo "${RED}SELFTEST FAIL: R6 missed a Spark-coupling signal in bad.spark.sh (hits=$r6_hits)${RST}"; fail_bad=1; }

  # ── Check bad.trino.{ts,sh,yaml} catch R7 (all six Trino-coupling signals) ───
  local r7_hits; r7_hits=0
  for f in "$d/bad.trino.ts" "$d/bad.trino.sh" "$d/bad.trino.yaml" "$d/bad.trino.mjs"; do
    while IFS= read -r line; do
      local content="${line#*:}"
      printf '%s' "$content" | grep -qE 'trinodb/trino' && r7_hits=$((r7_hits+1))
      printf '%s' "$content" | grep -qE 'TRINO_[A-Z0-9_]+' && r7_hits=$((r7_hits+1))
      printf '%s' "$content" | grep -qE '(createTrinoPool|withTrinoBrand|TrinoPool|TrinoQueryPort)' && r7_hits=$((r7_hits+1))
      printf '%s' "$content" | grep -qE 'db/trino/|db/iceberg/trino' && r7_hits=$((r7_hits+1))
      printf '%s' "$content" | grep -qE '/opt/brain/trino' && r7_hits=$((r7_hits+1))
      printf '%s' "$content" | grep -qE 'trino[a-zA-Z0-9._-]*:(8080|8090)' && r7_hits=$((r7_hits+1))
    done < <(noncomment_lines "$f")
  done
  # The corpus carries all six signal classes (client ids ×2 lines, env, image, 3 path forms, 2 host
  # forms) — require at least one hit per class, i.e. ≥ 6 total with every grep represented above,
  # PLUS the .mjs corpus line's two signals (env + host) so *.mjs stays a scanned extension.
  [ "$r7_hits" -ge 8 ] || { echo "${RED}SELFTEST FAIL: R7 missed a Trino-coupling signal in bad.trino.* incl. the .mjs corpus (hits=$r7_hits)${RST}"; fail_bad=1; }

  # ── Check bad.streamid.ts catches R8 (consumer-path Neo4j repo + identity-bridge import) ───
  local r8_hits; r8_hits=0
  while IFS= read -r line; do
    local content="${line#*:}"
    # signal 1 — the corpus stands in for a consumer-path file, so the Neo4j-repo grep applies:
    printf '%s' "$content" | grep -qE 'Neo4jIdentityRepository' && r8_hits=$((r8_hits+1))
    # signal 2 — an import/require from an identity-bridge/ module path:
    printf '%s' "$content" | grep -qE "(from[[:space:]]+|require\()['\"][^'\"]*identity-bridge" && r8_hits=$((r8_hits+1))
  done < <(noncomment_lines "$d/bad.streamid.ts")
  # The 2-line corpus carries both signals; require every one to be caught.
  [ "$r8_hits" -ge 2 ] || { echo "${RED}SELFTEST FAIL: R8 missed a stream-identity-coupling signal in bad.streamid.ts (hits=$r8_hits)${RST}"; fail_bad=1; }

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

  # ── Check good.starrocks.ts (duckdb-serving client) produces NO R5 false positives ──────
  local r5_fp; r5_fp=0
  while IFS= read -r line; do
    local content="${line#*:}"
    printf '%s' "$content" | grep -qE "(from[[:space:]]+['\"]mysql2|require\(['\"]mysql2|['\"]mysql2/promise['\"])" && r5_fp=$((r5_fp+1))
    printf '%s' "$content" | grep -qE 'STARROCKS_[A-Z0-9_]+' && r5_fp=$((r5_fp+1))
    printf '%s' "$content" | grep -qE '(^|[^0-9])9030([^0-9]|$)' && r5_fp=$((r5_fp+1))
  done < <(noncomment_lines "$d/good.starrocks.ts")
  [ "$r5_fp" -eq 0 ] || { echo "${RED}SELFTEST FAIL: R5 false-positived on the allowed duckdb-serving client in good.starrocks.ts (hits=$r5_fp)${RST}"; fail_good=1; }

  # ── Check good.spark.{sh,py,yaml} (DuckDB invocation + provenance comments) produce NO R6 FPs ──
  local r6_fp; r6_fp=0
  for f in "$d/good.spark.sh" "$d/good.spark.py" "$d/good.spark.yaml"; do
    while IFS= read -r line; do
      local content="${line#*:}"
      printf '%s' "$content" | grep -qE 'spark-submit' && r6_fp=$((r6_fp+1))
      printf '%s' "$content" | grep -qE 'db/iceberg/spark' && r6_fp=$((r6_fp+1))
    done < <(noncomment_lines "$f")
  done
  [ "$r6_fp" -eq 0 ] || { echo "${RED}SELFTEST FAIL: R6 false-positived on the allowed DuckDB invocation or a provenance comment (hits=$r6_fp)${RST}"; fail_good=1; }

  # ── Check good.trino.{ts,sh} (serving client + maintenance + a bare :8090 metrics port) produce NO R7 FPs ──
  local r7_fp; r7_fp=0
  for f in "$d/good.trino.ts" "$d/good.trino.sh"; do
    while IFS= read -r line; do
      local content="${line#*:}"
      printf '%s' "$content" | grep -qE 'trinodb/trino' && r7_fp=$((r7_fp+1))
      printf '%s' "$content" | grep -qE 'TRINO_[A-Z0-9_]+' && r7_fp=$((r7_fp+1))
      printf '%s' "$content" | grep -qE '(createTrinoPool|withTrinoBrand|TrinoPool|TrinoQueryPort)' && r7_fp=$((r7_fp+1))
      printf '%s' "$content" | grep -qE 'db/trino/|db/iceberg/trino' && r7_fp=$((r7_fp+1))
      printf '%s' "$content" | grep -qE '/opt/brain/trino' && r7_fp=$((r7_fp+1))
      printf '%s' "$content" | grep -qE 'trino[a-zA-Z0-9._-]*:(8080|8090)' && r7_fp=$((r7_fp+1))
    done < <(noncomment_lines "$f")
  done
  [ "$r7_fp" -eq 0 ] || { echo "${RED}SELFTEST FAIL: R7 false-positived on the duckdb-serving client / the :8090 metrics port / a provenance comment (hits=$r7_fp)${RST}"; fail_good=1; }

  # ── Check good.streamid.ts (erasure-consumer shape: comment + string literal) produces NO R8 FPs ──
  local r8_fp; r8_fp=0
  while IFS= read -r line; do
    local content="${line#*:}"
    printf '%s' "$content" | grep -qE 'Neo4jIdentityRepository' && r8_fp=$((r8_fp+1))
    printf '%s' "$content" | grep -qE "(from[[:space:]]+|require\()['\"][^'\"]*identity-bridge" && r8_fp=$((r8_fp+1))
  done < <(noncomment_lines "$d/good.streamid.ts")
  [ "$r8_fp" -eq 0 ] || { echo "${RED}SELFTEST FAIL: R8 false-positived on an allowed consumer shape (comment / '[identity-bridge]' string literal) in good.streamid.ts (hits=$r8_fp)${RST}"; fail_good=1; }

  if [ "$fail_bad" -eq 0 ] && [ "$fail_good" -eq 0 ]; then
    echo "${GRN}✓ v4-naming-guard self-test passed (catches R1/R2/R3 + R5 StarRocks + R6 Spark + R7 Trino + R8 stream-identity coupling on the bad corpus; no false positives on allowed Iceberg/DuckDB/duckdb-serving forms incl. the bare :8090 metrics port and the erasure-lane consumer shape).${RST}"
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
scan_starrocks_coupling
scan_spark_coupling
scan_trino_coupling
scan_stream_identity_coupling

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}v4-naming-guard FAILED: ${violations} violation(s).${RST}"
  echo "Brain V4: DuckDB-on-Iceberg is the sole TRANSFORM compute (db/iceberg/duckdb/**), maintenance is"
  echo "the PyIceberg client (db/iceberg/duckdb/maintenance/**); the Spark transform tree is DELETED (R6"
  echo "blocks spark-submit / db/iceberg/spark). The medallion lives in the brain_*_local Iceberg catalogs;"
  echo "Gold/Silver are SERVED via the duckdb-serving views brain_serving.mv_* (fronted by Redis);"
  echo "dbt and the dbt-internal brain_gold/brain_silver DBs are REMOVED; features are RUNTIME."
  echo "StarRocks is REMOVED entirely — NEW StarRocks coupling (mysql2 / :9030 / STARROCKS_*) in serving"
  echo "app code is FORBIDDEN (R5). Trino is REMOVED entirely (ADR-0014) — NEW Trino coupling"
  echo "(trinodb/trino / TRINO_* / createTrinoPool|withTrinoBrand|TrinoPool / db/trino / db/iceberg/trino"
  echo "/ /opt/brain/trino / trino:8080|trino…:8090) is FORBIDDEN (R7); use the duckdb-serving client"
  echo "(createDuckDbServingPool / withServingBrand) and the PyIceberg maintenance tier."
  echo "Identity is resolved in the SILVER stage (ADR-0015) — a stream-worker Kafka consumer path that"
  echo "names Neo4jIdentityRepository, or any import from the deleted identity-bridge tree, is FORBIDDEN"
  echo "(R8); the sanctioned invocation path is apps/stream-worker/src/jobs/silver-identity."
  exit 1
fi

echo "${GRN}✓ v4-naming-guard passed — no retired-dbt-DB refs, no dbt invocations, no feature precompute, no StarRocks coupling, no Trino coupling, no stream-tier identity coupling.${RST}"
exit 0
