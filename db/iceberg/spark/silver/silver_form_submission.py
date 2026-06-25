"""
silver_form_submission.py — NET-NEW canonical Silver `form_submission` (Brain V4 Phase 1b, GROUP pixel).

NO dbt predecessor (parity status=NEW). The lead / conversion-feedback grain — one row per first-party pixel
`form.submitted` event. Powers the conversion-feedback + lead dashboards: which forms (contact, newsletter,
lead-capture, account) are being submitted, on which page, in which session — WITHOUT ever reading the form's
field values. The whole point of a canonical form-submission table is to count and attribute submissions while
storing ZERO of the data the visitor typed (Brain rule: capture truth, but respect privacy — hashed/structural
only, no raw PII).

SOURCE  : rest.brain_bronze.collector_events — the `form.submitted` pixel event. The universal collector emits
          ONLY structural metadata for a form submission (form_id, page, session, anon id) and deliberately
          NEVER the entered field values, so this table is PII-safe by construction at the Bronze boundary.
GRAIN   : 1 row per (brand_id, event_id) — the Bronze idempotency key (replay-safe MERGE on it).
CANONICAL COLUMNS:
            form_id       — the form's structural identifier (e.g. "ContactFooter", "NewsletterSignup"). A DOM
                            id / name, NOT a value the user typed.
            form_name     — a human label for the form when the collector provides one (props.form_name);
                            falls back to NULL. Still structural, never user content.
            page          — landing_path, the page the form was submitted on (conversion-feedback groups by it).
            referrer      — the referrer at submission (for source-of-lead context; a URL, not PII).
            session_id    — the client session the submission belongs to (submissions-per-session rollups).
            brain_anon_id — the pseudonymous visitor id (links the submission back to the journey/identity graph
                            so a lead can later be stitched to a customer WITHOUT storing the typed email here).
            device_class, viewport — coarse device context for slicing.
NO RAW FIELD VALUES / PII: this job projects ONLY the structural columns above. It NEVER reads any
          `properties.fields` / `properties.values` / entered-text path — the typed contents are intentionally
          absent. brain_anon_id is an opaque pseudonymous id; form_id/form_name are DOM identifiers. There is
          NO raw email / phone / name column on this mart.
MONEY   : none — a form submission carries no money (it is a lead/intent signal). NO money column on this mart.
ISOLATION: brand_id is the FIRST column + the bucket() partition anchor (tenant isolation by construction).

DATA AVAILABILITY (this session): current Bronze HAS form.submitted=12 rows, so this materializes a small
populated table. Parity status=NEW (no dbt form-submission predecessor — oracle emits SKIP
reason=current-mart-absent).
"""
from __future__ import annotations  # Spark image is Python 3.8 — defer `str | None` annotation eval.

from _silver_base import ensure_silver_table, merge_on_pk, prop, read_bronze_events, run_job
from pyspark.sql.functions import col

TABLE = "silver_form_submission"

FORM_EVENTS = ["form.submitted"]

COLUMNS_SQL = """
          brand_id       string    NOT NULL,
          event_id       string    NOT NULL,
          form_id        string,
          form_name      string,
          page           string,
          referrer       string,
          session_id     string,
          brain_anon_id  string,
          device_class   string,
          viewport       string,
          occurred_at    timestamp NOT NULL,
          ingested_at    timestamp NOT NULL
""".strip("\n")


def build(spark):
    fqtn = ensure_silver_table(
        spark, TABLE, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), days(occurred_at)"
    )

    raw = read_bronze_events(spark, FORM_EVENTS)
    # PII-SAFE projection: ONLY structural metadata. We deliberately do NOT read any entered-value path
    # (properties.fields / properties.values) — the typed contents never enter Silver.
    staged = raw.select(
        col("brand_id"),
        col("event_id"),
        prop("pj", "form_id").alias("form_id"),
        prop("pj", "form_name").alias("form_name"),
        prop("pj", "landing_path").alias("page"),
        prop("pj", "referrer").alias("referrer"),
        prop("pj", "session_id").alias("session_id"),
        prop("pj", "brain_anon_id").alias("brain_anon_id"),
        prop("pj", "device.ua_class").alias("device_class"),
        prop("pj", "device.viewport").alias("viewport"),
        col("occurred_at"),
        col("ingested_at"),
    ).where(col("event_id").isNotNull() & col("brand_id").isNotNull())

    merge_on_pk(spark, fqtn, staged, ["brand_id", "event_id"], order_by_desc=["ingested_at", "occurred_at"])
    return fqtn, spark.table(fqtn).count()


if __name__ == "__main__":
    run_job("silver-form-submission", build)
