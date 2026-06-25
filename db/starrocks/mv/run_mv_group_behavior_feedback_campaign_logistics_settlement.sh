#!/usr/bin/env bash
# ============================================================
# Brain V4 Phase 3 — runner for the serving MV group:
#   mv_gold_behavior, mv_gold_conversion_feedback, mv_gold_campaign_performance,
#   mv_gold_logistics_performance, mv_gold_settlement_summary
#
# ADDITIVE / NON-BREAKING. Creates the brain_serving DB + async MVs over the
# external Iceberg Gold catalog, then REFRESH ... WITH SYNC MODE (blocks until done).
#
# StarRocks: mysql protocol 127.0.0.1:9030, root, no password.
# Local substrate: StarRocks runs in docker container brainv3-starrocks-1, which
# ships the mysql client; we exec into it so a host mysql client is not required.
# ============================================================
set -euo pipefail

CONTAINER="${STARROCKS_CONTAINER:-brainv3-starrocks-1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MVS=(
  mv_gold_behavior
  mv_gold_conversion_feedback
  mv_gold_campaign_performance
  mv_gold_logistics_performance
  mv_gold_settlement_summary
)

sr() { docker exec -i "$CONTAINER" mysql -h127.0.0.1 -P9030 -uroot "$@"; }

echo "==> REFRESH EXTERNAL TABLE (ensure Iceberg Gold metadata is fresh)"
for mv in "${MVS[@]}"; do
  src="gold_${mv#mv_gold_}"
  sr -e "REFRESH EXTERNAL TABLE brain_gold_local.brain_gold.${src};" 2>/dev/null || true
done

echo "==> Applying MV DDL"
for mv in "${MVS[@]}"; do
  echo "  - ${mv}"
  sr < "${HERE}/${mv}.sql"
done

echo "==> REFRESH ... WITH SYNC MODE (blocks until complete)"
for mv in "${MVS[@]}"; do
  echo "  - REFRESH ${mv}"
  sr -e "REFRESH MATERIALIZED VIEW brain_serving.${mv} WITH SYNC MODE;"
done

echo "==> DONE. MVs in brain_serving:"
sr -e "SHOW MATERIALIZED VIEWS FROM brain_serving;"
