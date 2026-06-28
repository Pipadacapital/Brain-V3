"""
silver_search.py — NET-NEW canonical Silver `search` grain (Brain V4 Phase 1b, GROUP pixel-behavior).

NO dbt predecessor (parity status=NEW). The on-site-search grain — one row per search.submitted signal from
the universal first-party pixel. Powers the `behavior` dashboard and merchandising (coverage matrix §2:
search.submitted → silver_search). The fact a shopper searched a term, how many results it returned, and
the session it happened in — the surface that powers top-queries, zero-result-rate, and
search-to-conversion behavior analytics.

SOURCE (universal pixel, collector pixel-asset.route.ts):
  - 'search.submitted' — a /search page load or a search-form submit. carries `query` (the search term),
                         optionally `results` (result count), plus session_id / landing_path / referrer /
                         device.* / brain_anon_id.

GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key.
MONEY   : NONE — a search is not monetary (no money column).
PII     : hashed/anon-only — brain_anon_id (opaque pixel id), session_id (per-visit uuid). The search
          `query` is the typed term (merchandising signal, not a contact identifier); we store it as-is for
          top-query analytics. No raw email/phone/name rides through.
ISOLATION: brand_id first column + bucket(256, brand_id) + days(occurred_at) partition.

RESULTS: results_count is the # of results the search returned WHEN the storefront emits it; NULL otherwise
         (the current Shopify search-page capture emits only the query) — never fabricated. is_zero_result
         is derived ONLY when results_count is non-null (so a NULL count is NOT mislabeled a zero-result).

STAGE-1 GATE (Brain V4 two-stage): a search is non-monetary, so the applicable Stage-1 DQ rules are the
  TIMESTAMP gate (occurred_at → future_occurred_at / unparseable_timestamp) and the QUANTITY gate over
  results_count (impossible_quantity: a negative or absurd result count). A NULL results_count is OMITTED
  from the check (the count is genuinely unknown, not zero/invalid). A failing search is diverted to
  brain_silver.silver_quarantine (stage='dq') and NEVER written to silver_search; Bronze keeps the
  original (replay-safe). The `query` is the typed search term (a merchandising signal stored as-is, never
  a contact identifier), so clean_name/clean_string do NOT apply — no parity-altering rewrite. Good rows
  are byte-identical to before (parity-faithful).

DATA AVAILABILITY (this session): current Bronze has search.submitted (4) → populated; results_count is NULL
(the search-page capture emits query only) — both schema + transform are the deliverable and populate with
no code change once a storefront emits a result count. Parity status=NEW (no dbt baseline).
"""
from __future__ import annotations

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from _silver_technical import dq_violations_udf, write_quarantine
from pyspark.sql.functions import array_join, coalesce, col, lit, size, when

TABLE = "silver_search"

SEARCH_EVENTS = ["search.submitted"]

COLUMNS_SQL = """
          brand_id        string    NOT NULL,
          event_id        string    NOT NULL,
          brain_anon_id   string    NOT NULL,
          session_id      string,
          query           string,
          results_count   bigint,
          is_zero_result  boolean,
          path            string,
          referrer        string,
          device_class    string,
          occurred_at     timestamp NOT NULL,
          ingested_at     timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, SEARCH_EVENTS).select(
        col("brand_id"),
        col("event_id"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "session_id").alias("session_id"),
        # The emitter sends `query`; accept `q` as a fallback (some storefronts name the param `q`).
        coalesce(prop("pj", "query"), prop("pj", "q")).alias("query"),
        # Result count only when the storefront emits it (results | results_count); else NULL.
        coalesce(prop("pj", "results"), prop("pj", "results_count")).cast("bigint").alias("results_count"),
        prop("pj", "landing_path").alias("path"),
        prop("pj", "referrer").alias("referrer"),
        prop("pj", "device.ua_class").alias("device_class"),
        col("occurred_at"),
        col("ingested_at"),
        # Carry the raw payload so a quarantined reject is replayable from the quarantine row alone.
        col("pj").alias("_payload"),
    )

    staged = (
        # Derive zero-result ONLY when the count is present — a NULL count stays unknown (NULL), not zero.
        raw.withColumn(
            "is_zero_result",
            when(col("results_count").isNotNull(), col("results_count") == lit(0)).otherwise(
                lit(None).cast("boolean")
            ),
        )
        .select(
            "brand_id", "event_id", "brain_anon_id", "session_id", "query", "results_count",
            "is_zero_result", "path", "referrer", "device_class", "occurred_at", "ingested_at", "_payload",
        )
        .where(col("event_id").isNotNull() & col("brand_id").isNotNull() & col("brain_anon_id").isNotNull())
    )

    # ── Stage-1 DQ gate: timestamp validity + result-count quantity (non-monetary entity, no money gate) ─
    gated = staged.withColumn(
        "_dq",
        dq_violations_udf()(
            lit(None).cast("bigint"),
            lit(None).cast("string"),
            col("occurred_at").cast("string"),
            col("results_count"),
        ),
    )
    write_quarantine(
        spark,
        gated.where(size(col("_dq")) > 0).select(
            col("brand_id"),
            lit("search.submitted").alias("source"),
            col("event_id").alias("bronze_event_id"),
            lit(TABLE).alias("canonical_target"),
            array_join(col("_dq"), ",").alias("reason"),
            col("_payload").alias("payload"),
        ),
        stage="dq",
    )
    good = gated.where(size(col("_dq")) == 0).drop("_dq", "_payload")

    merge_on_pk(spark, fqtn, good, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-search", build, target_table="silver_search")
