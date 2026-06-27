"""
silver_customer_identity.py — Spark re-home of the TS `identity-export` CUSTOMER projection
(Brain V4 Phase 1, customer+identity group). Reads the Neo4j identity graph (the identity SoR per
ADR-0004) and idempotently MERGEs the Customer-node projection into Iceberg
`brain_silver.silver_customer_identity`, reproducing EXACTLY what
apps/stream-worker/src/jobs/identity-export/run.ts writes to the StarRocks PRIMARY KEY table.

WHY NEO4J, NOT ICEBERG BRONZE (the load-bearing architectural fact):
  Identity is the Neo4j system-of-record (ADR-0004). dbt/StarRocks/Spark cannot read Neo4j as a
  table, so the TS identity-export job materializes Neo4j Customer nodes → StarRocks
  brain_silver.silver_customer_identity, which the dbt silver_customer mart then LEFT JOINs for
  acquisition/lifecycle attributes (first_identified_at, lifecycle_state, merged_into, minted_at).
  silver_customer_identity is therefore NOT a Bronze-derived mart — it is the lakehouse projection of
  the Neo4j graph. This Spark job re-homes that SAME export contract onto the Spark→Iceberg dual-run
  path: same source (Neo4j), same grain (one row per brand_id, brain_id), same columns, idempotent
  MERGE on the PK. "brain_id resolution stays via the Neo4j export contract" (task rule) is honored —
  brain_id comes only from the Neo4j Customer node, never minted or guessed here.

GRAIN: exactly one row per (brand_id, brain_id) — the model PK. MERGE WHEN MATCHED THEN UPDATE so a
  lifecycle mutation (merged/split/erased, merged_into) propagates on re-run (the TS job's tombstone
  sweep); WHEN NOT MATCHED THEN INSERT for new customers. Replay-safe + idempotent (re-run over an
  unchanged graph → no row content change).

PII / ISOLATION (this is the PII-SENSITIVE group):
  - NO raw PII is read or written. The Customer node carries only brain_id (a UUID surrogate) +
    coarse lifecycle/timestamp attributes. The hashed identifiers (email/phone hashes) live on the
    SEPARATE Identifier→IDENTIFIES→Customer edges, which this CUSTOMER projection deliberately does
    NOT read (those are silver_identity_link's job, a different model). So this job touches zero PII.
  - brand_id is the FIRST column on every row (tenant key); the Iceberg table is bucket(brand_id)-
    partitioned and isolation is enforced at the downstream read seam, identical to the dbt model.
  - GDPR-erasure note: on a GDPR erase the Neo4j writer sets c.lifecycle_state='erased' (and tombstones
    the Identifier edges). This FULL projection re-reads EVERY active+non-active Customer each run, so
    an 'erased' lifecycle_state propagates here on the next run (the dbt silver_customer mart excludes
    lifecycle_state <> 'merged' but NOT 'erased' — see notes; erased-customer suppression is enforced
    upstream by the edge tombstone removing all identifiers, leaving the customer node un-joinable to
    any order). This job preserves that contract; it does not weaken it.

STAGE-1 GATE (Brain V4 two-stage, _silver_technical.py): N/A — this job is a TRUSTED PROJECTION of the
  Neo4j identity SoR (ADR-0004), NOT a Bronze-derived business record, so no Stage-1 reject rule genuinely
  applies and none is FORCED (per the V4 gate rule: do not invent checks for a pure identity/graph
  projection). Concretely: zero money columns (no negative/non-integer/currency DQ gate), zero quantity
  field (no impossible-quantity gate), and NO non-PII display/name field to clean — brain_id / merged_into
  are UUID identity surrogates that must NEVER be cleaned/lowercased (clean_name/clean_string are for non-PII
  display text only, and this projection touches zero PII at all). minted_at / first_identified_at are
  SoR-surrogate node timestamps (Neo4j created/first-identified epochs), not event occurred_at subject to
  future/unparseable-timestamp validation. The (brand_id, brain_id) PK invariants are enforced structurally
  (Cypher `brain_id IS NOT NULL` + the isNotNull where-filter + Iceberg NOT NULL columns = the schema gate);
  brain_id is never minted or guessed here. Nothing diverts to brain_silver.silver_quarantine; good rows
  remain byte-identical (parity-faithful).

PARITY: the dbt-side current table is brain_silver.silver_customer_identity in StarRocks (populated by
  the TS identity-export job). The parity oracle compares this Iceberg table vs that StarRocks one on
  PK (brand_id, brain_id). No money columns (identity carries none).

Run via spark-submit inside the Spark+Iceberg image with the Neo4j Spark connector on the classpath —
see ../run-silver-customer.sh. All wiring is env-overridable; dev defaults target the compose service
names (iceberg-rest:8181, minio:9000, neo4j:7687).
"""
from __future__ import annotations  # Python 3.8 on the Spark image — defer annotation eval.

