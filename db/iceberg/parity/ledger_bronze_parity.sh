#!/usr/bin/env bash
# ledger_bronze_parity.sh — DB-AUDIT H2 parity oracle (the bake gate for ledger_source='iceberg').
# Compares the Iceberg Bronze ledger to the Postgres source of truth via the StarRocks catalogs:
#   Iceberg : brain_bronze_local.brain_bronze.revenue_ledger
#   Postgres: the JDBC read-shim brain_oltp_pg.public.silver_order_ledger_src (uuid→text)
# Asserts equal row-count AND equal signed SUM(amount_minor). Exits non-zero on drift (CI/cron-friendly).
#
# Usage: db/iceberg/parity/ledger_bronze_parity.sh
set -euo pipefail
SR="${STARROCKS_CONTAINER:-brainv3-starrocks-1}"
q() { docker exec -i "$SR" mysql -P9030 -h127.0.0.1 -uroot --skip-column-names -e "$1" 2>/dev/null | tail -1; }

ICE=$(q "SELECT concat(count(*),'|',coalesce(sum(amount_minor),0)) FROM brain_bronze_local.brain_bronze.revenue_ledger;")
PG=$(q "SELECT concat(count(*),'|',coalesce(sum(amount_minor),0)) FROM brain_oltp_pg.public.silver_order_ledger_src;")

echo "[ledger-parity] iceberg=${ICE}  postgres=${PG}"
if [ "$ICE" != "$PG" ]; then
  echo "[ledger-parity] DRIFT — Iceberg revenue_ledger != Postgres. Re-run run-ledger-bronze-refresh.sh before flipping/serving ledger_source=iceberg." >&2
  exit 1
fi
echo "[ledger-parity] OK — Iceberg revenue_ledger == Postgres (count + signed sum)."
