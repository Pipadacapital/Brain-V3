# SPEC: A.1.4
"""
backfill_interop_hashes.py — WA-10: ONE-OFF historical interop-hash backfill (bronze → silver).

WHY (AMD-01 dual-convention, BINDING)
-------------------------------------
WA-09 makes the connectors DUAL-WRITE the INTEROP-space identifiers (plain unsalted
sha256(normalized email) / sha256(E.164 phone) — the SAME hash the pixel computes client-side)
onto every NEW order/checkout event, behind the per-brand flag `connector.identity_fields`.
Historical Silver orders predate that dual-write, so their pixel↔connector bridge stays broken
until the interop hashes are re-derived. This job re-derives them FROM THE BRONZE RAW PAYLOADS
— the only place the raw identifiers still exist (Silver is hashed-only, I-S02).

WHAT IS ACTUALLY DERIVABLE (verified against the live lane schemas)
-------------------------------------------------------------------
Only raw lanes that carry UNHASHED identifiers can be backfilled:
  shopify_orders_raw_connect      — order.customer.email / order.customer.phone   (struct cols)
  woocommerce_orders_raw_connect  — order.billing.email  / order.billing.phone    (struct cols)
NOT derivable here (documented, honest):
  gokwik_events_raw_connect       — hashed-only lane (erasure map lists identifier_hash only);
  shopflo_checkout_raw_connect    — verbatim CHECKOUT webhooks (not orders; forward-filled by
                                    the WA-09 flag-on dual-write);
  collector_events_connect        — canonical envelopes are hashed-only by construction (I-S02).

OUTPUT (ADDITIVE — no existing mart is widened or rewritten)
------------------------------------------------------------
brain_silver.silver_order_interop_identifier
  {brand_id, source, order_id, email_sha256, phone_sha256, derived_at}
grain: 1 row per (brand_id, source, order_id); MERGE-idempotent (re-run = byte-identical rows,
modulo derived_at refresh on changed hashes). Consumers (WA-16 stitch) join it to the order
spine on (brand_id, source, order_id). Raw identifiers are consumed in-flight and NEVER stored.

INVARIANTS
----------
  FLAG-GATED    — per-brand `connector.identity_fields` via _platform_flags (DEFAULT OFF,
                  FAIL-CLOSED: Redis down → brand skipped → no rows). BRAND_ID env narrows a run.
  SHREDDED-SKIP — subjects in identity.pii_erasure_log (the RTBF crypto-shred ledger, migration
                  0114) are EXPLICITLY excluded: the job computes each row's INTERNAL salted
                  hashes (the same rn.hash_identifier convention the live identity link uses),
                  resolves them through ops.silver_identity_link, and ANTI-JOINs any identifier
                  belonging to an erased (brand_id, brain_id). This ENCODES the skip the
                  erasure_raw_delete.py hard-delete already implies (defense in depth: a row that
                  survived in an old snapshot still cannot resurrect an erased subject's hashes).
  TENANT-FIRST  — brand_id is the FIRST predicate/key everywhere (MERGE ON, joins, partitioning).
  IDEMPOTENT    — Iceberg MERGE on the full grain key; DELETE-free; re-runnable.
  MONEY         — no money columns (identity-only projection).

USAGE (one-off; NOT part of the refresh loop)
---------------------------------------------
  [BRAND_ID=<uuid>] db/iceberg/spark/run-backfill-interop-hashes.sh
Dry validation (CI): python3 -m py_compile + backfill_interop_hashes_guard_test.py (static SQL
invariant asserts — this job is NOT run against live data as part of WA-10 acceptance).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "silver"))

# NOTE: iceberg_base / job_log are imported LAZILY (inside build/main) so this module stays
# importable WITHOUT pyspark — the CI guard test (backfill_interop_hashes_guard_test.py)
# exercises the pure SQL builders below Spark-free. _platform_flags is dependency-free.
from _platform_flags import is_flag_enabled  # noqa: E402

BRONZE_NAMESPACE = os.environ.get("BRONZE_NAMESPACE", "brain_bronze")
REGION = os.environ.get("BRAIN_REGION_CODE", "IN")
PG_JDBC_URL = os.environ.get("SILVER_PG_JDBC_URL", "jdbc:postgresql://postgres:5432/brain")
PG_USER = os.environ.get("SILVER_PG_USER", "brain")
PG_PASSWORD = os.environ.get("SILVER_PG_PASSWORD", "brain")

# The WA-09 flag this backfill is gated on — one name, shared with the TS registry
# (packages/platform-flags/src/registry.ts) and the connector mappers.
IDENTITY_FIELDS_FLAG = "connector.identity_fields"

TARGET_TABLE = "silver_order_interop_identifier"

TARGET_COLUMNS_SQL = """
  brand_id      string    NOT NULL,
  source        string    NOT NULL,
  order_id      string    NOT NULL,
  email_sha256  string,
  phone_sha256  string,
  derived_at    timestamp NOT NULL
