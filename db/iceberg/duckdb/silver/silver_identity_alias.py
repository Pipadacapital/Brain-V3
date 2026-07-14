"""
silver_identity_alias.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_identity_alias.py.

The Iceberg-Silver projection of the Neo4j identity graph's IDENTIFIES edges — one row per
(brand_id, identifier_type, identifier_value): a hashed identifier (64-hex, NEVER raw PII) → the resolved
CANONICAL brain_id (follow the live ALIAS_OF chain to its terminal node).

SOURCE: Neo4j (identity SoR, ADR-0004), read via the neo4j python driver — the SAME IDENTITY_CYPHER the
Spark job uses (F2 alias-resolve: coalesce(canon.brain_id, c.brain_id) via a live-only ALIAS_OF*1..50 walk).

GRAIN / PK: (brand_id, identifier_type, identifier_value). brain_id = resolved canonical customer.
  is_active mirrors the edge state; tier drives CAPI subject-hash choice. created_at = Neo4j epoch-ms edge ts.

PII: identifier_value is a 64-hex HASH only — this job NEVER reads/writes a raw email/phone. brand_id first.
STAGE-1 GATE: N/A — trusted projection of the identity SoR. Non-null PK invariants enforced structurally
  (Cypher c.brain_id IS NOT NULL + isNotNull filter + NOT NULL columns). Nothing diverts to quarantine.
DATA-THIN DEV PATH: NEO4J_URI unset → EMPTY table + return.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TABLE = "silver_identity_alias"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "brain_neo4j")

# Byte-identical to the Spark IDENTITY_CYPHER: full projection of active IDENTIFIES edges with F2 alias-resolve.
IDENTITY_CYPHER = (
    "MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer) "
    "WHERE c.brain_id IS NOT NULL "
    "OPTIONAL MATCH _cano = (c)-[:ALIAS_OF*1..50]->(canon:Customer) "
    "WHERE all(rel IN relationships(_cano) WHERE rel.valid_to IS NULL) "
    "  AND NOT EXISTS { MATCH (canon)-[ra:ALIAS_OF]->() WHERE ra.valid_to IS NULL } "
    "RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_value, "
    "coalesce(canon.brain_id, c.brain_id) AS brain_id, r.tier AS tier, r.is_active AS is_active, "
    "r.created_at AS created_at_ms"
)

COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  identifier_type   string    NOT NULL,
  identifier_value  string    NOT NULL,
  brain_id          string,
  tier              string,
  is_active         boolean,
  created_at        timestamp,
  updated_at        timestamp NOT NULL
""".strip("\n")


def _read_edges() -> list[dict]:
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session() as session:
            return [dict(r) for r in session.run(IDENTITY_CYPHER)]
    finally:
        driver.close()


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    if not NEO4J_URI:
        print("[silver-identity-alias] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]

    rows = _read_edges()
    con.execute("DROP TABLE IF EXISTS _alias_raw;")
    con.execute(
        "CREATE TEMP TABLE _alias_raw ("
        "brand_id VARCHAR, identifier_type VARCHAR, identifier_value VARCHAR, brain_id VARCHAR, "
        "tier VARCHAR, is_active BOOLEAN, created_at_ms BIGINT)"
    )
    if rows:
        con.executemany(
            "INSERT INTO _alias_raw VALUES (?,?,?,?,?,?,?)",
            [
                (
                    r.get("brand_id"),
                    r.get("identifier_type"),
                    r.get("identifier_value"),
                    r.get("brain_id"),
                    r.get("tier"),
                    (r.get("is_active") is True),
                    int(r["created_at_ms"]) if r.get("created_at_ms") is not None else None,
                )
                for r in rows
            ],
        )

    staged = """
        SELECT
          CAST(brand_id AS VARCHAR)         AS brand_id,
          CAST(identifier_type AS VARCHAR)  AS identifier_type,
          CAST(identifier_value AS VARCHAR) AS identifier_value,
          CAST(brain_id AS VARCHAR)         AS brain_id,
          CAST(tier AS VARCHAR)             AS tier,
          is_active                         AS is_active,
          CASE WHEN created_at_ms IS NULL THEN NULL
               ELSE make_timestamp(created_at_ms * 1000) END AS created_at,
          now() AS updated_at
        FROM _alias_raw
        WHERE identifier_value IS NOT NULL AND brand_id IS NOT NULL
    """

    n = merge_on_pk(
        con, TARGET, staged,
        ["brand_id", "identifier_type", "identifier_value", "brain_id",
         "tier", "is_active", "created_at", "updated_at"],
        ["brand_id", "identifier_type", "identifier_value"],
        order_by_desc=["updated_at"],
    )
    con.execute("DROP TABLE IF EXISTS _alias_raw;")
    return n


if __name__ == "__main__":
    run_job("silver-identity-alias", build, target_table=TABLE)
