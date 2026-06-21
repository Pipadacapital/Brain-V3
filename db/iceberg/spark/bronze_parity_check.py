"""
bronze_parity_check.py — the PG ⇄ Iceberg Bronze parity oracle (ADR-0002 Slice 3).

The cautious cut-over gate. Both Bronze sinks run in parallel during the migration:
  - Postgres bronze_events (the live stream-worker write — the current SoR)
  - Iceberg brain_bronze.collector_events (the Spark materializer — the target SoR)

Both consume the SAME collector.event.v1 topic, so once caught up they must hold the SAME set of
(brand_id, event_id) identities. This job proves that — row-for-row, per brand — and exits non-zero
on drift, so it can gate the reader cut-overs (Slices 4-6): no reader moves to Iceberg until parity
is green and stable.

Parity is IDENTITY-based, not payload-byte-based: the two writers serialize payload differently
(Node JSON.stringify vs Spark to_json) but the (brand_id, event_id) idempotency key — the thing that
guarantees no event loss / no double-count — must match exactly. A small transient delta is expected
while one sink is mid-batch; persistent drift is a real failure.

Reads PG via JDBC as the superuser (RLS-bypass — a global cross-brand reconciliation read, the same
posture as the StarRocks ETL reader), and Iceberg via the REST catalog. Run in Redpanda's netns so
postgres/iceberg-rest/minio DNS resolves — see run-bronze-parity.sh.
"""
import os
import sys

from pyspark.sql import functions as F

from bronze_materialize import TABLE, build_spark

PG_URL = os.environ.get("PARITY_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("PARITY_PG_USER", "brain")
PG_PASSWORD = os.environ.get("PARITY_PG_PASSWORD", "brain")
# Allowed transient delta (one sink mid-batch). Persistent drift above this fails the gate.
TOLERANCE = int(os.environ.get("PARITY_TOLERANCE", "0"))


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("ERROR")

    pg = (
        spark.read.format("jdbc")
        .option("url", PG_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        # Cast uuid → text so the keys compare to Iceberg's string columns.
        .option("query", "SELECT brand_id::text AS brand_id, event_id::text AS event_id FROM bronze_events")
        .load()
    ).select("brand_id", "event_id").dropDuplicates()

    ice = spark.table(TABLE).select("brand_id", "event_id").dropDuplicates()

    pg_n = pg.count()
    ice_n = ice.count()
    missing_in_iceberg = pg.subtract(ice)   # in PG, not yet in Iceberg
    missing_in_pg = ice.subtract(pg)        # in Iceberg, not in PG
    miss_ice_n = missing_in_iceberg.count()
    miss_pg_n = missing_in_pg.count()

    print("\n================ BRONZE PARITY (PG ⇄ Iceberg) ================", flush=True)
    print(f"  postgres bronze_events distinct (brand_id,event_id): {pg_n}", flush=True)
    print(f"  iceberg  collector_events distinct (brand_id,event_id): {ice_n}", flush=True)
    print(f"  in PG but MISSING in Iceberg: {miss_ice_n}", flush=True)
    print(f"  in Iceberg but MISSING in PG: {miss_pg_n}", flush=True)

    print("\n  per-brand counts (PG vs Iceberg):", flush=True)
    by_brand = (
        pg.groupBy("brand_id").agg(F.count("*").alias("pg"))
        .join(ice.groupBy("brand_id").agg(F.count("*").alias("iceberg")), "brand_id", "outer")
        .fillna(0)
        .withColumn("delta", F.col("pg") - F.col("iceberg"))
    )
    by_brand.orderBy(F.abs(F.col("delta")).desc()).show(20, truncate=False)

    if miss_ice_n > 0:
        print("  sample MISSING-in-Iceberg keys:", flush=True)
        missing_in_iceberg.show(5, truncate=False)
    if miss_pg_n > 0:
        print("  sample MISSING-in-PG keys:", flush=True)
        missing_in_pg.show(5, truncate=False)

    drift = miss_ice_n + miss_pg_n
    if drift > TOLERANCE:
        print(f"\n  RESULT: ✗ PARITY DRIFT = {drift} (tolerance {TOLERANCE}) — gate CLOSED", flush=True)
        sys.exit(1)
    print(f"\n  RESULT: ✓ PARITY OK (drift {drift} ≤ tolerance {TOLERANCE}) — gate OPEN", flush=True)


if __name__ == "__main__":
    main()