"""

# ── Derivable raw lanes (struct-path verified against the live normalize jobs) ────────────────────
# Each lane: the Connect raw table (WITHOUT the `_connect` suffix — rn.read_bronze appends it),
# the provider tag written to `source`, and the STRUCT paths of order id / raw email / raw phone.
LANES = {
    "shopify_orders_raw": {
        "source": "shopify",
        "order_id_path": "order.id",
        "email_path": "order.customer.email",
        "phone_path": "order.customer.phone",
    },
    "woocommerce_orders_raw": {
        "source": "woocommerce",
        "order_id_path": "order.id",
        "email_path": "order.billing.email",
        "phone_path": "order.billing.phone",
    },
}

# ── Pure SQL builders (unit-guarded by backfill_interop_hashes_guard_test.py) ─────────────────────


def build_merge_sql(target_fqtn: str, source_view: str) -> str:
    """The idempotent additive MERGE — brand_id is the FIRST key of the ON clause (tenant-first)."""
    return f"""
        MERGE INTO {target_fqtn} t
        USING {source_view} s
        ON t.brand_id = s.brand_id AND t.source = s.source AND t.order_id = s.order_id
        WHEN MATCHED THEN UPDATE SET
          t.email_sha256 = s.email_sha256,
          t.phone_sha256 = s.phone_sha256,
          t.derived_at   = s.derived_at
        WHEN NOT MATCHED THEN INSERT
          (brand_id, source, order_id, email_sha256, phone_sha256, derived_at)
        VALUES
          (s.brand_id, s.source, s.order_id, s.email_sha256, s.phone_sha256, s.derived_at)
    """


def build_erased_identifiers_query() -> str:
    """JDBC pushdown: every ACTIVE identifier hash belonging to a crypto-shredded subject.

    identity.pii_erasure_log (migration 0114) is the RTBF erasure ledger, keyed
    (brand_id, brain_id); ops.silver_identity_link maps those brain_ids back to the
    identifier hashes historical rows would re-derive. brand_id leads every predicate.
    """
    return (
        "(SELECT DISTINCT l.brand_id::text AS brand_id, l.identifier_value AS identifier_hash "
        "FROM identity.pii_erasure_log e "
        "JOIN ops.silver_identity_link l "
        "  ON l.brand_id = e.brand_id AND l.brain_id = e.brain_id) erased"
    )


def build_salts_query() -> str:
    """(brand_id, salt_hex) — dev-derivable; prod overrides via SALT_QUERY (same seam as the
    silver normalize jobs). Needed ONLY to compute the INTERNAL salted hash used for the
    shredded-subject anti-join; the interop output hash is UNSALTED by definition (AMD-01)."""
    return os.environ.get("SALT_QUERY") or (
        "SELECT id::text AS brand_id, "
        "encode(sha256(('brain-dev-identity-salt-v1||'||lower(id::text))::bytea),'hex') AS salt_hex "
        "FROM tenancy.brand"
    )


def _read_pg(spark, query: str):
    return (
        spark.read.format("jdbc")
        .option("url", PG_JDBC_URL)
        .option("user", PG_USER)
        .option("password", PG_PASSWORD)
        .option("driver", "org.postgresql.Driver")
        .option("query" if not query.strip().startswith("(") else "dbtable", query)
        .load()
    )


def _enabled_brands(brand_ids):
    """FLAG GATE (driver-side): keep only brands with connector.identity_fields = ON.
    _platform_flags.is_flag_enabled is DEFAULT-OFF + FAIL-CLOSED — Redis down → brand skipped."""
    return [b for b in brand_ids if is_flag_enabled(b, IDENTITY_FIELDS_FLAG)]


def build(spark):
    from pyspark.sql.functions import col, current_timestamp, lit, udf  # noqa: E402
    from pyspark.sql.types import StringType  # noqa: E402

    from iceberg_base import CATALOG, SILVER_NAMESPACE, create_iceberg_table  # noqa: E402 — lazy (guard test imports Spark-free)

    import _identity_normalization as inorm  # noqa: E402 — the WA-06 python twin (interop hashes)
    import _raw_normalize as rn  # noqa: E402 — the INTERNAL salted convention (identity-link match)

    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TARGET_TABLE, TARGET_COLUMNS_SQL,
        partitioned_by="bucket(64, brand_id)",
    )

    # UDFs — interop (unsalted, AMD-01) for the OUTPUT; internal (salted) ONLY for the erased join.
    u_interop_email = udf(lambda v: inorm.email_interop_hash(v) if v else None, StringType())
    u_interop_phone = udf(lambda v: inorm.phone_interop_hash(v, REGION) if v else None, StringType())
    u_internal_email = udf(lambda v, s: rn.hash_identifier(v, "email", s, REGION) if (v and s) else None, StringType())
    u_internal_phone = udf(lambda v, s: rn.hash_identifier(v, "phone", s, REGION) if (v and s) else None, StringType())

    # PG dimension reads (small): per-brand salts + the crypto-shred exclusion set.
    salts = _read_pg(spark, build_salts_query())
    erased = _read_pg(spark, build_erased_identifiers_query())

    only_brand = (os.environ.get("BRAND_ID") or "").strip() or None
    total = 0

    for lane_table, lane in LANES.items():
        raw = rn.read_bronze(spark, CATALOG, BRONZE_NAMESPACE, lane_table, lane["source"])
        if raw.limit(1).count() == 0:
            print(f"[backfill-interop] {lane_table}_connect empty/absent — skip", flush=True)
            continue

        df = raw.select(
            col("brand_id").cast("string").alias("brand_id"),  # MT-1: server-trusted envelope ONLY
            col(lane["order_id_path"]).cast("string").alias("order_id"),
            col(lane["email_path"]).cast("string").alias("raw_email"),
            col(lane["phone_path"]).cast("string").alias("raw_phone"),
        ).where(col("order_id").isNotNull())

        if only_brand:
            df = df.where(col("brand_id") == only_brand)

        # ── FLAG GATE (per brand, fail-closed) ──────────────────────────────────────────────────
        brands = [r["brand_id"] for r in df.select("brand_id").distinct().collect()]
        enabled = _enabled_brands(brands)
        if not enabled:
            print(f"[backfill-interop] {lane_table}: no brand has {IDENTITY_FIELDS_FLAG} ON — skip", flush=True)
            continue
        df = df.where(col("brand_id").isin(enabled))

        # Nothing derivable without at least one raw identifier.
        df = df.where(col("raw_email").isNotNull() | col("raw_phone").isNotNull())

        # ── SHREDDED-SUBJECT SKIP (explicit, ledger-encoded) ────────────────────────────────────
        # Compute the INTERNAL salted hashes (the live identity-link convention) and anti-join
        # every identifier hash belonging to an erased (brand_id, brain_id).
        df = df.join(salts.hint("broadcast"), "brand_id", "left")
        df = (
            df.withColumn("internal_email", u_internal_email(col("raw_email"), col("salt_hex")))
            .withColumn("internal_phone", u_internal_phone(col("raw_phone"), col("salt_hex")))
        )
        e = erased.hint("broadcast")
        df = df.join(
            e.withColumnRenamed("identifier_hash", "internal_email"),
            ["brand_id", "internal_email"], "left_anti",
        )
        df = df.join(
            e.withColumnRenamed("identifier_hash", "internal_phone"),
            ["brand_id", "internal_phone"], "left_anti",
        )

        # ── INTEROP derivation (the output; raw is dropped right here) ──────────────────────────
        out = (
            df.withColumn("email_sha256", u_interop_email(col("raw_email")))
            .withColumn("phone_sha256", u_interop_phone(col("raw_phone")))
            .where(col("email_sha256").isNotNull() | col("phone_sha256").isNotNull())
            .select(
                col("brand_id"),
                lit(lane["source"]).alias("source"),
                col("order_id"),
                col("email_sha256"),
                col("phone_sha256"),
                current_timestamp().alias("derived_at"),
            )
        )
        out = rn.dedupe_latest(out, ["brand_id", "source", "order_id"], "derived_at")

        n = out.count()
        if n == 0:
            print(f"[backfill-interop] {lane_table}: 0 derivable rows — skip", flush=True)
            continue

        out.createOrReplaceTempView("interop_src")
        spark.sql(build_merge_sql(fqtn, "interop_src"))
        print(f"[backfill-interop] {lane_table}: MERGEd {n} rows into {fqtn}", flush=True)
        total += n

    return fqtn, total


def main() -> None:
    import time

    from iceberg_base import build_spark  # noqa: E402 — lazy (guard test imports Spark-free)
    from job_log import emit_job_log  # noqa: E402

    spark = build_spark("backfill-interop-hashes")
    spark.sparkContext.setLogLevel("WARN")
    # UDF helpers must reach the Python WORKERS (the known addPyFile gotcha).
    here = os.path.dirname(os.path.abspath(__file__))
    spark.sparkContext.addPyFile(os.path.join(here, "_identity_normalization.py"))
    spark.sparkContext.addPyFile(os.path.join(here, "silver", "_raw_normalize.py"))

    started = time.monotonic()
    try:
        fqtn, n = build(spark)
        emit_job_log("backfill_interop_hashes", status="ok", rows_out=n, fqtn=fqtn,
                     duration_ms=int((time.monotonic() - started) * 1000))
    except Exception as exc:  # noqa: BLE001 — job boundary
        emit_job_log("backfill_interop_hashes", status="error", error=str(exc)[:500],
                     duration_ms=int((time.monotonic() - started) * 1000))
        raise
    finally:
        spark.stop()


if __name__ == "__main__":
    main()
