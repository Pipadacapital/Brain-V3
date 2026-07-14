"""
gold_marketing_attribution.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_marketing_attribution.py.

Brain V4 Phase-2 GROUP attribution mart (dbt predecessor gold_marketing_attribution.sql = a thin VIEW over
brain_gold.gold_attribution_credit). This job MATERIALIZES the identical projection over the Iceberg
brain_gold.gold_attribution_credit (the SIGNED credit ledger owned by the attribution group — ported
SEPARATELY; read it DIRECTLY, may be EMPTY / absent) — one row per (brand_id, credit_id) with the SAME
columns + casts (touch_seq→int, credited_revenue_minor/realized_revenue_minor→bigint, attribution_confidence
kept as the numeric string) WHERE credit_id IS NOT NULL. Writes Iceberg brain_gold.gold_marketing_attribution
via MERGE on the PK (brand_id, credit_id).

MONEY (I-S07): credited_revenue_minor (SIGNED: +credit / -clawback) + realized_revenue_minor are bigint
MINOR units paired with currency_code — carried VERBATIM from the credit ledger (NO re-derivation; a pure
projection, so per-(brand,currency) Σ equals the credit ledger's exactly, zero drift). brand_id first.

CAVEAT — credit ledger ported separately: this reads {CATALOG}.brain_gold.gold_attribution_credit. In the
current corpus that mart is EMPTY or ABSENT. Absent → this job's read raises; we probe first and, if absent,
still CREATE the empty target and exit clean (the Spark job SystemExits on absence — here we write an empty
mart, matching the honest-empty parity oracle 0). When PRESENT-but-empty the projection yields 0 rows.

QUARANTINE: none — a pure projection over already-gated Gold has no Stage-1/quarantine side-write; the
  DuckDB framework never writes a quarantine table either. Nothing to skip.

DATA NOTE: parity oracle = 0 rows (the live StarRocks VIEW over an empty credit ledger). This writes a
  correct EMPTY mart today; it populates with no code change once the credit ledger fills.

Honors MIGRATION_TABLE_SUFFIX (→ gold_marketing_attribution_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_marketing_attribution.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_marketing_attribution_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TABLE = "gold_marketing_attribution"
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# The SIGNED credit ledger (owned/ported by the attribution group). This mart is its pure projection.
SRC_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_attribution_credit"

# Column contract — the dbt gold_marketing_attribution VIEW select list (the metric-engine read shape).
COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  credit_id              string    NOT NULL,
  order_id               string,
  brain_anon_id          string,
  touch_seq              int,
  channel                string,
  campaign_id            string,
  model_id               string,
  row_kind               string,
  credited_revenue_minor bigint,
  currency_code          string,
  realized_revenue_minor bigint,
  reversed_of_credit_id  string,
  confidence_grade       string,
  attribution_confidence string,
  model_version          string,
  occurred_at            timestamp,
  economic_effective_at  timestamp,
  billing_posted_period  string,
  updated_at             timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "credit_id", "order_id", "brain_anon_id", "touch_seq", "channel",
    "campaign_id", "model_id", "row_kind", "credited_revenue_minor", "currency_code",
    "realized_revenue_minor", "reversed_of_credit_id", "confidence_grade",
    "attribution_confidence", "model_version", "occurred_at", "economic_effective_at",
    "billing_posted_period", "updated_at",
]

PK = ["brand_id", "credit_id"]


def _source_exists(con) -> bool:
    """True iff gold_attribution_credit exists. Absent → still create the empty target and exit clean
    (parity: both sides row-count 0). The Spark job SystemExits on absence; we degrade to an empty mart."""
    try:
        con.execute(f"SELECT 1 FROM {SRC_TABLE} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent credit ledger → write an empty Gold mart, exit clean
        return False


def build(con):
    # brand-first tenant partitioning (mirrors the Spark bucket(8, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id)")

    # If the credit ledger is absent, the empty target is already created — nothing to MERGE. Exit clean.
    if not _source_exists(con):
        print(f"[gold-marketing-attribution] source {SRC_TABLE} absent — wrote empty {TABLE}, exiting",
              flush=True)
        return 0

    # The dbt VIEW projection (same columns, same casts, credit_id IS NOT NULL filter), byte-for-byte the
    # Spark .select(...). touch_seq→INT, credited/realized→BIGINT; attribution_confidence stays the string.
    staged = f"""
        SELECT
            brand_id,
            credit_id,
            order_id,
            brain_anon_id,
            CAST(touch_seq AS INTEGER)              AS touch_seq,
            channel,
            campaign_id,
            model_id,
            row_kind,
            CAST(credited_revenue_minor AS BIGINT)  AS credited_revenue_minor,
            currency_code,
            CAST(realized_revenue_minor AS BIGINT)  AS realized_revenue_minor,
            reversed_of_credit_id,
            confidence_grade,
            attribution_confidence,
            model_version,
            occurred_at,
            economic_effective_at,
            billing_posted_period,
            now() AT TIME ZONE 'UTC'                AS updated_at
        FROM {SRC_TABLE}
        WHERE credit_id IS NOT NULL
    """

    # Pure projection is already 1 row per credit_id, so merge_on_pk's in-batch dedup is a no-op;
    # order_by_desc=[updated_at] is just a deterministic tie-break. MATCHED-UPDATE / NOT-MATCHED-INSERT.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-marketing-attribution", build, target_table=TABLE)
