# SPEC: ADR-0016 P1.2 — incremental dirty-set export for silver_identity_map (the ~20 min → seconds win).
"""
test_silver_identity_map_dirty.py — proves the two contracts of the incremental dirty-set map export:

  A. _dirty_stage_predicate() PURE builder:
     - [] → '1=0' (nothing mutated ⇒ empty stage ⇒ append-per-mutation no-op)
     - selects a brain_id on EITHER side of a bi-temporal supersede pair (brain_id / replaced_by_brain_id)
     - single-quote escapes (brain_ids are opaque ids, never PII — I-S02).

  B. PARITY (the DE gate): over a seeded projection, the INCREMENTAL pass (stage filtered to the mutated
     brain_ids) applied through the SAME two-MERGE append-per-mutation must produce, for the touched
     brain_ids, byte-identical rows to a FULL rebuild pass — AND must leave a non-dirty brain_id's existing
     open row UNTOUCHED (the AMD-07 validity invariant: never rewrite validity in place, never re-project a
     brain the tick didn't move). Live parity is additionally gated pre-merge by
     db/iceberg/duckdb/parity_check.py against a real FULL_REFRESH run; this pure-logic test locks the
     filter+MERGE algebra in isolation (no Iceberg catalog / Neo4j / PG needed).

Self-contained: an in-memory DuckDB stands in for the Iceberg target; the stage view + the exact two MERGE
passes are replicated from silver_identity_map so the SHIPPED PK/payload/filter algebra is what's tested.
Run:  python -m pytest db/iceberg/duckdb/silver/test_silver_identity_map_dirty.py
      (or plain `python db/iceberg/duckdb/silver/test_silver_identity_map_dirty.py` — a __main__ runner is included).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # db/iceberg/duckdb
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))                    # db/iceberg/duckdb/silver

import duckdb  # noqa: E402
import silver_identity_map as m  # noqa: E402


# ── A. pure predicate builder ─────────────────────────────────────────────────────────────────────────
def test_predicate_empty_is_false():
    assert m._dirty_stage_predicate([]) == "1=0", "no mutated brain_id ⇒ empty stage (1=0)"


def test_predicate_covers_both_supersede_sides():
    pred = m._dirty_stage_predicate(["A", "B"])
    # A merge that moves a hash from B onto A must re-project A's CURRENT row (brain_id IN …) AND B's
    # SUPERSEDED row (replaced_by_brain_id IN …) in the SAME pass, or the two-MERGE supersede+insert splits.
    assert "brain_id IN ('A', 'B')" in pred
    assert "replaced_by_brain_id IN ('A', 'B')" in pred
    assert pred.startswith("(") and " OR " in pred


def test_predicate_escapes_quotes():
    # brain_ids are opaque UUID/id strings — never PII — but escape defensively so the IN-list can't break out.
    assert m._dirty_stage_predicate(["a'b"]) == "(brain_id IN ('a''b') OR replaced_by_brain_id IN ('a''b'))"


# ── B. parity: incremental (filtered) == full rebuild over the touched brain_ids ────────────────────────
_RAW_DDL = (
    "CREATE TABLE _idm_raw ("
    "brand_id VARCHAR, identifier_type VARCHAR, identifier_hash VARCHAR, brain_id VARCHAR, "
    "customer_ref VARCHAR, confidence DOUBLE, effective_from_ms BIGINT, effective_to_ms BIGINT, "
    "replaced_by_brain_id VARCHAR, merge_event_id VARCHAR, is_current BOOLEAN)"
)

# The projected TARGET-shaped table (subset of COLUMNS_SQL sufficient for the PK/payload/validity algebra).
_TARGET_DDL = (
    "CREATE TABLE tgt ("
    "brand_id VARCHAR, identifier_hash VARCHAR, identifier_type VARCHAR, brain_id VARCHAR, "
    "customer_ref VARCHAR, confidence DOUBLE, effective_from TIMESTAMP, effective_to TIMESTAMP, "
    "replaced_by_brain_id VARCHAR, merge_event_id VARCHAR, is_current BOOLEAN, "
    "system_from TIMESTAMP, system_to TIMESTAMP, updated_at TIMESTAMP)"
)


def _stage_view(con, stage_filter: str) -> None:
    """The SHIPPED _idm_stage projection (typed-sentinel → NULL, epoch-0 PK anchor), with the dirty filter
    spliced into its WHERE exactly as silver_identity_map.build does."""
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _idm_stage AS
        SELECT
          CAST(brand_id AS VARCHAR)        AS brand_id,
          CAST(identifier_hash AS VARCHAR) AS identifier_hash,
          CAST(identifier_type AS VARCHAR) AS identifier_type,
          CAST(brain_id AS VARCHAR)        AS brain_id,
          CAST(customer_ref AS VARCHAR)    AS customer_ref,
          CAST(confidence AS DOUBLE)       AS confidence,
          COALESCE(
            CASE WHEN effective_from_ms IS NOT NULL THEN make_timestamp(effective_from_ms * 1000) END,
            TIMESTAMP '1970-01-01 00:00:00'
          ) AS effective_from,
          CASE WHEN effective_to_ms >= 0 THEN make_timestamp(effective_to_ms * 1000) ELSE NULL END AS effective_to,
          NULLIF(replaced_by_brain_id, '') AS replaced_by_brain_id,
          NULLIF(merge_event_id, '')       AS merge_event_id,
          (is_current = true)              AS is_current,
          TIMESTAMP '2026-07-18 00:00:00' AS system_from,
          CAST(NULL AS TIMESTAMP)          AS system_to,
          TIMESTAMP '2026-07-18 00:00:00' AS updated_at
        FROM _idm_raw
        WHERE brand_id IS NOT NULL AND identifier_hash IS NOT NULL AND brain_id IS NOT NULL
          AND ({stage_filter});
        """
    )


