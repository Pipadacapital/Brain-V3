"""
gold_journey_events_reversion.py (DuckDB) — faithful port of
db/iceberg/spark/gold/gold_journey_events_reversion.py.

MERGE RE-VERSIONING for the event-sourced journey ledger brain_gold.gold_journey_events (spec gap G4 companion
of gold_journey_events.py — the SAME table, a separate job so the v4-refresh-loop sequences it in the BI
tier AFTER construction). It reads the SAME target the construction job writes (honoring
MIGRATION_TABLE_SUFFIX) and, for a parallel-run parity harness, operates on journey_events<suffix>.

EVENT-SOURCED SEMANTICS (the contract this job enforces, byte-for-byte the Spark job):
  journey_events is an append-mostly VERSIONED ledger. An identity MERGE (silver_identity_map row closed
  with replaced_by_brain_id) never rewrites history: the superseded owner's rows survive verbatim — the ONLY
  in-place mutation is flipping is_current=false (+ its updated_at audit stamp). Ownership transfer is
  expressed as NEW rows: copies of the superseded rows re-keyed to the canonical brain_id with
  data_version = old_version + 1 and is_current=true, sequence_number RECOMPUTED over the union of the new
  owner's current timeline. Every version of every touchpoint remains queryable forever.

WHAT ONE RUN DOES (both passes; each with its OWN watermark + graceful no-op so one absent/empty source
never blocks the other):
  MERGE pass (silver_identity_map):
    1. CHECKPOINT — read the silver_job_watermark row for JOB_NAME keyed on silver_identity_map.updated_at
       (FULL_REFRESH=1 re-scans all merge history — idempotent).
    2. DETECT merge events since the checkpoint: is_current=false AND replaced_by_brain_id IS NOT NULL AND
       brain_id <> replaced_by_brain_id AND updated_at > checkpoint → distinct (brand, old, new). Chains
       (A→B, B→C) resolved to the TERMINAL canonical id driver-side via the vendored pure helper.
    3. AFFECTED — journey_events rows whose LATEST data_version is still owned by an old_brain_id (keying on
       latest-version-ownership, NOT is_current, makes the run CRASH-SAFE: a crash between flip and insert
       leaves the latest version owned by the old id → re-detected on re-run).
    4. FLIP FIRST — set is_current=false (+ audit stamp) on the affected rows (flip before insert: a crash
       between leaves the latest version with the old owner → re-detected; the reverse would strand currents).
    5. INSERT COPIES — new rows: brain_id=new, data_version=old+1, is_current=true, sequence_number
       recomputed over the UNION of the new owner's current timeline (row_number over occurred_at with the
       deterministic touchpoint_id tiebreak — the ledger carries no touch_seq). All other columns (incl.
       revenue_minor + currency_code + the DG-2 AS-OF pair) carry VERBATIM — a merge moves ownership, never
       money, never history, never provenance (identity_basis stays 'deterministic').
    6. ADVANCE the watermark (only after both steps committed).
  UNMERGE pass (silver_identity_unmerge — SPEC A.2.4 / WA-19): the inverse. Moves the journey rows a merge
    transferred onto a survivor BACK to the absorbed id as a NEW version. Reuses the same flip+copy machinery
    with pairs (old=survivor→FROM, new=absorbed→TO) and AFFECTED = latest-version rows owned by the survivor
    whose data_version-1 was owned by the absorbed id. Absent/empty source → no-op. Its OWN watermark.

MONEY: revenue_minor (bigint MINOR units) + currency_code carried VERBATIM onto the copy — a merge moves
  ownership, never money. identity_confidence carried as recorded at construction.

SCOPE BOUNDARIES vs the Spark job (all parity-preserving on this catalog):
  - journey_version_log (SPEC B.2 / WB-B2, AMD-11): the flag-gated brain-grain audit side-table. It is
    written ONLY for brands with journey.engine ON; every brand is default-OFF (fail-closed), so this
    side-effect is INERT and the golden ledger is byte-identical. The Spark job also wraps it so it NEVER
    raises into the re-version path. We SKIP it here (no flag/Redis seam in the DuckDB tree) — noted; it
    changes NO journey_events row.
  - identity-view-guard (SPEC A.2.2, identity_raw accessor): a Spark-only allowlist wrapper around the
    silver_identity_map read. We read the table directly (the same rows) — the guard is a lint/compile-time
    seam with no runtime effect on the produced data.

QUARANTINE: none — this Gold re-version has no Stage-1/quarantine side-write. Nothing to skip.

Run count on this catalog: silver_identity_map has 11 distinct merge pairs, but the live journey_events is
  entirely v1/is_current with NO row owned by a merged-away old brain_id (the merges post-date construction
  from anonymous_/unmatched touchpoints), so AFFECTED is 0 → 0 re-versions (a clean, idempotent no-op that
  advances the watermark). See the report.
"""
from __future__ import annotations

