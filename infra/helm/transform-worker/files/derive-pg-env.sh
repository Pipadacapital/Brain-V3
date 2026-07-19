# Derive BRONZE/SILVER/GOLD PG env from core-env's DATABASE_URL_DIRECT (fallback DATABASE_URL).
#
# WHY: the DuckDB Silver/Gold jobs read THREE PG env families, and they disagree on shape —
#   *_PG_JDBC_URL / *_PG_USER / *_PG_PASSWORD    ← silver_collector_event, _normalize_base, gold_*
#   *_PG_HOST / *_PG_PORT / *_PG_DB (+USER/PASS) ← silver_touchpoint, silver_session_identity
# In docker-compose these default to host `postgres`/`localhost`; in PROD they MUST be derived
# from core-env, which carries DATABASE_URL_DIRECT (direct Aurora) + DATABASE_URL (pgbouncer),
# NOT the bespoke *_PG_* keys. Absent derivation the jobs fell back to localhost:5432 and every
# PG read fail-softed to empty — silently dropping the pixel-lane install→brand resolution
# (silver_collector_event R2) and starving the cost/margin Gold marts (prod 2026-07-14).
#
# This is the SINGLE fix point: embedded verbatim into the v4-silver/v4-gold cron scripts by the
# `brain.sparkPgEnvDerivation` helper (via .Files.Get) AND exercised by derive-pg-env.test.sh.
# Edit here only — never copy-paste the logic.
#
# Idempotent + override-safe: runs only when a source URL exists and SILVER_PG_JDBC_URL is unset,
# so an explicit per-env override (or a re-source on pass 2) is a no-op.
SRC_URL="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
if [ -n "$SRC_URL" ] && [ -z "${SILVER_PG_JDBC_URL:-}" ]; then
  stripped="${SRC_URL#postgres://}"; stripped="${stripped#postgresql://}"
  creds="${stripped%%@*}"; rest="${stripped#*@}"
  _pg_user="${creds%%:*}"; _pg_pass="${creds#*:}"
  hostport="${rest%%/*}"; db_q="${rest#*/}"; db="${db_q%%\?*}"   # db_q keeps ?sslmode=… (pgJDBC), db is bare (libpq)
  _pg_host="${hostport%%:*}"
  _pg_port="${hostport#*:}"; [ "$_pg_port" = "$hostport" ] && _pg_port=5432   # no ':port' → Aurora default
  for fam in BRONZE SILVER GOLD; do
    export ${fam}_PG_JDBC_URL="jdbc:postgresql://${hostport}/${db_q}"
    export ${fam}_PG_USER="${_pg_user}"
    export ${fam}_PG_PASSWORD="${_pg_pass}"
    export ${fam}_PG_HOST="${_pg_host}"
    export ${fam}_PG_PORT="${_pg_port}"
    export ${fam}_PG_DB="${db}"
  done
  echo "[pg-env] BRONZE/SILVER/GOLD PG env derived from core-env (host ${_pg_host} db ${db})"
fi
