<!-- SPEC: 0.4 -->
# AMD-07 — Bi-temporality of silver_identity_map (§1.5 / A.1.5)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-13 (system-time columns), WA-14 (sanctioned views), B.4 replay

## Conflicting spec text
> §1.5 "`silver_identity_map` is bi-temporal (valid-time + system-time). Consumers state their view: `current` for operational paths; `as-of(T_valid, T_system)` for replay/audit."
> §A.1.5 "All `silver_identity_map` writes are bi-temporal appends (close old interval, open new), never in-place."

## Ground truth (delta-plan evidence)
Live schema is **valid-time only**: `effective_from/to, is_current, replaced_by_brain_id, merge_event_id, updated_at` (Trino DESCRIBE; 14,902 rows). It is a **batch projection of Neo4j** (silver_identity_map.py, MERGE on brand+hash+brain_id+effective_from), not append-per-mutation — so `as-of(T_system)` is impossible today.

## Candidate resolutions
### R1 — Additive system-time columns + append semantics + sanctioned views (adopted)
- Add **`system_from` / `system_to`** columns (nullable, additive ALTER; the delta plan's draft naming — `recorded_at`/`superseded_at` are the same axis, `system_from`/`system_to` is the adopted spelling) and make map mutations bi-axial appends (close old system interval, open new).
- Access ONLY via the sanctioned views `identity_current_v` / `identity_asof` (A.2.2, WA-14).
- Replay/as-of is reconstructed from **retained version rows + identity intervals** — explicitly **NOT** from Iceberg time-travel beyond snapshot TTL (see AMD-10: 7-day snapshot TTL makes time-travel unusable as the system axis).
- Trade-offs: table grows append-only (bounded, identity-map-sized); existing rows get NULL/backfilled system_from = updated_at as best-effort history start.

### R2 — Declare Iceberg snapshots the system axis
- Trade-offs: directly conflicts with the live `SNAPSHOT_TTL_MS=7d` daily sweep — as-of older than 7 days silently fails; only viable with a per-table retention exemption (storage + maintenance divergence). Rejected except as a future exemption.

## RECOMMENDED resolution (BINDING)
**R1.** Additive columns + views; no existing consumer breaks (all current readers see is_current semantics unchanged); replay becomes possible without new infrastructure.
