"""
silver_form_submission.py (DuckDB) — faithful port of db/iceberg/spark/silver/silver_form_submission.py.

NET-NEW canonical Silver `form_submission` (Brain V4 Phase 1b, GROUP pixel). The lead / conversion-feedback
grain: one row per first-party pixel `form.submitted` event, read from the gated keystone
rest.brain_silver.silver_collector_event (ADR-0006 P3 — the Spark job's read_bronze_events reads that same
gated source). Powers the conversion-feedback + lead dashboards WITHOUT ever reading the form's field values.

FAITHFUL to the Spark build():
  - event_type IN ('form.submitted').
  - PII-SAFE structural-only projection: form_id, form_name, page (landing_path), referrer, session_id,
    brain_anon_id, device_class (device.ua_class), viewport (device.viewport). It NEVER reads any
    entered-value path (properties.fields / properties.values) — typed contents never enter Silver.
    brain_anon_id is an opaque pseudonymous id, form_id/form_name are DOM identifiers; nothing is
    re-derived or un-hashed.
  - admission filter: event_id IS NOT NULL AND brand_id IS NOT NULL (matches the Spark .where()).
  - idempotent MERGE on (brand_id, event_id), latest-ingested-wins (order_by_desc ingested_at, occurred_at).
MONEY: none — a form submission carries no money (lead/intent signal). NO money column on this mart.
ISOLATION: brand_id is the FIRST column + the bucket() partition anchor.

CAVEAT — quarantine side-write SKIPPED: the Spark job runs a Stage-1 DQ TIMESTAMP gate
(_silver_technical.dq_violations_udf over occurred_at: future_occurred_at / unparseable_timestamp) and
diverts failures to brain_silver.silver_quarantine (stage='dq'), dropping them from the mart. This DuckDB
port does NOT write the quarantine side-table (no _silver_technical analogue here) and does NOT reproduce
the occurred_at timestamp-validity drop — occurred_at is already a parsed `timestamp` in the gated keystone
(silver_collector_event), so the Stage-1 unparseable/future check is a no-op for well-formed source rows;
Bronze/keystone keep the originals, so the quarantine ledger can be rebuilt separately. Good rows are
data-equivalent to the Spark mart output.

Parity target: brain_silver.silver_form_submission.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from _base import ensure_table, merge_on_pk, prop, read_gated_events_sql, run_job  # noqa: E402
from _catalog import CATALOG, SILVER_NAMESPACE  # noqa: E402

# MIGRATION_TABLE_SUFFIX lets the parity harness write silver_form_submission_duckdb_test beside the
# Spark-produced live table (parallel run → compare → cut over). Empty in production.
TARGET = f"{CATALOG}.{SILVER_NAMESPACE}.silver_form_submission{os.environ.get('MIGRATION_TABLE_SUFFIX', '')}"

FORM_EVENTS = ["form.submitted"]

# Canonical Silver column contract — mirrors the Spark mart DDL column-for-column. No money column.
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

COLUMNS = [
    "brand_id", "event_id", "form_id", "form_name", "page", "referrer", "session_id",
    "brain_anon_id", "device_class", "viewport", "occurred_at", "ingested_at",
]


def build(con):
    ensure_table(con, TARGET, COLUMNS_SQL, partitioned_by="bucket(256, brand_id), day(occurred_at)")

    # PII-SAFE projection: ONLY structural metadata. We deliberately do NOT read any entered-value path
    # (properties.fields / properties.values) — the typed contents never enter Silver.
    staged = f"""
      SELECT
        brand_id,
        event_id,
        {prop('pj','form_id')}          AS form_id,
        {prop('pj','form_name')}        AS form_name,
        {prop('pj','landing_path')}     AS page,
        {prop('pj','referrer')}         AS referrer,
        {prop('pj','session_id')}       AS session_id,
        {prop('pj','brain_anon_id')}    AS brain_anon_id,
        {prop('pj','device.ua_class')}  AS device_class,
        {prop('pj','device.viewport')}  AS viewport,
        occurred_at,
        ingested_at
      FROM ({read_gated_events_sql(FORM_EVENTS)})
      WHERE event_id IS NOT NULL AND brand_id IS NOT NULL
    """

    return merge_on_pk(con, TARGET, staged, COLUMNS, ["brand_id", "event_id"],
                       order_by_desc=["ingested_at", "occurred_at"])


if __name__ == "__main__":
    run_job("silver-form-submission", build, target_table="silver_form_submission")
