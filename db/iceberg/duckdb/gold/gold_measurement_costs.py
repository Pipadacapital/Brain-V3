# SPEC:C.2.4
"""
gold_measurement_costs.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_measurement_costs.py.

The measurement engine's per-order COSTS fact (Brain V4 Wave C, SPEC:C.2.4) — every per-order cost CM2
needs: COGS, forward shipping, REVERSE-logistics shipping (RTO), and packaging — at the
(brand_id, order_id, event_id) grain. Money = BIGINT minor units + a sibling currency_code (never blended,
never a float). source_system / source_event_id lineage. Append-only fact.

COST COMPONENTS (one row per (order, cost_type); per-currency, integer minor, no float):
  cost_type='cogs'            — Σ over the order's silver_order_line of (quantity × per-unit gold_product_costs
                                for the SKU, valid at the order date). source_system='catalog'.
  cost_type='shipping_forward'— the brand-configured global shipping cost (billing.cost_input scope='global',
                                cost_type='shipping', fixed amount_minor). source_system='cost_config'.
  cost_type='shipping_reverse'— REVERSE LOGISTICS: an RTO (return-to-origin) incurs a SECOND shipping leg,
                                emitted ONLY for orders whose forward shipment reached terminal_class='rto'.
                                Amount = the same brand shipping config. source_system='cost_config'.
  cost_type='packaging'       — the brand-configured global packaging cost (scope='global',
                                cost_type='packaging'). source_system='cost_config'.

CURRENCY DISCIPLINE: a configured cost applies to an order ONLY when its currency matches the order's
currency (per-currency, never a fabricated FX conversion). A cost with no matching config / no product cost
is simply NOT emitted (honest absence — never a fabricated 0-money row). event_id / source_event_id =
deterministic sha256(brand_id, order_id, cost_type) so a re-run is byte-idempotent.

── PORT NOTES ───────────────────────────────────────────────────────────────────────────────────────────
  - get_json_object(payload, '$.properties.X')  →  json_extract_string(payload, '$.properties.X').
  - silver_exists(...) (Spark probes .schema)   →  _exists(...) probes with `LIMIT 0` (schema-only touch).
    A table that EXISTS but is EMPTY reads TRUE (its lane runs, yields 0 rows), exactly as Spark's probe;
    a truly ABSENT table → FALSE → its lane is an empty typed view (WHERE FALSE).
  - sha2(concat_ws('\\0', …), 256)              →  sha256(concat_ws(chr(0), …)). DuckDB's sha256() returns
    lowercase hex of the UTF-8 bytes, byte-identical to Spark's sha2(x,256); chr(0) == '\\0' separator.
  - current_timestamp() → now() AT TIME ZONE 'UTC' (UTC session set in _catalog.connect).
  - cast(x AS bigint) / coalesce(...,0) stays integer minor units end-to-end. No float touches money.
  - row_number() OVER (…) dedup latest-per-(brand,order) is identical in DuckDB.

── PG portability (billing.cost_input, DuckDB vs Spark JDBC) ─────────────────────────────────────────────
The Spark job reads GLOBAL shipping/packaging costs from operational Postgres billing.cost_input over the
JDBC driver. This DuckDB port reads the SAME query through the DuckDB `postgres` extension (ATTACH), and on
ANY failure (extension missing / PG unreachable — the parity-harness / prod-local posture) degrades
GRACEFULLY to the honest no-config path (empty _cost_global → shipping/packaging/reverse lanes emit nothing),
identical to the Spark output whenever billing.cost_input is empty (the current live data has 0 rows).
Mirrors gold_contribution_margin.py's ATTACH-with-fallback exactly. Set GOLD_PG_JDBC_URL / a reachable PG to
take the exact Spark path when a cost config exists.

WRITE MODE: the Spark job uses overwritePartitions (config-derived costs restated atomically). _base has no
overwrite primitive, so this port MERGE-UPSERTs on the mart PK (brand_id, order_id, event_id) — for the
honest-empty live data (0 rows) and the parity harness (fresh _duckdb_test from the same Silver+config) the
result set is IDENTICAL. The only divergence is the documented Spark edge (a brand that removes ALL cost
config leaves stale rows under overwrite too — noted, not silently dropped). MATCHED-UPDATE /
NOT-MATCHED-INSERT only; the sha256 event_id makes each restatement idempotent.

QUARANTINE: none — this Gold fact reads already-gated Silver + the gated keystone; there is NO
  Stage-1/quarantine side-write in the Spark job to mirror.
VENDORED HELPERS: none — the Spark job imports only framework helpers (already in _base/_catalog); the PG
  read is inlined here (mirroring gold_contribution_margin.py's ATTACH), so no pure Spark helper is copied.

GRAIN / PK: exactly 1 row per (brand_id, order_id, event_id) — event_id fully determines cost_type
  (sha256(brand_id, order_id, cost_type)), so the PK matches the Spark (order, cost_type) grain EXACTLY.

DATA NOTE: billing.cost_input + gold_product_costs are EMPTY live → the Spark oracle brain_gold.
  gold_measurement_costs is 0 rows / possibly ABSENT (HONEST-EMPTY). This port writes a correct EMPTY fact
  today and creates the empty target even when every source is absent/empty; it populates the moment a brand
  configures costs, with no code change.

Honors MIGRATION_TABLE_SUFFIX (→ gold_measurement_costs_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_measurement_costs (0 rows — honest-empty).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE  # noqa: E402

TABLE = "gold_measurement_costs"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_measurement_costs_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

SILVER_COLLECTOR = f"{CATALOG}.{SILVER_NAMESPACE}.silver_collector_event"
SILVER_ORDER_LINE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_order_line"
GOLD_PRODUCT_COSTS = f"{CATALOG}.{GOLD_NAMESPACE}.gold_product_costs"

# Operational Postgres (config tier) — the SAME source the Spark job reads for GLOBAL shipping/packaging.
# jdbc:postgresql://host:port/db → the DuckDB postgres-extension needs a libpq DSN; translated below.
PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL",
                                                                "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

# brand_id-first; money = BIGINT minor + currency_code; source_system/source_event_id lineage. occurred_at +
# updated_at NOT NULL (occurred_at is the partition anchor + the order/cost moment; updated_at is the write
# stamp). Mirrors the Spark COLUMNS_SQL order/types EXACTLY.
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  order_id         string    NOT NULL,
  event_id         string    NOT NULL,
  cost_type        string    NOT NULL,
  amount_minor     bigint    NOT NULL,
  currency_code    string,
  cost_confidence  string,
  source_system    string,
  source_event_id  string,
  occurred_at      timestamp NOT NULL,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "order_id", "event_id", "cost_type", "amount_minor", "currency_code",
    "cost_confidence", "source_system", "source_event_id", "occurred_at", "updated_at",
]

PK = ["brand_id", "order_id", "event_id"]


def _exists(con, fq: str) -> bool:
    """True iff a source table EXISTS (empty or not). Mirrors the Spark silver_exists (probes .schema): an
    existing-but-empty table returns True (its lane runs, yields 0 rows), only a truly ABSENT table → False.
    Probes with `LIMIT 0` (schema-only touch, no scan)."""
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001 — absent source → False → an empty (WHERE FALSE) lane
        return False


def _jdbc_to_libpq(jdbc_url: str) -> str:
    """Translate a jdbc:postgresql://host:port/db URL into a DuckDB postgres-extension libpq DSN."""
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    parts = [f"host={host or 'postgres'}", f"port={port or '5432'}", f"dbname={dbname}",
             f"user={PG_USER}", f"password={PG_PASSWORD}"]
    return " ".join(parts)