import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_DUCKDB_ROOT = os.path.dirname(_HERE)
sys.path.insert(0, _DUCKDB_ROOT)
sys.path.insert(0, _HERE)

from _base import read_watermark, write_watermark  # noqa: E402
from _catalog import CATALOG, GOLD_NAMESPACE, SILVER_NAMESPACE, connect  # noqa: E402
from _journey_reversion_pure import derive_unmerge_pairs, resolve_terminal  # noqa: E402 — vendored pure

JOB_NAME = "gold_journey_events_reversion"          # silver_job_watermark key (merge pass)
UNMERGE_JOB_NAME = "gold_journey_events_reversion_unmerge"  # SECOND, independent watermark (unmerge pass)
TABLE_NAME = "gold_journey_events"                  # the SAME ledger construction writes (DR-001 rename)
_SUFFIX = os.environ.get("MIGRATION_TABLE_SUFFIX", "")
TARGET = f"{CATALOG}.{GOLD_NAMESPACE}.{TABLE_NAME}{_SUFFIX}"

SILVER_IDENTITY_MAP = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_map"
SILVER_IDENTITY_UNMERGE = f"{CATALOG}.{SILVER_NAMESPACE}.silver_identity_unmerge"

PK = ["brand_id", "touchpoint_id", "data_version"]

# journey_events full column list (must match construction) — used to project the re-versioned copies.
_ALL_COLS = [
    "brand_id", "brain_id", "touchpoint_id", "source_event_ref", "data_version", "is_current",
    "sequence_number", "occurred_at", "session_key", "event_category", "event_type", "channel",
    "campaign", "revenue_minor", "currency_code", "product_handles", "attribution_signals",
    "identity_confidence", "brain_id_asof", "identity_confidence_asof", "is_composite",
    "composite_order_key", "ingested_at", "updated_at", "matched_via", "identity_basis",
]

_FULL_REFRESH = os.environ.get("FULL_REFRESH", "").lower() in ("1", "true", "yes")


def _table_exists(con, fq: str) -> bool:
    try:
        con.execute(f"SELECT 1 FROM {fq} LIMIT 0")
        return True
    except Exception:  # noqa: BLE001
        return False


def _set_merge_pairs(con, resolved) -> None:
    """Stage the resolved (brand, old, new) transfer pairs as a temp table `_merge_pairs`."""
    con.execute(
        "CREATE OR REPLACE TEMP TABLE _merge_pairs "
        "(brand_id VARCHAR, old_brain_id VARCHAR, new_brain_id VARCHAR)"
    )
    if resolved:
        con.executemany(
            "INSERT INTO _merge_pairs VALUES (?, ?, ?)",
            [(b, o, n) for (b, o, n) in resolved],
        )


def _copies_insert_sql() -> str:
    """The re-versioned copies (SPEC: the Spark _copies_sql), verbatim: affected rows re-keyed to the
    canonical brain_id, data_version + 1, is_current=true, sequence_number recomputed over the UNION of the
    new owner's current timeline. All other columns carry VERBATIM. Reads the pre-flip `_je_affected`
    snapshot + the target for the owner's existing currents."""
    return f"""
        WITH own AS (  -- the new owner's pre-existing current timeline (kept in place, never edited)
            SELECT je.brand_id, je.brain_id, je.touchpoint_id, je.occurred_at
            FROM {TARGET} je
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
                   CAST(row_number() OVER (
                       PARTITION BY brand_id, brain_id
                       ORDER BY occurred_at ASC, touchpoint_id ASC
                   ) AS BIGINT) AS sequence_number
            FROM timeline
        )
        SELECT
            a.brand_id,
            a.new_brain_id AS brain_id,
            a.touchpoint_id,
            a.source_event_ref,
            CAST(a.data_version + 1 AS INTEGER) AS data_version,   -- the version bump
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
            now() AT TIME ZONE 'UTC' AS updated_at,
            a.matched_via,                 -- identity-link provenance carries VERBATIM
            a.identity_basis               -- basis stays 'deterministic'
        FROM _je_affected a
        JOIN seq s
          ON s.brand_id = a.brand_id AND s.brain_id = a.new_brain_id
         AND s.touchpoint_id = a.touchpoint_id AND s.is_copy = true
    """


