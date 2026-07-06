# SPEC: A.1.5 / A.2.2 — sanctioned Spark accessors for the bi-temporal silver_identity_map (AMD-07).
"""
_identity_views.py — the SANCTIONED Spark-side accessors for brain_silver.silver_identity_map.

WHY (A.2.2 / AMD-07): silver_identity_map is BI-TEMPORAL — valid-time (effective_from/effective_to,
is_current) crossed with system-time (system_from/system_to, the append-per-mutation axis). A reader that
touches the raw table directly can silently forget one axis (e.g. read is_current=true but ignore that the
row was system-superseded), which corrupts point-in-time / replay answers. So EVERY Spark read of the map
goes through one of the two accessors below — they are the map's only sanctioned Spark entry points, the
mirror of the Trino views identity_current_v / identity_asof. The CI guard tools/lint/identity-view-guard.sh
FAILS on any direct read of silver_identity_map outside this module + the map writer + the Trino accessors.

TWO ACCESSORS (the two consumers state their view, per §1.5):
  - identity_current(spark)                    — VALID-NOW + KNOWN-NOW: is_current = true AND system_to IS
                                                 NULL. The operational read; what every "who is this today"
                                                 path wants.
  - identity_asof(spark, t_valid, t_system)    — the BI-TEMPORAL point-in-time read for replay / audit:
                                                 the mapping as it was VALID at t_valid and as the system
                                                 KNEW it at t_system. Either bound may be None (= unbounded
                                                 on that axis); identity_asof(spark) with both None returns
                                                 the FULL interval set (current + superseded) so a caller
                                                 can run its own interval-covering join (the DG-2 pattern).

Both are thin filters over identity_raw(spark), the SINGLE physical read of the table — kept private-ish so
there is exactly ONE `spark.table(...silver_identity_map)` call in the whole Spark tree. When the table is
absent (pre-identity-export / data-thin dev), identity_raw returns a correctly-SHAPED EMPTY DataFrame so
consumers degrade to NULL instead of raising (the same graceful-empty contract silver_exists gave them).

PII: identifier_hash is a 64-hex HASH only (hash-only rule). brand_id is the first/tenant key. No money.
"""
from __future__ import annotations

import os

from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    BooleanType,
    DoubleType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

# Namespace resolution mirrors iceberg_base / _gold_base (env-driven) so this module stays dependency-light
# — it imports pyspark only, never iceberg_base, so it needs no addPyFile to reach a worker.
_CATALOG = os.environ.get("ICEBERG_CATALOG", "rest")
_SILVER_NS = os.environ.get("SILVER_NAMESPACE", "brain_silver")
_TABLE = "silver_identity_map"


def _fqtn() -> str:
    return f"{_CATALOG}.{_SILVER_NS}.{_TABLE}"


# The empty-shaped fallback schema (the table's full bi-temporal column contract). Keeps consumers' LEFT
# JOINs / selects resolvable when the map has not been exported yet.
_EMPTY_SCHEMA = StructType(
    [
        StructField("brand_id", StringType()),
        StructField("identifier_hash", StringType()),
        StructField("identifier_type", StringType()),
        StructField("brain_id", StringType()),
        StructField("customer_ref", StringType()),
        StructField("confidence", DoubleType()),
        StructField("effective_from", TimestampType()),
        StructField("effective_to", TimestampType()),
        StructField("replaced_by_brain_id", StringType()),
        StructField("merge_event_id", StringType()),
        StructField("is_current", BooleanType()),
        StructField("system_from", TimestampType()),
        StructField("system_to", TimestampType()),
        StructField("updated_at", TimestampType()),
    ]
)


def identity_map_exists(spark: SparkSession) -> bool:
    """True iff brain_silver.silver_identity_map exists (probe, so a job over an absent map degrades)."""
    try:
        spark.table(_fqtn()).schema
        return True
    except Exception:  # noqa: BLE001 — absent table → False
        return False


def identity_raw(spark: SparkSession) -> DataFrame:
    """The SINGLE sanctioned physical read of silver_identity_map (all bi-temporal columns). Absent table
    → a correctly-shaped EMPTY DataFrame (graceful degrade). Prefer identity_current / identity_asof; use
    identity_raw only when a consumer legitimately needs the raw interval rows (e.g. merge-event detection)."""
    try:
        df = spark.table(_fqtn())
        df.schema  # force resolution so an absent table raises here, not lazily downstream
        return df
    except Exception:  # noqa: BLE001 — absent table → empty-shaped DF
        return spark.createDataFrame([], _EMPTY_SCHEMA)


def identity_current(spark: SparkSession) -> DataFrame:
    """VALID-NOW + KNOWN-NOW mapping: is_current = true AND system_to IS NULL. The operational accessor —
    the Spark mirror of the Trino view identity_current_v."""
    return identity_raw(spark).where((F.col("is_current") == F.lit(True)) & F.col("system_to").isNull())


def identity_asof(spark: SparkSession, t_valid=None, t_system=None) -> DataFrame:
    """BI-TEMPORAL point-in-time / replay accessor — the Spark mirror of the Trino view identity_asof.

    Returns the mapping as it was VALID at t_valid AND as the system KNEW it at t_system, using the SAME
    canonical predicate the Trino view documents:
        valid-time  : effective_from <= t_valid  AND (effective_to IS NULL OR effective_to > t_valid)
        system-time : system_from   <= t_system AND (system_to   IS NULL OR system_to   > t_system)
    Reconstructed from RETAINED interval rows (AMD-07 / AMD-10) — NOT from Iceberg time-travel (snapshot TTL
    makes time-travel unusable as the system axis). t_valid / t_system are timestamp-castable values or None;
    None = unbounded on that axis. identity_asof(spark) (both None) = the full interval set (current +
    superseded) for a caller's own interval-covering join."""
    df = identity_raw(spark)
    if t_valid is not None:
        tv = F.lit(t_valid).cast("timestamp")
        df = df.where(
            (F.col("effective_from") <= tv)
            & (F.col("effective_to").isNull() | (F.col("effective_to") > tv))
        )
    if t_system is not None:
        ts = F.lit(t_system).cast("timestamp")
        df = df.where(
            (F.col("system_from") <= ts)
            & (F.col("system_to").isNull() | (F.col("system_to") > ts))
        )
    return df
