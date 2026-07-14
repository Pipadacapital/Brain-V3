# SPEC:C.2.3
"""
gold_measurement_fees.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_measurement_fees.py.

The measurement engine's canonical APPEND-ONLY per-order FEES fact at the (brand_id, order_id, event_id)
grain — platform / payment / checkout-provider fees per order, money = BIGINT minor units + a sibling
currency_code (never blended, never a float), with source_system/source_event_id lineage.

AMD-16 R1 (BINDING): fees today live ONLY inside razorpay settlements (silver_settlement.fee_minor /
tax_minor). This GOLD fact EXTRACTS them into a first-class per-order fee fact so CM2 can read fees directly
rather than re-deriving them from the settlement rollup. Additive; no existing reader repointed.

FEE COMPONENTS (per settlement item that carries a fee, per-currency, integer minor, no float):
  fee_type='payment'  fee_minor = fee_minor (the MDR / gateway processing fee)
  fee_type='tax'      fee_minor = tax_minor (GST-on-MDR — a distinct withheld component)
Only rows with a NON-ZERO component are emitted (a settlement item with no fee is not a fee fact). event_id
is suffixed with the component (':payment' / ':tax') so payment + tax from ONE settlement item are two
distinct, idempotent fact rows that never collide on the merge key.

FORWARD-COMPAT: checkout-provider fees (Shopflo/GoKwik) and platform fees (marketplace commission) land in
the SAME table under fee_type='checkout'/'platform' the moment a connector exposes them — no schema change.

── PORT NOTES ───────────────────────────────────────────────────────────────────────────────────────────
  - silver('silver_settlement')                    →  {CATALOG}.brain_silver.silver_settlement (direct read).
  - silver_exists(...) (Spark probes .schema)      →  _exists(...) probes with `LIMIT 0` (schema-only touch).
    A table that EXISTS but is EMPTY reads TRUE (its lane runs and yields 0 rows), exactly as Spark's probe.
    A truly ABSENT table → FALSE → the empty-source guard writes the empty Gold mart and exits clean.
  - concat(a, ':payment')  →  a || ':payment'      (DuckDB string concat; identical result).
  - current_timestamp()    →  now() AT TIME ZONE 'UTC'  (UTC session set in _catalog.connect).
  - cast(x AS bigint) / coalesce(...,0) stays integer minor units end-to-end. No float touches money.

PG: this Gold fact reads NO operational Postgres (it reads ONLY the already-gated Iceberg silver_settlement),
    so there is NO postgres-extension ATTACH / graceful-fallback to mirror (unlike gold_contribution_margin).

GRAIN / PK: exactly 1 row per (brand_id, order_id, event_id) — the mart PK (EXACT match to the Spark
  merge_on_pk ["brand_id","order_id","event_id"]). order_id coalesced to '' so the merge key is never NULL.
  The ':payment'/':tax' event_id suffix makes each staged row a distinct PK (no in-batch collision).
QUARANTINE: none — this Gold fact reads already-gated Silver; the Spark job has NO Stage-1/quarantine
  side-write to mirror.
VENDORED HELPERS: none. The Spark job's only helper imports (ensure_gold_table/merge_on_pk/run_job/silver/
  silver_exists) all have direct DuckDB _base analogues — no PURE spark helper needs vendoring.
REPLAY-SAFE: full recompute over silver_settlement, MERGE-UPDATE'd on the PK. The Spark job runs a plain
  run_job (NOT entity_incremental) with ensure-table-on-empty — a full-scan recompute here is
  parity-equivalent: the MERGE on the mart PK is idempotent and restates every (brand, order, event) group.
  MATCHED-UPDATE / NOT-MATCHED-INSERT only — the Spark merge_on_pk passes no delete_orphans, so no
  orphan-shedding divergence.

DATA NOTE: current Bronze has ZERO settlement.live.v1 → silver_settlement is empty (or absent) → this writes
  a correct EMPTY Gold mart today (HONEST-EMPTY); it populates with no code change once a Razorpay settlement
  connector syncs. If silver_settlement is ABSENT the empty-source guard still creates the empty target and
  exits clean.

Honors MIGRATION_TABLE_SUFFIX (→ gold_measurement_fees_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_measurement_fees (0 rows — HONEST-EMPTY, possibly absent).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_measurement_fees"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_measurement_fees_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_SETTLEMENT = f"{CATALOG}.{SILVER_NAMESPACE}.silver_settlement"

# Mirrors the Spark COLUMNS_SQL order/types EXACTLY. brand_id tenant key first; money = bigint minor +
# currency_code sibling; source_system/source_event_id lineage. occurred_at + updated_at NOT NULL
# (occurred_at is the partition anchor + the event moment; updated_at is the write stamp).
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  order_id         string    NOT NULL,
  event_id         string    NOT NULL,
  fee_type         string    NOT NULL,
  fee_minor        bigint    NOT NULL,
  currency_code    string,
  source_system    string,
  source_event_id  string,
  occurred_at      timestamp NOT NULL,
  ingested_at      timestamp,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "event_id", "fee_type", "fee_minor", "currency_code",
    "source_system", "source_event_id", "occurred_at", "ingested_at", "updated_at",
]

PK = ["brand_id", "order_id", "event_id"]


def _exists(con, fq: str) -> bool:
    """True iff a source table EXISTS (empty or not). Mirrors the Spark silver_exists (probes .schema): an
    existing-but-empty table returns True (its lane runs, yields 0 rows), only a truly ABSENT table → False.
    Probes with `LIMIT 0` (schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → False → empty-source guard writes empty target
        return False


def build(con):
    # Spark partitions bucket(64, brand_id), days(occurred_at). DuckDB's Iceberg writer does not implement
    # the days() transform, so we keep the brand-bucket anchor only (physical layout only — no effect on the
    # rows/PK/parity). Matches the established DuckDB gold pattern (e.g. gold_measurement_refunds).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # Empty-source guard: if silver_settlement is ABSENT the empty target is already created — nothing to
    # extract. Exit clean (parity: both sides row-count 0). An existing-but-empty table falls through and
    # yields 0 staged rows, identical to the Spark ensure-table-on-empty path.
    if not _exists(con, SILVER_SETTLEMENT):
        print(f"[gold-measurement-fees] source {SILVER_SETTLEMENT} absent — wrote empty {TABLE}, exiting",
              flush=True)
        return 0

    # Faithful SQL port of the Spark staged CTE. Two fee components (payment / tax) extracted per settlement
    # item that carries a NON-ZERO fee, each with its own ':payment'/':tax'-suffixed event_id so the two
    # never collide on the merge key. Integer minor units end-to-end (no float touches money).
    staged = f"""
        WITH src AS (
            SELECT brand_id, event_id, coalesce(order_id, '') AS order_id,
                   CAST(coalesce(fee_minor, 0) AS BIGINT) AS fee_minor,
                   CAST(coalesce(tax_minor, 0) AS BIGINT) AS tax_minor,
                   currency_code, coalesce(source, 'razorpay') AS source_system, occurred_at, ingested_at
            FROM {SILVER_SETTLEMENT}
            WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
        ),
        payment_fee AS (
            SELECT brand_id, order_id, event_id || ':payment' AS event_id, 'payment' AS fee_type,
                   fee_minor AS fee_minor, currency_code, source_system, event_id AS source_event_id,
                   occurred_at, ingested_at
            FROM src WHERE fee_minor <> 0
        ),
        tax_fee AS (
            SELECT brand_id, order_id, event_id || ':tax' AS event_id, 'tax' AS fee_type,
                   tax_minor AS fee_minor, currency_code, source_system, event_id AS source_event_id,
                   occurred_at, ingested_at
            FROM src WHERE tax_minor <> 0
        )
        SELECT brand_id, order_id, event_id, fee_type, fee_minor, currency_code, source_system,
               source_event_id, occurred_at, ingested_at, now() AT TIME ZONE 'UTC' AS updated_at
        FROM payment_fee
        UNION ALL
        SELECT brand_id, order_id, event_id, fee_type, fee_minor, currency_code, source_system,
               source_event_id, occurred_at, ingested_at, now() AT TIME ZONE 'UTC' AS updated_at
        FROM tax_fee
    """

    # Full-recompute MERGE on (brand_id, order_id, event_id). The ':payment'/':tax' event_id suffix already
    # makes every staged row a distinct PK, so merge_on_pk's in-batch dedup is a no-op; order_by_desc is a
    # deterministic tie-break for the rare re-pull duplicate. MATCHED-UPDATE / NOT-MATCHED-INSERT (the Spark
    # merge_on_pk passes no delete_orphans → no orphan-shedding divergence).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("gold-measurement-fees", build, target_table=TABLE)