def _flip_and_copy(con) -> None:
    """Steps 4-5 shared by BOTH passes: FLIP the affected latest-version rows is_current=false, then INSERT
    the re-versioned copies (data_version + 1, new owner, recomputed sequence). Requires `_je_affected`
    (with a `new_brain_id` column) + `_merge_pairs` temp tables to be set. Flip-before-insert is crash-safe.
    (SPEC B.2 journey_version_log is flag-gated + inert on this default-OFF catalog → skipped; see header.)"""
    # 4. FLIP FIRST — the ONLY in-place mutation the ledger ever takes: is_current=false (+ audit stamp).
    con.execute(
        f"""
        MERGE INTO {TARGET} t
        USING (SELECT brand_id, touchpoint_id, data_version FROM _je_affected) s
        ON t.brand_id = s.brand_id
       AND t.touchpoint_id = s.touchpoint_id
       AND t.data_version = s.data_version
        WHEN MATCHED AND t.is_current = true THEN
            UPDATE SET is_current = false, updated_at = now() AT TIME ZONE 'UTC'
        """
    )
    # 5. INSERT the re-versioned copies (data_version + 1, new owner, recomputed sequence).
    collist = ", ".join(_ALL_COLS)
    con.execute(f"INSERT INTO {TARGET} ({collist}) {_copies_insert_sql()}")


