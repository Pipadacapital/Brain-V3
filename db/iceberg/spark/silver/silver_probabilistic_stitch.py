# SPEC: A.3 (WA-20) — Probabilistic stitch (QUARANTINED). AMD-12 R1: Splink is a SIBLING matcher_id
# that EXCLUSIVELY owns brain_silver.silver_probabilistic_stitch; the live rule-based Fellegi–Sunter
# matcher (MergeReview) is untouched. §1.4 quarantine is ABSOLUTE — nothing here is ever read by
# attribution/revenue (guarded by probabilistic_quarantine_guard_test.py).
"""
silver_probabilistic_stitch.py — Splink (Python, Spark backend) probabilistic session→customer stitch.

WHAT IT DOES (spec A.3)
  Over UNSTITCHED sessions (no deterministic identity), score each against the DETERMINISTICALLY-known
  customers using weak device/behavioral signals; write ONLY pairs with match probability ≥ 0.95 to the
  QUARANTINED table brain_silver.silver_probabilistic_stitch:
      {brand_id, session_id, probabilistic_brain_id, confidence, model_version, features_used, scored_at}

  session grain = brain_anon_id (the repo "session key" — silver_touchpoint sessionizes per brain_anon_id;
  session_id column carries brain_anon_id). Probabilistic NEVER crosses brand_id (tenant isolation).

TRAINING (train on deterministic labels; 20% holdout evaluated OUT-OF-BAND)
  The model is trained with Splink's supervised m-estimation from a DETERMINISTIC label column
  (`det_person`, derived from identify email-hash clusters = multi-device truth). u is estimated by
  random sampling. The holdout precision/recall + the 0.98 ship bar live in the reproducible harness
  splink_v1_golden_eval.py → knowledge-base/models/splink-v1.md (run there; do NOT re-derive here).

FLAG GATE (identity.probabilistic, per-brand, DEFAULT OFF — registry: "writes silver_probabilistic_stitch
  (quarantined; never attribution/revenue)"). The job SCORES every brand but only WRITES ≥0.95 rows for
  brands whose flag is ON. Default OFF ⇒ zero rows written ⇒ the quarantined table stays EMPTY ⇒
  golden byte-identical (§0.5) and the quarantine holds trivially. The 0.98 ship bar (harness) gates
  turning the flag ON for a real brand; the flag stays OFF on golden regardless of any score.

FEATURE AVAILABILITY (honest — see the model card):
  Available on the pixel/golden envelope: device.ua_class (desktop|mobile), device.viewport (screen
  class), hour-of-day (occurred_at) → dominant daypart + active-hour overlap, top-product overlap
  (product_handle). ABSENT (documented, honestly not used): IP /24 (schema seam exists in the resolver
  but the pixel never populates it — 0 rows), timezone, OS / UA-family, device-fingerprint. The spec's
  blocking keys (same IP /24 + 7-day window; device-fingerprint hash) are therefore UNAVAILABLE; the
  fallback blocking is brand_id (tenant isolation) + coarse device/daypart signals. This is why the
  model emits 0 rows ≥0.95 on golden — a DATA (entropy) limit, not a code limit.

DEPENDENCY NOTE (WA-16 not yet built): silver_session_identity / identity_current_v (the sanctioned
  deterministic identity views) are a later Wave A deliverable. Until they land, this job derives its
  deterministic label + probabilistic_brain_id from identify email-hash clusters in
  silver_collector_event (AMD-13-style bridge: switch to identity_current_v behind the flag when WA-16
  ships, with golden parity first). ADDITIVE, non-breaking.

LOCAL PROFILE (A.2.5): --master local[2], --driver-memory 4g (run-silver-probabilistic-stitch.sh),
  brand-partitioned so a single-brand scoring pass stays within the 4GB executor budget on golden.

Run via run-silver-probabilistic-stitch.sh (installs Splink 3.x into the apache/spark:3.5.3 image —
Python 3.8 → Splink <4 — or use the built brain Spark image which pip-installs it at BUILD time).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from pyspark.sql import SparkSession
from pyspark.sql import functions as F

from iceberg_base import (  # noqa: E402
    CATALOG,
    SILVER_NAMESPACE,
    build_spark,
    create_iceberg_table,
)

try:  # driver-only gate; fail-closed (default OFF) if the twin/redis is unreachable
    from _platform_flags import FLAG_IDENTITY_PROBABILISTIC, is_flag_enabled  # noqa: E402
except Exception:  # noqa: BLE001
    FLAG_IDENTITY_PROBABILISTIC = "identity.probabilistic"

    def is_flag_enabled(_brand_id: str, _flag: str) -> bool:  # fail-closed
        return False


MODEL_VERSION = os.environ.get("SPLINK_MODEL_VERSION", "splink-v1")
OUTPUT_FLOOR = float(os.environ.get("SPLINK_OUTPUT_FLOOR", "0.95"))  # spec A.3 write floor
FEATURES_USED = "ua_class,screen_class,daypart,active_hours,top_products"  # honest: what the model saw

_SILVER_NS = os.environ.get("SILVER_NAMESPACE", "brain_silver")
COLLECTOR_TABLE = f"{CATALOG}.{_SILVER_NS}.silver_collector_event"
TOUCHPOINT_TABLE = f"{CATALOG}.{_SILVER_NS}.silver_touchpoint"
TABLE_NAME = "silver_probabilistic_stitch"

# Spec output schema (exact) + brand_id-first tenant key. hash-only PII (session_id = anon; brain_id proxy).
_COLUMNS = """
          brand_id             string    NOT NULL,
          session_id           string    NOT NULL,
          probabilistic_brain_id string  NOT NULL,
          confidence           double,
          model_version        string,
          features_used        string,
          scored_at            timestamp NOT NULL
