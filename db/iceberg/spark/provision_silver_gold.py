"""
provision_silver_gold.py — one-shot: create the Iceberg brain_silver + brain_gold namespaces
(Brain V4 Phase 0, Area B). The seam later Silver and Gold Spark jobs reuse.

Phase 0 is NON-BREAKING and ADDITIVE: this creates EMPTY Iceberg Silver/Gold namespaces (plus one
canonical, empty smoke-test table in each) in the SAME local REST catalog over MinIO that Bronze
already uses. It changes NO existing read path, dbt model, or app code. It is the local-prod
equivalent of the Terraform-provisioned Glue Silver/Gold catalogs (which can be written but not
applied here) — so Spark can actually CREATE + MERGE Silver/Gold tables in local-prod and that is
verifiable this session, and StarRocks can see the namespaces via its external Iceberg catalog.

What it does (idempotent — safe to re-run, mirrors the Bronze `IF NOT EXISTS` discipline):
  1. CREATE NAMESPACE IF NOT EXISTS rest.brain_silver
  2. CREATE NAMESPACE IF NOT EXISTS rest.brain_gold
  3. CREATE TABLE IF NOT EXISTS one canonical empty table in each, demonstrating + locking in the
     medallion table conventions every later job inherits:
        - brand_id is the tenant key on EVERY table (first column; tenant partition anchor).
        - hidden partitioning by bucket(256, brand_id) + days(event-time) — same shape as Bronze.
        - money is bigint MINOR UNITS + a currency_code column (NEVER a float / NEVER a bare number).
        - format-v2 + zstd parquet + upsert disabled → idempotent MERGE WHEN NOT MATCHED (Bronze parity).
  4. MERGE a single zero-row-effect self-check (an empty USING set) to PROVE the MERGE path compiles
     against each freshly-created table — the Phase 0 exit-criterion ("Spark can CREATE + MERGE into
     an empty Iceberg Silver/Gold table").

These two tables are intentionally minimal scaffolds (`_provision_check` grain) — the real Silver/Gold
marts are added by Phase 1+ jobs using iceberg_base.create_iceberg_table. They exist so (a) the
namespace is non-empty and visible to StarRocks immediately, and (b) the CREATE+MERGE capability is
verifiable now. They can be dropped once real marts land; nothing reads them.

Run via spark-submit inside the Spark+Iceberg image — see run-provision-silver-gold.sh. All wiring is
env-overridable; dev defaults target the compose service names (iceberg-rest:8181, minio:9000).
"""
from __future__ import annotations  # Python 3.8 (Spark image): defer `list[str]` annotation eval.

import os

from pyspark.sql import SparkSession

from iceberg_base import (
    CATALOG,
    GOLD_NAMESPACE,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
    ensure_namespace,
)

# Canonical smoke-test table name in each namespace (the Phase-0 provision check grain).
SILVER_CHECK_TABLE = os.environ.get("SILVER_CHECK_TABLE", "_provision_check")
GOLD_CHECK_TABLE = os.environ.get("GOLD_CHECK_TABLE", "_provision_check")

# ── Canonical column contracts ────────────────────────────────────────────────────────────────────
# Silver = conformed event-grain. brand_id tenant key first; an event-time col for days() partitioning.
_SILVER_COLUMNS = """
          brand_id          string    NOT NULL,
          entity_id         string    NOT NULL,
          occurred_at       timestamp NOT NULL,
          ingested_at       timestamp NOT NULL,
          source            string,
          payload           string
""".strip("\n")

# Gold = business-truth aggregate grain. brand_id tenant key first; money is bigint MINOR UNITS plus a
# currency_code (HARD RULE) — never a float. A grain_date carries the days() partition / TTL anchor.
_GOLD_COLUMNS = """
          brand_id          string    NOT NULL,
          metric_key        string    NOT NULL,
          grain_date        timestamp NOT NULL,
          amount_minor      bigint    NOT NULL,
          currency_code     string    NOT NULL,
          computed_at       timestamp NOT NULL
""".strip("\n")


def _merge_self_check(spark: SparkSession, fqtn: str, key_cols: list[str]) -> None:
    """Prove the idempotent MERGE path compiles + runs against a freshly-created EMPTY table.

    Uses an empty USING source (LIMIT 0 over the table itself) so it is a true no-op — it writes
    nothing, but exercises the exact `MERGE INTO ... ON <keys> WHEN NOT MATCHED THEN INSERT *` shape
    Silver/Gold jobs use. If the table/format can't support MERGE, this fails loudly here.
    """
    on_clause = " AND ".join(f"t.{c} = s.{c}" for c in key_cols)
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (SELECT * FROM {fqtn} LIMIT 0) s
        ON {on_clause}
        WHEN NOT MATCHED THEN INSERT *
        """
    )


def provision(spark: SparkSession) -> None:
    # 1+2: the namespaces (the actual Phase-0 deliverable / the reuse seam).
    silver_ns = ensure_namespace(spark, SILVER_NAMESPACE)
    gold_ns = ensure_namespace(spark, GOLD_NAMESPACE)
    print(f"[provision] namespace ready: {silver_ns}", flush=True)
    print(f"[provision] namespace ready: {gold_ns}", flush=True)

    # 3: one canonical empty table in each (brand_id-first, money = minor units + currency, Bronze-parity props).
    silver_tbl = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        SILVER_CHECK_TABLE,
        _SILVER_COLUMNS,
        partitioned_by="bucket(256, brand_id), days(occurred_at)",
    )
    gold_tbl = create_iceberg_table(
        spark,
        GOLD_NAMESPACE,
        GOLD_CHECK_TABLE,
        _GOLD_COLUMNS,
        partitioned_by="bucket(256, brand_id), days(grain_date)",
    )
    print(f"[provision] table ready: {silver_tbl} ({spark.table(silver_tbl).count()} rows)", flush=True)
    print(f"[provision] table ready: {gold_tbl} ({spark.table(gold_tbl).count()} rows)", flush=True)

    # 4: prove CREATE + MERGE works against each empty table (the Phase-0 exit criterion).
    _merge_self_check(spark, silver_tbl, ["brand_id", "entity_id"])
    _merge_self_check(spark, gold_tbl, ["brand_id", "metric_key", "grain_date"])
    print("[provision] MERGE self-check OK on both Silver + Gold (idempotent, no-op) ✓", flush=True)

    print("\n[provision] namespaces in catalog:", flush=True)
    spark.sql(f"SHOW NAMESPACES IN {CATALOG}").show(truncate=False)
    print(f"[provision] tables in {silver_ns}:", flush=True)
    spark.sql(f"SHOW TABLES IN {silver_ns}").show(truncate=False)
    print(f"[provision] tables in {gold_ns}:", flush=True)
    spark.sql(f"SHOW TABLES IN {gold_ns}").show(truncate=False)
    print("[provision] DONE — brain_silver + brain_gold are CREATE+MERGE-able in local-prod ✓", flush=True)


def main() -> None:
    spark = build_spark("provision-silver-gold")
    spark.sparkContext.setLogLevel("WARN")
    provision(spark)


if __name__ == "__main__":
    main()
