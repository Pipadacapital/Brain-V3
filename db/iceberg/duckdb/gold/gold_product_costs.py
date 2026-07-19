"""
gold_product_costs.py (DuckDB) — faithful port of db/iceberg/spark/gold/gold_product_costs.py.

SPEC:C.2.4 per-SKU COGS dimension (Brain V4 Wave C). The brand-configured cost-of-goods catalogue:
{brand_id, sku, cost_minor, currency_code, valid_from, valid_to, …}. This is the COGS source
gold_measurement_costs (and gold_order_economics CM1) joins order lines against. Additive Gold
dimension; no reader repointed.

SOURCE (config tier, operational Postgres): billing.product_cost_sheet — the brand-uploaded C.2.4
per-SKU cost sheet (0126, renamed out of public by 0143; RLS-isolated, bi-temporal with a DB-level
no-overlap constraint). DR-003: this job previously read billing.cost_input (scope='sku',
cost_type='cogs' — the 0055 rate-config ancestor), which the CSV upload path never wrote, so
uploaded COGS could not reach the economics chain. The sheet is the SOLE per-SKU COGS authority;
cost_input remains the RATE-config seam (pct_bps / global / category) read by contribution margin.
cost_minor is per-unit COGS in bigint minor units + currency_code; valid_from/valid_to map direct
(open cost → valid_to NULL); the sheet's own source_system/source_event_id project through;
cost_confidence = 'Trusted' (brand-provided actuals; taxonomy Trusted|Estimated|Insufficient).

MONEY : cost_minor bigint minor units + currency_code, per-currency, never blended/float. brand_id first.
KEY   : (brand_id, sku, valid_from) — a SKU may have a cost history (re-costing); each interval is one row.

── PG portability ───────────────────────────────────────────────────────────────────────────────────────
Reads Postgres through the DuckDB `postgres` extension (ATTACH … TYPE postgres, READ_ONLY) — mirroring
gold_contribution_margin.py. When Postgres is UNREACHABLE — the parity harness / prod-local posture
where only iceberg-rest + MinIO are up — the read degrades GRACEFULLY: the job still creates the
correct EMPTY Gold dimension and exits clean (equivalent to a brand with no uploaded cost sheet).

NO Iceberg Silver/Gold source: this dimension is sourced entirely from operational Postgres (a pure
PG read, no lakehouse input). Uploading the brand cost sheet (CSV, POST /api/v1/product-costs lane)
populates it on the next refresh with no code change.

CAVEATS vs the Spark job (parity-preserving):
  - QUARANTINE: none — the Spark job has NO Stage-1/quarantine side-write here (reads governed PG config).
    This framework has none either — nothing to skip.
  - ORPHAN-SHEDDING: the Spark merge_on_pk does WHEN MATCHED UPDATE / WHEN NOT MATCHED INSERT (no
    not-matched-by-source DELETE); _base.merge_on_pk here matches that discipline exactly. No divergence.

Honors MIGRATION_TABLE_SUFFIX (→ gold_product_costs_duckdb_test) for the parallel-run parity harness.
Parity target: brain_gold.gold_product_costs (0 rows / possibly absent — HONEST-EMPTY today).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE  # noqa: E402

TABLE = "gold_product_costs"

# MIGRATION_TABLE_SUFFIX lets the parity harness write gold_product_costs_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# Operational Postgres (config tier) — the SAME source the Spark job reads over JDBC for the SKU COGS
# catalogue. jdbc:postgresql://host:port/db → the DuckDB postgres-extension needs a libpq DSN; translated below.
PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

# Mirrors the Spark COLUMNS_SQL order/types exactly. brand_id tenant key first; money = bigint minor +
# currency_code sibling. valid_from/valid_to are plain `date`; updated_at is plain `timestamp` (UTC).
COLUMNS_SQL = """
  brand_id         string    NOT NULL,
  sku              string    NOT NULL,
  cost_minor       bigint    NOT NULL,
  currency_code    string,
  valid_from       date      NOT NULL,
  valid_to         date,
  cost_confidence  string,
  source_system    string,
  source_event_id  string,
  updated_at       timestamp NOT NULL
