<!-- SPEC: 0.4 -->
# AMD-11 — journey_version grain (B.1 / B.2)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** B.1 (canonical journey generation), B.3 (X-Journey-Version header)

## Conflicting spec text
> §B.1 "write to versioned `journey_events` […] Idempotent: MERGE on `(brand_id, brain_id, journey_version, event_id)`."
> §B.3 "`X-Journey-Version` header."

## Ground truth (delta-plan evidence)
Live journey_events versioning is **per-touchpoint**: `data_version` + `is_current`, PK `(brand_id, touchpoint_id, data_version)` (gold_journey_events.py; 6,743 live rows, 24 cols). Same event-sourced intent, **incompatible key** — retrofitting a per-journey `journey_version` into the PK is a PK change on a live table, prohibited by §0.5.

## Candidate resolutions
### R1 — Keep data_version; expose a DERIVED journey-level version (adopted)
- Keep PK `(brand_id, touchpoint_id, data_version)` and per-touchpoint versioning.
- Journey-level version = `max(data_version)` over the brain_id's current rows (or the journey_version_log head, once B.2 writes it) — served as `X-Journey-Version` and recorded in `journey_version_log {brand_id, brain_id, from_version, to_version, cause, at}`.
- Trade-offs: journey version is derived, not stored per row; version-log write required for a cheap header read (B.2 already has all fields in hand at reversion step 5).

### R2 — New PK with journey_version (spec verbatim)
- Trade-offs: breaking PK change / table rewrite on live data; violates §0.5 non-breaking rule outright.

## RECOMMENDED resolution (BINDING)
**R1.** Additive (a derived value + a new log table); preserves the live event-sourced mechanism (§1.6) while delivering the spec's observable contract (versioned journeys, version header, version log).
