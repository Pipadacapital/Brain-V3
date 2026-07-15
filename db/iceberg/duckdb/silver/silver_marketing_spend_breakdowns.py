"""
silver_marketing_spend_breakdowns.py (DuckDB) — faithful port of
db/iceberg/spark/silver/silver_marketing_spend_breakdowns.py.

The Meta breakdown spend marts. Reads the SAME gated keystone as silver_marketing_spend
(event_type='spend.live.v1') but keeps ONLY the BREAKDOWN rows (breakdown_key present + non-empty) that the
base mart DROPS. Each breakdown FAMILY lands in its OWN parallel Iceberg table with the breakdown dims
projected for slicing, so the base (brand_id, spend_event_id) one-row-per-campaign-day grain that CAC/ROAS
assume is NEVER exploded. Because the breakdown dims are already folded into the DISTINCT spend_event_id,
(brand_id, spend_event_id) IS a sufficient PK for every family.

FAMILIES (each a separate target table, MERGE keyed on (brand_id, spend_event_id)):
  - silver_marketing_spend_by_demographic  : + age, gender
  - silver_marketing_spend_by_geo          : + country, region, dma
  - silver_marketing_spend_by_placement    : + publisher_platform, platform_position, device_platform, impression_device
  - silver_marketing_spend_by_hour         : + hour_bucket (source: hourly_stats_aggregated_by_advertiser_time_zone)

A family keeps only rows carrying ≥1 of its dims (so a placement row does not appear in the demographic mart)
AND stat_date non-null. MONEY: bigint MINOR units + currency_code (never blended/float). ISOLATION: brand_id
first (server-trusted in Bronze, MT-1). updated_at = now() (a run-clock column, excluded from parity).

DATA AVAILABILITY: Bronze holds ZERO Meta breakdown spend rows today, so each family writes a correct EMPTY
  table; a breakdown repull populates them with no code change.

QUARANTINE: N/A — the Spark job has no Stage-1 DQ gate on this path (pure projection).

MULTI-TARGET NOTE: this one job produces FOUR target tables. run_job's target_table is cosmetic (log line);
  each family table honors MIGRATION_TABLE_SUFFIX independently, so the parity harness checks each of the four
  <family>_duckdb_test tables separately. Parity target: brain_silver.silver_marketing_spend_by_* (NEW).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import (  # noqa: E402
    GATED_SOURCE,
    ensure_table,
    incremental_window,
    merge_on_pk,
    prop,
    read_gated_events_sql,
    run_job,
)
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
SPEND_EVENT = os.environ.get("SPEND_EVENT_TYPE", "spend.live.v1")

# Common leading columns shared by every breakdown mart (identity + core spend measures).
_COMMON_COLS_SQL = """
  brand_id          string    NOT NULL,
  spend_event_id    string    NOT NULL,
  platform          string,
  level             string,
  level_id          string,
  campaign_id       string,
  campaign_name     string,
  stat_date         date,
  breakdown_key     string,
  spend_minor       bigint,
  currency_code     string,
  impressions       bigint,
  clicks            bigint,
  conversions       bigint,
  conv_value_minor  bigint,
  occurred_at       timestamp,
  updated_at        timestamp NOT NULL
