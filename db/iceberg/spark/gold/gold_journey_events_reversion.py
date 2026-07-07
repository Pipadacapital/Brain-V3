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
from pyspark.sql.functions import col, current_timestamp, lit  # noqa: E402

from iceberg_base import (  # noqa: E402
    CATALOG,
    GOLD_NAMESPACE,
    read_job_watermark,
    write_job_watermark,
)
from _gold_base import ensure_gold_table, merge_on_pk, run_job, silver, silver_exists  # noqa: E402
# SPEC: A.2.2 — the ONLY sanctioned Spark reads of silver_identity_map (identity-view-guard allowlist).
from _identity_views import identity_map_exists, identity_raw  # noqa: E402
# SPEC: A.2.4 (WA-19) — pyspark-free driver helpers (unit-tested without a Spark runtime).
from _journey_reversion_pure import derive_unmerge_pairs, resolve_terminal as _resolve_terminal  # noqa: E402
# SPEC: B.2 (WB-B2, AMD-11) — journey_version_log version-bump helper (pyspark-free, unit-tested).
from _journey_version_log_pure import version_log_rows  # noqa: E402
# SPEC: 0.5 / B.2 — per-brand journey.engine gate (fail-closed DEFAULT OFF): journey_version_log rows are
# written ONLY for flag-ON brands, so with every brand default-OFF this side-effect is inert (byte-identical
# golden). Mirrors the stitch.v2 Spark gate.
from _platform_flags import is_flag_enabled  # noqa: E402

JOB_NAME = "gold_journey_events_reversion"   # silver_job_watermark key (distinct from the table's)
# SPEC: A.2.4 (WA-19) — a SECOND, independent watermark for the UNMERGE un-reversion pass, keyed on
# silver_identity_unmerge.unmerged_at (the merge pass keeps its silver_identity_map.updated_at key).
UNMERGE_JOB_NAME = "gold_journey_events_reversion_unmerge"
UNMERGE_SOURCE_TABLE = "silver_identity_unmerge"
TABLE_NAME = "journey_events"                # the SAME ledger construction writes
PK = ["brand_id", "touchpoint_id", "data_version"]
JOURNEY_ENGINE_FLAG = "journey.engine"