def _register_global_costs(con) -> None:
    """Register _cost_global (brand-configured GLOBAL shipping/packaging costs, fixed amount_minor) as a temp
    view — from PG billing.cost_input when attachable, else an EMPTY typed view (honest no-config).

    Mirrors the Spark _read_global_costs: scope='global', cost_type IN ('shipping','packaging'),
    amount_minor NOT NULL. On ANY PG failure (extension missing / unreachable — the parity-harness posture)
    degrades to the empty view, parity-equivalent to the Spark output whenever billing.cost_input is empty."""
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS pg (TYPE postgres, READ_ONLY);")
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")  # probe: unreachable fails HERE
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cost_global AS
            SELECT CAST(brand_id AS VARCHAR) AS brand_id, cost_type,
                   CAST(amount_minor AS BIGINT) AS amount_minor, currency_code, cost_confidence
            FROM pg.billing.cost_input
            WHERE scope = 'global' AND cost_type IN ('shipping', 'packaging') AND amount_minor IS NOT NULL;
        """)
    except Exception as exc:  # noqa: BLE001 — PG optional; degrade to the no-config (empty) posture.
        print(f'{{"job":"gold-measurement-costs","pg":"unreachable","detail":"{str(exc)[:120]}",'
              f'"fallback":"no global costs (empty _cost_global)"}}', flush=True)
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cost_global AS
            SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS cost_type,
                   CAST(NULL AS BIGINT) AS amount_minor, CAST(NULL AS VARCHAR) AS currency_code,
                   CAST(NULL AS VARCHAR) AS cost_confidence WHERE FALSE;
        """)