import os
import sys

# Make iceberg_base importable whether this file is submitted directly (its dir on sys.path) or the
# parent spark/ dir is mounted. The run script mounts spark/ at /opt/spike, so add the parent dir.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql import functions as F  # noqa: E402
from pyspark.sql.window import Window  # noqa: E402

from iceberg_base import SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

# ── Neo4j (the identity SoR) wiring — mirrors apps/stream-worker .../identity-export/run.ts ────────
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USER = os.environ.get("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "brain_neo4j")

TABLE_NAME = "silver_customer_identity"

# Column contract — byte-for-byte the StarRocks silver_customer_identity DDL
# (db/starrocks/silver_customer_identity.sql), expressed as Iceberg types. brand_id first (tenant key).
_COLUMNS = """
          brand_id            string    NOT NULL,
          brain_id            string    NOT NULL,
          lifecycle_state     string,
          merged_into         string,
          minted_at           timestamp,
          first_identified_at timestamp,
          updated_at          timestamp
""".strip("\n")


def _read_customers(spark: SparkSession):
    """Read Customer nodes from Neo4j and project EXACTLY the identity-export CUSTOMER query.

    Mirrors run.ts mapCustomer / the FULL-refresh Cypher:
        MATCH (c:Customer) WHERE c.brain_id IS NOT NULL
        RETURN brand_id, brain_id, lifecycle_state, merged_into,
               created_at AS minted_at, first_identified_at

    We always read the FULL active+non-active set (the Spark dual-run is a periodic full projection;
    the TS job's incremental watermark is a perf optimization, not a correctness requirement — a full
    read yields the identical end-state, which is what parity compares). Epoch-millis numeric props
    (created_at / first_identified_at, stored as Neo4j numbers) → Iceberg timestamp via from_unixtime
    on the SECONDS value (millis/1000), matching the TS `new Date(ms)` → 'yyyy-MM-dd HH:mm:ss' mapping.
    """
    raw = (
        spark.read.format("org.neo4j.spark.DataSource")
        .option("url", NEO4J_URI)
        .option("authentication.type", "basic")
        .option("authentication.basic.username", NEO4J_USER)
        .option("authentication.basic.password", NEO4J_PASSWORD)
        .option(
            "query",
            # brain_id NOT NULL == a real, minted customer. merged_into is absent on active nodes →
            # coalesce to null in Cypher so the column always projects. lifecycle_state default 'active'
            # is NOT applied here (the TS job passes the raw value through; dbt filters <> 'merged').
            "MATCH (c:Customer) WHERE c.brain_id IS NOT NULL "
            "RETURN c.brand_id AS brand_id, c.brain_id AS brain_id, "
            "c.lifecycle_state AS lifecycle_state, c.merged_into AS merged_into, "
            "c.created_at AS minted_at_ms, c.first_identified_at AS first_identified_at_ms",
        )
        # The connector needs a partition/row count hint for a custom read query.
        .option("partitions", "1")
        .load()
    )

    def _ms_to_ts(col_name: str):
        # Neo4j numeric epoch-millis → timestamp. Cast to long (drop the float fractional millis),
        # divide to seconds, from_unixtime → timestamp. Null-safe (null ms → null ts).
        ms = F.col(col_name).cast("long")
        return F.when(ms.isNull(), F.lit(None).cast("timestamp")).otherwise(
            (ms / F.lit(1000)).cast("timestamp")
        )

    return raw.select(
        F.col("brand_id").cast("string").alias("brand_id"),
        F.col("brain_id").cast("string").alias("brain_id"),
        F.col("lifecycle_state").cast("string").alias("lifecycle_state"),
        F.col("merged_into").cast("string").alias("merged_into"),
        _ms_to_ts("minted_at_ms").alias("minted_at"),
        _ms_to_ts("first_identified_at_ms").alias("first_identified_at"),
        F.current_timestamp().alias("updated_at"),
    ).where(F.col("brand_id").isNotNull() & F.col("brain_id").isNotNull())


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        # Tenant-first hidden partitioning (brand_id bucket), like the Bronze/provision convention.
        partitioned_by="bucket(8, brand_id)",
    )

    src = _read_customers(spark)
    # Defensive dedup within the projection: one row per (brand_id, brain_id). A Customer node is unique
    # by brain_id already, but guard against any duplicate projection (keep the latest minted_at).
    deduped = (
        src.withColumn(
            "_rn",
            F.row_number().over(
                Window.partitionBy("brand_id", "brain_id").orderBy(F.col("minted_at").desc_nulls_last())
            ),
        )
        .where(F.col("_rn") == 1)
        .drop("_rn")
    )
    # DETACH from the Neo4j connector before the MERGE. The Neo4j Spark connector closes its
    # FixedChannelPool after the FIRST action on a read DataFrame; any SECOND evaluation of the same
    # source (the MERGE re-scans `sci_src`, plus the final table count) then fails with
    # "Connection pool for server neo4j:7687 is closed". So we materialize the projection ONCE to the
    # driver and rebuild a fresh, connector-independent DataFrame that the MERGE reads — a single Neo4j
    # scan, no re-evaluation. The set is small (one row per customer), so the collect is cheap + safe.
    rows = deduped.collect()
    n = len(rows)
    src_schema = deduped.schema
    materialized = spark.createDataFrame(rows, src_schema) if n else spark.createDataFrame([], src_schema)
    materialized.createOrReplaceTempView("sci_src")

    # Idempotent MERGE on the model PK. WHEN MATCHED THEN UPDATE so lifecycle/merged_into mutations
    # (the TS tombstone sweep) propagate on re-run; WHEN NOT MATCHED THEN INSERT for new customers.
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING sci_src s
        ON t.brand_id = s.brand_id AND t.brain_id = s.brain_id
        WHEN MATCHED THEN UPDATE SET
          t.lifecycle_state     = s.lifecycle_state,
          t.merged_into         = s.merged_into,
          t.minted_at           = s.minted_at,
          t.first_identified_at = s.first_identified_at,
          t.updated_at          = s.updated_at
        WHEN NOT MATCHED THEN INSERT (
          brand_id, brain_id, lifecycle_state, merged_into, minted_at, first_identified_at, updated_at
        ) VALUES (
          s.brand_id, s.brain_id, s.lifecycle_state, s.merged_into, s.minted_at, s.first_identified_at, s.updated_at
        )
        """
    )
    total = spark.table(fqtn).count()
    print(
        f"[silver_customer_identity] MERGEd {n} Neo4j Customer projection rows → {fqtn} "
        f"(table now {total} rows)",
        flush=True,
    )
    return fqtn


def main() -> None:
    spark = build_spark("silver-customer-identity")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[silver_customer_identity] DONE — Iceberg projection populated from Neo4j (no PII) ✓", flush=True)


if __name__ == "__main__":
    main()
