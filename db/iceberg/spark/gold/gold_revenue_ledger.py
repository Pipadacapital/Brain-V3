"""
gold_revenue_ledger.py — Brain V4 Phase 2 (Spark Gold, dual-run). GROUP=revenue (HIGH-RISK money math).

Reimplements db/dbt/models/marts/gold_revenue_ledger.sql as a Spark job that READS the Iceberg Silver
layer and WRITES Iceberg brain_gold.gold_revenue_ledger, reproducing the realized-revenue RECOGNITION
ledger BYTE / MINOR-UNIT EXACT. Runs BESIDE the live dbt→StarRocks brain_gold.gold_revenue_ledger +
the TS metric-engine/billing readers — repoints no reader, changes no dbt, changes no app code.
ADDITIVE / dual-run only (V4 Phase-2 rule).

THE MART (dbt): gold_revenue_ledger is a 1:1 projection of silver_order_recognition — the revenue
RECOGNITION ledger (Epic-1 decision B), one row per (brand_id, ledger_event_id). dbt's only filter is
`where ledger_event_id is not null and occurred_at is not null`. So this job's job is to reproduce
silver_order_recognition EXACTLY and apply that filter.

WHY THIS JOB FOLDS THE RECOGNITION CHAIN FROM BRONZE (and does not read an Iceberg silver_order_recognition):
silver_order_recognition.sql is a dbt **VIEW** (materialized='view'), so it is NEVER written to the
StarRocks brain_silver layer and there is NO Iceberg brain_silver.silver_order_recognition table to read.
The recognition events are the canonical revenue business-logic, computed deterministically FROM raw
Bronze (order.{live,backfill}.v1 + shiprocket.shipment_status.v1) plus two small dimension reads (brand horizons, identity
link). The proven Phase-1 silver_order_state.py ALREADY folds this exact recognition chain from Iceberg
Bronze; this job reuses that IDENTICAL fold and stops at the recognition-event grain (it does not collapse
to one row per order). So the "Iceberg Silver" this Gold job reads is the recognition transform applied
to Iceberg Bronze — byte-identical to the silver_order_recognition view dbt's gold mart reads.

RECOGNITION RULES reproduced EXACTLY from silver_order_recognition.sql (signed BIGINT minor units):
  1. provisional_recognition  — every order (the booking).                              +amount_minor
  2. finalization             — PREPAID only, past the prepaid horizon, not reversed.    +amount_minor
  3. cod_delivery_confirmed   — COD recognized on terminal delivery.                     +amount_minor
  4. cod_rto_clawback         — COD returned (RTO).                                       -amount_minor
  5. cancellation             — order cancelled.                                          -amount_minor
  6. refund                   — refunded and not already a cancellation.                  -amount_minor
ledger_event_id = sha2(concat_ws('\\0', brand_id, order_id, event_type, cast(economic_effective_at as
string)), 256) — the SAME deterministic, replay-idempotent key dbt computes.
recognition_label = 'provisional' for provisional_recognition else 'finalized'.
billing_posted_period = date_format(economic_effective_at, '%Y-%m').
fee_minor = 0 (silver_order_recognition emits 0; gold casts coalesce(fee_minor,0)).
data_source = 'live' (real builds = live; the demo seed overwrites to 'synthetic' — we always emit live).

MONEY: amount_minor / fee_minor are signed BIGINT minor units paired with currency_code; per-currency,
never blended. brand_id is the tenant key, FIRST column. PII is hashed-only upstream (brain_id resolved).
IDEMPOTENT / REPLAY-SAFE: MERGE on (brand_id, ledger_event_id) — re-run yields byte-identical rows.

CURRENT-SIDE DIMENSION READS (all over PG JDBC, same posture as silver_order_state.py):
  - brand prepaid recognition horizon  → PG tenancy.brand (brand_horizons_src shim columns)
  - hashed-email → brain_id            → PG ops.silver_identity_link (the Neo4j export, PG op-only store)

Run via run-gold-revenue.sh (mirrors run-silver-orders.sh — Iceberg + PG JDBC package).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyspark.sql import SparkSession  # noqa: E402

from iceberg_base import (  # noqa: E402 — sys.path tweak above
    CATALOG,
    GOLD_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
BRONZE_TABLE = f"{CATALOG}.{os.environ.get('SILVER_NAMESPACE', 'brain_silver')}.silver_collector_event"  # ADR-0006 P3: gated source (R2/R3 now in Silver)
TABLE_NAME = "gold_revenue_ledger"

# CURRENT-side dimension reads — all over PG JDBC now (brain_ops moved to PG schema `ops`; PG is the
# operational-only store). Superuser RLS-bypass ETL read; same JDBC posture for every dimension.
PG_JDBC_URL = os.environ.get("GOLD_PG_JDBC_URL", os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain"))
PG_USER = os.environ.get("GOLD_PG_USER", os.environ.get("SILVER_PG_USER", "brain"))
PG_PASSWORD = os.environ.get("GOLD_PG_PASSWORD", os.environ.get("SILVER_PG_PASSWORD", "brain"))

# Mirrors gold_revenue_ledger.sql column order/types (StarRocks: varchar/bigint/datetime + data_source/updated_at).
_COLUMNS = """
          brand_id               string    NOT NULL,
          ledger_event_id        string    NOT NULL,
          order_id               string,
          brain_id               string,
          event_type             string,
          amount_minor           bigint,
          currency_code          string,
          fee_minor              bigint,
          occurred_at            timestamp,
          economic_effective_at  timestamp,
          recognition_label      string,
          billing_posted_period  string,
          ingested_at            timestamp,
          data_source            string    NOT NULL,
          updated_at             timestamp NOT NULL
