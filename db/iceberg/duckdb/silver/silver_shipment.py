"""
silver_shipment.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_shipment.py.

Folds the Silver transition log rest.brain_silver.silver_shipment_event to the LATEST shipment
state per order, writing rest.brain_silver.silver_shipment via an idempotent MERGE on the model PK
(brand_id, order_id). This is a TRUSTED same-tier PROJECTION: it reads NO raw Bronze and NO gated
keystone — it reads the Silver event log directly (which already ran its own Stage-1 DQ timestamp
gate at the transition grain), so no additional Stage-1 gate applies here.

RUN ORDER: silver_shipment_event.py BEFORE this job (the DuckDB or Spark producer — same Iceberg
table either way). This DuckDB port reads whichever produced brain_silver.silver_shipment_event.

FOLDED LOGIC (verbatim from the Spark SQL, 1:1 with dbt silver_shipment.sql):
  - events = silver_shipment_event.
  - ranked: row_number() over (partition by brand_id, order_id ORDER BY
      is_terminal DESC, status_changed_at DESC, occurred_at DESC, event_id DESC) — terminal-state wins,
      then latest status_changed_at (a STRING/varchar — lexical DESC, same as Spark), then latest
      occurred_at, then highest event_id (deterministic tie-break).
    first_event_at = min(occurred_at) over (partition by brand_id, order_id).
  - latest row per (brand_id, order_id): _win_rn == 1, projecting:
      current_status = status, is_rto = (terminal_class='rto'), is_delivered = (terminal_class='delivered'),
      last_status_at = status_changed_at (STRING), + first_event_at + now() AS updated_at.

GRAIN : 1 row per (brand_id, order_id) — latest shipment state per order. brand_id tenant key.
PII   : none raw — awb_number_hash already hashed.  MONEY: none (this mart carries no money).
last_status_at is a STRING (varchar) — it carries status_changed_at verbatim.
updated_at = now() (current_timestamp() in Spark) — a run-clock column, excluded from parity.

CAVEAT — no Stage-1 quarantine side-write applies (this is a trusted projection off the already-gated
event log), so there is nothing to skip; matches the framework's convention. The source is already
1 row per (brand_id, event_id), and the _win_rn=1 fold yields exactly 1 row per (brand_id, order_id),
so merge_on_pk's in-batch DESC re-dedup is a no-op here.

Parity target: brain_silver.silver_shipment.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, incremental_window, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_shipment_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# Upstream Silver transition log (produced by silver_shipment_event). Read directly — same tier.
EVENT_TABLE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_shipment_event"

# Canonical Silver column contract — mirrors brain_silver.silver_shipment column-for-column.
# last_status_at is a STRING (varchar) — it carries status_changed_at, a string.
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  order_id         string    NOT NULL,
  source           string,
  awb_number_hash  string,
  courier          string,
  current_status   string,
  terminal_class   string,
  is_terminal      boolean,
  is_rto           boolean,
  is_delivered     boolean,
  payment_method   string,
  pincode          string,
  first_event_at   timestamp,
  last_status_at   string,
  is_synthetic     boolean,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "source", "awb_number_hash", "courier", "current_status",
    "terminal_class", "is_terminal", "is_rto", "is_delivered", "payment_method", "pincode",
    "first_event_at", "last_status_at", "is_synthetic", "updated_at",
]


def build(con):
    # Latest-state grain has no NOT-NULL event-time col across the grain; partition by brand bucket +
    # day(first_event_at) (always present for any order with events) — matches the Spark partitioning.
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(first_event_at)")

    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GRAIN = entity_fold: MANY silver_shipment_event transition rows collapse to ONE (brand_id, order_id)
    #   row whose value (terminal-wins ranking + min(occurred_at)) depends on events that may sit BELOW the
    #   watermark. So we MUST NOT window the fold input directly (that would silently drop history → a
    #   partial, wrong shipment state). Instead: use the [lo,hi) window ONLY to discover the CHANGED order
    #   keys, then re-fold each changed order over its FULL history.
    #
    #   The source silver_shipment_event has NO `ingested_at` column (see its COLUMNS_SQL: only occurred_at
    #   + a `now()` run-clock `updated_at`). Its physical arrival/change key is `updated_at` — every re-landed
    #   or new transition row gets a fresh now() on write — so the watermark tracks max(updated_at) with the
    #   framework's trailing lookback (a slightly-late write can never be skipped; the idempotent MERGE dedups
    #   the re-scanned overlap). This mirrors the keystone using kafka_timestamp because its source likewise
    #   lacked ingested_at. Default OFF (lo=None) → NO changed-set, NO semi-join → byte-identical full re-fold.
    lo, hi = incremental_window(con, "silver-shipment", EVENT_TABLE, ts_col="updated_at")
    win = []
    if lo is not None:
        win.append(f"updated_at >= '{lo}'")
    if hi is not None:
        win.append(f"updated_at <= '{hi}'")
    src_window = f"WHERE {' AND '.join(win)}" if win else ""

    # CHANGED-KEY set: the (brand_id, order_id) entity keys whose event log changed in [lo,hi). Uses the SAME
    # key derivation the fold groups on (PARTITION BY brand_id, order_id — no extra not-null guard, matching
    # the fold exactly). Empty string / never referenced when lo is None (default OFF).
    changed = (
        f"SELECT DISTINCT brand_id, order_id FROM {EVENT_TABLE} {src_window}"
    )

    # The fold reads the FULL, UNWINDOWED source; when incremental is on, a semi-join narrows it to ONLY the
    # changed orders so each re-folds over its COMPLETE history. When lo is None the extra predicate is
    # absent → byte-identical full scan.
    fold_source = EVENT_TABLE
    if lo is not None:
        fold_source = (
            f"(SELECT * FROM {EVENT_TABLE} "
            f"WHERE (brand_id, order_id) IN (SELECT brand_id, order_id FROM ({changed})))"
        )

    # ranked: terminal-state wins, then latest status_changed_at (STRING lexical DESC), then latest
    # occurred_at, then highest event_id. first_event_at = min(occurred_at) over the order partition.
    ranked = f"""
      SELECT *,
             row_number() OVER (
               PARTITION BY brand_id, order_id
               ORDER BY is_terminal        DESC,
                        status_changed_at  DESC,
                        occurred_at        DESC,
                        event_id           DESC
             ) AS _win_rn,
             min(occurred_at) OVER (PARTITION BY brand_id, order_id) AS first_event_at
      FROM {fold_source}
    """

    staged = f"""
      SELECT
        brand_id,
        order_id,
        source,
        awb_number_hash,
        courier,
        status                         AS current_status,
        terminal_class,
        is_terminal,
        (terminal_class = 'rto')       AS is_rto,
        (terminal_class = 'delivered') AS is_delivered,
        payment_method,
        pincode,
        first_event_at,
        status_changed_at              AS last_status_at,
        is_synthetic,
        now()                          AS updated_at
      FROM ({ranked})
      WHERE _win_rn = 1
    """

    # PK (brand_id, order_id). Source is already 1 row per PK (the _win_rn=1 filter), so merge_on_pk's
    # in-batch DESC re-dedup is a no-op. order_by_desc kept for framework-shape consistency.
    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "order_id"],
                       order_by_desc=["first_event_at"])


if __name__ == "__main__":
    # Source is the same-tier Silver event log (NOT the gated keystone); its physical change key is
    # `updated_at` (no ingested_at column exists on silver_shipment_event) — the watermark tracks that.
    run_job(
        "silver-shipment", build, target_table="silver_shipment",
        source_table=EVENT_TABLE, ts_col="updated_at",
    )
