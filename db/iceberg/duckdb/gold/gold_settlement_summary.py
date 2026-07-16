"""
gold_settlement_summary.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_settlement_summary.py.

NET-NEW gap Gold mart (Brain V4 Phase 2, GROUP "NEW gap Gold products"). NO dbt predecessor
(parity status=NEW). The materialized settlement (net-of-fees) surface — one row per
(brand_id, currency_code) holding gross recognized credit, total fees + tax, net settled, and the
refund/dispute deductions, read from Iceberg brain_silver.silver_settlement DIRECTLY (exactly like
the Spark job reads it via silver()). This is the Gold materialization of the TS
computeSettlementSummary signal (settlement-summary.ts), aggregated to the brand/currency grain.

Sign + component model (mirrors the TS settlement taxonomy, reproduced on the Silver entity grain):
  silver_settlement carries POSITIVE-magnitude amount_minor / fee_minor / tax_minor per item,
  discriminated by entity_type (settlement / payment / refund / dispute / …). We reconstruct the TS
  gross/net/fee model, verbatim from the Spark staged CTE:
    gross_minor   = Σ amount_minor of the CREDIT items (recognized inflow), per currency.
    fee_minor     = Σ fee_minor of those items   (POSITIVE magnitude — MDR processing fees).
    tax_minor     = Σ tax_minor of those items   (POSITIVE magnitude — GST on MDR, separate from fee).
    refund_minor  = Σ amount_minor of refund items (POSITIVE magnitude — settlement reversals).
    dispute_minor = Σ amount_minor of dispute items (POSITIVE magnitude — chargeback deductions).
    net_minor     = gross − fee − tax − refund − dispute  (net settled cash; integer minor math).

Per-currency (NEVER blend currencies). All money bigint MINOR units; net is integer arithmetic over
the per-currency component sums (no float, no cross-currency add). brand_id is the tenant key, first
column + partition anchor.

GRAIN / PK : 1 row per (brand_id, currency_code). currency_code = COALESCE(currency_code, 'INR').
REPLAY-SAFE: full recompute from Silver, MERGE-UPDATE'd on (brand_id, currency_code). Idempotent.

CAVEAT — orphan-shedding: the Spark job passes delete_orphans=True (WHEN NOT MATCHED BY SOURCE DELETE)
so a full per-brand recompute sheds a disappeared group's Gold row. The DuckDB _base.merge_on_pk does
NOT implement a not-matched-by-source DELETE — this port is a MATCHED-UPDATE / NOT-MATCHED-INSERT MERGE
only. For the parallel-run parity harness (fresh <table>_duckdb_test built from the same Silver) the
admission set is identical; the divergence only exists after an upstream group disappears from Silver
between runs. Noted, not silently dropped.

QUARANTINE : the Spark job has NO Stage-1/quarantine side-write here (reads already-gated Silver).
             This framework has none either — nothing to skip.

DATA NOTE: current Bronze has ZERO settlement.live.v1 → silver_settlement is empty (or absent) → this
writes a correct EMPTY Gold mart today; it populates with no code change once a Razorpay settlement
connector syncs. If silver_settlement is ABSENT the job still creates the empty target and exits clean.

Honors MIGRATION_TABLE_SUFFIX (→ gold_settlement_summary_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_settlement_summary.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_settlement_summary_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_settlement_summary"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_SETTLEMENT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_settlement"

# Credit (recognized inflow) entity types vs the deduction lanes (the TS gross-credit vs fee/reversal
# split, expressed over the silver_settlement entity_type discriminant) — verbatim from the Spark job.
CREDIT_TYPES = "('settlement', 'payment', 'order_paid', 'payment_authorized', 'settlement_finalization', 'rolling_reserve_release')"
REFUND_TYPES = "('refund', 'settlement_reversal')"
DISPUTE_TYPES = "('dispute', 'chargeback')"

# Mirrors the Spark COLUMNS_SQL order/types exactly. brand_id tenant key first; money = bigint minor +
# currency_code sibling.
COLUMNS_SQL = """
  brand_id        string    NOT NULL,
  currency_code   string    NOT NULL,
  settlements     bigint    NOT NULL,
  gross_minor     bigint    NOT NULL,
  fee_minor       bigint    NOT NULL,
  tax_minor       bigint    NOT NULL,
  refund_minor    bigint    NOT NULL,
  dispute_minor   bigint    NOT NULL,
  net_minor       bigint    NOT NULL,
  updated_at      timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "currency_code", "settlements", "gross_minor", "fee_minor",
    "tax_minor", "refund_minor", "dispute_minor", "net_minor", "updated_at",
]

PK = ["brand_id", "currency_code"]


