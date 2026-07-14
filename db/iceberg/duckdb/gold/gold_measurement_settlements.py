# SPEC:C.2.2
"""
gold_measurement_settlements.py (DuckDB) — faithful port of
db/iceberg/spark/gold/gold_measurement_settlements.py.

The measurement engine's canonical APPEND-ONLY SETTLEMENTS fact (COD + gateway) at the
(brand_id, order_id, event_id) grain — money = BIGINT minor units + a sibling currency_code
(never blended, never a float). It is the measurement-namespace projection of the single settlement
fact brain_silver.silver_settlement (razorpay lane) to gross/fees/net with a canonical
settlement_batch_id + source_system/source_event_id lineage. It does NOT fork a second settlement copy
and does NOT touch the live gold_settlement_summary (brand×currency rollup) — additive.

SIGN/COMPONENT MODEL (per row, per-currency, integer minor, no float — verbatim from the Spark staged CTE):
  gross_minor = amount_minor          (the settled item's face value; native sign preserved on reversals).
  fees_minor  = fee_minor + tax_minor (MDR processing fee + GST-on-MDR — withheld by the gateway).
  net_minor   = gross_minor - fees_minor (the net cash actually settled to the brand).
  settlement_batch_id = settlement_id (the gateway's payout batch ref; opaque, not PII).

KEY/IDEMPOTENCY: merged on (brand_id, order_id, event_id) — order_id coalesced to '' so the merge key is
  never NULL (a settlement item may be batch-level, not order-linked). Idempotent re-run.

── PORT NOTES ───────────────────────────────────────────────────────────────────────────────────────────
  - Reads brain_silver.silver_settlement DIRECTLY (exactly like the Spark job via silver()); no payload
    json extraction here (the columns are already promoted on the Silver entity fact).
  - silver_exists(...) (Spark probes .schema) → _exists(...) probes with `LIMIT 0` (schema-only touch). A
    table that EXISTS but is EMPTY reads TRUE (its lane runs, yields 0 rows) — exactly Spark's probe; only a
    truly ABSENT table → FALSE, in which case the empty target is still created and the job exits clean.
  - current_timestamp() → now() AT TIME ZONE 'UTC' (UTC session set in _catalog.connect).
  - cast(x AS bigint) / coalesce(...,0) stays integer minor units end-to-end. No float touches money.
  - The Spark job uses a plain run_job (NOT entity_incremental) precisely so an EMPTY/ABSENT silver_settlement
    still ensures the Gold table exists (the delta driver's "ensure-table-on-empty" gap). A full recompute
    over the small settlement source is idempotent (MERGE UPDATE *) — this DuckDB full-scan recompute is
    parity-equivalent (MATCHED-UPDATE / NOT-MATCHED-INSERT; the Spark merge_on_pk passes no delete_orphans).

GRAIN / PK: exactly 1 row per (brand_id, order_id, event_id) — EXACT match to the Spark merge_on_pk
  ["brand_id","order_id","event_id"].
QUARANTINE: none — this Gold fact reads already-gated Silver; there is NO Stage-1/quarantine side-write in
  the Spark job to mirror (nothing to skip).
VENDORED HELPERS: none — the Spark job's only imports are the shared _gold_base helpers (ported here as the
  DuckDB _base/_catalog seam); it uses no PURE spark helper module, so nothing needs vendor-copying.

DATA NOTE: current Bronze has ZERO settlement.live.v1 → silver_settlement is empty (or absent) → this writes
  a correct EMPTY Gold fact today (HONEST-EMPTY); it populates with no code change once a razorpay settlement
  connector syncs. Spark oracle = 0 rows / possibly absent.

Honors MIGRATION_TABLE_SUFFIX (→ gold_measurement_settlements_duckdb_test) for the parallel-run parity
harness. Parity target: brain_gold.gold_measurement_settlements (0 rows / honest-empty).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_measurement_settlements"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_measurement_settlements_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_SETTLEMENT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_settlement"

# Mirrors the Spark COLUMNS_SQL order/types EXACTLY. brand_id tenant key first; money = BIGINT minor +
# currency_code sibling. occurred_at + updated_at NOT NULL (occurred_at is the event moment / partition
# anchor; updated_at is the write stamp).
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  order_id            string    NOT NULL,
  event_id            string    NOT NULL,
  settlement_batch_id string,
  entity_type         string,
  gross_minor         bigint    NOT NULL,
  fees_minor          bigint    NOT NULL,
  net_minor           bigint    NOT NULL,
  currency_code       string,
  reconciliation_type string,
  settled_at          timestamp,
  source_system       string,
  source_event_id     string,
  occurred_at         timestamp NOT NULL,
  ingested_at         timestamp,
  updated_at          timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "event_id", "settlement_batch_id", "entity_type",
    "gross_minor", "fees_minor", "net_minor", "currency_code", "reconciliation_type",
    "settled_at", "source_system", "source_event_id", "occurred_at", "ingested_at", "updated_at",
]

PK = ["brand_id", "order_id", "event_id"]


def _exists(con, fq: str) -> bool:
    """True iff the source table EXISTS (empty or not). Mirrors the Spark silver_exists (probes .schema): an
    existing-but-empty table returns True (its lane runs, yields 0 rows), only a truly ABSENT table → False.
    Probes with `LIMIT 0` (schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → False → write the empty Gold fact, exit clean
        return False


def build(con):
    # Spark partitions bucket(64, brand_id), days(occurred_at). DuckDB's Iceberg writer does not implement
    # the days() transform, so we keep the brand-bucket anchor only (physical layout only — no effect on the
    # rows/PK/parity). Matches the established DuckDB gold pattern (e.g. gold_measurement_refunds).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ABSENT upstream → the empty target is already created; nothing to MERGE. Exit clean (parity: both 0).
    if not _exists(con, SILVER_SETTLEMENT):
        print(f"[gold-measurement-settlements] source {SILVER_SETTLEMENT} absent — "
              f"wrote empty {TABLE}, exiting", flush=True)
        return 0

    # Faithful SQL port of the Spark staged projection. Per-row measurement-namespace projection of the
    # silver_settlement fact to gross/fees/net (integer minor units; per-currency; no float). settled_at ←
    # settlement_at; source_system ← coalesce(source,'razorpay'); source_event_id ← event_id.
    staged = f"""
        SELECT
            brand_id,
            coalesce(order_id, '')                                                          AS order_id,
            event_id,
            settlement_id                                                                   AS settlement_batch_id,
            entity_type,
            CAST(coalesce(amount_minor, 0) AS BIGINT)                                       AS gross_minor,
            CAST(coalesce(fee_minor, 0) + coalesce(tax_minor, 0) AS BIGINT)                 AS fees_minor,
            CAST(coalesce(amount_minor, 0)
                 - (coalesce(fee_minor, 0) + coalesce(tax_minor, 0)) AS BIGINT)             AS net_minor,
            currency_code,
            reconciliation_type,
            settlement_at                                                                   AS settled_at,
            coalesce(source, 'razorpay')                                                    AS source_system,
            event_id                                                                        AS source_event_id,
            occurred_at,
            ingested_at,
            now() AT TIME ZONE 'UTC'                                                         AS updated_at
        FROM {SILVER_SETTLEMENT}
        WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
    """

    # Full-recompute MERGE on (brand_id, order_id, event_id). In-batch dedup keeps latest-ingested-wins (a
    # re-pull can emit the same PK twice). MATCHED-UPDATE / NOT-MATCHED-INSERT (no orphan-shedding — matches
    # the Spark merge_on_pk, which passes no delete_orphans).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("gold-measurement-settlements", build, target_table=TABLE)