def build(con):
    # Spark partitions bucket(64, brand_id), days(occurred_at). DuckDB's Iceberg writer does not implement
    # the days() transform, so we keep the brand-bucket anchor only (physical layout only — no effect on the
    # rows/PK/parity). Matches the established DuckDB gold pattern (e.g. gold_measurement_refunds).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # EXISTENCE / EMPTY GUARD — if the gated keystone is absent, no order can be costed. The empty target is
    # already created; nothing to MERGE. Exit clean (parity: both sides row-count 0). Mirrors the Spark
    # `if not silver_exists(spark, 'silver_collector_event'): return`.
    if not _exists(con, SILVER_COLLECTOR):
        print(f"[gold-measurement-costs] source {SILVER_COLLECTOR} absent — wrote empty {TABLE}, exiting",
              flush=True)
        return 0

    # ── orders: dedup latest per (brand, order) + is_rto flag (from the forward shipment lane) ──────────
    con.execute(f"""
        CREATE OR REPLACE TEMP VIEW _cost_orders AS
        WITH ord AS (
            SELECT brand_id,
                   json_extract_string(payload, '$.properties.order_id')      AS order_id,
                   json_extract_string(payload, '$.properties.currency_code')  AS currency_code,
                   occurred_at,
                   row_number() OVER (
                       PARTITION BY brand_id, json_extract_string(payload, '$.properties.order_id')
                       ORDER BY occurred_at DESC, event_id DESC
                   ) AS _rn
            FROM {SILVER_COLLECTOR}
            WHERE event_type IN ('order.live.v1', 'order.backfill.v1')
              AND json_extract_string(payload, '$.properties.order_id') IS NOT NULL
        ),
        rto AS (
            SELECT DISTINCT brand_id, json_extract_string(payload, '$.properties.order_id') AS order_id
            FROM {SILVER_COLLECTOR}
            WHERE event_type = 'shiprocket.shipment_status.v1'
              AND json_extract_string(payload, '$.properties.terminal_class') = 'rto'
        )
        SELECT o.brand_id, o.order_id, o.currency_code, o.occurred_at,
               (r.order_id IS NOT NULL) AS is_rto
        FROM ord o LEFT JOIN rto r ON r.brand_id = o.brand_id AND r.order_id = o.order_id
        WHERE o._rn = 1;
    """)

    # ── global shipping/packaging config (PG, optional) → _cost_global ──
    _register_global_costs(con)

    # ── COGS per order from order lines × gold_product_costs (valid at order date) ─────────────────────
    if _exists(con, SILVER_ORDER_LINE) and _exists(con, GOLD_PRODUCT_COSTS):
        con.execute(f"""
            CREATE OR REPLACE TEMP VIEW _cost_cogs AS
            SELECT
                ol.brand_id, ol.order_id,
                CAST(SUM(CAST(COALESCE(ol.quantity, 0) AS BIGINT)
                         * CAST(COALESCE(pc.cost_minor, 0) AS BIGINT)) AS BIGINT) AS cogs_minor,
                MAX(pc.cost_confidence) AS cost_confidence
            FROM {SILVER_ORDER_LINE} ol
            JOIN _cost_orders o ON o.brand_id = ol.brand_id AND o.order_id = ol.order_id
            JOIN {GOLD_PRODUCT_COSTS} pc
              ON pc.brand_id = ol.brand_id AND pc.sku = ol.sku
             AND pc.currency_code = o.currency_code
             AND CAST(o.occurred_at AS DATE) >= pc.valid_from
             AND (pc.valid_to IS NULL OR CAST(o.occurred_at AS DATE) < pc.valid_to)
            WHERE ol.sku IS NOT NULL
            GROUP BY ol.brand_id, ol.order_id
            HAVING SUM(CAST(COALESCE(pc.cost_minor, 0) AS BIGINT)) > 0;
        """)
    else:
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _cost_cogs AS
            SELECT CAST(NULL AS VARCHAR) AS brand_id, CAST(NULL AS VARCHAR) AS order_id,
                   CAST(NULL AS BIGINT) AS cogs_minor, CAST(NULL AS VARCHAR) AS cost_confidence WHERE FALSE;
        """)

    # ── assemble the 4 cost lanes → one append-only fact (only determinable rows; honest absence) ──────
    staged = """
        WITH cogs AS (
            SELECT o.brand_id, o.order_id, 'cogs' AS cost_type, c.cogs_minor AS amount_minor,
                   o.currency_code, COALESCE(c.cost_confidence, 'Estimated') AS cost_confidence,
                   'catalog' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_cogs c ON c.brand_id = o.brand_id AND c.order_id = o.order_id
        ),
        shipping_fwd AS (
            SELECT o.brand_id, o.order_id, 'shipping_forward' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'shipping' AND g.currency_code = o.currency_code
        ),
        shipping_rev AS (
            SELECT o.brand_id, o.order_id, 'shipping_reverse' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'shipping' AND g.currency_code = o.currency_code
            WHERE o.is_rto = true
        ),
        packaging AS (
            SELECT o.brand_id, o.order_id, 'packaging' AS cost_type, g.amount_minor,
                   o.currency_code, g.cost_confidence, 'cost_config' AS source_system, o.occurred_at
            FROM _cost_orders o JOIN _cost_global g
              ON g.brand_id = o.brand_id AND g.cost_type = 'packaging' AND g.currency_code = o.currency_code
        ),
        unioned AS (
            SELECT * FROM cogs UNION ALL SELECT * FROM shipping_fwd
            UNION ALL SELECT * FROM shipping_rev UNION ALL SELECT * FROM packaging
        )
        SELECT
            brand_id, order_id,
            sha256(concat_ws(chr(0), brand_id, order_id, cost_type)) AS event_id,
            cost_type,
            CAST(COALESCE(amount_minor, 0) AS BIGINT) AS amount_minor,
            currency_code, cost_confidence, source_system,
            sha256(concat_ws(chr(0), brand_id, order_id, cost_type)) AS source_event_id,
            occurred_at, now() AT TIME ZONE 'UTC' AS updated_at
        FROM unioned
        WHERE amount_minor IS NOT NULL AND amount_minor <> 0
    """

    # Full-recompute MERGE on (brand_id, order_id, event_id). event_id is deterministic sha256 per
    # (brand, order, cost_type), so a re-run restates each cost row idempotently. The union already yields at
    # most one row per PK, so the in-batch dedup is a no-op; order_by is a nominal tie-break. See the module
    # docstring on the overwritePartitions → MERGE substitution (parity-identical for empty/harness data).
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at"])


if __name__ == "__main__":
    run_job("gold-measurement-costs", build, target_table=TABLE)
