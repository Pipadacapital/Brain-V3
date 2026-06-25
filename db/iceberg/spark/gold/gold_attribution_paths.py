"""
gold_attribution_paths.py — Spark reimplementation of the dbt gold_attribution_paths mart (Brain V4
Phase 2, GROUP attribution). Reproduces db/dbt/models/marts/gold_attribution_paths.sql EXACTLY: the
JOURNEY/PATH-grain attribution mart — ONE row per CONVERTED journey (brand_id, brain_anon_id,
stitched_order_id) with the ORDERED multi-touch channel path, first/last-touch channel, touch counts,
and the path span. READS Iceberg brain_silver.silver_touchpoint, WRITES Iceberg
brain_gold.gold_attribution_paths via MERGE on the PK.

This runs BESIDE the live dbt→StarRocks gold_attribution_paths (dual-run, NON-BREAKING): repoints NO
reader, changes NO dbt, touches NO app code.

NO MONEY (per the dbt model header): the path is not monetary — there is NO money column. Revenue joins
at read via stitched_order_id → gold_revenue_ledger. So this mart's parity is row-identity ONLY (keyed by
the PK), no per-currency Σ.

THE TRANSFORM (folded from the dbt model, reproduced byte-for-byte):
  converted_touches = silver_touchpoint WHERE stitched_order_id IS NOT NULL (a CONVERTED journey — the
                      deterministic read-back stitch; un-stitched journeys have no conversion → excluded).
  endpoints         = per (brand_id, brain_anon_id, stitched_order_id): the first/last touch channel
                      derived from min/max of an lpad(touch_seq,10,'0')||'|'||channel encoding — so the
                      MIN/MAX picks the channel at the smallest/largest touch_seq deterministically.
  result            = GROUP BY (brand_id, brain_anon_id, stitched_order_id):
                        stitched_brain_id        = max(stitched_brain_id)
                        channel_path             = group_concat(channel ORDER BY touch_seq, occurred_at
                                                                 SEPARATOR ' > ')  → an ordered ' > ' join
                        touch_count              = count(*)::bigint
                        distinct_channel_count   = count(distinct channel)::bigint
                        first_touch_channel      = substring_index(max(_first_enc), '|', -1)
                        last_touch_channel       = substring_index(max(_last_enc),  '|', -1)
                        path_start_at / path_end_at = min/max(occurred_at)
                        updated_at               = current_timestamp()

PARITY: current side = StarRocks brain_gold.gold_attribution_paths (dbt). PK (brand_id, brain_anon_id,
stitched_order_id); NO money column → row-identity parity. NOTE: with 0 stitched touchpoints in the
current Silver (stitched_order_id NULL for all rows), the converted set is EMPTY → 0 path rows, exactly
like the live empty StarRocks mart (parity-exact dual-run). The ordering (touch_seq ASC, occurred_at ASC)
+ ' > ' separator are byte-for-byte the dbt group_concat so paths match the moment stitch data exists.

Run via run-gold-attribution.sh.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.utils import AnalysisException  # noqa: E402

from iceberg_base import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, build_spark, create_iceberg_table  # noqa: E402

TABLE_NAME = "gold_attribution_paths"

# Column contract — the dbt gold_attribution_paths select list. brand_id first (tenant key). NO money.
_COLUMNS = """
          brand_id               string    NOT NULL,
          brain_anon_id          string    NOT NULL,
          stitched_order_id      string    NOT NULL,
          stitched_brain_id      string,
          channel_path           string,
          touch_count            bigint    NOT NULL,
          distinct_channel_count bigint    NOT NULL,
          first_touch_channel    string,
          last_touch_channel     string,
          path_start_at          timestamp,
          path_end_at            timestamp,
          updated_at             timestamp NOT NULL
""".strip("\n")


def _read_silver_touchpoint(spark: SparkSession):
    fqtn = f"{CATALOG}.{SILVER_NAMESPACE}.silver_touchpoint"
    try:
        df = spark.table(fqtn)
        df.schema
        return df
    except (AnalysisException, Exception) as exc:  # noqa: BLE001
        msg = str(exc).lower()
        if any(s in msg for s in ("not found", "does not exist", "no such", "nosuchtable", "cannot be found")):
            raise SystemExit(
                f"[gold_attribution_paths] REQUIRED Iceberg table {fqtn} is absent — build the Phase-1 "
                f"silver_touchpoint Spark mart first."
            )
        raise


def materialize(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, GOLD_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(8, brand_id)"
    )
    _read_silver_touchpoint(spark).createOrReplaceTempView("silver_touchpoint")

    # The dbt transform, folded into one Spark SQL. Spark's concat_ws(...,collect_list over a window) is
    # NOT order-stable; instead use array_join(sort_array(collect_list(struct(...))) ...) to order by
    # (touch_seq, occurred_at) then project the channel — byte-identical to the dbt group_concat ordering.
    # The lpad(touch_seq,10)||'|'||channel min/max picks the endpoint channel exactly as the dbt model does.
    result_sql = """
        with converted_touches as (
            select
                brand_id, brain_anon_id, stitched_order_id, stitched_brain_id,
                touch_seq, occurred_at, channel
            from silver_touchpoint
            where stitched_order_id is not null
        ),
        endpoints as (
            select
                brand_id, brain_anon_id, stitched_order_id,
                min(case when touch_seq is not null
                         then concat(lpad(cast(touch_seq as string), 10, '0'), '|', channel) end) as _first_enc,
                max(case when touch_seq is not null
                         then concat(lpad(cast(touch_seq as string), 10, '0'), '|', channel) end) as _last_enc
            from converted_touches
            group by brand_id, brain_anon_id, stitched_order_id
        ),
        ordered_paths as (
            select
                brand_id, brain_anon_id, stitched_order_id,
                max(stitched_brain_id) as stitched_brain_id,
                array_join(
                    transform(
                        sort_array(collect_list(struct(touch_seq, occurred_at, channel))),
                        x -> x.channel
                    ),
                    ' > '
                ) as channel_path,
                cast(count(*) as bigint)                  as touch_count,
                cast(count(distinct channel) as bigint)   as distinct_channel_count,
                min(occurred_at)                          as path_start_at,
                max(occurred_at)                          as path_end_at
            from converted_touches
            group by brand_id, brain_anon_id, stitched_order_id
        )
        select
            p.brand_id, p.brain_anon_id, p.stitched_order_id, p.stitched_brain_id,
            p.channel_path, p.touch_count, p.distinct_channel_count,
            substring_index(e._first_enc, '|', -1) as first_touch_channel,
            substring_index(e._last_enc,  '|', -1) as last_touch_channel,
            p.path_start_at, p.path_end_at,
            current_timestamp() as updated_at
        from ordered_paths p
        join endpoints e
          on p.brand_id = e.brand_id
         and p.brain_anon_id = e.brain_anon_id
         and p.stitched_order_id = e.stitched_order_id
    """
    spark.sql(result_sql).createOrReplaceTempView("attribution_paths_src")
    n = spark.table("attribution_paths_src").count()

    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING attribution_paths_src s
        ON t.brand_id = s.brand_id
       AND t.brain_anon_id = s.brain_anon_id
       AND t.stitched_order_id = s.stitched_order_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    total = spark.table(fqtn).count()
    print(f"[gold_attribution_paths] MERGEd {n} converted-path rows → {fqtn} (table now {total} rows)", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("gold-attribution-paths")
    spark.sparkContext.setLogLevel("WARN")
    materialize(spark)
    print("[gold_attribution_paths] DONE — Iceberg journey-path mart populated (dual-run) ✓", flush=True)


if __name__ == "__main__":
    main()
