"""
silver_identity_map.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_identity_map.py.

The BI-TEMPORAL identifier→brain_id map: for each identifier, one row per effective interval during which it
resolved to a given brain_id, end-dated when a merge moved it. Valid-time (effective_from/effective_to,
is_current) crossed with system-time (system_from/system_to, append-per-mutation).

SOURCE: Neo4j identity graph (identity SoR, ADR-0004) via the neo4j python driver — the SAME connector-safe
IDENTITY_MAP_CYPHER the Spark job uses (a flat MATCH … OPTIONAL MATCH … UNWIND emitting the CURRENT ('C')
canonical interval and, for a merged-away attach node, the SUPERSEDED ('S') closed interval). TYPED SENTINELS
(-1 epoch-ms, '' id) are converted back to NULL after read, exactly as Spark does.

customer_ref (public BRN- id) is derived FROM brain_id via the vendored pure _identity_ref.brain_ref
(byte-identical to the Spark UDF + the TS mirror).

GRAIN / PK (valid-time natural key): (brand_id, identifier_hash, brain_id, effective_from). effective_from
  falls back to epoch 0 when the origin created_at is missing so the PK is always non-null.

WRITE = BI-TEMPORAL APPEND-PER-MUTATION (AMD-07 R1): never rewrite validity columns in place. Two MERGE
  passes — Pass A closes the open system interval whose payload changed, Pass B inserts brand-new PKs AND the
  new version of changed PKs (an unchanged open row blocks the insert). Idempotent: an unchanged projection
  appends nothing. Plus the ONE-TIME legacy _backfill_system_time (runs first; a no-op on a fresh table).

PII: identifier_hash is a 64-hex HASH only. brand_id first. MONEY: none. STAGE-1 GATE: N/A (trusted
  projection). DATA-THIN DEV PATH: NEO4J_URI unset → EMPTY table (+ backfill runs regardless).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402
from _identity_ref import brain_ref  # noqa: E402 — vendored pure helper

TABLE = "silver_identity_map"
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.{TABLE}{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "brain_neo4j")

# Connector-safe flat MATCH … UNWIND — byte-identical to the Spark IDENTITY_MAP_CYPHER.
IDENTITY_MAP_CYPHER = (
    "MATCH (i:Identifier)-[r:IDENTIFIES]->(c:Customer) "
    "WHERE c.brain_id IS NOT NULL "
    "OPTIONAL MATCH (c)-[a:ALIAS_OF]->(nextc:Customer) WHERE a.valid_to IS NULL "
    "OPTIONAL MATCH _cano = (c)-[:ALIAS_OF*1..50]->(canon:Customer) "
    "WHERE all(rel IN relationships(_cano) WHERE rel.valid_to IS NULL) "
    "  AND NOT EXISTS { MATCH (canon)-[ra:ALIAS_OF]->() WHERE ra.valid_to IS NULL } "
    "UNWIND (CASE WHEN a IS NULL THEN ['C'] ELSE ['C', 'S'] END) AS rk "
    "RETURN i.brand_id AS brand_id, i.type AS identifier_type, i.hash AS identifier_hash, "
    "(CASE rk WHEN 'C' THEN coalesce(canon.brain_id, c.brain_id) ELSE c.brain_id END) AS brain_id, "
    "toFloat(coalesce(r.confidence, 1.0)) AS confidence, toInteger(coalesce(r.created_at, 0)) AS effective_from_ms, "
    "toInteger(CASE rk WHEN 'C' THEN -1 ELSE a.valid_from END) AS effective_to_ms, "
    "(CASE rk WHEN 'C' THEN '' ELSE nextc.brain_id END) AS replaced_by_brain_id, "
    "(CASE rk WHEN 'C' THEN '' ELSE coalesce(a.merge_id, '') END) AS merge_event_id, "
    "(rk = 'C') AS is_current"
)

COLUMNS_SQL = """
  brand_id             string    NOT NULL,
  identifier_hash      string    NOT NULL,
  identifier_type      string    NOT NULL,
  brain_id             string    NOT NULL,
  customer_ref         string,
  confidence           double,
  effective_from       timestamp,
  effective_to         timestamp,
  replaced_by_brain_id string,
  merge_event_id       string,
  is_current           boolean,
  system_from          timestamp,
  system_to            timestamp,
  updated_at           timestamp NOT NULL
""".strip("\n")

# Payload columns whose (null-safe) change defines a "mutation" — excludes PK, system axis, updated_at.
_PAYLOAD_COLS = [
    "identifier_type", "customer_ref", "confidence", "effective_to",
    "replaced_by_brain_id", "merge_event_id", "is_current",
]
_PK_COLS = ["brand_id", "identifier_hash", "brain_id", "effective_from"]
_ALL_COLS = [
    "brand_id", "identifier_hash", "identifier_type", "brain_id", "customer_ref", "confidence",
    "effective_from", "effective_to", "replaced_by_brain_id", "merge_event_id", "is_current",
    "system_from", "system_to", "updated_at",
]


def _backfill_system_time(con):
    """ONE-TIME legacy backfill (AMD-07 R1, best-effort). Rows landed by prior runs with NULL system_from
    get a system interval. Idempotent + re-entrant (gate = a system_from IS NULL row exists; the gate-clearing
    UPDATE runs LAST). On a fresh test table this is a no-op. Mirrors the Spark _backfill_system_time."""
    try:
        n = con.execute(f"SELECT count(*) FROM {TARGET} WHERE system_from IS NULL").fetchone()[0]
    except Exception:  # noqa: BLE001 — table absent/empty
        return
    if not n:
        return
    print(f"[silver-identity-map] one-time system-time backfill of {n} legacy row(s) (AMD-07 best-effort)", flush=True)
    # 1. superseded legacy rows: system_to = the superseding CURRENT row's system_from (== its updated_at).
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING (
          SELECT brand_id, identifier_hash, brain_id AS succ_brain_id, min(updated_at) AS succ_updated_at
          FROM {TARGET} WHERE is_current = true
          GROUP BY brand_id, identifier_hash, brain_id
        ) succ
        ON t.brand_id = succ.brand_id
           AND t.identifier_hash = succ.identifier_hash
           AND t.replaced_by_brain_id = succ.succ_brain_id
           AND t.is_current = false
           AND t.system_to IS NULL
        WHEN MATCHED THEN UPDATE SET system_to = succ.succ_updated_at;
        """
    )
    # 2. system_from = updated_at for every legacy row — LAST (clears the re-entrancy gate).
    con.execute(f"UPDATE {TARGET} SET system_from = updated_at WHERE system_from IS NULL;")