""".strip("\n")

_COMMON_COLS = [
    "brand_id", "spend_event_id", "platform", "level", "level_id", "campaign_id", "campaign_name",
    "stat_date", "breakdown_key", "spend_minor", "currency_code", "impressions", "clicks",
    "conversions", "conv_value_minor", "occurred_at", "updated_at",
]

# family → (payload dim source props, extra column DDL, extra output column names).
# hour maps the source prop `hourly_stats_aggregated_by_advertiser_time_zone` to the output col `hour_bucket`.
_FAMILIES = {
    "silver_marketing_spend_by_demographic": {
        "dims": [("age", "age"), ("gender", "gender")],
        "cols_sql": "  age string,\n  gender string",
    },
    "silver_marketing_spend_by_geo": {
        "dims": [("country", "country"), ("region", "region"), ("dma", "dma")],
        "cols_sql": "  country string,\n  region string,\n  dma string",
    },
    "silver_marketing_spend_by_placement": {
        "dims": [
            ("publisher_platform", "publisher_platform"),
            ("platform_position", "platform_position"),
            ("device_platform", "device_platform"),
            ("impression_device", "impression_device"),
        ],
        "cols_sql": (
            "  publisher_platform string,\n  platform_position string,\n"
            "  device_platform string,\n  impression_device string"
        ),
    },
    # NOTE: the source column in the typed view is the ALIASED `hour_bucket` (the base projection maps the
    # payload prop hourly_stats_aggregated_by_advertiser_time_zone → hour_bucket), so the family dim src is
    # `hour_bucket`, not the raw prop name — matching the Spark _project_family hour_bucket source column.
    "silver_marketing_spend_by_hour": {
        "dims": [("hour_bucket", "hour_bucket")],
        "cols_sql": "  hour_bucket string",
    },
}


def _base_typed_sql(lo=None, hi=None) -> str:
    """Read spend.live.v1, keep BREAKDOWN rows only (breakdown_key present + non-empty), dedup latest.
    Projects every family's dim so each family can select+filter its own. spend_event_id = Bronze event_id."""
    dim_props = [
        "age", "gender", "country", "region", "dma", "publisher_platform", "platform_position",
        "device_platform", "impression_device",
    ]
    dim_sel = ", ".join(f"{prop('pj', d)} AS {d}" for d in dim_props)
    typed = f"""
      SELECT
        brand_id,
        event_id                                     AS spend_event_id,
        {prop('pj','platform')}                      AS platform,
        {prop('pj','level')}                         AS level,
        {prop('pj','level_id')}                      AS level_id,
        {prop('pj','campaign_id')}                   AS campaign_id,
        {prop('pj','campaign_name')}                 AS campaign_name,
        CAST({prop('pj','stat_date')} AS DATE)       AS stat_date,
        {prop('pj','breakdown_key')}                 AS breakdown_key,
        CAST({prop('pj','spend_minor')} AS BIGINT)   AS spend_minor,
        {prop('pj','currency_code')}                 AS currency_code,
        CAST({prop('pj','impressions')} AS BIGINT)   AS impressions,
        CAST({prop('pj','clicks')} AS BIGINT)        AS clicks,
        CAST({prop('pj','conversions')} AS BIGINT)   AS conversions,
        CAST({prop('pj','conv_value_minor')} AS BIGINT) AS conv_value_minor,
        {dim_sel},
        {prop('pj','hourly_stats_aggregated_by_advertiser_time_zone')} AS hour_bucket,
        occurred_at, ingested_at
      FROM ({read_gated_events_sql([SPEND_EVENT], lo=lo, hi=hi)})
      WHERE event_id IS NOT NULL AND event_id <> ''
        AND {prop('pj','breakdown_key')} IS NOT NULL AND {prop('pj','breakdown_key')} <> ''
    """
    return f"""
      SELECT * EXCLUDE (_rn) FROM (
        SELECT *, row_number() OVER (
          PARTITION BY brand_id, spend_event_id
          ORDER BY ingested_at DESC, occurred_at DESC) AS _rn
        FROM ({typed})
      ) WHERE _rn = 1
    """


def _project_family_sql(typed_sql: str, family: str) -> str:
    """Common columns + this family's breakdown dims; keep only rows carrying ≥1 of the family's dims AND
    a non-null stat_date. impressions/clicks coalesce to 0 (verbatim from the Spark _project_family)."""
    dims = _FAMILIES[family]["dims"]
    out_cols = [
        "brand_id", "spend_event_id", "platform", "level", "level_id", "campaign_id", "campaign_name",
        "stat_date", "breakdown_key", "spend_minor", "currency_code",
        "CAST(coalesce(impressions, 0) AS BIGINT) AS impressions",
        "CAST(coalesce(clicks, 0) AS BIGINT) AS clicks",
        "conversions", "conv_value_minor", "occurred_at", "now() AS updated_at",
    ]
    out_cols += [f"{src} AS {out}" for src, out in dims]
    present = " OR ".join(f"{src} IS NOT NULL" for src, _ in dims)
    return f"""
      SELECT {', '.join(out_cols)} FROM ({typed_sql})
      WHERE ({present}) AND stat_date IS NOT NULL
    """


def build(con):
    # ── INCREMENTAL WINDOW (opt-in; SILVER_INCREMENTAL=1) ─────────────────────────────────────────────
    #   GRAIN=per_event over the gated keystone: each source spend row → 0..1 breakdown row per family via
    #   the idempotent MERGE on (brand_id, spend_event_id), so windowing the source read is safe. read_gated_
    #   events_sql builds the [lo,hi) predicate on ingested_at itself and omits it when lo/hi are None, so
    #   default OFF → (None, None) → full scan, byte-identical to before.
    lo, hi = incremental_window(con, "silver-marketing-spend-breakdowns", GATED_SOURCE, ts_col="ingested_at")
    typed_sql = _base_typed_sql(lo=lo, hi=hi)
    total = 0
    for family, spec in _FAMILIES.items():
        target = f"{CATALOG}.{SILVER_NAMESPACE}.{family}{SUFFIX}"
        columns_sql = _COMMON_COLS_SQL + ",\n" + spec["cols_sql"]
        ensure_table(con, target, columns_sql, partitioned_by="bucket(256, brand_id), day(occurred_at)")
        columns = _COMMON_COLS + [out for _, out in spec["dims"]]
        staged = _project_family_sql(typed_sql, family)
        # staged is already 1 row/PK (the _base_typed dedup), so this in-batch re-dedup is a no-op;
        # order on occurred_at, the only ordering column surviving into the family projection.
        n = merge_on_pk(con, target, staged, columns, ["brand_id", "spend_event_id"],
                        order_by_desc=["occurred_at"])
        print(f'{{"family":"{family}","target":"{family}","upserted":{n},"engine":"duckdb"}}', flush=True)
        total += n or 0
    return total


if __name__ == "__main__":
    run_job("silver-marketing-spend-breakdowns", build,
            target_table="silver_marketing_spend_breakdowns")