""".strip("\n")


def _feature_frame(spark: SparkSession):
    """Per-anon (session grain) feature frame + deterministic person label, over Silver only.

    device/identify signals from silver_collector_event; product/hour from silver_touchpoint. det_person
    is a deterministic label from identify email-hash (multi-device truth) — the m-training label AND the
    probabilistic_brain_id source until WA-16's identity_current_v lands (see module docstring)."""
    ev = spark.read.table(COLLECTOR_TABLE).select(
        "brand_id", "event_type", "occurred_at",
        F.get_json_object("payload", "$.properties.brain_anon_id").alias("anon"),
        F.get_json_object("payload", "$.properties.device.ua_class").alias("ua_class"),
        F.get_json_object("payload", "$.properties.device.viewport").alias("screen_class"),
        F.get_json_object("payload", "$.properties.hashed_customer_email").alias("email"),
    ).where(F.col("anon").isNotNull() & (F.col("anon") != ""))
    ev = ev.withColumn("hr", F.hour("occurred_at"))

    dev = ev.groupBy("brand_id", "anon").agg(
        F.max("ua_class").alias("ua_class"),        # ua_class/viewport are anon-consistent on golden
        F.max("screen_class").alias("screen_class"),
        F.collect_set(F.when(F.col("event_type") == "identify", F.col("email"))).alias("emails_raw"),
        F.collect_set("hr").alias("hrs_ev"),
    )

    tp = spark.read.table(TOUCHPOINT_TABLE).select(
        "brand_id", F.col("brain_anon_id").alias("anon"), "product_handle", "occurred_at",
    )
    tp = tp.withColumn("hr", F.hour("occurred_at"))
    tp_agg = tp.groupBy("brand_id", "anon").agg(
        F.collect_set(F.when(F.col("product_handle").isNotNull() & (F.col("product_handle") != ""),
                             F.col("product_handle"))).alias("top_products"),
        F.collect_set("hr").alias("hrs_tp"),
    )

    feats = dev.join(tp_agg, ["brand_id", "anon"], "outer")
    # emails_raw / collect_set includes a null when the CASE misses — filter it out.
    feats = feats.withColumn(
        "emails", F.array_sort(F.expr("filter(coalesce(emails_raw, array()), x -> x is not null)"))
    ).withColumn(
        "active_hours", F.array_sort(F.array_distinct(F.concat(
            F.coalesce(F.col("hrs_ev"), F.array()), F.coalesce(F.col("hrs_tp"), F.array()))))
    ).withColumn(
        "top_products", F.coalesce(F.col("top_products"), F.array())
    ).withColumn(
        "daypart", F.when(F.size("active_hours") > 0, F.element_at("active_hours", 1) / F.lit(6)).cast("int")
    )
    # Deterministic person label / brain_id proxy: identified anons only (email present). Min email hash
    # groups multi-device anons that share it (full bi-temporal clustering arrives with WA-16). NULL for
    # unstitched anons — excluded from m-from-label training (null != null) → probabilistic-eligible.
    feats = feats.withColumn(
        "det_person",
        F.when(F.size("emails") > 0,
               F.concat(F.lit("DET-"), F.sha1(F.concat_ws("|", F.col("brand_id"), F.element_at("emails", 1)))))
    )
    return feats.select(
        F.col("anon").alias("unique_id"), "brand_id", "ua_class", "screen_class", "daypart",
        "active_hours", "top_products", "det_person",
    )


