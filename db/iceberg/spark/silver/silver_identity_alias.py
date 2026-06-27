"""
silver_identity_alias.py — NET-NEW canonical Silver `identity_alias` entity (Brain V4 Phase 1, GROUP new-entities).

NO dbt predecessor (parity status=NEW). The Iceberg-Silver projection of the identity graph's IDENTIFIES
edges — one row per (brand_id, identifier_type, identifier_value): a hashed identifier (64-hex, NEVER raw
PII) → the resolved brain_id. This is the Spark→Iceberg sibling of the existing StarRocks
brain_ops.silver_identity_link (materialized by apps/stream-worker/.../identity-export/run.ts).

WHY this exists (ADR-0004 / identity SoR = Neo4j): dbt/StarRocks cannot read Neo4j, so identity has no dbt
model — the stream-worker exports it to StarRocks for the dbt marts. Brain V4 moves the Silver layer onto
Spark→Iceberg, so this job exports the SAME Neo4j edges into Iceberg brain_silver (dual-run, ADDITIVE — it
does NOT replace the StarRocks export; the existing reader still reads StarRocks).

SOURCE  : the Neo4j identity graph (the identity SoR). Read via the Neo4j Spark connector
          (org.neo4j:neo4j-connector-apache-spark) — the SAME IDENTIFIES-edge Cypher the stream-worker
          identity-export uses. Credentials are ENV-CONFIGURED (NEO4J_URI/USER/PASSWORD), NEVER hardcoded —
          mirrors the existing job. Set NEO4J_URI to enable; absent → the job creates the EMPTY table and
          skips the read (the data-thin path, see below).
GRAIN   : 1 row per (brand_id, identifier_type, identifier_value). brain_id is the resolved customer;
          is_active mirrors the edge state (tombstoned on GDPR erase). tier drives CAPI subject-hash choice.
PII     : identifier_value is a 64-hex HASH only (the resolver hashes raw identifiers at the boundary) —
          this job NEVER reads or writes a raw email/phone. HARD RULE honored.
MONEY   : none (an identity mapping carries no money).
ISOLATION: brand_id first column + bucket() partition anchor.
STAGE-1 GATE (Brain V4 two-stage, _silver_technical.py): N/A — this is a TRUSTED PROJECTION of the Neo4j
          identity SoR (ADR-0004), not a Bronze-derived business record, so no Stage-1 reject rule genuinely
          applies and none is FORCED (per the V4 gate rule: do not invent checks for a pure identity/graph
          projection). Zero money (no negative/non-integer/currency DQ gate), zero quantity (no impossible-
          quantity gate), and NO non-PII display/name to clean: identifier_value is a 64-hex HASH and
          identifier_type / tier are enum tokens — running clean_name/clean_string on the hash would VIOLATE
          the hash-only PII rule (ids/hashes are never cleaned or lowercased), and brain_id is a UUID
          surrogate, not display text. created_at is a SoR-surrogate edge timestamp (Neo4j epoch), not an
          event occurred_at subject to future/unparseable validation. The (brand_id, identifier_type,
          identifier_value) PK + brain_id resolution come straight from the Neo4j edge (never minted here);
          their non-null invariants are enforced structurally (Cypher `c.brain_id IS NOT NULL` + the
          isNotNull where-filter + Iceberg NOT NULL columns = the schema gate). Nothing diverts to
          brain_silver.silver_quarantine; good rows stay byte-identical.

DATA AVAILABILITY (this session): Neo4j is empty in this dev run (StarRocks silver_identity_link = 0 rows),
and NEO4J_URI is intentionally NOT supplied to this batch container, so the job writes a correct EMPTY
Iceberg table. Schema is the deliverable; supplying NEO4J_URI + creds (as the stream-worker job receives
them) populates it with no code change. Parity status=NEW.
"""
from __future__ import annotations

import os

from _silver_base import ensure_silver_table, merge_on_pk, run_job
from pyspark.sql import functions as F
from pyspark.sql.functions import col, lit

TABLE = "silver_identity_alias"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

# The active-edge export Cypher — mirrors identity-export/run.ts (FULL projection of active IDENTIFIES edges).
# F2 ALIAS-RESOLVE: brain_id is the CANONICAL (survivor) — follow the live ALIAS_OF chain to its terminal
# node (multi-hop *1..50 cycle-safe; live-only valid_to IS NULL; canon has no live outgoing ALIAS_OF), so
# snap_identity_link (which reads this Iceberg projection) carries the canonical brain_id after a merge, not
# the dead alias. coalesce(canon.brain_id, c.brain_id) = canonical for a merged node, own brain_id otherwise.
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


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)"
    )

    if not NEO4J_URI:
        # Data-thin path: no Neo4j endpoint supplied to this batch container. The EMPTY, correctly-shaped
        # table IS the deliverable for this session (Neo4j is empty in dev anyway). A run WITH NEO4J_URI +
        # the neo4j-spark connector on the classpath populates it identically — no code change.
        print("[silver-identity-alias] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return fqtn, spark.table(fqtn).count()

    edges = (
        spark.read.format("org.neo4j.spark.DataSource")
        .option("url", NEO4J_URI)
        .option("authentication.type", "basic")
        .option("authentication.basic.username", NEO4J_USER)
        .option("authentication.basic.password", NEO4J_PASSWORD)
        .option("query", IDENTITY_CYPHER)
        .load()
    )

    staged = edges.select(
        col("brand_id"),
        col("identifier_type"),
        col("identifier_value"),
        col("brain_id"),
        col("tier"),
        (col("is_active") == lit(True)).alias("is_active"),
        # Neo4j epoch-millis → timestamp (the export stores created_at as epoch ms, see toMs()).
        F.to_timestamp(F.from_unixtime(col("created_at_ms") / lit(1000))).alias("created_at"),
        F.current_timestamp().alias("updated_at"),
    ).where(col("identifier_value").isNotNull() & col("brand_id").isNotNull())

    merge_on_pk(
        spark, fqtn, staged,
        ["brand_id", "identifier_type", "identifier_value"],
        order_by_desc=["updated_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-identity-alias", build)
