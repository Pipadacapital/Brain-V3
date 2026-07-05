"""
gold_journey_events_reversion.py — MERGE RE-VERSIONING for the event-sourced journey ledger
brain_gold.journey_events (spec gap G4 companion of gold_journey_events.py — SAME table, separate
job so the v4-refresh-loop sequences it in the BI tier AFTER construction + identity export).

EVENT-SOURCED SEMANTICS (the contract this job enforces):
  journey_events is an append-mostly VERSIONED ledger. An identity MERGE (silver_identity_map row
  closed with replaced_by_brain_id) never rewrites history: the superseded owner's rows survive
  verbatim — the ONLY in-place mutation ever applied is flipping is_current=false (+ its updated_at
  audit stamp). Ownership transfer is expressed as NEW rows: copies of the superseded rows re-keyed
  to the canonical brain_id with data_version = old_version + 1 and is_current=true. Every version
  of every touchpoint therefore remains queryable forever; the serving view
  mv_journey_events_current projects WHERE is_current = true.

WHAT ONE RUN DOES:
  1. CHECKPOINT — reads the silver_job_watermark side-table (job name
     gold_journey_events_reversion, iceberg_base.read/write_job_watermark) keyed on
     silver_identity_map.updated_at; FULL_REFRESH=1 re-scans all merge history (idempotent).
  2. DETECT — merge events since the checkpoint: identity-map rows with is_current=false AND
     replaced_by_brain_id IS NOT NULL AND updated_at > checkpoint → distinct
     (brand_id, old_brain_id = brain_id, new_brain_id = replaced_by_brain_id). Chains (A→B, B→C)
     are resolved to their TERMINAL canonical id driver-side (merge batches are tiny).
  3. AFFECTED — journey_events rows whose LATEST data_version is still owned by an old_brain_id.
     Keying on latest-version-ownership (not on is_current) makes the run CRASH-SAFE: if a prior
     run flipped flags but died before inserting the copies, the latest version still belongs to
     the old id, so a re-run re-detects and completes the transfer (the watermark only advances
     after full success).
  4. FLIP FIRST — MERGE UPDATE is_current=false on the affected rows (flip before insert: a crash
     between the two steps leaves the latest version with the old owner → re-detected on re-run;
     the reverse order would strand duplicate currents).
  5. INSERT COPIES — new rows with brain_id = new_brain_id, data_version = old + 1,
     is_current=true, sequence_number RECOMPUTED over the UNION of the new owner's current
     timeline (row_number over occurred_at with the deterministic touchpoint_id tiebreak — the
     ledger does not carry touch_seq). Only the INSERTED copies carry the recomputed positions;
     the new owner's pre-existing rows are never touched (event-sourced: no in-place edits beyond
     the is_current flip) — readers ordering by occurred_at see the true merged timeline either way.
  6. ADVANCE the watermark (only after both steps committed).

Money rule: revenue_minor (bigint MINOR units) + currency_code are carried VERBATIM onto the copy
— a merge moves ownership, never money. identity_confidence is carried as recorded at
construction; the next construction refresh restamps it from the live identity map.

Run via run-gold-journey-reversion.sh (name chosen so the loop glob sorts it AFTER
run-gold-journey-events.sh — '-' sorts before '.' in C collation, so a
run-gold-journey-events-reversion.sh would have run FIRST).
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import sys

_GOLD_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_GOLD_DIR))  # iceberg_base
sys.path.insert(0, _GOLD_DIR)                   # _gold_base

from pyspark.sql import SparkSession  # noqa: E402
from pyspark.sql.functions import col, lit  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    read_job_watermark,
    write_job_watermark,
)
from _gold_base import SILVER_NS, merge_on_pk, run_job, silver_exists  # noqa: E402

JOB_NAME = "gold_journey_events_reversion"   # silver_job_watermark key (distinct from the table's)
TABLE_NAME = "journey_events"                # the SAME ledger construction writes
PK = ["brand_id", "touchpoint_id", "data_version"]


def _resolve_terminal(pairs):
    """Collapse merge CHAINS driver-side: [(brand, old, new), …] → old maps to its TERMINAL canonical
    id (A→B + B→C becomes A→C and B→C). Cycle-guarded (a pathological A→B→A stops at the last id
    before revisiting). Merge batches since a checkpoint are tiny, so a driver dict is fine."""
    fwd = {}
    for brand, old, new in pairs:
        fwd[(brand, old)] = new
    resolved = []
    for (brand, old), new in fwd.items():
        seen = {old}
        terminal = new
        while (brand, terminal) in fwd and terminal not in seen:
            seen.add(terminal)
            terminal = fwd[(brand, terminal)]
        resolved.append((brand, old, terminal))
    return resolved


def _copies_sql(fqtn: str) -> str:
    """The re-versioned copies: affected rows re-keyed to the canonical brain_id, data_version + 1,
    is_current=true, sequence_number recomputed over the UNION of the new owner's current timeline.
    All other columns (incl. revenue_minor + currency_code) carry VERBATIM — a merge moves
    ownership, never money, never history."""
    return f"""
        WITH own AS (  -- the new owner's pre-existing current timeline (kept in place, never edited)
            SELECT je.brand_id, je.brain_id, je.touchpoint_id, je.occurred_at
            FROM {fqtn} je
            WHERE je.is_current = true
              AND EXISTS (
                    SELECT 1 FROM _merge_pairs m
                    WHERE m.brand_id = je.brand_id AND m.new_brain_id = je.brain_id
              )
        ),
        timeline AS (  -- union of copies-to-be + the owner's existing currents → true merged order
            SELECT brand_id, new_brain_id AS brain_id, touchpoint_id, occurred_at, true AS is_copy
            FROM _je_affected
            UNION ALL
            SELECT brand_id, brain_id, touchpoint_id, occurred_at, false AS is_copy
            FROM own
        ),
        seq AS (
            SELECT brand_id, brain_id, touchpoint_id, is_copy,
                   cast(row_number() OVER (
                       PARTITION BY brand_id, brain_id
                       ORDER BY occurred_at ASC, touchpoint_id ASC
                   ) AS bigint) AS sequence_number
            FROM timeline
        )
        SELECT
            a.brand_id,
            a.new_brain_id AS brain_id,
            a.touchpoint_id,
            a.source_event_ref,
            cast(a.data_version + 1 AS int) AS data_version,   -- the version bump
            true AS is_current,
            s.sequence_number,
            a.occurred_at,
            a.session_key,
            a.event_category,
            a.event_type,
            a.channel,
            a.campaign,
            a.revenue_minor,
            a.currency_code,
            a.product_handles,
            a.attribution_signals,
            a.identity_confidence,
            a.is_composite,
            a.composite_order_key,
            a.ingested_at,
            current_timestamp() AS updated_at
        FROM _je_affected a
        JOIN seq s
          ON s.brand_id = a.brand_id AND s.brain_id = a.new_brain_id
         AND s.touchpoint_id = a.touchpoint_id AND s.is_copy = true
    """


def build(spark: SparkSession):
    fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE_NAME}"

    # The ledger must exist (construction runs first in the loop) — degrade gracefully if not.
    try:
        spark.table(fqtn).schema
    except Exception:  # noqa: BLE001 — absent target → nothing to re-version yet
        print(f"[{JOB_NAME}] target {fqtn} absent — run gold_journey_events first; no-op.", flush=True)
        return fqtn, 0

    if not silver_exists(spark, "silver_identity_map"):
        print(f"[{JOB_NAME}] silver_identity_map absent — no merge events to fold; no-op.", flush=True)
        return fqtn, spark.table(fqtn).count()

    # 1. CHECKPOINT (silver_job_watermark side-table, keyed on silver_identity_map.updated_at).
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    wm = None if full_refresh else read_job_watermark(spark, JOB_NAME)

    idm = spark.table(f"{CATALOG}.{SILVER_NS}.silver_identity_map")
    new_wm = idm.selectExpr("max(updated_at) AS m").collect()[0]["m"]

    # 2. DETECT merge events since the checkpoint.
    merged = idm.where(
        (col("is_current") == lit(False))
        & col("replaced_by_brain_id").isNotNull()
        & (col("brain_id") != col("replaced_by_brain_id"))
    )
    if wm is not None:
        merged = merged.where(col("updated_at") > lit(wm))
    pairs = [
        (r["brand_id"], r["brain_id"], r["replaced_by_brain_id"])
        for r in merged.select("brand_id", "brain_id", "replaced_by_brain_id").distinct().collect()
        if r["brand_id"] is not None
    ]
    if not pairs:
        write_job_watermark(spark, JOB_NAME, new_wm)
        print(f"[{JOB_NAME}] no merge events since checkpoint — 0 re-versions", flush=True)
        return fqtn, spark.table(fqtn).count()

    resolved = _resolve_terminal(pairs)
    spark.createDataFrame(
        resolved, "brand_id string, old_brain_id string, new_brain_id string"
    ).createOrReplaceTempView("_merge_pairs")
    print(f"[{JOB_NAME}] {len(resolved)} merge pair(s) since checkpoint (chains resolved)", flush=True)

    # 3. AFFECTED = ledger rows whose LATEST version is still owned by an old brain_id. Latest-version
    #    ownership (not is_current) keys the detection so a crash between flip and insert is re-run-safe.
    affected = spark.sql(
        f"""
        WITH latest AS (
            SELECT brand_id, touchpoint_id, max(data_version) AS max_ver
            FROM {fqtn}
            GROUP BY brand_id, touchpoint_id
        )
        SELECT je.*, m.new_brain_id
        FROM {fqtn} je
        JOIN latest l
          ON l.brand_id = je.brand_id AND l.touchpoint_id = je.touchpoint_id
         AND je.data_version = l.max_ver
        JOIN _merge_pairs m
          ON m.brand_id = je.brand_id AND m.old_brain_id = je.brain_id
        """
    )
    affected.persist()  # pin the pre-flip snapshot (the flip below must not re-evaluate this plan)
    n_affected = affected.count()
    affected.createOrReplaceTempView("_je_affected")
    if n_affected == 0:
        affected.unpersist()
        write_job_watermark(spark, JOB_NAME, new_wm)
        print(f"[{JOB_NAME}] merge pairs matched no owned journey rows — 0 re-versions", flush=True)
        return fqtn, spark.table(fqtn).count()

    # 4. FLIP FIRST — the ONLY in-place mutation the ledger ever takes: is_current=false (+ audit stamp).
    spark.sql(
        f"""
        MERGE INTO {fqtn} t
        USING (SELECT brand_id, touchpoint_id, data_version FROM _je_affected) s
        ON t.brand_id = s.brand_id
       AND t.touchpoint_id = s.touchpoint_id
       AND t.data_version = s.data_version
        WHEN MATCHED AND t.is_current = true THEN
            UPDATE SET t.is_current = false, t.updated_at = current_timestamp()
        """
    )

    # 5. INSERT the re-versioned copies (data_version + 1, canonical owner, recomputed sequence).
    copies = spark.sql(_copies_sql(fqtn))
    merge_on_pk(spark, fqtn, copies, PK)
    affected.unpersist()

    # 6. Advance the checkpoint only after both steps committed.
    write_job_watermark(spark, JOB_NAME, new_wm)
    total = spark.table(fqtn).count()
    print(f"[{JOB_NAME}] re-versioned {n_affected} row(s) across {len(resolved)} merge pair(s)", flush=True)
    return fqtn, total


def main() -> None:
    run_job("gold-journey-events-reversion", build)


if __name__ == "__main__":
    main()
