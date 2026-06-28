"""
silver_order_state.py — Brain V4 Phase 1 (Spark Silver, dual-run). GROUP=orders.

Reimplements the dbt model db/dbt/models/marts/silver_order_state.sql as a Spark job that READS
Iceberg Bronze (rest.brain_bronze.collector_events) and WRITES Iceberg brain_silver.silver_order_state,
reproducing the dbt SQL transform EXACTLY. This runs BESIDE the live dbt→StarRocks brain_silver
(dual-run, NON-BREAKING). It repoints no reader, changes no dbt model, changes no app code.

THE FOLDED TRANSFORM CHAIN (dbt → Spark, inlined here so this one job reproduces the whole pipeline):
  stg_order_events_bronze.sql   — read order.live.v1 from Bronze, type payload.properties.*, dedup to
                                  (brand_id, order_id) latest-ingested.
  silver_order_recognition.sql  — emit the recognition ledger events (provisional / finalization /
                                  cod_delivery_confirmed / cod_rto_clawback / cancellation / refund),
                                  signed minor-unit money, brain_id from silver_identity_link, COD from
                                  shiprocket.shipment_status.v1 terminal_class (the LIVE logistics lane;
                                  the retired gokwik.awb_status.v1 is gone), prepaid horizon from horizons.
  int_order_lifecycle.sql       — normalize each ledger event_type → canonical lifecycle_state +
                                  is_terminal + state_rank.
  silver_order_state.sql        — the deterministic terminal-wins FOLD: 1 row per (brand_id, order_id).

GRAIN: exactly 1 row per (brand_id, order_id) — latest lifecycle state per order.
MONEY: order_value_minor is signed BIGINT minor units (Σ of recognized rows, excluding placed), paired
       with currency_code. brand_id is the tenant key, first column. PII is hashed-only upstream.
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, order_id) — re-run yields byte-identical rows.

STAGE-1 GATE (Brain V4 two-stage): BEFORE the recognition fold, each staged order is run through the
  Stage-1 DQ gate _silver_technical.dq_check (negative amount_minor, non-ISO-4217 currency_code, future
  occurred_at). A failing order is diverted to brain_silver.silver_quarantine (stage='dq') and EXCLUDED
  from recognition — it never reaches silver_order_state; Bronze keeps the original (replay-safe: fix +
  re-run re-admits it). And the lifecycle events are EVENT-ORDERED via _silver_technical.event_order_key
  (added as the lowest-priority, replay-stable final tiebreaker in the terminal-wins fold — it does NOT
  change the winner for well-formed data, only makes exact ties totally ordered). Good orders are
  byte-identical to before (parity-faithful).

SOURCES it cannot get from Iceberg (read via JDBC, exactly as dbt does cross-catalog):
  - brand prepaid recognition horizon  → PG tenancy.brand (the brand_horizons_src shim columns)
  - hashed-email → brain_id            → PG ops.silver_identity_link (the Neo4j export, PG operational store)
Both are small dimension reads; the order/recognition logic itself is pure over Iceberg Bronze.

Run via run-silver-orders.sh (mirrors run-bronze-parity.sh — Iceberg + PG JDBC package).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession
from pyspark.sql.functions import array_join, col, lit, size  # noqa: E402
from pyspark.sql.types import StringType  # noqa: E402

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)
from _silver_technical import dq_violations_udf, event_order_key_str, write_quarantine  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)
TABLE_NAME = "silver_order_state"

# CURRENT-side dimension reads — all over PG JDBC now (brain_ops moved to PG schema `ops`; PG is the
# operational-only store). Superuser RLS-bypass ETL read; same JDBC posture for every dimension.
PG_JDBC_URL = os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("SILVER_PG_USER", "brain")
PG_PASSWORD = os.environ.get("SILVER_PG_PASSWORD", "brain")

# Mirrors silver_order_state.sql column order/types (StarRocks: varchar/bigint/boolean/datetime).
_COLUMNS = """
          brand_id            string    NOT NULL,
          order_id            string    NOT NULL,
          brain_id            string,
          lifecycle_state     string,
          is_terminal         boolean,
          order_value_minor   bigint,
          currency_code       string,
          first_event_at      timestamp,
          state_effective_at  timestamp,
          max_ingested_at     timestamp,
          updated_at          timestamp NOT NULL