# SPEC: B.2 (WB-B2, AMD-11) — journey_version_log: the brain-grain audit of every re-version transition.
# ADDITIVE Iceberg Gold table; brand_id FIRST (I-S01). One row per (brand_id, brain_id, to_version): a
# re-version pass bumps the journey-level version N -> N+1 (AMD-11 R1 — the version is derived as
# max(data_version) over the brain's current rows). Read by B.3 to serve the X-Journey-Version header.
LOG_TABLE_NAME = "journey_version_log"
LOG_PK = ["brand_id", "brain_id", "to_version"]   # idempotent under FULL_REFRESH re-scan
LOG_COLUMNS_SQL = (
    "brand_id string, brain_id string, "
    "from_version int, to_version int, "
    "cause string, at timestamp"
)


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
            a.brain_id_asof,               -- DG-2 AS-OF pair carries VERBATIM: point-in-time truth
            a.identity_confidence_asof,    -- at occurred_at is immutable — a merge never rewrites it
            a.is_composite,
            a.composite_order_key,
            a.ingested_at,
            current_timestamp() AS updated_at,
            a.matched_via,          -- SPEC: B.1 — identity-link provenance carries VERBATIM (a merge
            a.identity_basis        -- moves ownership, never provenance; basis stays 'deterministic')
        FROM _je_affected a
        JOIN seq s
          ON s.brand_id = a.brand_id AND s.brain_id = a.new_brain_id
         AND s.touchpoint_id = a.touchpoint_id AND s.is_copy = true
    """


def _write_version_log(spark: SparkSession, cause: str) -> int:
    """SPEC: B.2 (WB-B2, AMD-11) — write the journey_version_log rows for this re-version pass. Reads the
    pre-flip `_je_affected` snapshot (persisted BEFORE the flip, so data_version is still the OLD version),
    aggregates to ONE row per re-versioned brain (from_version = max(data_version) over the transferred
    rows for that canonical owner), and records the N -> N+1 bump with the pass `cause` ('merge'|'unmerge').

    FLAG GATE (§0.5): only brands with journey.engine ON get a log row — driver-side is_flag_enabled filter
    (merge/unmerge batches since a checkpoint are tiny, so a per-brand check is cheap). With every brand
    default-OFF NOTHING is written → this side-effect is inert and golden journeys are byte-identical.

    Idempotent: MERGE on LOG_PK (brand_id, brain_id, to_version) — a FULL_REFRESH re-scan re-derives the
    same rows. Returns the number of log rows written. NEVER raises into the re-version path (audit must not
    break the ledger transfer): on any error it logs and returns 0."""
    try:
        agg = spark.sql(
            """
            SELECT brand_id, new_brain_id AS brain_id, cast(max(data_version) AS int) AS from_version
            FROM _je_affected
            GROUP BY brand_id, new_brain_id
            """
        ).collect()
        # Flag-gate driver-side (fail-closed): keep only journey.engine-ON brands.
        flagged = [
            {"brand_id": r["brand_id"], "brain_id": r["brain_id"], "from_version": r["from_version"]}
            for r in agg
            if r["brand_id"] is not None
            and r["brain_id"] is not None
            and is_flag_enabled(r["brand_id"], JOURNEY_ENGINE_FLAG)
        ]
        rows = version_log_rows(flagged, cause=cause, at=None)  # `at` set in Spark (current_timestamp)
        if not rows:
            return 0
        log_fqtn = ensure_gold_table(
            spark, LOG_TABLE_NAME, LOG_COLUMNS_SQL, partitioned_by="bucket(64, brand_id)"
        )
        staged = (
            spark.createDataFrame(
                [(r["brand_id"], r["brain_id"], r["from_version"], r["to_version"], r["cause"]) for r in rows],
                "brand_id string, brain_id string, from_version int, to_version int, cause string",
            )
            .withColumn("at", current_timestamp())
        )
        merge_on_pk(spark, log_fqtn, staged, LOG_PK)
        print(f"[{JOB_NAME}] journey_version_log: {len(rows)} row(s) written (cause={cause})", flush=True)
        return len(rows)
    except Exception as exc:  # noqa: BLE001 — audit log must NEVER break the re-version transfer
        print(f"[{JOB_NAME}] journey_version_log write skipped (non-fatal): {exc}", flush=True)
        return 0


def _flip_and_copy(spark: SparkSession, fqtn: str, cause: str) -> None:
    """Steps 4-5 shared by BOTH passes: FLIP the affected latest-version rows is_current=false, then
    INSERT the re-versioned copies (data_version + 1, new owner, recomputed sequence). Requires the
    `_je_affected` (persisted, with a `new_brain_id` column) + `_merge_pairs` temp views to be set.
    Flip-before-insert is crash-safe (a crash between leaves the latest version owned by the OLD id →
    re-detected on the next run). `cause` ('merge'|'unmerge') is recorded on journey_version_log."""
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
    # 5. INSERT the re-versioned copies (data_version + 1, new owner, recomputed sequence).
    copies = spark.sql(_copies_sql(fqtn))
    merge_on_pk(spark, fqtn, copies, PK)
    # 5b. SPEC: B.2 (WB-B2, AMD-11) — record the journey-level N->N+1 transition (flag-gated audit).
    _write_version_log(spark, cause)


def _apply_merge(spark: SparkSession, fqtn: str) -> int:
    """MERGE re-versioning: transfer an absorbed id's LATEST-version journey rows onto the canonical
    survivor (data_version + 1). Detection from silver_identity_map (is_current=false + replaced_by).
    Returns the number of rows re-versioned (0 = no-op). Advances its OWN watermark (JOB_NAME)."""
    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    wm = None if full_refresh else read_job_watermark(spark, JOB_NAME)

    # Merge-event detection needs the RAW interval rows (is_current=false + replaced_by set) — read via the
    # sanctioned identity_raw accessor (A.2.2/AMD-07), not a direct spark.table on silver_identity_map.
    idm = identity_raw(spark)
    new_wm = idm.selectExpr("max(updated_at) AS m").collect()[0]["m"]

    # DETECT merge events since the checkpoint.
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
        return 0

    resolved = _resolve_terminal(pairs)
    spark.createDataFrame(
        resolved, "brand_id string, old_brain_id string, new_brain_id string"
    ).createOrReplaceTempView("_merge_pairs")
    print(f"[{JOB_NAME}] {len(resolved)} merge pair(s) since checkpoint (chains resolved)", flush=True)

    # AFFECTED = ledger rows whose LATEST version is still owned by an old brain_id. Latest-version
    # ownership (not is_current) keys the detection so a crash between flip and insert is re-run-safe.
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
        return 0

    _flip_and_copy(spark, fqtn, cause="merge")
    affected.unpersist()
    write_job_watermark(spark, JOB_NAME, new_wm)
    print(f"[{JOB_NAME}] re-versioned {n_affected} row(s) across {len(resolved)} merge pair(s)", flush=True)
    return n_affected


def _apply_unmerge(spark: SparkSession, fqtn: str) -> int:
    """SPEC: A.2.4 (WA-19) — UN-REVERSION: the inverse of a merge. For every committed unmerge
    (silver_identity_unmerge) move the journey rows the merge transferred from the absorbed id onto the
    survivor BACK to the absorbed id, as a NEW version (data_version + 1) — the split journeys reappear,
    history preserved (the merge-era versions survive is_current=false). Reuses the merge machinery: the
    unmerge pairs become `_merge_pairs` with old=survivor (from), new=absorbed (to), and AFFECTED is the
    latest-version rows currently owned by the survivor whose IMMEDIATELY-PRIOR version was owned by the
    absorbed id (i.e. exactly the rows the merge moved). Latest-version-ownership keying (no is_current
    filter) keeps it crash-safe + idempotent. Advances its OWN watermark (UNMERGE_JOB_NAME)."""
    if not silver_exists(spark, UNMERGE_SOURCE_TABLE):
        print(f"[{UNMERGE_JOB_NAME}] {UNMERGE_SOURCE_TABLE} absent — no unmerge events to fold; no-op.", flush=True)
        return 0

    full_refresh = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")
    wm = None if full_refresh else read_job_watermark(spark, UNMERGE_JOB_NAME)

    um = spark.table(silver(UNMERGE_SOURCE_TABLE))
    new_wm = um.selectExpr("max(unmerged_at) AS m").collect()[0]["m"]
    if new_wm is None:
        print(f"[{UNMERGE_JOB_NAME}] {UNMERGE_SOURCE_TABLE} empty — 0 un-reversions", flush=True)
        return 0

    ev = um.where(
        col("survivor_brain_id").isNotNull()
        & (col("survivor_brain_id") != col("absorbed_brain_id"))
    )
    if wm is not None:
        ev = ev.where(col("unmerged_at") > lit(wm))
    # (brand, survivor=from-owner, absorbed=to-owner) — reuse the _merge_pairs (old→new) shape via the
    # pure derive_unmerge_pairs helper (unit-tested without Spark).
    pairs = derive_unmerge_pairs(
        [r.asDict() for r in ev.select("brand_id", "survivor_brain_id", "absorbed_brain_id").distinct().collect()]
    )
    if not pairs:
        write_job_watermark(spark, UNMERGE_JOB_NAME, new_wm)
        print(f"[{UNMERGE_JOB_NAME}] no unmerge events since checkpoint — 0 un-reversions", flush=True)
        return 0

    spark.createDataFrame(
        pairs, "brand_id string, old_brain_id string, new_brain_id string"
    ).createOrReplaceTempView("_merge_pairs")
    print(f"[{UNMERGE_JOB_NAME}] {len(pairs)} unmerge pair(s) since checkpoint", flush=True)

    # AFFECTED = latest-version rows currently owned by the SURVIVOR (old_brain_id) whose data_version-1
    # version was owned by the ABSORBED id (new_brain_id) — precisely the rows the merge transferred.
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
        JOIN {fqtn} prev
          ON prev.brand_id = je.brand_id AND prev.touchpoint_id = je.touchpoint_id
         AND prev.data_version = je.data_version - 1
         AND prev.brain_id = m.new_brain_id
        """
    )
    affected.persist()
    n_affected = affected.count()
    affected.createOrReplaceTempView("_je_affected")
    if n_affected == 0:
        affected.unpersist()
        write_job_watermark(spark, UNMERGE_JOB_NAME, new_wm)
        print(f"[{UNMERGE_JOB_NAME}] unmerge pairs matched no transferred journey rows — 0 un-reversions", flush=True)
        return 0

    _flip_and_copy(spark, fqtn, cause="unmerge")
    affected.unpersist()
    write_job_watermark(spark, UNMERGE_JOB_NAME, new_wm)
    print(f"[{UNMERGE_JOB_NAME}] un-reversioned {n_affected} row(s) across {len(pairs)} unmerge pair(s)", flush=True)
    return n_affected


def build(spark: SparkSession):
    fqtn = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE_NAME}"

    # The ledger must exist (construction runs first in the loop) — degrade gracefully if not.
    try:
        spark.table(fqtn).schema
    except Exception:  # noqa: BLE001 — absent target → nothing to re-version yet
        print(f"[{JOB_NAME}] target {fqtn} absent — run gold_journey_events first; no-op.", flush=True)
        return fqtn, 0

    # MERGE pass (silver_identity_map) then UNMERGE un-reversion pass (silver_identity_unmerge). Each has
    # its OWN watermark + graceful no-op, so one being absent/empty never blocks the other.
    if identity_map_exists(spark):
        _apply_merge(spark, fqtn)
    else:
        print(f"[{JOB_NAME}] silver_identity_map absent — merge pass skipped.", flush=True)

    _apply_unmerge(spark, fqtn)

    return fqtn, spark.table(fqtn).count()


def main() -> None:
    run_job("gold-journey-events-reversion", build)


if __name__ == "__main__":
    main()
