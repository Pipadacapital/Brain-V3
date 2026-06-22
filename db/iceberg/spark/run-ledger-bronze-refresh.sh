#!/usr/bin/env bash
# run-ledger-bronze-refresh.sh — DB-AUDIT H2: the scheduled ledger→Bronze refresh.
# Re-materializes BOTH worker-written ledgers from Postgres into Iceberg Bronze (idempotent MERGEs):
#   billing.realized_revenue_ledger   → brain_bronze.revenue_ledger
#   billing.attribution_credit_ledger → brain_bronze.attribution_credit
# This is the freshness mechanism behind gold's ledger_source='iceberg' (the Argo CronWorkflow target
# in prod; run on-demand in dev). After it runs, rebuild the dbt marts to pick up new rows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "[ledger-bronze-refresh] 1/2 revenue ledger →  Iceberg"
bash "${SCRIPT_DIR}/run-revenue-ledger-materialize.sh"
echo "[ledger-bronze-refresh] 2/2 attribution credit → Iceberg"
bash "${SCRIPT_DIR}/run-attribution-credit-materialize.sh"
echo "[ledger-bronze-refresh] done — now rebuild gold: dbt build --select gold_revenue_ledger gold_marketing_attribution"
