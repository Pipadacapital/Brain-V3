# SPEC: B.2 (WB-B2, AMD-11)
"""
_journey_version_log_pure.py — the PySpark-FREE driver-side helper for the journey_version_log write in
gold_journey_events_reversion.py.

Kept dependency-thin (no pyspark import) so the journey-level VERSION BUMP contract is unit-testable on a
vanilla Python without a Spark runtime — same posture as _journey_reversion_pure.py. The Spark job
aggregates the affected rows to one (brand_id, brain_id, from_version) per re-versioned brain in SQL
(GROUP BY max(data_version)), collects the small result driver-side, and calls version_log_rows() to shape
the journey_version_log rows.

AMD-11 R1: the journey-level version is derived as max(data_version) over a brain's current touchpoint
rows, and a re-version pass rebuilds the journey as EXACTLY version N+1. from_version is the pre-flip max
version being superseded; to_version = from_version + 1; cause is the pass class ('merge'|'unmerge') or the
dirty-set-carried cause ('restitch'). The TypeScript twin is
apps/stream-worker/src/domain/journey/JourneyReversionDirty.ts (nextJourneyVersion /
buildJourneyVersionLogEntry) — keep the two in lockstep.
"""
from __future__ import annotations

_VALID_CAUSES = ("merge", "unmerge", "restitch")


def next_journey_version(from_version):
    """The journey-level version bump: N -> N+1 (AMD-11). from_version must be a non-negative integer
    (a version is a monotone counter). Mirrors nextJourneyVersion() in the TS twin."""
    if isinstance(from_version, bool) or not isinstance(from_version, int) or from_version < 0:
        raise ValueError(
            "next_journey_version: from_version must be a non-negative integer, got {0!r}".format(from_version)
        )
    return from_version + 1


def version_log_rows(aggregated, cause, at):
    """Shape the journey_version_log rows for a re-version pass.

    aggregated : iterable of mappings with brand_id / brain_id / from_version (already 1 row per
                 re-versioned brain — the Spark job GROUP BYs max(data_version) upstream).
    cause      : 'merge' | 'unmerge' | 'restitch' (the re-version cause recorded on every row).
    at         : the commit instant (a timestamp/str carried verbatim onto every row).

    Returns a list of dicts {brand_id, brain_id, from_version, to_version, cause, at} with
    to_version = from_version + 1. Skips rows with a missing brand_id / brain_id / from_version. Order-stable
    (input order preserved) so a replay is byte-identical.
    """
    if cause not in _VALID_CAUSES:
        raise ValueError("version_log_rows: cause must be one of {0}, got {1!r}".format(_VALID_CAUSES, cause))
    out = []
    for r in aggregated:
        brand = r.get("brand_id")
        brain = r.get("brain_id")
        from_v = r.get("from_version")
        if brand is None or brain is None or from_v is None:
            continue
        out.append(
            {
                "brand_id": brand,
                "brain_id": brain,
                "from_version": int(from_v),
                "to_version": next_journey_version(int(from_v)),
                "cause": cause,
                "at": at,
            }
        )
    return out
