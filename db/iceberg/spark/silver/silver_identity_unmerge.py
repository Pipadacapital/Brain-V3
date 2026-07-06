# SPEC: A.2.4 (WA-19)
"""
silver_identity_unmerge.py — the UNMERGE ledger: a deterministic projection of the Neo4j UnmergeEvent
audit nodes (identity SoR, ADR-0004) that the journey re-version job reads to UN-REVERT journeys a
prior merge moved.

WHY (the gap this closes): a MERGE is projected into silver_identity_map as a closed interval
(replaced_by_brain_id set) which gold_journey_events_reversion.py folds by transferring the absorbed
id's journey rows onto the survivor. An UNMERGE (admin merge-reversal, apps/core neo4j-identity-reader
unmergeCustomer) CLOSES that ALIAS_OF (valid_to set) and CREATES a `(:UnmergeEvent {...})` node. The
identity_map re-projects the absorbed identifiers back to the absorbed brain_id (bi-temporal restore),
but nothing tells the journey ledger to move the transferred journey rows BACK. This table is that
signal: one row per committed unmerge, watermarked on unmerged_at, so the reversion job can un-revert
exactly the transfer the merge made — additive, auditable, replay-idempotent (append-only SoR).

SOURCE = Neo4j UnmergeEvent nodes (SAME connector posture + data-thin dev path as
silver_identity_map.py / silver_identity_alias.py). The node is created in one atomic tx with the
ALIAS_OF close, so this projection is a deterministic read of an append-only graph.

PII: brain_ids + a merge_event_id (uuid) + an operator actor id + an optional free-text reason — NO
raw PII (I-S02). brand_id is the first column / tenant key. MONEY: none. STAGE-1 GATE: N/A — trusted
projection of the identity SoR (same rationale as silver_identity_map).

DATA-THIN DEV PATH: if NEO4J_URI is unset the job creates the correctly-shaped EMPTY table and returns
(Neo4j is empty in dev) — so the generic v4-silver cron loop never breaks. Parity status = NEW.

Run: picked up by the generic v4-silver cron loop (silver/silver_*.py) or run-silver-identity-unmerge.sh.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/iceberg/spark

from _silver_base import ensure_silver_table, merge_on_pk, run_job  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.functions import col, lit  # noqa: E402

TABLE = "silver_identity_unmerge"

NEO4J_URI = os.environ.get("NEO4J_URI", "").strip()
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

# Flat MATCH … RETURN — the shape the Neo4j Spark connector proves it handles (see silver_identity_map).
# TYPED SENTINELS ('' for a null id, 0 for a null epoch-ms) keep every column concretely typed in row 1
# so the connector's schema inference can't stall on an all-null column; Spark converts them back.
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


def _ms_to_ts(col_ms):
    """Neo4j epoch-millis (nullable / sentinel 0) → Spark timestamp (null-safe)."""
    return F.when(col_ms > lit(0), F.to_timestamp(F.from_unixtime(col_ms / lit(1000)))).otherwise(
        F.lit(None).cast("timestamp")
    )


def build(spark):
    fqtn = ensure_silver_table(spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id)")

    if not NEO4J_URI:
        print("[silver-identity-unmerge] NEO4J_URI not set — created EMPTY table (data-thin path).", flush=True)
        return fqtn, spark.table(fqtn).count()

    events = (
        spark.read.format("org.neo4j.spark.DataSource")
        .option("url", NEO4J_URI)
        .option("authentication.type", "basic")
        .option("authentication.basic.username", NEO4J_USER)
        .option("authentication.basic.password", NEO4J_PASSWORD)
        .option("query", UNMERGE_CYPHER)
        .option("connection.timeout", os.environ.get("NEO4J_CONNECTION_TIMEOUT_MS", "30000"))
        .option("connection.acquisition.timeout", os.environ.get("NEO4J_ACQUIRE_TIMEOUT_MS", "60000"))
        .load()
    )

    def _blank_to_null(c):
        return F.when(col(c) == lit(""), F.lit(None).cast("string")).otherwise(col(c))

    staged = (
        events.select(
            col("brand_id"),
            col("absorbed_brain_id"),
            _blank_to_null("survivor_brain_id").alias("survivor_brain_id"),
            _blank_to_null("merge_event_id").alias("merge_event_id"),
            _blank_to_null("actor").alias("actor"),
            _blank_to_null("reason").alias("reason"),
            _ms_to_ts(col("unmerged_at_ms")).alias("unmerged_at"),
            F.current_timestamp().alias("updated_at"),
        )
        .where(col("brand_id").isNotNull() & col("absorbed_brain_id").isNotNull())
        # unmerged_at anchors the interval key; a missing timestamp falls back to epoch 0 so the PK is
        # always non-null (honest — a re-run of the same unmerge upserts the same row, idempotent).
        .withColumn("unmerged_at", F.coalesce(col("unmerged_at"), F.to_timestamp(lit("1970-01-01 00:00:00"))))
    )

    merge_on_pk(
        spark, fqtn, staged,
        ["brand_id", "absorbed_brain_id", "unmerged_at"],
        order_by_desc=["updated_at"],
    )
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-identity-unmerge", build)
