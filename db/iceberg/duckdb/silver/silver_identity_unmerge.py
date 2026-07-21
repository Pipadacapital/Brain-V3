"""
silver_identity_unmerge.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_identity_unmerge.py.

The UNMERGE ledger: a deterministic projection of the Neo4j UnmergeEvent audit nodes (identity SoR,
ADR-0004) that the journey re-version job reads to un-revert journeys a prior merge moved.

SOURCE: Neo4j UnmergeEvent nodes via the neo4j python driver — SAME UNMERGE_CYPHER as the Spark job
(TYPED SENTINELS '' / 0 for null id / epoch-ms, converted back to NULL after read).

GRAIN / PK: (brand_id, absorbed_brain_id, unmerged_at) — one row per committed unmerge, append-only SoR
  → replay-idempotent. unmerged_at falls back to epoch 0 so the PK is always non-null.

PII: brain_ids + a merge_event_id (uuid) + an operator actor + optional free-text reason — NO raw PII.
STAGE-1 GATE: N/A — trusted projection of the identity SoR. DATA-THIN DEV PATH: NEO4J_URI unset → EMPTY.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

TABLE = "silver_identity_unmerge"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "brain_neo4j")

# Flat MATCH … RETURN with TYPED SENTINELS ('' id, 0 epoch-ms) — byte-identical to the Spark UNMERGE_CYPHER.
UNMERGE_CYPHER = (
    "MATCH (ue:UnmergeEvent) "
    "WHERE ue.brand_id IS NOT NULL AND ue.absorbed_brain_id IS NOT NULL "
    "RETURN ue.brand_id AS brand_id, ue.absorbed_brain_id AS absorbed_brain_id, "
    "coalesce(ue.survivor_brain_id, '') AS survivor_brain_id, "
    "coalesce(ue.merge_event_id, '') AS merge_event_id, "
    "coalesce(ue.actor, '') AS actor, coalesce(ue.reason, '') AS reason, "
    "toInteger(coalesce(ue.unmerged_at, 0)) AS unmerged_at_ms"
)

COLUMNS_SQL = """
  brand_id          string    NOT NULL,
  absorbed_brain_id string    NOT NULL,
  survivor_brain_id string,
  merge_event_id    string,
  actor             string,
  reason            string,
  unmerged_at       timestamp,
  updated_at        timestamp NOT NULL
""".strip("\n")


def _read_events() -> list[dict]:
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session() as session:
            return [dict(r) for r in session.run(UNMERGE_CYPHER)]
    finally:
        driver.close()


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL)

    if not NEO4J_URI:
        print("[silver-identity-unmerge] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]

    rows = _read_events()
    con.execute("DROP TABLE IF EXISTS _unmerge_raw;")
    con.execute(
        "CREATE TEMP TABLE _unmerge_raw ("
        "brand_id VARCHAR, absorbed_brain_id VARCHAR, survivor_brain_id VARCHAR, merge_event_id VARCHAR, "
        "actor VARCHAR, reason VARCHAR, unmerged_at_ms BIGINT)"
    )
    if rows:
        con.executemany(
            "INSERT INTO _unmerge_raw VALUES (?,?,?,?,?,?,?)",
            [
                (
                    r.get("brand_id"),
                    r.get("absorbed_brain_id"),
                    r.get("survivor_brain_id"),
                    r.get("merge_event_id"),
                    r.get("actor"),
                    r.get("reason"),
                    int(r["unmerged_at_ms"]) if r.get("unmerged_at_ms") is not None else 0,
                )
                for r in rows
            ],
        )

    # Sentinels '' → NULL; unmerged_at from ms>0 else epoch 0 (coalesced so PK non-null), matching Spark.
    staged = """
        SELECT
          CAST(brand_id AS VARCHAR)          AS brand_id,
          CAST(absorbed_brain_id AS VARCHAR) AS absorbed_brain_id,
          NULLIF(survivor_brain_id, '')      AS survivor_brain_id,
          NULLIF(merge_event_id, '')         AS merge_event_id,
          NULLIF(actor, '')                  AS actor,
          NULLIF(reason, '')                 AS reason,
          COALESCE(
            CASE WHEN unmerged_at_ms > 0 THEN make_timestamp(unmerged_at_ms * 1000) END,
            TIMESTAMP '1970-01-01 00:00:00'
          ) AS unmerged_at,
          now() AS updated_at
        FROM _unmerge_raw
        WHERE brand_id IS NOT NULL AND absorbed_brain_id IS NOT NULL
    """

    n = merge_on_pk(
        con, TARGET, staged,
        ["brand_id", "absorbed_brain_id", "survivor_brain_id", "merge_event_id",
         "actor", "reason", "unmerged_at", "updated_at"],
        ["brand_id", "absorbed_brain_id", "unmerged_at"],
        order_by_desc=["updated_at"],
    )
    con.execute("DROP TABLE IF EXISTS _unmerge_raw;")
    return n


if __name__ == "__main__":
    run_job("silver-identity-unmerge", build, target_table=TABLE, source_table=None)  # A3: graph projection, no keystone pin