""".strip("\n")

COLUMNS = [
    "brand_id", "sku", "cost_minor", "currency_code", "valid_from", "valid_to",
    "cost_confidence", "source_system", "source_event_id", "updated_at",
]

# (brand_id, sku, valid_from) — a SKU may have a re-costing history; each interval is one row.
PK = ["brand_id", "sku", "valid_from"]


def _jdbc_to_libpq(jdbc_url: str) -> str:
    """Translate a jdbc:postgresql://host:port/db URL into a DuckDB postgres-extension libpq DSN.

    ATTACH '<dsn>' AS pg (TYPE postgres) wants a libpq connection string: host=… port=… dbname=… .
    Identical helper to gold_contribution_margin.py (vendor-copied — a PURE pg-DSN translation).
    """
    rest = jdbc_url.replace("jdbc:postgresql://", "").replace("postgresql://", "")
    hostport, _, dbname = rest.partition("/")
    dbname = (dbname.split("?")[0] or "brain")
    host, _, port = hostport.partition(":")
    parts = [f"host={host or 'postgres'}", f"port={port or '5432'}", f"dbname={dbname}",
             f"user={PG_USER}", f"password={PG_PASSWORD}"]
    return " ".join(parts)


def _try_attach_pg(con) -> bool:
    """Attach operational Postgres READ-ONLY as `pg` via the DuckDB postgres extension.

    Returns True on success. On ANY failure (extension missing, PG unreachable — the parity-harness /
    prod-local posture) returns False and the job writes the correct EMPTY dimension (equivalent to a
    brand that has uploaded no cost sheet). Best-effort, non-fatal.
    """
    try:
        con.execute("INSTALL postgres; LOAD postgres;")
        dsn = _jdbc_to_libpq(PG_JDBC_URL)
        con.execute(f"ATTACH IF NOT EXISTS '{dsn}' AS pg (TYPE postgres, READ_ONLY);")
        # Probe a trivial query so an unreachable server fails HERE (not mid-build).
        con.execute("SELECT 1 FROM pg_catalog.pg_class LIMIT 1;")
        return True
    except Exception as exc:  # noqa: BLE001 — PG optional; degrade to empty-dimension posture.
        print(f'{{"job":"gold-product-costs","pg":"unreachable","detail":"{str(exc)[:120]}",'
              f'"fallback":"empty dimension (no sku/cogs config)"}}', flush=True)
        return False


def build(con):
    # brand-first tenant partitioning (mirrors Spark bucket(64, brand_id)).
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(64, brand_id)")

    # ── Config tier (PG, optional): the per-SKU COGS catalogue ──
    if not _try_attach_pg(con):
        # PG unreachable → the empty target is already created; nothing to MERGE. Exit clean.
        print(f"[gold-product-costs] PG unreachable — wrote empty {TABLE}, exiting", flush=True)
        return 0

    # Register the PG source as a temp view — the C.2.4 cost sheet, column-for-column (DR-003).
    # If billing.product_cost_sheet is absent/unreadable, degrade to empty (best-effort) and write
    # the empty mart.
    try:
        con.execute("""
            CREATE OR REPLACE TEMP VIEW _product_costs_src AS
            SELECT
                CAST(brand_id AS VARCHAR)   AS brand_id,
                sku,
                CAST(cost_minor AS BIGINT)  AS cost_minor,
                currency_code,
                CAST(valid_from AS DATE)    AS valid_from,
                CAST(valid_to   AS DATE)    AS valid_to,
                'Trusted'                   AS cost_confidence,
                source_system,
                CAST(source_event_id AS VARCHAR) AS source_event_id
            FROM pg.billing.product_cost_sheet
            WHERE sku IS NOT NULL AND sku <> '' AND cost_minor IS NOT NULL;
        """)
    except Exception as exc:  # noqa: BLE001 — table absent/unreadable → empty dimension, exit clean
        print(f'{{"job":"gold-product-costs","pg":"product_cost_sheet-unreadable","detail":"{str(exc)[:120]}",'
              f'"fallback":"empty dimension"}}', flush=True)
        return 0

    # Project to the mart shape. source_system/source_event_id come from the sheet (idempotent CSV
    # versioning); updated_at is UTC now(). brand_id/sku/valid_from non-NULL (the mart PK).
    staged = f"""
        SELECT
            brand_id,
            sku,
            CAST(cost_minor AS BIGINT)   AS cost_minor,
            currency_code,
            CAST(valid_from AS DATE)     AS valid_from,
            CAST(valid_to   AS DATE)     AS valid_to,
            cost_confidence,
            source_system,
            source_event_id,
            now() AT TIME ZONE 'UTC'     AS updated_at
        FROM _product_costs_src
        WHERE brand_id IS NOT NULL AND sku IS NOT NULL AND valid_from IS NOT NULL
    """

    # Idempotent MERGE on (brand_id, sku, valid_from). A re-pull can emit the same PK twice; the batch
    # dedup keeps the latest updated_at (nominal tie-break — the PK is already the natural key). Replay-safe.
    return merge_on_pk(con, TARGET, staged, COLUMNS, PK, order_by_desc=["updated_at", "cost_minor"])


if __name__ == "__main__":
    run_job("gold-product-costs", build, target_table=TABLE)