def _detect_and_apply(con, source_kind: str, job_name: str) -> int:
    """Shared merge/unmerge pass. source_kind ∈ {'merge','unmerge'}. Returns rows re-versioned."""
    if source_kind == "merge":
        wm = None if _FULL_REFRESH else read_watermark(con, job_name)
        new_wm = con.execute(f"SELECT max(updated_at) FROM {SILVER_IDENTITY_MAP}").fetchone()[0]
        # DETECT merge events since the checkpoint.
        where = [
            "is_current = false",
            "replaced_by_brain_id IS NOT NULL",
            "brain_id <> replaced_by_brain_id",
            "brand_id IS NOT NULL",
        ]
        if wm is not None:
            where.append(f"updated_at > TIMESTAMP '{wm}'")
        rows = con.execute(
            f"SELECT DISTINCT brand_id, brain_id, replaced_by_brain_id FROM {SILVER_IDENTITY_MAP} "
            f"WHERE {' AND '.join(where)}"
        ).fetchall()
        pairs = [(r[0], r[1], r[2]) for r in rows]
        if not pairs:
            write_watermark(con, job_name, new_wm)
            print(f"[{job_name}] no merge events since checkpoint — 0 re-versions", flush=True)
            return 0
        resolved = resolve_terminal(pairs)
        print(f"[{job_name}] {len(resolved)} merge pair(s) since checkpoint (chains resolved)", flush=True)
    else:  # unmerge
        if not _table_exists(con, SILVER_IDENTITY_UNMERGE):
            print(f"[{job_name}] {SILVER_IDENTITY_UNMERGE} absent — no unmerge events; no-op.", flush=True)
            return 0
        wm = None if _FULL_REFRESH else read_watermark(con, job_name)
        new_wm = con.execute(f"SELECT max(unmerged_at) FROM {SILVER_IDENTITY_UNMERGE}").fetchone()[0]
        if new_wm is None:
            print(f"[{job_name}] {SILVER_IDENTITY_UNMERGE} empty — 0 un-reversions", flush=True)
            return 0
        where = [
            "survivor_brain_id IS NOT NULL",
            "survivor_brain_id <> absorbed_brain_id",
            "brand_id IS NOT NULL",
        ]
        if wm is not None:
            where.append(f"unmerged_at > TIMESTAMP '{wm}'")
        rows = con.execute(
            f"SELECT DISTINCT brand_id, survivor_brain_id, absorbed_brain_id "
            f"FROM {SILVER_IDENTITY_UNMERGE} WHERE {' AND '.join(where)}"
        ).fetchall()
        # (brand, survivor=FROM, absorbed=TO) — reuse the merge machinery via the pure helper.
        resolved = derive_unmerge_pairs(
            [{"brand_id": r[0], "survivor_brain_id": r[1], "absorbed_brain_id": r[2]} for r in rows]
        )
        if not resolved:
            write_watermark(con, job_name, new_wm)
            print(f"[{job_name}] no unmerge events since checkpoint — 0 un-reversions", flush=True)
            return 0
        print(f"[{job_name}] {len(resolved)} unmerge pair(s) since checkpoint", flush=True)

    _set_merge_pairs(con, resolved)

    # AFFECTED = ledger rows whose LATEST version is still owned by an old brain_id (latest-version ownership,
    # NOT is_current, keys the detection so a crash between flip and insert is re-run-safe). For unmerge, the
    # extra prev-version join restricts to exactly the rows the merge transferred.
    if source_kind == "merge":
        affected_sql = f"""
            WITH latest AS (
                SELECT brand_id, touchpoint_id, max(data_version) AS max_ver
                FROM {TARGET}
                GROUP BY brand_id, touchpoint_id
            )
            SELECT je.*, m.new_brain_id
            FROM {TARGET} je
            JOIN latest l
              ON l.brand_id = je.brand_id AND l.touchpoint_id = je.touchpoint_id
             AND je.data_version = l.max_ver
            JOIN _merge_pairs m
              ON m.brand_id = je.brand_id AND m.old_brain_id = je.brain_id
        """
    else:
        affected_sql = f"""
            WITH latest AS (
                SELECT brand_id, touchpoint_id, max(data_version) AS max_ver
                FROM {TARGET}
                GROUP BY brand_id, touchpoint_id
            )
            SELECT je.*, m.new_brain_id
            FROM {TARGET} je
            JOIN latest l
              ON l.brand_id = je.brand_id AND l.touchpoint_id = je.touchpoint_id
             AND je.data_version = l.max_ver
            JOIN _merge_pairs m
              ON m.brand_id = je.brand_id AND m.old_brain_id = je.brain_id
            JOIN {TARGET} prev
              ON prev.brand_id = je.brand_id AND prev.touchpoint_id = je.touchpoint_id
             AND prev.data_version = je.data_version - 1
             AND prev.brain_id = m.new_brain_id
        """
    con.execute(f"CREATE OR REPLACE TEMP TABLE _je_affected AS {affected_sql}")
    n_affected = con.execute("SELECT count(*) FROM _je_affected").fetchone()[0]
    if n_affected == 0:
        write_watermark(con, job_name, new_wm)
        print(f"[{job_name}] pairs matched no owned journey rows — 0 re-versions", flush=True)
        return 0

    _flip_and_copy(con)
    write_watermark(con, job_name, new_wm)
    print(f"[{job_name}] re-versioned {n_affected} row(s) across {len(resolved)} pair(s)", flush=True)
    return n_affected


def build(con) -> int:
    # The ledger must exist (construction runs first in the loop) — degrade gracefully if not.
    if not _table_exists(con, TARGET):
        print(f"[{JOB_NAME}] target {TARGET} absent — run gold_journey_events first; no-op.", flush=True)
        return 0

    total = 0
    # MERGE pass (silver_identity_map) then UNMERGE un-reversion pass (silver_identity_unmerge). Each has its
    # OWN watermark + graceful no-op, so one being absent/empty never blocks the other.
    if _table_exists(con, SILVER_IDENTITY_MAP):
        total += _detect_and_apply(con, "merge", JOB_NAME)
    else:
        print(f"[{JOB_NAME}] {SILVER_IDENTITY_MAP} absent — merge pass skipped.", flush=True)

    total += _detect_and_apply(con, "unmerge", UNMERGE_JOB_NAME)
    return total


def main() -> None:
    t0 = time.time()
    con = connect()
    try:
        reversioned = build(con)
        dt = time.time() - t0
        print(f'{{"job":"gold-journey-events-reversion","target":"{TABLE_NAME}",'
              f'"reversioned":{reversioned},"seconds":{dt:.2f},"engine":"duckdb"}}', flush=True)
    finally:
        con.close()


if __name__ == "__main__":
    main()
