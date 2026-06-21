"""validate_bronze.py — inspect the Iceberg Bronze table the spike wrote (ADR-0002 Slice 2).

Prints row count, the Iceberg partition metadata (proves bucket(16, brand_id) + days(occurred_at)),
the table's partition spec, and a sample row. Reuses the same catalog wiring as the materializer.
"""
from bronze_materialize import TABLE, build_spark


def main() -> None:
    spark = build_spark()
    spark.sparkContext.setLogLevel("ERROR")

    print(f"\n=== row count: {TABLE} ===", flush=True)
    print(spark.table(TABLE).count(), flush=True)

    print("\n=== distinct event_type ===", flush=True)
    spark.sql(f"SELECT event_type, count(*) AS n FROM {TABLE} GROUP BY event_type ORDER BY n DESC").show(truncate=False)

    print("\n=== Iceberg partitions (proves bucket(brand_id)+days(occurred_at)) ===", flush=True)
    spark.sql(f"SELECT partition, record_count, file_count FROM {TABLE}.partitions ORDER BY record_count DESC LIMIT 10").show(truncate=False)

    print("\n=== table partition spec (DESCRIBE) ===", flush=True)
    spark.sql(f"DESCRIBE TABLE EXTENDED {TABLE}").show(n=100, truncate=False)

    print("\n=== sample row ===", flush=True)
    spark.sql(f"SELECT event_id, brand_id, occurred_at, event_type, partition_key FROM {TABLE} LIMIT 2").show(truncate=False)


if __name__ == "__main__":
    main()