def _splink_settings():
    # Splink 3.9.x (Python 3.8 image): the DIALECT-specific comparison library carries the lowercase
    # factory fns (exact_match / array_intersect_at_sizes). splink.comparison_library holds only *Base.
    import splink.spark.comparison_library as cl
    return {
        "link_type": "dedupe_only",
        "unique_id_column_name": "unique_id",
        # Surface brand_id (tenant orientation) + det_person (the deterministic label / brain_id proxy)
        # onto the pairwise prediction output as *_l / *_r so _score can orient identified↔unstitched.
        "additional_columns_to_retain": ["brand_id", "det_person"],
        # Spec blocking keys (IP /24 + 7-day window; device-fingerprint) are ABSENT (see docstring).
        # Fallback: brand_id FIRST (probabilistic never crosses tenant) + the coarse signals we have.
        "blocking_rules_to_generate_predictions": [
            "l.brand_id = r.brand_id and l.screen_class = r.screen_class and l.daypart = r.daypart",
            "l.brand_id = r.brand_id and l.ua_class = r.ua_class",
        ],
        "comparisons": [
            cl.exact_match("ua_class"),
            cl.exact_match("screen_class"),
            cl.exact_match("daypart"),
            cl.array_intersect_at_sizes("active_hours", [3, 2, 1]),
            cl.array_intersect_at_sizes("top_products", [3, 2, 1]),
        ],
    }


def _prepare_splink_spark(spark: SparkSession) -> None:
    """Two Splink-3.9-on-Spark-3.5.3 shims the job needs before any SparkLinker runs:
      1. a checkpoint dir — SparkLinker checkpoints to break query lineage (else `Checkpoint directory
         has not been set`). Local /tmp by default; override SPLINK_CHECKPOINT_DIR for a prod S3A path.
      2. an `array_length` session function — Splink's Spark array_intersect_at_sizes SQL emits
         ARRAY_LENGTH, which is NOT a Spark 3.5.3 builtin (Spark uses size()); alias it so the array
         comparisons (active_hours / top_products) resolve."""
    spark.sparkContext.setCheckpointDir(os.environ.get("SPLINK_CHECKPOINT_DIR", "/tmp/splink_checkpoints"))
    spark.udf.register("array_length", lambda a: (len(a) if a is not None else 0), "int")


