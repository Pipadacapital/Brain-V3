"""
silver_customer_identity.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_customer_identity.py.

Reads the Neo4j identity graph (identity SoR, ADR-0004) via the neo4j python driver and idempotently
MERGEs the Customer-node projection into Iceberg brain_silver.silver_customer_identity — the SAME source
(Neo4j), grain (one row per brand_id, brain_id), columns, and idempotent PK MERGE the Spark job produces.

SOURCE: Neo4j Customer nodes. Cypher (byte-identical intent to the Spark job's mapCustomer query):
    MATCH (c:Customer) WHERE c.brain_id IS NOT NULL
    RETURN c.brand_id, c.brain_id, c.lifecycle_state, c.merged_into,
           c.created_at AS minted_at_ms, c.first_identified_at AS first_identified_at_ms
  epoch-millis node props (created_at / first_identified_at) → timestamp via ms/1000 (matches TS new Date(ms)).

GRAIN / PK: (brand_id, brain_id). WHEN MATCHED UPDATE (lifecycle/merged_into mutations propagate on re-run);
  WHEN NOT MATCHED INSERT. Defensive dedup: one row per PK (keep latest minted_at).

PII: NO raw PII — the Customer node carries only brain_id (UUID surrogate) + coarse lifecycle/timestamps.
  Hashed identifiers live on the SEPARATE IDENTIFIES edges, deliberately NOT read here. brand_id first.

STAGE-1 GATE: N/A — trusted projection of the identity SoR (no Bronze-derived business record). Skipped
  exactly as in Spark; nothing diverts to silver_quarantine.

DATA-THIN DEV PATH: NEO4J_URI unset → create the correctly-shaped EMPTY table and return (Neo4j empty in
  some dev runs). Supplying NEO4J_URI + creds populates it with no code change.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TABLE = "silver_customer_identity"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

# Neo4j wiring — mirrors the Spark job / apps/stream-worker identity-export defaults.
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "brain_neo4j")

# Column contract — byte-for-byte the StarRocks/Spark silver_customer_identity DDL. brand_id first.
COLUMNS_SQL = """
  brand_id            string    NOT NULL,
  brain_id            string    NOT NULL,
  lifecycle_state     string,
  merged_into         string,
  minted_at           timestamp,
  first_identified_at timestamp,
  updated_at          timestamp
""".strip("\n")

CUSTOMER_CYPHER = (
    "MATCH (c:Customer) WHERE c.brain_id IS NOT NULL "
    "RETURN c.brand_id AS brand_id, c.brain_id AS brain_id, "
    "c.lifecycle_state AS lifecycle_state, c.merged_into AS merged_into, "
    "c.created_at AS minted_at_ms, c.first_identified_at AS first_identified_at_ms"
)


def _read_customers() -> list[dict]:
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session() as session:
            return [dict(r) for r in session.run(CUSTOMER_CYPHER)]
    finally:
        driver.close()


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    if not NEO4J_URI:
        print("[silver-customer-identity] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]

    rows = _read_customers()
    # Register the raw Neo4j rows as a DuckDB relation. epoch-millis → timestamp (ms/1000, null-safe),
    # matching the TS new Date(ms) → 'yyyy-MM-dd HH:mm:ss' mapping and the Spark _ms_to_ts.
    con.execute("DROP TABLE IF EXISTS _sci_raw;")
    con.execute(
        "CREATE TEMP TABLE _sci_raw ("
        "brand_id VARCHAR, brain_id VARCHAR, lifecycle_state VARCHAR, merged_into VARCHAR, "
        "minted_at_ms BIGINT, first_identified_at_ms BIGINT)"
    )
    if rows:
        con.executemany(
            "INSERT INTO _sci_raw VALUES (?,?,?,?,?,?)",
            [
                (
                    r.get("brand_id"),
                    r.get("brain_id"),
                    r.get("lifecycle_state"),
                    r.get("merged_into"),
                    int(r["minted_at_ms"]) if r.get("minted_at_ms") is not None else None,
                    int(r["first_identified_at_ms"]) if r.get("first_identified_at_ms") is not None else None,
                )
                for r in rows
            ],
        )

    staged = """
        SELECT
          CAST(brand_id AS VARCHAR)        AS brand_id,
          CAST(brain_id AS VARCHAR)        AS brain_id,
          CAST(lifecycle_state AS VARCHAR) AS lifecycle_state,
          CAST(merged_into AS VARCHAR)     AS merged_into,
          CASE WHEN minted_at_ms IS NULL THEN NULL
               ELSE make_timestamp(minted_at_ms * 1000) END AS minted_at,
          CASE WHEN first_identified_at_ms IS NULL THEN NULL
               ELSE make_timestamp(first_identified_at_ms * 1000) END AS first_identified_at,
          now() AS updated_at
        FROM _sci_raw
        WHERE brand_id IS NOT NULL AND brain_id IS NOT NULL
    """

    from _base import merge_on_pk  # local import: same discipline as other duckdb jobs
    n = merge_on_pk(
        con, TARGET, staged,
        ["brand_id", "brain_id", "lifecycle_state", "merged_into",
         "minted_at", "first_identified_at", "updated_at"],
        ["brand_id", "brain_id"],
        order_by_desc=["minted_at"],
    )
    con.execute("DROP TABLE IF EXISTS _sci_raw;")
    return n


if __name__ == "__main__":
    run_job("silver-customer-identity", build, target_table=TABLE)
