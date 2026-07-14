# SPEC:C.2.1
"""
gold_measurement_refunds.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_measurement_refunds.py.

The measurement engine's canonical APPEND-ONLY refunds/returns fact at the (brand_id, order_id, event_id)
grain — money = BIGINT minor units + a sibling currency_code (never blended, never a float). It is the GOLD
projection of the extended live silver_refund (explicit refunds) UNIONed with the RTO (return-to-origin)
lane derived from the forward shipment signal, which silver_refund cannot see.

TWO SOURCES → ONE FACT (per-currency, integer minor units, no float):
  A. EXPLICIT REFUNDS — {CATALOG}.brain_silver.silver_refund (the extended taxonomy/lineage fact).
     reason_code is the note-derived taxonomy ('rto' | 'return' | 'damaged' | 'cancellation' |
     'customer_request' | 'other'); amount_minor is the settled refund total; refund_method honest-null when
     the connector omits it. Rows with order_unresolved=true are EXCLUDED (order ref not yet resolvable).
  B. RTO RETURNS — {CATALOG}.brain_silver.silver_collector_event WHERE
     event_type='shiprocket.shipment_status.v1' AND properties.terminal_class='rto'. A FIRST-CLASS
     reason_code='rto' row: the order's value is reversed. amount_minor = the order's amount_minor;
     refund_method = 'cod_not_collected' for COD else 'original_payment'. Emitted ONLY for orders that do
     NOT already carry an explicit refund (LEFT ANTI JOIN on (brand_id, order_id)) — the explicit refund wins
     (no double-reversal).

KEY/IDEMPOTENCY: merged on (brand_id, order_id, event_id) — order_id coalesced to '' so the merge key is
never NULL (idempotent re-run). event_id is the deterministic Bronze/transition id.

── PORT NOTES ───────────────────────────────────────────────────────────────────────────────────────────
  - get_json_object(payload, '$.properties.X')  →  json_extract_string(payload, '$.properties.X').
  - silver_exists(...) (Spark probes .schema)   →  _exists(...) probes with `LIMIT 0` (schema-only touch).
    A table that EXISTS but is EMPTY reads TRUE (its lane runs and yields 0 rows), exactly as Spark's probe.
    A truly ABSENT table → FALSE → an empty lane (shaped SELECT ... WHERE 1=0).
  - current_timestamp() → now() AT TIME ZONE 'UTC' (UTC session set in _catalog.connect).
  - cast(x AS bigint) / coalesce(...,0) stays integer minor units end-to-end. No float touches money.
  - LEFT ANTI JOIN → DuckDB ANTI JOIN (a JOIN qualifier DuckDB supports); expressed as NOT EXISTS for the
    widest-compatibility form (semantically identical for a non-nullable key predicate).

GRAIN / PK: exactly 1 row per (brand_id, order_id, event_id) — the mart PK (EXACT match to the Spark
  merge_on_pk ["brand_id","order_id","event_id"]).
QUARANTINE: none — this Gold fact reads already-gated Silver + the gated keystone; there is NO
  Stage-1/quarantine side-write in the Spark job to mirror.
VENDORED HELPERS: none. The Spark job's only helper import (_measurement_taxonomy._reason_code) lives in
  silver_refund, NOT here — this Gold mart reads the already-computed reason_code from silver_refund and
  hard-codes 'rto' for the RTO lane, so no pure helper needs vendoring.
REPLAY-SAFE: full recompute over both sources, MERGE-UPDATE'd on the PK. The Spark job wraps the identical
  build in run_entity_incremental (a SCALING optimization — recompute only affected brands, each over full
  history, then the SAME UPDATE/INSERT MERGE). A full-scan recompute here is parity-equivalent: the MERGE on
  the mart PK is idempotent and restates every (brand, order, event) group. MATCHED-UPDATE / NOT-MATCHED-
  INSERT only — the Spark merge_on_pk passes no delete_orphans, so no orphan-shedding divergence.

Honors MIGRATION_TABLE_SUFFIX (→ gold_measurement_refunds_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_measurement_refunds (212 rows).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_measurement_refunds"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_measurement_refunds_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_REFUND = f"{CATALOG}.{SILVER_NAMESPACE}.silver_refund"
SILVER_COLLECTOR = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"

# brand_id-first; money = BIGINT minor + currency_code; source_system/source_event_id lineage. occurred_at +
# updated_at NOT NULL (occurred_at is the partition anchor + the event moment; updated_at is the write stamp).
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  order_id         string    NOT NULL,
  event_id         string    NOT NULL,
  order_line_id    string,
  amount_minor     bigint    NOT NULL,
  currency_code    string,
  reason_code      string,
  refund_method    string,
  initiated_at     timestamp,
  settled_at       timestamp,
  source_system    string,
  source_event_id  string,
  occurred_at      timestamp NOT NULL,
  ingested_at      timestamp,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "event_id", "order_line_id", "amount_minor", "currency_code",
    "reason_code", "refund_method", "initiated_at", "settled_at", "source_system",
    "source_event_id", "occurred_at", "ingested_at", "updated_at",
]

PK = ["brand_id", "order_id", "event_id"]


def _exists(con, fq: str) -> bool:
    """True iff a source table EXISTS (empty or not). Mirrors the Spark silver_exists (probes .schema): an
    existing-but-empty table returns True (its lane runs, yields 0 rows), only a truly ABSENT table → False.
    Probes with `LIMIT 0` (schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → False → an empty (WHERE 1=0) lane
        return False


# Shared column shape for both lanes (pre-updated_at) — so the UNION ALL and the empty-lane fallback line up.
_EMPTY_LANE = (
    "SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS order_id, "
    "CAST(NULL AS VARCHAR) AS event_id, CAST(NULL AS VARCHAR) AS order_line_id, "
    "CAST(NULL AS BIGINT) AS amount_minor, CAST(NULL AS VARCHAR) AS currency_code, "
    "CAST(NULL AS VARCHAR) AS reason_code, CAST(NULL AS VARCHAR) AS refund_method, "
    "CAST(NULL AS TIMESTAMP) AS initiated_at, CAST(NULL AS TIMESTAMP) AS settled_at, "
    "CAST(NULL AS VARCHAR) AS source_system, CAST(NULL AS VARCHAR) AS source_event_id, "
    "CAST(NULL AS TIMESTAMP) AS occurred_at, CAST(NULL AS TIMESTAMP) AS ingested_at WHERE 1=0"
)


def build(con):
    # Spark partitions bucket(64, brand_id), days(occurred_at). DuckDB's Iceberg writer does not implement
    # the days() transform, so we keep the brand-bucket anchor only (physical layout only — no effect on the
    # rows/PK/parity). Matches the established DuckDB gold pattern (e.g. gold_revenue_ledger).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── A. explicit refunds from the extended silver_refund fact ──────────────────────────────────────
    if _exists(con, SILVER_REFUND):
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _refunds_explicit AS
            SELECT
                brand_id,
                coalesce(order_id, '')                          AS order_id,
                event_id,
                order_line_id,
                CAST(coalesce(amount_minor, 0) AS BIGINT)       AS amount_minor,
                currency_code,
                coalesce(reason_code, 'other')                  AS reason_code,
                refund_method,
                initiated_at,
                settled_at,
                coalesce(source_system, source, 'unknown')      AS source_system,
                coalesce(source_event_id, event_id)             AS source_event_id,
                occurred_at,
                ingested_at
            FROM {SILVER_REFUND}
            WHERE brand_id IS NOT NULL AND event_id IS NOT NULL
              AND coalesce(order_unresolved, false) = false
        """)
    else:
        con.execute(f"CREATE OR REPLACE TEMP VIEW _refunds_explicit AS {_EMPTY_LANE}")

    # ── B. RTO returns from the forward shipment lane (terminal_class='rto'), joined to the order for the
    #      reversed value + payment method. Read the SAME collector_event source the ledger folds from. ──
    if _exists(con, SILVER_COLLECTOR):
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _refunds_rto AS
            WITH rto AS (
                SELECT
                    brand_id,
                    event_id,
                    json_extract_string(payload, '$.properties.order_id')                 AS order_id,
                    lower(json_extract_string(payload, '$.properties.payment_method'))     AS payment_method,
                    occurred_at,
                    ingested_at,
                    row_number() OVER (
                        PARTITION BY brand_id, json_extract_string(payload, '$.properties.order_id')
                        ORDER BY occurred_at DESC, event_id DESC
                    ) AS _rn
                FROM {SILVER_COLLECTOR}
                WHERE event_type = 'shiprocket.shipment_status.v1'
                  AND json_extract_string(payload, '$.properties.terminal_class') = 'rto'
                  AND json_extract_string(payload, '$.properties.order_id') IS NOT NULL
            ),
            orders AS (
                SELECT
                    brand_id,
                    json_extract_string(payload, '$.properties.order_id')                     AS order_id,
                    CAST(json_extract_string(payload, '$.properties.amount_minor') AS BIGINT)  AS amount_minor,
                    json_extract_string(payload, '$.properties.currency_code')                AS currency_code,
                    lower(json_extract_string(payload, '$.properties.payment_method'))        AS payment_method,
                    row_number() OVER (
                        PARTITION BY brand_id, json_extract_string(payload, '$.properties.order_id')
                        ORDER BY occurred_at DESC, event_id DESC
                    ) AS _orn
                FROM {SILVER_COLLECTOR}
                WHERE event_type IN ('order.live.v1', 'order.backfill.v1')
                  AND json_extract_string(payload, '$.properties.order_id') IS NOT NULL
            )
            SELECT
                r.brand_id,
                r.order_id                                          AS order_id,
                r.event_id                                          AS event_id,
                CAST(NULL AS VARCHAR)                               AS order_line_id,
                CAST(coalesce(o.amount_minor, 0) AS BIGINT)         AS amount_minor,
                o.currency_code                                     AS currency_code,
                'rto'                                               AS reason_code,
                CASE WHEN coalesce(r.payment_method, o.payment_method) = 'cod'
                     THEN 'cod_not_collected' ELSE 'original_payment' END AS refund_method,
                r.occurred_at                                       AS initiated_at,
                r.occurred_at                                       AS settled_at,
                'shiprocket'                                        AS source_system,
                r.event_id                                          AS source_event_id,
                r.occurred_at                                       AS occurred_at,
                r.ingested_at                                       AS ingested_at
            FROM rto r
            LEFT JOIN orders o ON o.brand_id = r.brand_id AND o.order_id = r.order_id AND o._orn = 1
            WHERE r._rn = 1
              -- anti-join: skip RTO orders that already carry an explicit refund (no double-reversal).
              AND NOT EXISTS (
                  SELECT 1 FROM _refunds_explicit e
                  WHERE e.brand_id = r.brand_id AND e.order_id = r.order_id
              )
        """)
    else:
        con.execute(f"CREATE OR REPLACE TEMP VIEW _refunds_rto AS {_EMPTY_LANE}")

    staged = """
        SELECT *, now() AT TIME ZONE 'UTC' AS updated_at FROM (
            SELECT * FROM _refunds_explicit
            UNION ALL
            SELECT * FROM _refunds_rto
        )
    """

    # Full-recompute MERGE on (brand_id, order_id, event_id). In-batch dedup keeps latest-ingested-wins (a
    # re-pull can emit the same PK twice); the RTO lane's event_id is per shipment-event so ties are rare.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK,
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("gold-measurement-refunds", build, target_table=TABLE)
