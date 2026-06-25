#!/usr/bin/env bash
# ============================================================
# Brain V4 Phase 3 — apply + refresh + verify the StarRocks mv_* serving layer.
# ADDITIVE / dual-run: creates ASYNC materialized views in the brain_serving DB
# that SELECT from the external Iceberg Gold catalog (brain_gold_local.brain_gold.*).
# Does NOT touch dbt internal brain_gold, app code, readers, or the external catalog.
#
# Usage:  db/starrocks/mv/run-mv.sh
# Env:    SR_CONTAINER (default brainv3-starrocks-1), SR_HOST/SR_PORT (in-container 127.0.0.1:9030)
#
# For each MV: CREATE (idempotent IF NOT EXISTS) -> REFRESH ... WITH SYNC MODE
# (blocks until done) -> verify count(*) + per-(brand,currency) money SUM match
# the Iceberg Gold source exactly (row + minor-unit money parity).
#
# Bash 3.2 compatible (macOS default) — no associative arrays.
# ============================================================
set -eo pipefail

SR_CONTAINER="${SR_CONTAINER:-brainv3-starrocks-1}"
SR_HOST="${SR_HOST:-127.0.0.1}"
SR_PORT="${SR_PORT:-9030}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All docker-exec calls read stdin from /dev/null by default so they never
# consume the read-loop's stdin (the mart list). The create step passes the
# DDL file explicitly on fd 0 via redirection at the call site.
sr()  { docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -uroot "$@" </dev/null; }
srN() { sr -N -e "$1"; }
srFile() { docker exec -i "$SR_CONTAINER" mysql -h"$SR_HOST" -P"$SR_PORT" -uroot < "$1"; }

# one line per mart:  mart|money_minor_cols(csv, empty=none)|has_currency(1/0)
MARTS="
gold_contribution_margin|net_revenue_minor,cogs_minor,variable_minor,cm1_minor,marketing_minor,cm2_minor|1
gold_cod_rto|cod_amount_minor|1
gold_funnel||0
gold_abandoned_cart|abandoned_value_minor|1
gold_engagement||0
"

echo "== Refreshing external Iceberg Gold catalog metadata =="
echo "$MARTS" | while IFS='|' read -r m money cur; do
  [ -z "$m" ] && continue
  sr -e "REFRESH EXTERNAL TABLE brain_gold_local.brain_gold.$m;" 2>/dev/null || true
done

RC=0
while IFS='|' read -r m money cur; do
  [ -z "$m" ] && continue
  mv="mv_$m"
  src="brain_gold_local.brain_gold.$m"
  dst="brain_serving.$mv"
  echo
  echo "==================== $mv ===================="

  echo "-- create (idempotent)"
  srFile "$HERE/$mv.sql"

  echo "-- refresh WITH SYNC MODE (blocking)"
  sr -e "REFRESH MATERIALIZED VIEW $dst WITH SYNC MODE;"

  # ---- verify: row count parity ----
  src_n="$(srN "SELECT count(*) FROM $src;")"
  dst_n="$(srN "SELECT count(*) FROM $dst;")"
  if [ "$src_n" = "$dst_n" ]; then
    echo "   ROWS  OK   src=$src_n mv=$dst_n"
  else
    echo "   ROWS  FAIL src=$src_n mv=$dst_n"; RC=1
  fi

  # ---- verify: per-(brand,currency) money SUM parity ----
  if [ -n "$money" ]; then
    if [ "$cur" = "1" ]; then grp="brand_id, currency_code"; else grp="brand_id"; fi
    sums=""
    OIFS="$IFS"; IFS=','
    for c in $money; do
      if [ -z "$sums" ]; then sums="coalesce(sum($c),0) AS s_$c"; else sums="$sums,coalesce(sum($c),0) AS s_$c"; fi
    done
    IFS="$OIFS"
    q_src="SELECT $grp, $sums FROM $src GROUP BY $grp ORDER BY $grp;"
    q_dst="SELECT $grp, $sums FROM $dst GROUP BY $grp ORDER BY $grp;"
    h_src="$(srN "$q_src" | md5)"
    h_dst="$(srN "$q_dst" | md5)"
    if [ "$h_src" = "$h_dst" ]; then
      echo "   MONEY OK   per-($grp) SUM($money) identical"
    else
      echo "   MONEY FAIL per-($grp) SUM($money) differ"
      echo "     src:"; srN "$q_src" | sed 's/^/       /'
      echo "     mv :"; srN "$q_dst" | sed 's/^/       /'
      RC=1
    fi
  else
    echo "   MONEY n/a  (no money columns)"
  fi
done <<EOF
$(echo "$MARTS")
EOF

echo
if [ "$RC" = "0" ]; then echo "ALL MVs CREATED, REFRESHED & VERIFIED (row + money parity)."; else echo "VERIFICATION FAILED."; fi
exit $RC
