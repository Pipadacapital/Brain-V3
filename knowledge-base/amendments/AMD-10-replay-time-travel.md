<!-- SPEC: 0.4 -->
# AMD-10 — Journey replay via Iceberg time-travel (B.4)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** B.4 (?as_of= replay path)

## Conflicting spec text
> §B.4 "`?as_of=<iso>`: Iceberg time-travel on `journey_events` + `identity_asof` — journey as known then. Batch-path only; `replayed: true`."

## Ground truth (delta-plan evidence)
`SNAPSHOT_TTL_MS = 7d`, swept daily by table maintenance; live journey_events snapshots span **< 1 hour**. `FOR TIMESTAMP AS OF` beyond the TTL horizon fails — Iceberg time-travel cannot serve arbitrary as_of. What IS fully retained: journey_events **version rows** (data_version/is_current, never deleted), the bi-temporal identity map intervals (per AMD-07), the `brain_id_asof` column pair (gold_journey_events.py:243–258), and the test-proven `snap_identity_link`/`_snap_as_of` seam.

## Candidate resolutions
### R1 — Reconstruct as-of from retained version history + identity intervals (adopted)
Replay = filter journey_events version rows to those valid at T + resolve identity via `identity_asof(T_valid, T_system)` intervals + the snap_identity_link seam. All inputs are retained indefinitely; **NOT Iceberg time-travel beyond snapshot TTL**. Responses carry `replayed: true`; batch-path only per spec. Pre-identification replay is answerable today from `brain_id_asof` NULL / `anonymous_` rows.
- Trade-offs: as-of query is a join over version history rather than a snapshot read — slower, acceptable for the explicitly batch-only path.

### R2 — Per-table snapshot-retention exemption for journey_events
- Trade-offs: unbounded-ish snapshot growth (bounded but large), diverges table-maintenance policy, and still couples correctness to physical snapshots rather than modeled history. Kept as a future optimization only.

## RECOMMENDED resolution (BINDING)
**R1.** Uses only retained, modeled history (additive, invariant-preserving per §1.6); no maintenance-policy change; consistent with AMD-07's system-time columns.
