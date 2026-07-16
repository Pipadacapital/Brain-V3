"""
gold_customer_scores.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_customer_scores.py.

GOLD mart (not a Bronze/keystone read): READS the sibling Silver Iceberg table
{CATALOG}.brain_silver.silver_customer directly and rolls it up to the deterministic (NOT ML)
RFM + churn-risk customer scoring mart {CATALOG}.brain_gold.gold_customer_scores via an idempotent
MERGE on the mart PK. ONE row per (brand_id, brain_id) with transparent, rule-based
recency/frequency/monetary tiers + a churn-risk band.

THE TRANSFORM (Brain V4 — features are RUNTIME, not a precompute table; reproduced verbatim from the
Spark materialize(), itself the retired dbt gold_customer_scores.sql):
  In V4 there is NO permanent feature-precompute table. The "latest customer snapshot per customer" IS
  today's silver_customer projection, so this job FOLDS that feature snapshot INLINE from the Iceberg
  silver_customer spine at runtime (identical formulae), then applies the scoring:
        snapshot_date         = current_date()
        days_since_last_order = datediff(current_date(), cast(last_seen_at as date))
        (+ lifetime_orders / lifetime_value_minor / currency_code carried verbatim from silver_customer)
        scored_on             = snapshot_date  (= current_date())
        recency_score   ∈ 1..5 by days_since_last_order  (≤30→5, ≤60→4, ≤90→3, ≤180→2, else 1)
        frequency_score ∈ 1..5 by lifetime_orders        (≥10→5, ≥5→4, ≥3→3, ≥2→2, else 1)
        monetary_score  ∈ 1..5 by lifetime_value_minor   (≥1e7→5, ≥5e6→4, ≥1e6→3, ≥2e5→2, else 1)
        churn_risk      ∈ {high (>180d), medium (>90d), low}
        data_source     = 'live'
        computed_at     = current_timestamp()

  WHY runtime-fold-from-silver: on a single-snapshot-per-day grain, "today's latest feature snapshot per
  customer" IS today's silver_customer projection — point-in-time-correct (money columns carried verbatim;
  no re-derivation → no rounding). This is the V4 rule: features are computed at runtime from the Silver
  spine, never read from a permanent precompute DB.

DATE MATH (Spark → DuckDB): Spark datediff(end, start) = whole-day (end − start). DuckDB uses
  date_diff('day', start, end) — note the ARGUMENT ORDER flips (start first, end second) so the sign
  matches. current_date() → current_date; current_timestamp() → now() AT TIME ZONE 'UTC' (UTC session).
  Both engines truncate last_seen_at to a plain DATE before the diff, so a same-instant timestamptz yields
  the identical whole-day count.

GRAIN / PK: exactly one row per (brand_id, brain_id) — the mart PK, matching the Spark mart EXACTLY.
MONEY (I-S07): lifetime_value_minor is a descriptive bigint MINOR field carried VERBATIM from
  silver_customer (never a float; no re-derivation), paired with currency_code on-row. The scores
  (recency/frequency/monetary/churn) are non-money tiers. brand_id is the tenant key, first column.
  The parity oracle treats this mart as row-identity only (registry money_columns=[]).

FULL RECOMPUTE vs Spark's gold_partition_filter: the Spark job wraps the identical fold in
  gold_partition_filter (a SCALING optimization — recompute only brands whose silver_customer changed
  since the watermark, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent:
  the MERGE on the mart PK is idempotent and restates every (brand_id, brain_id) to the current
  silver_customer snapshot.

QUARANTINE: none — this Gold rollup has no Stage-1/quarantine side-write (it reads already-gated Silver).
VENDORED: nothing — the Spark job uses only pyspark built-in functions (no pure helper module), so the
  DuckDB port is pure SQL; no module is copied into duckdb/gold/.

Parity target: brain_gold.gold_customer_scores (3799 rows). PK (brand_id, brain_id).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import GOLD_INCREMENTAL, ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parallel-run parity harness write to gold_customer_scores_duckdb_test
# instead of the live mart (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.gold_customer_scores{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"
SOURCE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_customer"

# Column contract — byte-for-byte the Spark mart's _COLUMNS. brand_id tenant key first; money =
# bigint minor + currency. Uses Iceberg/Spark type names (ensure_table maps them).
COLUMNS_SQL = """
  brand_id              string    NOT NULL,
  brain_id              string    NOT NULL,
  currency_code         string,
  scored_on             date,
  lifetime_orders       bigint,
  lifetime_value_minor  bigint,
  days_since_last_order int,
  recency_score         int,
  frequency_score       int,
  monetary_score        int,
  churn_risk            string,
  data_source           string    NOT NULL,
  computed_at           timestamp