""".strip("\n")


def _read_horizons(spark: SparkSession):
    """Per-brand prepaid recognition horizon (PG tenancy.brand → the brand_horizons_src contract).

    silver_order_recognition reads source('oltp','brand_horizons_src') for
    prepaid_recognition_horizon_days keyed by brand_id::text. Read the same column directly over PG JDBC
    (the JDBC catalog dbt uses IS this PG; superuser → cross-brand). IDENTICAL to silver_order_state.py.
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
    we read it over the SAME PG JDBC connection as the horizons dimension and aggregate identically —
    IDENTICAL to silver_order_state.py so the brain_id column matches byte-for-byte.

    F2 (merge → canonical LTV): the identity export already projects the CANONICAL (alias-resolved)
    brain_id into silver_identity_link; as a DEFENSIVE single-hop net this also folds
    ops.silver_customer_identity.merged_into → canonical (COALESCE(c.merged_into, l.brain_id)) BEFORE the
    MIN/group. Non-merged → merged_into NULL → COALESCE = original brain_id (parity no-op); merged → the
    dead brain_id maps to the survivor. brain_id is NOT part of ledger_event_id (sha2 of brand_id/order_id/
    event_type/economic_effective_at), so the money key + amounts are byte-identical — only the resolved
    customer changes. Kept IDENTICAL to silver_order_state.py's reader.

    NOTE: brain_id/merged_into are PG `uuid` and PostgreSQL has no min(uuid) aggregate, so the
    MIN operand is cast ::text (the projected brain_id column is `string` anyway). This was already
    required by the pre-F2 MIN(brain_id) form; the COALESCE fold keeps the same uuid→text shape.
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
        print(f"[gold_revenue_ledger] identity_link unavailable ({exc}); brain_id → null", flush=True)
        return None


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark,
        GOLD_NAMESPACE,
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

    # ── stg_order_events_bronze: type + dedup order.{live,backfill}.v1 to (brand_id, order_id) latest ──
    # IDENTICAL to silver_order_state.py / stg_order_events_bronze.sql so the enriched order matches.
    # BOTH lanes: order.live.v1 (webhook) AND order.backfill.v1 (historical connector backfill) — same
    # canonical payload, so a backfilled order IS a real order and must produce recognition events here
    # too, else the revenue ledger UNDERCOUNTS (backfilled revenue stranded). The (brand_id, order_id)
    # latest-ingested dedup collapses any live↔backfill overlap to one winner (no double recognition).
    stg_order_events = """
        with raw as (
            select brand_id, event_id, occurred_at, payload as pj
            from bronze_events
            where event_type in ('order.live.v1', 'order.backfill.v1')
        ),
        typed as (
            select
                brand_id, event_id, occurred_at,
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
            brand_id, order_id, amount_minor, currency_code,
            case when payment_method_raw = 'cod' then 'cod' else 'prepaid' end as payment_method,
            financial_status, cancelled_at, hashed_customer_email,
            occurred_at,
            ingested_at_raw
        from deduped
        where _dedup_rn = 1
    """
    spark.sql(stg_order_events).createOrReplaceTempView("stg_order_events_bronze")

    # ── latest terminal_class per order (COD recognition signal) — IDENTICAL to silver_order_state.py ──
    # HIGH COD fix parity: the RETIRED `gokwik.awb_status.v1` (emitted by nothing) is replaced by the LIVE
    # forward logistics lane `shiprocket.shipment_status.v1` (server-trusted; properties.terminal_class is
    # the SAME deterministic class from @brain/logistics-status). silver_order_state.py was already
    # repointed; this file had drifted, so COD delivery/RTO recognition never fired in the gold ledger.
    # Read ONLY the forward shipment lane (the return lane carries return_class → the SR-4 false-delivery bug).
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

    # ── silver_order_recognition.enriched: one enriched canonical order row ──
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

    # ── silver_order_recognition.events: the 6 recognition event_types (signed minor units) ──
    # IDENTICAL recognition rules to silver_order_recognition.sql; economic_effective_at of a finalization
    # = occurred_at + prepaid horizon (the deterministic moment it became final), NOT run-time.
    #
    # PARITY-CRITICAL: dbt's `date_add(occurred_at, interval N day)` runs in StarRocks, which PRESERVES the
    # time-of-day (occurred_at 08:42:03 → +7d = 2026-06-10 08:42:03). Spark's `date_add(ts, N)` returns a
    # DATE (midnight), which would TRUNCATE the time and produce a DIFFERENT economic_effective_at → a
    # DIFFERENT sha2 ledger_event_id (the parity-fail root cause, verified live: 3796 finalization keys
    # diverged at money_delta=0). `occurred_at + make_dt_interval(N,0,0,0)` adds N days as a day-time
    # interval, preserving the time-of-day exactly as StarRocks does → byte-identical ledger_event_id.
    recognition_sql = """
        select brand_id, order_id, brain_id, 'provisional_recognition' as event_type,
               amount_minor, currency_code, occurred_at, occurred_at as economic_effective_at, ingested_at
        from enriched
        union all
        select brand_id, order_id, brain_id, 'finalization' as event_type,
               amount_minor, currency_code, occurred_at,
               occurred_at + make_dt_interval(prepaid_horizon, 0, 0, 0) as economic_effective_at, ingested_at
        from enriched
        where payment_method = 'prepaid'
          and occurred_at + make_dt_interval(coalesce(prepaid_horizon, 7), 0, 0, 0) < current_timestamp()
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
    spark.sql(recognition_sql).createOrReplaceTempView("recognition_events")

    # ── silver_order_recognition final SELECT → gold_revenue_ledger projection ──
    # ledger_event_id, recognition_label, billing_posted_period, fee_minor=0 exactly as the view emits;
    # then the gold mart's projection: data_source='live', updated_at=now(), filter ledger_event_id /
    # occurred_at NOT NULL. concat_ws('\\0', ...) — \\0 is the NUL byte separator dbt uses (sha2 256).
    #
    # PARITY-CRITICAL #2: the sha2 input casts economic_effective_at to STRING. dbt does this cast in
    # StarRocks, whose DATETIME→string rendering is: WHOLE seconds → 'yyyy-MM-dd HH:mm:ss' (no fraction);
    # any SUB-second → 'yyyy-MM-dd HH:mm:ss.NNNNNN' (ALWAYS 6 microsecond digits). Spark's
    # `cast(timestamp as string)` instead TRIMS trailing zeros (e.g. '...:38.702' not '...:38.702000'),
    # so a microsecond-precision occurred_at produced a DIFFERENT sha2 key (verified live: 20 provisional
    # keys diverged at money_delta=0). `_sr_dt_str` reproduces StarRocks' exact rendering — whole-second
    # values format without a fraction (matching the finalization rows, which are whole-second), sub-second
    # values format with a left-padded 6-digit microsecond tail — so the ledger_event_id is byte-identical.
    _sr_dt_str = (
        "case when date_format(economic_effective_at, 'SSSSSS') = '000000' "
        "then date_format(economic_effective_at, 'yyyy-MM-dd HH:mm:ss') "
        "else concat(date_format(economic_effective_at, 'yyyy-MM-dd HH:mm:ss'), '.', "
        "date_format(economic_effective_at, 'SSSSSS')) end"
    )
    ledger_sql = f"""
        select
            brand_id,
            sha2(concat_ws('\\0', brand_id, order_id, event_type, {_sr_dt_str}), 256) as ledger_event_id,
            order_id,
            brain_id,
            event_type,
            cast(amount_minor as bigint)                       as amount_minor,
            currency_code,
            cast(0 as bigint)                                  as fee_minor,
            occurred_at,
            economic_effective_at,
            case when event_type = 'provisional_recognition' then 'provisional' else 'finalized' end as recognition_label,
            date_format(economic_effective_at, 'yyyy-MM')      as billing_posted_period,
            ingested_at,
            cast('live' as string)                             as data_source,
            current_timestamp()                                as updated_at
        from recognition_events
        where order_id is not null
          and occurred_at is not null
    """
    result = spark.sql(ledger_sql)
    result.createOrReplaceTempView("gold_revenue_ledger_new")

    # WRITE MODE — atomic partition overwrite, NOT a MERGE upsert. This job is a COMPLETE full fold of ALL
    # brands from Bronze every run (no watermark, no brand filter), so gold_revenue_ledger_new IS the entire
    # current ledger. A MERGE on ledger_event_id could NOT remove orphans: when a re-fold changes an order's
    # winning event — e.g. a backfilled order.backfill.v1 out-ingests the original order.live.v1, so the
    # deduped economic_effective_at (hence the sha2 ledger_event_id) changes — MERGE inserts the new
    # recognition row but LEAVES the stale one, double-counting revenue (verified: 777 overlap orders →
    # +₹0.98Cr). overwritePartitions() atomically REPLACES every brand-bucket partition present in the fresh
    # fold, so the ledger exactly matches the current Bronze recognition set — orphan-free and idempotent
    # (re-running yields the identical table). Byte-identical recognition to silver_order_state.py, so the
    # ledger's non-provisional Σ reconciles with silver_order_state.order_value_minor.
    result.writeTo(fqtn).overwritePartitions()
    n = spark.table(fqtn).count()
    print(f"[gold_revenue_ledger] MERGE complete → {fqtn} has {n} rows", flush=True)
    return fqtn


def main() -> None:
    # Structured per-job observability (additive) — one machine-parseable spark_job line with status +
    # duration + final row count, carrying V4_CORRELATION_ID when the v4-refresh-loop set it. The legacy
    # human "[gold_revenue_ledger] MERGE complete" line inside build() is unchanged.
    import os
    import sys
    import time

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from job_log import emit_job_log  # noqa: E402

    spark = build_spark("gold-revenue-ledger")
    spark.sparkContext.setLogLevel("WARN")
    started = time.monotonic()
    try:
        fqtn = build(spark)
        emit_job_log(
            "gold-revenue-ledger", status="ok", fqtn=fqtn,
            rows_out=spark.table(fqtn).count(),
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001
        emit_job_log("gold-revenue-ledger", status="fail",
                     duration_ms=int((time.monotonic() - started) * 1000), error=str(exc))
        raise


if __name__ == "__main__":
    main()