def _source_exists(con) -> bool:
    """True iff silver_settlement exists. An ABSENT upstream table would raise on read; we probe so the
    job still creates the empty Gold mart and exits cleanly (parity: both sides row-count 0)."""
    try:
        con.execute(f"SELECT 1 FROM {SILVER_SETTLEMENT} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent Silver table → write an empty Gold mart, exit clean
        return False


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(64, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # If silver_settlement is absent, the empty target is already created — nothing to MERGE. Exit clean.
    if not _source_exists(con):
        print(f"[gold-settlement-summary] source {SILVER_SETTLEMENT} absent — wrote empty {TABLE}, exiting",
              flush=True)
        return 0

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ENTITY REFOLD ─────────────────────────
    #   GRAIN = entity_fold: MANY silver_settlement rows aggregate into ONE (brand_id, currency_code) row
    #   whose gross/fee/tax/refund/dispute/net totals depend on that entity's FULL settlement history —
    #   including rows BELOW the watermark. Windowing the fold input directly would silently drop history →
    #   wrong settled money. So we window ONLY to DISCOVER which (brand_id, currency_code) entities changed
    #   (a new settlement item landed since the last run), then re-fold each changed entity over its FULL,
    #   UNWINDOWED settlement history. The MERGE on the PK upserts exactly those restated rollups. The
    #   fold-driving source is silver_settlement; its arrival clock is ingested_at (per-event Silver mart).
    #   Gold flips INDEPENDENTLY of Silver via enabled=GOLD_INCREMENTAL. Default OFF / first run /
    #   FULL_REFRESH → lo=None → NO changed-set, NO semi-join → the SQL below is BYTE-IDENTICAL to the
    #   pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-settlement-summary", SILVER_SETTLEMENT,
                                ts_col="ingested_at", enabled=GOLD_INCREMENTAL)

    # Window predicate as an EMPTY string when lo is None (byte-identical full scan); a [lo, hi] range over
    # silver_settlement's arrival clock otherwise. Same brand_id-NOT-NULL guard the fold uses.
    win = []
    if lo is not None:
        win.append(f"ingested_at >= '{lo}'")
    if hi is not None:
        win.append(f"ingested_at <= '{hi}'")
    settlement_window = f" AND {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: entities whose settlement rows changed within [lo, hi], using the SAME entity-key
    # derivation (brand_id, COALESCE(currency_code, 'INR')) + brand_id-NOT-NULL guard the fold uses. Built
    # ONLY when incremental (lo not None).
    changed = f"""
        SELECT DISTINCT brand_id, COALESCE(currency_code, 'INR') AS currency_code
        FROM {SILVER_SETTLEMENT}
        WHERE brand_id IS NOT NULL{settlement_window}
    """

    # Semi-join clause: when incremental, restrict the FULL-history fold to only the changed entities so
    # each re-folds over its ENTIRE settlement history. EMPTY when lo is None → unwindowed full recompute.
    # Applied on the SAME derived key (brand_id, COALESCE(currency_code, 'INR')) the GROUP BY uses.
    refold_filter = (
        f"              AND (brand_id, COALESCE(currency_code, 'INR')) IN "
        f"(SELECT brand_id, currency_code FROM ({changed}))\n"
        if lo is not None else ""
    )

    # Faithful SQL port of the Spark staged CTE. Per-currency component sums over the silver_settlement
    # entity_type discriminant, then net = gross − fee − tax − refund − dispute (integer minor units;
    # per-currency; no float; NEVER blended across currencies).
    staged = f"""
        WITH agg AS (
            SELECT
                brand_id,
                COALESCE(currency_code, 'INR')                                                       AS currency_code,
                COUNT(*)                                                                             AS settlements,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type, '') IN {CREDIT_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS gross_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type, '') IN {CREDIT_TYPES}
                                  THEN COALESCE(fee_minor, 0) ELSE 0 END), 0)                        AS fee_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type, '') IN {CREDIT_TYPES}
                                  THEN COALESCE(tax_minor, 0) ELSE 0 END), 0)                        AS tax_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type, '') IN {REFUND_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS refund_minor,
                COALESCE(SUM(CASE WHEN COALESCE(entity_type, '') IN {DISPUTE_TYPES}
                                  THEN COALESCE(amount_minor, 0) ELSE 0 END), 0)                     AS dispute_minor
            FROM {SILVER_SETTLEMENT}
            WHERE brand_id IS NOT NULL
{refold_filter}            GROUP BY brand_id, COALESCE(currency_code, 'INR')
        )
        SELECT
            brand_id,
            currency_code,
            CAST(settlements   AS BIGINT)                                                  AS settlements,
            CAST(gross_minor   AS BIGINT)                                                  AS gross_minor,
            CAST(fee_minor     AS BIGINT)                                                  AS fee_minor,
            CAST(tax_minor     AS BIGINT)                                                  AS tax_minor,
            CAST(refund_minor  AS BIGINT)                                                  AS refund_minor,
            CAST(dispute_minor AS BIGINT)                                                  AS dispute_minor,
            -- Net = gross − fee − tax − refund − dispute (integer minor units; per-currency; no float).
            CAST(gross_minor - fee_minor - tax_minor - refund_minor - dispute_minor AS BIGINT) AS net_minor,
            now()                                                                          AS updated_at
        FROM agg
    """

    # The rollup is already 1 row per PK (GROUP BY upstream), so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    # The watermark tracks the settlement source's arrival clock (silver_settlement.ingested_at), NOT the
    # gated keystone default — this Gold job folds a sibling Silver mart directly.
    run_job("gold-settlement-summary", build, target_table=TABLE,
            source_table=SILVER_SETTLEMENT, ts_col="ingested_at")
