"""
_snap_as_of.py — the single canonical AS-OF (point-in-time) read seam for the snap_* SCD snapshots.

A snap_* table (snap_order_state / snap_identity_link / snap_attribution_credit) stamps one day-slice
per run, keyed on a PK that INCLUDES snapshot_date. To read the state of an entity AS-OF a date D — the
HISTORICAL version that was current on D, NOT today's row — you filter to snapshot_date <= D and take
the LATEST snapshot per entity. This module defines that query in ONE place so every reader (StarRocks
MV consumer, Trino exploration, the proof test) uses identical point-in-time semantics, and provides a
pure-Python reference resolver the unit test verifies against.

WHY a seam: "select the latest row per key where snapshot_date <= D" is easy to get subtly wrong
(e.g. MAX(snapshot_date) without re-joining the rest of the row, or forgetting the per-entity
partition). Centralizing it guarantees the SQL and the reference implementation agree, and the test
proves the SQL returns the as-of version, never current state.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple


def as_of_sql(table: str, entity_key: Sequence[str], *, as_of_param: str = ":as_of") -> str:
    """The canonical AS-OF SELECT for a snap_* table.

    Returns the latest snapshot row per `entity_key` whose snapshot_date <= the as-of date — i.e. the
    point-in-time version of each entity as of `as_of_param`. `entity_key` is the snapshot PK WITHOUT
    snapshot_date (e.g. ['brand_id','identifier_type','identifier_value']). The window orders by
    snapshot_date DESC and keeps rank 1, so each entity yields its most-recent-on-or-before-D slice.

    `as_of_param` is a SQL placeholder/literal: ':as_of' for a parameterized driver (sqlite/JDBC),
    or a quoted DATE literal (e.g. "DATE '2026-06-20'") for an ad-hoc StarRocks/Trino query. This SQL
    is portable across StarRocks, Trino, and sqlite (all support ROW_NUMBER window functions).
    """
    partition = ", ".join(entity_key)
    return (
        "SELECT * FROM (\n"
        "  SELECT *,\n"
        "    ROW_NUMBER() OVER (\n"
        f"      PARTITION BY {partition}\n"
        "      ORDER BY snapshot_date DESC\n"
        "    ) AS _asof_rn\n"
        f"  FROM {table}\n"
        f"  WHERE snapshot_date <= {as_of_param}\n"
        ") ranked\n"
        "WHERE _asof_rn = 1"
    )


def resolve_as_of(
    rows: List[dict],
    entity_key: Sequence[str],
    as_of_date: str,
) -> Dict[Tuple, Optional[dict]]:
    """Pure-Python reference implementation of `as_of_sql` — the as-of resolver, no DB required.

    Given snapshot `rows` (each a dict with the entity_key columns + a 'snapshot_date' string in
    ISO 'YYYY-MM-DD' form), return a map {entity_key_tuple -> the latest row with snapshot_date <=
    as_of_date}, or None for entities that have no slice on or before that date. snapshot_date strings
    sort correctly lexicographically in ISO form (so no date parsing is needed).
    """
    best: Dict[Tuple, Optional[dict]] = {}
    for r in rows:
        key = tuple(r[c] for c in entity_key)
        sd = r["snapshot_date"]
        if sd > as_of_date:
            continue  # future slice — invisible as-of D
        cur = best.get(key)
        if cur is None or sd > cur["snapshot_date"]:
            best[key] = r
    return best


__all__ = ["as_of_sql", "resolve_as_of"]