""".strip("\n")


def _read_horizons(spark: SparkSession):
    """Per-brand prepaid recognition horizon (PG tenancy.brand → the brand_horizons_src contract).

    silver_order_recognition reads source('oltp','brand_horizons_src'). That shim exposes
    tenancy.brand.{cod,prepaid}_recognition_horizon_days keyed by brand_id::text. We read the same
    columns directly over PG JDBC (the JDBC catalog dbt uses IS this PG, superuser → cross-brand).
    """
    query = (
        "(SELECT id::text AS brand_id, prepaid_recognition_horizon_days "
        "FROM tenancy.brand) h"
    )
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("dbtable", query)
        .load()
    )


def _read_identity_link(spark: SparkSession):
    """hashed-email → brain_id from the identity export (PG ops.silver_identity_link).

    silver_order_recognition resolves brain_id from ops.silver_identity_link where
    identifier_type='pre_hashed_email' and is_active and brain_id is not null, min(brain_id) per
    (brand_id, identifier_value). brain_ops moved to the PG `ops` schema (PG operational-only store), so
    we read it over the SAME PG JDBC connection as the other dimensions and aggregate identically.

    F2 (merge → canonical LTV): the identity export already projects the CANONICAL (alias-resolved)
    brain_id into silver_identity_link, so a post-merge identifier resolves to the survivor. As a
    DEFENSIVE single-hop net (covers the window before an export catches a fresh merge) we additionally
    fold ops.silver_customer_identity.merged_into → canonical here: COALESCE(c.merged_into, l.brain_id).
    For a non-merged customer merged_into IS NULL → COALESCE = the original brain_id (parity-exact, no-op);
    for a merged one it maps the dead brain_id to the survivor BEFORE the MIN/group, so a merged customer's
    orders all roll up under the single canonical brain_id. brain_id is NOT part of any money key, so this
    cannot perturb the recognition ledger / order value.

    NOTE: brain_id/merged_into are PG `uuid` and PostgreSQL has no min(uuid) aggregate, so the MIN
    operand is cast ::text (the projected brain_id column is `string` anyway). This was already required
    by the pre-F2 MIN(brain_id) form; the COALESCE fold keeps the same uuid→text shape.
    """
    query = (
        "(SELECT l.brand_id, l.identifier_value AS hashed_customer_email, "
        "MIN(COALESCE(c.merged_into, l.brain_id)::text) AS brain_id "
        "FROM ops.silver_identity_link l "
        "LEFT JOIN ops.silver_customer_identity c "
        "  ON c.brand_id = l.brand_id AND c.brain_id = l.brain_id "
        "WHERE l.identifier_type = 'pre_hashed_email' AND l.is_active = true AND l.brain_id IS NOT NULL "
        "GROUP BY l.brand_id, l.identifier_value) b"
    )
    try:
        return (
            spark.read.format("jdbc")
            .option("url", PG_JDBC_URL)
            .option("user", PG_USER)
            .option("password", PG_PASSWORD)
            .option("driver", "org.postgresql.Driver")
            .option("dbtable", query)
            .load()
        )
    except Exception as exc:  # noqa: BLE001 — identity export not built yet → all brain_id null (dbt parity)
        print(f"[silver_order_state] identity_link unavailable ({exc}); brain_id → null", flush=True)
        return None


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        SILVER_NAMESPACE,
        TABLE_NAME,
        _COLUMNS,
        partitioned_by="bucket(256, brand_id)",
    )

    spark.read.table(BRONZE_TABLE).createOrReplaceTempView("bronze_events")
    _read_horizons(spark).createOrReplaceTempView("brand_horizons")

    ident = _read_identity_link(spark)
    if ident is not None:
        ident.createOrReplaceTempView("identity_link")
        identity_join = (
            "left join identity_link b "
            "on b.brand_id = o.brand_id and b.hashed_customer_email = o.hashed_customer_email"
        )
        brain_col = "b.brain_id"
    else:
        identity_join = ""
        brain_col = "cast(null as string)"

    # ── stg_order_events_bronze: type + dedup order.live.v1 to (brand_id, order_id) latest-ingested ──
    stg_order_events = """
        with raw as (
            select brand_id, event_id, occurred_at, payload as pj
            from bronze_events
            where event_type = 'order.live.v1'
        ),
        typed as (
            select
                brand_id, event_id, occurred_at, pj,
                get_json_object(pj, '$.properties.order_id')                          as order_id,
                cast(get_json_object(pj, '$.properties.amount_minor') as bigint)      as amount_minor,
                get_json_object(pj, '$.properties.currency_code')                     as currency_code,
                lower(get_json_object(pj, '$.properties.payment_method'))             as payment_method_raw,
                get_json_object(pj, '$.properties.financial_status')                  as financial_status,
                get_json_object(pj, '$.properties.cancelled_at')                      as cancelled_at,
                get_json_object(pj, '$.properties.hashed_customer_email')             as hashed_customer_email,
                get_json_object(pj, '$.ingested_at')                                  as ingested_at_raw
            from raw
        ),
        deduped as (
            select *,
                row_number() over (
                    partition by brand_id, order_id
                    order by ingested_at_raw desc, occurred_at desc, event_id desc
                ) as _dedup_rn
            from typed
            where order_id is not null and order_id <> ''
        )
        select
            brand_id, event_id, pj as payload, order_id, amount_minor, currency_code,
            case when payment_method_raw = 'cod' then 'cod' else 'prepaid' end as payment_method,
            financial_status, cancelled_at, hashed_customer_email,
            occurred_at,
            occurred_at as economic_effective_at,
            ingested_at_raw
        from deduped
        where _dedup_rn = 1
    """
    # ── Stage-1 DQ gate over the staged orders: negative amount / bad currency / future occurred_at ───
    stg_df = spark.sql(stg_order_events).withColumn(
        "_dq",
        dq_violations_udf()(col("amount_minor"), col("currency_code"), col("occurred_at").cast("string")),
    )
    bad_orders = stg_df.where(size(col("_dq")) > 0)
    write_quarantine(
        spark,
        bad_orders.select(
            col("brand_id"),
            lit("order.live.v1").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE_NAME).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("payload"),
        ),
        stage="dq",
    )
    stg_df.where(size(col("_dq")) == 0).drop("_dq", "payload").createOrReplaceTempView("stg_order_events_bronze")

    # Event-ordering port (registered for the SQL fold): event_order_key as a sortable string key. Used as
    # the additive, lowest-priority final tiebreaker in the terminal-wins window (replay-stable total order).
    spark.udf.register(
        "event_order_key_str_sql",
        lambda occurred_at, source_ts, sequence: event_order_key_str(
            {"occurred_at": occurred_at, "source_ts": source_ts, "sequence": sequence}
        ),
        StringType(),
    )

    # ── latest logistics terminal_class per order (COD recognition signal) ──
    # HIGH COD fix: this CTE used to key on the RETIRED `gokwik.awb_status.v1` (migration 0117 — the wrong
    # AWB model, emitted by NOTHING now), so cod_delivery_confirmed / cod_rto_clawback never fired and
    # delivered COD orders were stranded at lifecycle_state='placed' with order_value_minor=0 (COD revenue
    # understated for a COD-heavy IN store). REPOINTED to `shiprocket.shipment_status.v1` — the LIVE forward
    # logistics lane (SERVER_TRUSTED, already in Bronze). Its `properties.terminal_class` is the SAME
    # deterministic class as before, computed at the mapper boundary by the SHARED @brain/logistics-status
    # authority: delivered -> cod_delivery_confirmed, rto -> cod_rto_clawback (other/none never fire).
    # IMPORTANT: read ONLY the forward shipment lane here — the RETURN lane (`shiprocket.return_status.v1`)
    # is DELIBERATELY excluded (it carries return_class, not terminal_class; folding a return whose status
    # is "delivered" as a forward DELIVERED is the SR-4 false-delivery bug). Returns flow to silver_return.
    spark.sql(
        """
        with awb_raw as (
            select
                brand_id,
                get_json_object(payload, '$.properties.order_id')       as order_id,
                get_json_object(payload, '$.properties.terminal_class') as terminal_class,
                occurred_at
            from bronze_events
            where event_type = 'shiprocket.shipment_status.v1'
        ),
        awb_latest as (
            select brand_id, order_id, terminal_class, occurred_at,
                   row_number() over (partition by brand_id, order_id order by occurred_at desc) as _rn
            from awb_raw
            where order_id is not null and order_id <> ''
        )
        select brand_id, order_id, terminal_class from awb_latest where _rn = 1
        """
    ).createOrReplaceTempView("awb_latest")

    # ── silver_order_recognition: enriched order → the 6 recognition event_types (signed money) ──
    enriched_sql = f"""
        select
            o.brand_id, o.order_id, {brain_col} as brain_id, o.amount_minor, o.currency_code,
            o.payment_method, o.financial_status, o.cancelled_at, o.occurred_at,
            cast(o.ingested_at_raw as timestamp) as ingested_at,
            h.prepaid_recognition_horizon_days as prepaid_horizon,
            a.terminal_class as awb_terminal_class
        from stg_order_events_bronze o
        {identity_join}
        left join brand_horizons h on h.brand_id = o.brand_id
        left join awb_latest a on a.brand_id = o.brand_id and a.order_id = o.order_id
    """
    spark.sql(enriched_sql).createOrReplaceTempView("enriched")

    recognition_sql = """
        select brand_id, order_id, brain_id, 'provisional_recognition' as event_type,
               amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        union all
        select brand_id, order_id, brain_id, 'finalization' as event_type,
               amount_minor, currency_code, occurred_at,
               date_add(occurred_at, prepaid_horizon) as economic_effective_at, ingested_at
        from enriched
        where payment_method = 'prepaid'
          and date_add(occurred_at, coalesce(prepaid_horizon, 7)) < current_timestamp()
          and cancelled_at is null
          and coalesce(financial_status, '') not in ('refunded', 'voided', 'cancelled')
        union all
        select brand_id, order_id, brain_id, 'cod_delivery_confirmed' as event_type,
               amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        where payment_method = 'cod' and awb_terminal_class = 'delivered'
        union all
        select brand_id, order_id, brain_id, 'cod_rto_clawback' as event_type,
               -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        where payment_method = 'cod' and awb_terminal_class = 'rto'
        union all
        select brand_id, order_id, brain_id, 'cancellation' as event_type,
               -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        where cancelled_at is not null
        union all
        select brand_id, order_id, brain_id, 'refund' as event_type,
               -amount_minor as amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        where coalesce(financial_status, '') = 'refunded' and cancelled_at is null
    """
    spark.sql(recognition_sql).createOrReplaceTempView("recognition")

    # ── int_order_lifecycle: event_type → lifecycle_state / is_terminal / state_rank ──
    lifecycle_sql = """
        select
            brand_id, order_id, brain_id, amount_minor, currency_code,
            occurred_at, economic_effective_at, ingested_at, event_type,
            event_order_key_str_sql(cast(occurred_at as string), cast(ingested_at as string), cast(null as int)) as event_order_key,
            case event_type
                when 'provisional_recognition'   then 'placed'
                when 'finalization'              then 'confirmed'
                when 'cod_delivery_confirmed'    then 'delivered'
                when 'cancellation'              then 'cancelled'
                when 'rto_reversal'              then 'rto'
                when 'cod_rto_clawback'          then 'rto'
                when 'refund'                    then 'refunded'
                when 'chargeback'                then 'refunded'
            end as lifecycle_state,
            case event_type
                when 'cod_delivery_confirmed'    then true
                when 'cancellation'              then true
                when 'rto_reversal'              then true
                when 'cod_rto_clawback'          then true
                when 'refund'                    then true
                when 'chargeback'                then true
                else false
            end as is_terminal,
            case event_type
                when 'provisional_recognition'   then 10
                when 'finalization'              then 20
                when 'cod_delivery_confirmed'    then 90
                when 'cancellation'              then 80
                when 'rto_reversal'              then 85
                when 'cod_rto_clawback'          then 85
                when 'refund'                    then 70
                when 'chargeback'                then 70
                else 0
            end as state_rank
        from recognition
    """
    spark.sql(lifecycle_sql).createOrReplaceTempView("lifecycle")

    # ── silver_order_state: the terminal-wins fold + realized order value + lifecycle times ──
    fold_sql = """
        with ranked as (
            select
                brand_id, order_id, brain_id, lifecycle_state, is_terminal, currency_code,
                occurred_at, economic_effective_at,
                row_number() over (
                    partition by brand_id, order_id
                    order by is_terminal desc, economic_effective_at desc, state_rank desc, occurred_at desc,
                             event_order_key desc
                ) as _win_rn
            from lifecycle
        ),
        winner as (
            select brand_id, order_id, brain_id, lifecycle_state, is_terminal, currency_code
            from ranked where _win_rn = 1
        ),
        order_value as (
            select brand_id, order_id, cast(sum(amount_minor) as bigint) as order_value_minor
            from lifecycle
            where lifecycle_state <> 'placed'
            group by brand_id, order_id
        ),
        order_times as (
            select
                brand_id, order_id,
                min(occurred_at) as first_event_at,
                max(economic_effective_at) as state_effective_at,
                max(ingested_at) as max_ingested_at
            from lifecycle
            group by brand_id, order_id
        )
        select
            w.brand_id, w.order_id, w.brain_id, w.lifecycle_state, w.is_terminal,
            cast(coalesce(ov.order_value_minor, 0) as bigint) as order_value_minor,
            w.currency_code,
            t.first_event_at, t.state_effective_at, t.max_ingested_at,
            current_timestamp() as updated_at
        from winner w
        left join order_value ov on w.brand_id = ov.brand_id and w.order_id = ov.order_id
        left join order_times t  on w.brand_id = t.brand_id  and w.order_id = t.order_id
    """
    result = spark.sql(fold_sql)
    result.createOrReplaceTempView("silver_order_state_new")

    # Idempotent MERGE on the (brand_id, order_id) PK — replay-safe upsert (terminal-wins is restated).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING silver_order_state_new s
        ON t.brand_id = s.brand_id AND t.order_id = s.order_id
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_order_state] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    # Structured per-job observability (additive) — one machine-parseable spark_job line with status +
    # duration + final row count, carrying V4_CORRELATION_ID when the v4-refresh-loop set it. The legacy
    # human "[silver_order_state] MERGE complete" line inside build() is unchanged.
    import os
    import sys
    import time

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from job_log import emit_job_log  # noqa: E402

    spark = build_spark("silver-order-state")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn = build(spark)
        emit_job_log(
            "silver-order-state", status="ok", fqtn=fqtn,
            rows_out=spark.table(fqtn).count(),
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001
        emit_job_log("silver-order-state", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
