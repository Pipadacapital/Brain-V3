"""
snap_attribution_credit.py (DuckDB) — faithful port of db/iceberg/spark/gold/snap_attribution_credit.py.

The daily attribution-result history SNAPSHOT — one row per (brand_id, credit_id, snapshot_date) capturing
the credit-as-of each date, so attribution can be reproduced as-of a report date and compared across model
versions over time. Reproduces db/dbt/models/marts/snap_attribution_credit.sql EXACTLY.

NAMESPACE: snap_attribution_credit is a brain_SILVER mart (the dbt model is config schema='brain_silver'),
  even though it lives in the attribution group and reads the gold credit projection — so, like the Spark
  job, this WRITES to the brain_silver namespace (NOT brain_gold), honoring MIGRATION_TABLE_SUFFIX.

SOURCE (pure Iceberg read): {CATALOG}.brain_gold.gold_marketing_attribution — the dbt ref() source (the
  Iceberg projection over gold_attribution_credit built by gold_marketing_attribution.py — ported
  separately). In the current corpus this source is EMPTY (0 rows) → the snapshot is honest-empty too.
  The Spark job SystemExits if the source TABLE is ABSENT; we mirror that with a probe (absent → still
  CREATE the empty target and exit clean, matching the honest-empty parity oracle of 0).

THE TRANSFORM (folded from the dbt model — the exact select list):
  from gold_marketing_attribution:
    brand_id, credit_id, current_date() as snapshot_date, order_id, channel, campaign_id, model_id,
    model_version, row_kind, credited_revenue_minor, currency_code, confidence_grade, occurred_at,
    current_timestamp() as computed_at

MONEY (I-S07): credited_revenue_minor is SIGNED bigint MINOR units paired with currency_code — carried
  VERBATIM from the gold credit projection (NO re-derivation → per-(brand,currency) Σ for a given
  snapshot_date equals the gold ledger's exactly). brand_id is the first column / tenant key.

SPARK→DUCKDB SQL TRANSLATIONS:
  - current_date()        → current_date  (UTC session → same run-date as Spark / dbt).
  - current_timestamp()   → now() AT TIME ZONE 'UTC'.
  - credited_revenue_minor.cast("bigint")  → CAST(... AS BIGINT).

WRITE: idempotent same-day upsert via _base.merge_on_pk on the PK (brand_id, credit_id, snapshot_date) — the
  dbt incremental default-strategy semantic (prior days preserved; same-day re-run overwrites that day's
  snapshot). The source is 1 row per credit_id, so within a run it is 1 row per PK — the in-batch dedup is a
  stable no-op (order_by computed_at is a deterministic tie-break).

QUARANTINE: none — a snapshot projection over already-gated Gold has no Stage-1/quarantine side-write.

PARITY: current side = StarRocks/Spark brain_silver.snap_attribution_credit. With 0 credit rows in the source
  ledger the snapshot is also empty → parity-exact at 0. snapshot_date = current_date() is RUN-DATE-dependent
  — run same-day so the PK's snapshot_date matches once the ledger fills.

Parity target: brain_silver.snap_attribution_credit (0 rows — honest-empty). PK (brand_id, credit_id,
  snapshot_date); money column credited_revenue_minor.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "snap_attribution_credit"
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
# snap_attribution_credit is a brain_SILVER mart (config schema='brain_silver').
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{_SUFFIX}"

# The dbt ref() source (a gold projection) — read DIRECTLY; may be EMPTY / absent.
SRC_TABLE = f"{CATALOG}.{GOLD_NAMESPACE}.gold_marketing_attribution"

PK = ["brand_id", "credit_id", "snapshot_date"]

# Column contract — the dbt snap_attribution_credit select list. brand_id first; PK adds snapshot_date.
COLUMNS_SQL = """
  brand_id               string    NOT NULL,
  credit_id              string    NOT NULL,
  snapshot_date          date      NOT NULL,
  order_id               string,
  channel                string,
  campaign_id            string,
  model_id               string,
  model_version          string,
  row_kind               string,
  credited_revenue_minor bigint,
  currency_code          string,
  confidence_grade       string,
  occurred_at            timestamp,
  computed_at            timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "credit_id", "snapshot_date", "order_id", "channel", "campaign_id", "model_id",
    "model_version", "row_kind", "credited_revenue_minor", "currency_code", "confidence_grade",
    "occurred_at", "computed_at",
]


def _source_exists(con) -> bool:
    """True iff gold_marketing_attribution exists. Absent → still create the empty target and exit clean
    (the Spark job SystemExits on absence; we degrade to an honest-empty snapshot — parity oracle is 0)."""
    try:
        con.execute(f"SELECT 1 FROM {SRC_TABLE} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source ledger → write an empty snapshot, exit clean
        return False


def build(con):
    # brand-first tenant bucketing + day-partition on the snapshot grain (mirrors the Spark bucket(8,
    # brand_id), days(snapshot_date)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id), day(snapshot_date)")

    if not _source_exists(con):
        print(f"[snap-attribution-credit] source {SRC_TABLE} absent — wrote empty {TABLE}, exiting",
              flush=True)
        return 0

    # The dbt snapshot projection: run-date stamp + pass-through credit (credited_revenue_minor cast bigint).
    staged = f"""
        SELECT
            brand_id,
            credit_id,
            current_date                          AS snapshot_date,
            order_id,
            channel,
            campaign_id,
            model_id,
            model_version,
            row_kind,
            CAST(credited_revenue_minor AS BIGINT) AS credited_revenue_minor,
            currency_code,
            confidence_grade,
            occurred_at,
            now() AT TIME ZONE 'UTC'              AS computed_at
        FROM {SRC_TABLE}
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["computed_at"])


if __name__ == "__main__":
    run_job("snap-attribution-credit", build, target_table=TABLE)