def _read_edges() -> list[dict]:
    from neo4j import GraphDatabase

    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        with driver.session() as session:
            return [dict(r) for r in session.run(IDENTITY_MAP_CYPHER)]
    finally:
        driver.close()


def _append_per_mutation(con):
    """Bi-temporal append-per-mutation over the staged rows in _idm_stage. Batch-dedup first (a re-pull can
    emit a PK twice), then Pass A (close changed open rows) + Pass B (insert brand-new + changed versions)."""
    part = ", ".join(_PK_COLS)
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _idm_stage_dedup AS
        SELECT * EXCLUDE (_rn) FROM (
          SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY system_from DESC) AS _rn
          FROM _idm_stage
        ) WHERE _rn = 1;
        """
    )
    on_pk = " AND ".join(f"t.{c} IS NOT DISTINCT FROM s.{c}" for c in _PK_COLS)
    same = " AND ".join(f"t.{c} IS NOT DISTINCT FROM s.{c}" for c in _PAYLOAD_COLS)
    collist = ", ".join(_ALL_COLS)
    ins_vals = ", ".join(f"s.{c}" for c in _ALL_COLS)
    # Pass A — close the superseded system interval (only when the payload actually changed).
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING (SELECT * FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL
        WHEN MATCHED AND NOT ({same}) THEN UPDATE SET system_to = s.system_from;
        """
    )
    # Pass B — insert brand-new PKs AND the new version of changed PKs (an unchanged open row blocks it).
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING (SELECT {collist} FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL AND ({same})
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({ins_vals});
        """
    )


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    # System-time backfill runs BEFORE the append (and even in the data-thin path). One-time + idempotent.
    _backfill_system_time(con)

    if not NEO4J_URI:
        print("[silver-identity-map] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]

    rows = _read_edges()
    con.execute("DROP TABLE IF EXISTS _idm_raw;")
    con.execute(
        "CREATE TEMP TABLE _idm_raw ("
        "brand_id VARCHAR, identifier_type VARCHAR, identifier_hash VARCHAR, brain_id VARCHAR, "
        "customer_ref VARCHAR, confidence DOUBLE, effective_from_ms BIGINT, effective_to_ms BIGINT, "
        "replaced_by_brain_id VARCHAR, merge_event_id VARCHAR, is_current BOOLEAN)"
    )
    if rows:
        con.executemany(
            "INSERT INTO _idm_raw VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    r.get("brand_id"),
                    r.get("identifier_type"),
                    r.get("identifier_hash"),
                    r.get("brain_id"),
                    brain_ref(r.get("brain_id")),  # customer_ref via the vendored pure helper
                    float(r["confidence"]) if r.get("confidence") is not None else None,
                    int(r["effective_from_ms"]) if r.get("effective_from_ms") is not None else None,
                    int(r["effective_to_ms"]) if r.get("effective_to_ms") is not None else None,
                    r.get("replaced_by_brain_id"),
                    r.get("merge_event_id"),
                    (r.get("is_current") is True),
                )
                for r in rows
            ],
        )

    # Convert TYPED SENTINELS back to NULL; effective_from anchors the PK (coalesce to epoch 0 if missing).
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _idm_stage AS
        SELECT
          CAST(brand_id AS VARCHAR)        AS brand_id,
          CAST(identifier_hash AS VARCHAR) AS identifier_hash,
          CAST(identifier_type AS VARCHAR) AS identifier_type,
          CAST(brain_id AS VARCHAR)        AS brain_id,
          CAST(customer_ref AS VARCHAR)    AS customer_ref,
          CAST(confidence AS DOUBLE)       AS confidence,
          COALESCE(
            CASE WHEN effective_from_ms IS NOT NULL THEN make_timestamp(effective_from_ms * 1000) END,
            TIMESTAMP '1970-01-01 00:00:00'
          ) AS effective_from,
          CASE WHEN effective_to_ms >= 0 THEN make_timestamp(effective_to_ms * 1000) ELSE NULL END AS effective_to,
          NULLIF(replaced_by_brain_id, '') AS replaced_by_brain_id,
          NULLIF(merge_event_id, '')       AS merge_event_id,
          (is_current = true)              AS is_current,
          now()                            AS system_from,
          CAST(NULL AS TIMESTAMP)          AS system_to,
          now()                            AS updated_at
        FROM _idm_raw
        WHERE brand_id IS NOT NULL AND identifier_hash IS NOT NULL AND brain_id IS NOT NULL;
        """
    )

    _append_per_mutation(con)
    con.execute("DROP TABLE IF EXISTS _idm_raw;")
    return con.execute(f"SELECT count(*) FROM {TARGET}").fetchone()[0]


if __name__ == "__main__":
    run_job("silver-identity-map", build, target_table=TABLE)