""".strip("\n")

COLUMNS = [
    "brand_id", "brain_id", "currency_code", "scored_on", "lifetime_orders", "lifetime_value_minor",
    "days_since_last_order", "recency_score", "frequency_score", "monetary_score", "churn_risk",
    "data_source", "computed_at",
]

PK = ["brand_id", "brain_id"]


def build(con):
    # brand-first tenant bucketing (mirrors the Spark bucket(8, brand_id) hidden partitioning).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(8, brand_id)")

    # ── INCREMENTAL WINDOW (opt-in; GOLD_INCREMENTAL=1) — CHANGED-ROW READ ─────────────────────────────
    #   GRAIN = per_row: silver_customer is already ONE row per (brand_id, brain_id) and this job maps each
    #   source row to EXACTLY ONE output row (no cross-row fold; the scoring is a pure per-row projection).
    #   So we window the SOURCE READ directly on silver_customer's arrival/write clock to read only the rows
    #   that changed since the last run; the idempotent MERGE on the mart PK restates exactly those.
    #   CLOCK: silver_customer has NO ingested_at (it's an entity Silver mart, not a per-event mart); its
    #   arrival clock is updated_at — the NOW()-stamped write clock set on every re-fold — so ts_col
    #   ='updated_at' means "which customer rows were (re)written since last run". enabled=GOLD_INCREMENTAL
    #   flips the Gold tier INDEPENDENTLY of Silver.
    #   Default OFF / first run / FULL_REFRESH → lo=None → src_window is the EMPTY string → the SQL below is
    #   BYTE-IDENTICAL to the pre-incremental full recompute.
    lo, hi = incremental_window(con, "gold-customer-scores", SOURCE, ts_col="updated_at",
                                enabled=GOLD_INCREMENTAL)
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    src_window = f"\n      WHERE {' AND '.join(win)}" if win else ""

    # ── The runtime feature fold + RFM/churn scoring, reproduced verbatim from the Spark materialize().
    #    days_since_last_order = date_diff('day', last_seen_at::date, current_date) — Spark
    #    datediff(current_date, last_seen_at) with the DuckDB (start, end) argument order. The score
    #    CASE ladders are the identical thresholds; churn from the same day bands. ──
    scored = f"""
      SELECT
        brand_id,
        brain_id,
        currency_code,
        current_date                                                        AS scored_on,
        lifetime_orders,
        lifetime_value_minor,
        date_diff('day', CAST(last_seen_at AS DATE), current_date)          AS days_since_last_order,
        CAST(
          CASE
            WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) <= 30  THEN 5
            WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) <= 60  THEN 4
            WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) <= 90  THEN 3
            WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) <= 180 THEN 2
            ELSE 1
          END AS INTEGER)                                                   AS recency_score,
        CAST(
          CASE
            WHEN lifetime_orders >= 10 THEN 5
            WHEN lifetime_orders >= 5  THEN 4
            WHEN lifetime_orders >= 3  THEN 3
            WHEN lifetime_orders >= 2  THEN 2
            ELSE 1
          END AS INTEGER)                                                   AS frequency_score,
        CAST(
          CASE
            WHEN lifetime_value_minor >= 10000000 THEN 5
            WHEN lifetime_value_minor >= 5000000  THEN 4
            WHEN lifetime_value_minor >= 1000000  THEN 3
            WHEN lifetime_value_minor >= 200000   THEN 2
            ELSE 1
          END AS INTEGER)                                                   AS monetary_score,
        CASE
          WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) > 180 THEN 'high'
          WHEN date_diff('day', CAST(last_seen_at AS DATE), current_date) > 90  THEN 'medium'
          ELSE 'low'
        END                                                                 AS churn_risk,
        CAST('live' AS VARCHAR)                                             AS data_source,
        now() AT TIME ZONE 'UTC'                                            AS computed_at
      FROM {SOURCE}{src_window}
    """

    # Idempotent MERGE on the (brand_id, brain_id) PK — replay-safe restatement. silver_customer is
    # already one row per (brand_id, brain_id), so the in-batch dedup order_by is a stable no-op tie-break.
    return merge_on_pk(con, TARGET, scored, COLUMNS, PK,
                       order_by_desc=["computed_at", "lifetime_orders"])


if __name__ == "__main__":
    # The watermark tracks silver_customer's write clock (updated_at) — this Gold mart reads the sibling
    # Silver mart, not the gated keystone default; and there is NO ingested_at on silver_customer.
    run_job("gold-customer-scores", build, target_table="gold_customer_scores",
            source_table=SOURCE, ts_col="updated_at")