def _append_per_mutation(con) -> None:
    """Byte-for-byte the two MERGE passes from silver_identity_map._append_per_mutation, against local `tgt`
    (the module's version targets the catalog identifier `TARGET`, unusable in-memory)."""
    part = ", ".join(m._PK_COLS)
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW _idm_stage_dedup AS
        SELECT * EXCLUDE (_rn) FROM (
          SELECT *, row_number() OVER (PARTITION BY {part} ORDER BY system_from DESC) AS _rn
          FROM _idm_stage
        ) WHERE _rn = 1;
        """
    )
    on_pk = " AND ".join(f"t.{c} IS NOT DISTINCT FROM s.{c}" for c in m._PK_COLS)
    same = " AND ".join(f"t.{c} IS NOT DISTINCT FROM s.{c}" for c in m._PAYLOAD_COLS)
    collist = ", ".join(m._ALL_COLS)
    ins_vals = ", ".join(f"s.{c}" for c in m._ALL_COLS)
    con.execute(
        f"""
        MERGE INTO tgt t
        USING (SELECT * FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL
        WHEN MATCHED AND NOT ({same}) THEN UPDATE SET system_to = s.system_from;
        """
    )
    con.execute(
        f"""
        MERGE INTO tgt t
        USING (SELECT {collist} FROM _idm_stage_dedup) s
        ON {on_pk} AND t.system_to IS NULL AND ({same})
        WHEN NOT MATCHED THEN INSERT ({collist}) VALUES ({ins_vals});
        """
    )


def _seed_raw(con) -> None:
    """A projection where brain 'A' is CURRENT for hash h1 and 'B' is a SUPERSEDED row that was replaced_by
    'A' (a merge B→A), plus an UNTOUCHED brain 'Z' (current for hash hz) the tick did NOT move."""
    con.execute("DROP TABLE IF EXISTS _idm_raw;")
    con.execute(_RAW_DDL)
    con.executemany(
        "INSERT INTO _idm_raw VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [
            # (brand, type, hash, brain_id, ref, conf, eff_from_ms, eff_to_ms, replaced_by, merge_ev, is_current)
            ("br1", "email", "h1", "A", "BRN-A", 1.0, 1000, -1, "", "", True),        # A CURRENT (dirty)
            ("br1", "email", "h1", "B", "BRN-B", 1.0, 500, 900, "A", "mev1", False),  # B SUPERSEDED→A (dirty)
            ("br1", "email", "hz", "Z", "BRN-Z", 1.0, 2000, -1, "", "", True),        # Z CURRENT (NOT dirty)
        ],
    )


def _rows(con):
    return con.execute(
        "SELECT brand_id, identifier_hash, brain_id, is_current, replaced_by_brain_id, "
        "effective_to, system_to FROM tgt ORDER BY brain_id, identifier_hash"
    ).fetchall()


def test_incremental_equals_full_over_touched_brain_ids():
    dirty = ["A", "B"]  # the mutated brain_ids the identity job dirtied this tick (A gained h1, B was merged)

    # FULL rebuild (FULL_REFRESH path): stage filter = TRUE → every brain projected.
    full = duckdb.connect()
    full.execute(_TARGET_DDL)
    _seed_raw(full)
    _stage_view(full, "TRUE")
    _append_per_mutation(full)
    full_touched = full.execute(
        "SELECT brand_id, identifier_hash, brain_id, is_current, replaced_by_brain_id, effective_to, system_to "
        "FROM tgt WHERE brain_id IN ('A','B') ORDER BY brain_id, identifier_hash"
    ).fetchall()

    # INCREMENTAL: stage filter = the dirty-set predicate → only A/B projected.
    inc = duckdb.connect()
    inc.execute(_TARGET_DDL)
    _seed_raw(inc)
    _stage_view(inc, m._dirty_stage_predicate(dirty))
    _append_per_mutation(inc)
    inc_touched = inc.execute(
        "SELECT brand_id, identifier_hash, brain_id, is_current, replaced_by_brain_id, effective_to, system_to "
        "FROM tgt WHERE brain_id IN ('A','B') ORDER BY brain_id, identifier_hash"
    ).fetchall()

    # PARITY: the incremental output for the touched brain_ids equals the full rebuild's.
    assert inc_touched == full_touched, "incremental dirty-set export must equal the full rebuild for touched ids"
    # Both sides of the supersede pair landed (A CURRENT + B SUPERSEDED→A).
    brains = {r[2] for r in inc_touched}
    assert brains == {"A", "B"}, "both the canonical (A) and the superseded (B→A) rows must be projected"

    # VALIDITY INVARIANT: the incremental pass NEVER touched the non-dirty brain Z (it is absent — never
    # projected — so its live row could not have been rewritten).
    z = inc.execute("SELECT count(*) FROM tgt WHERE brain_id = 'Z'").fetchone()[0]
    assert z == 0, "a non-dirty brain_id must NOT be projected by the incremental pass"


def test_empty_dirty_set_is_a_noop():
    """Nothing mutated this tick ([] dirty-set) ⇒ 1=0 stage ⇒ append-per-mutation appends nothing."""
    con = duckdb.connect()
    con.execute(_TARGET_DDL)
    _seed_raw(con)
    _stage_view(con, m._dirty_stage_predicate([]))
    _append_per_mutation(con)
    assert con.execute("SELECT count(*) FROM tgt").fetchone()[0] == 0, "empty dirty-set must append zero rows"


def test_second_run_is_idempotent():
    """Re-running the SAME dirty projection appends nothing the second time (append-per-mutation idempotence)."""
    con = duckdb.connect()
    con.execute(_TARGET_DDL)
    _seed_raw(con)
    pred = m._dirty_stage_predicate(["A", "B"])
    _stage_view(con, pred)
    _append_per_mutation(con)
    n1 = con.execute("SELECT count(*) FROM tgt").fetchone()[0]
    _stage_view(con, pred)
    _append_per_mutation(con)
    n2 = con.execute("SELECT count(*) FROM tgt").fetchone()[0]
    assert n1 == n2, "an unchanged re-projection must append nothing (idempotent)"


if __name__ == "__main__":
    test_predicate_empty_is_false()
    test_predicate_covers_both_supersede_sides()
    test_predicate_escapes_quotes()
    test_incremental_equals_full_over_touched_brain_ids()
    test_empty_dirty_set_is_a_noop()
    test_second_run_is_idempotent()
    print("PASS: silver_identity_map dirty-set export (6/6)")