def _score(spark: SparkSession, feats):
    """Train on deterministic labels, predict pairwise, keep identified↔unstitched pairs ≥ floor.

    Single dedupe_only linker over ALL sessions: m estimated from the det_person label (null labels are
    excluded), u by random sampling. From predictions, keep pairs where exactly ONE side is identified
    (has det_person) and the other is unstitched → (session_id = unstitched anon, probabilistic_brain_id
    = identified det_person, confidence = match probability) ≥ OUTPUT_FLOOR. Returns a Spark DataFrame in
    the _COLUMNS shape (possibly empty — the golden reality: max prob ≈ 0.04)."""
    # §1.4 optional weak-signal matcher — DEGRADE SAFELY when splink is absent from the Spark image.
    # The quarantined table then stays empty (identical to the flag-OFF write path), the refresh exits
    # clean, and no deterministic output is affected. Only brands with identity.probabilistic ON would
    # ever consume this table, and the import is the sole hard dependency on the library.
    try:
        from splink.spark.linker import SparkLinker
    except ModuleNotFoundError:
        print("[silver_probabilistic_stitch] splink not installed — skipping probabilistic scoring "
              "(quarantined table stays empty; §1.4 optional weak-signal matcher)", flush=True)
        return None

    feats = feats.persist()
    n_labeled = feats.where(F.col("det_person").isNotNull()).limit(1).count()
    if n_labeled == 0:
        print("[silver_probabilistic_stitch] no deterministic labels (no identify emails) — nothing to train/score", flush=True)
        return None

    linker = SparkLinker(feats, _splink_settings(), spark=spark)
    linker.estimate_u_using_random_sampling(max_pairs=float(os.environ.get("SPLINK_U_MAX_PAIRS", "2e6")))
    try:
        linker.estimate_m_from_label_column("det_person")
    except Exception as exc:  # noqa: BLE001 — too few labeled pairs → untrained m (defaults). Safe: scores stay low.
        print(f"[silver_probabilistic_stitch] m-from-label skipped ({exc}); using default m", flush=True)

    preds = linker.predict(threshold_match_probability=OUTPUT_FLOOR).as_spark_dataframe()
    # keep identified(one side) ↔ unstitched(other side); orient so probabilistic_brain_id = identified.
    p = preds.select(
        "match_probability",
        F.col("unique_id_l").alias("id_l"), F.col("unique_id_r").alias("id_r"),
        F.col("det_person_l").alias("det_l"), F.col("det_person_r").alias("det_r"),
        F.col("brand_id_l").alias("brand_id"),
    ).where(
        (F.col("det_l").isNotNull() & F.col("det_r").isNull())
        | (F.col("det_l").isNull() & F.col("det_r").isNotNull())
    )
    out = p.select(
        "brand_id",
        F.when(F.col("det_l").isNull(), F.col("id_l")).otherwise(F.col("id_r")).alias("session_id"),
        F.when(F.col("det_l").isNotNull(), F.col("det_l")).otherwise(F.col("det_r")).alias("probabilistic_brain_id"),
        F.col("match_probability").cast("double").alias("confidence"),
        F.lit(MODEL_VERSION).alias("model_version"),
        F.lit(FEATURES_USED).alias("features_used"),
        F.current_timestamp().alias("scored_at"),
    ).where(F.col("confidence") >= F.lit(OUTPUT_FLOOR))
    # keep the single best identified match per unstitched session (highest confidence).
    from pyspark.sql.window import Window
    w = Window.partitionBy("brand_id", "session_id").orderBy(F.col("confidence").desc(), F.col("probabilistic_brain_id"))
    out = out.withColumn("_rn", F.row_number().over(w)).where(F.col("_rn") == 1).drop("_rn")
    return out


def build(spark: SparkSession) -> str:
    fqtn = create_iceberg_table(
        spark, SILVER_NAMESPACE, TABLE_NAME, _COLUMNS, partitioned_by="bucket(64, brand_id)",
    )
    feats = _feature_frame(spark)
    scored = _score(spark, feats)
    if scored is None:
        print(f"[silver_probabilistic_stitch] {fqtn}: no rows scored", flush=True)
        return fqtn

    # ── FLAG GATE (identity.probabilistic, per-brand, default OFF) — write ONLY flag-ON brands ────────
    brands = [r["brand_id"] for r in scored.select("brand_id").distinct().collect()]
    enabled = [b for b in brands if is_flag_enabled(b, FLAG_IDENTITY_PROBABILISTIC)]
    if not enabled:
        print(
            f"[silver_probabilistic_stitch] flag '{FLAG_IDENTITY_PROBABILISTIC}' OFF for all "
            f"{len(brands)} scored brand(s) → 0 rows written (quarantined table stays empty)", flush=True,
        )
        return fqtn
    to_write = scored.where(F.col("brand_id").isin(enabled))

    to_write.createOrReplaceTempView("splink_stitch_new")
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING splink_stitch_new s
        ON t.brand_id = s.brand_id AND t.session_id = s.session_id
           AND t.probabilistic_brain_id = s.probabilistic_brain_id AND t.model_version = s.model_version
        WHEN MATCHED THEN UPDATE SET *
        WHEN NOT MATCHED THEN INSERT *
        """
    )
    n = spark.table(fqtn).count()
    print(f"[silver_probabilistic_stitch] MERGE complete → {fqtn} has {n} row(s) "
          f"(flag-ON brands: {len(enabled)})", flush=True)
    return fqtn


def main() -> None:
    spark = build_spark("silver-probabilistic-stitch")
    spark.sparkContext.setLogLevel("WARN")
    _prepare_splink_spark(spark)
    build(spark)


if __name__ == "__main__":
    main()
