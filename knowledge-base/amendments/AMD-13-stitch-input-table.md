<!-- SPEC: 0.4 -->
# AMD-13 — Journey builder input table (B.1)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** B.1 (canonical journey generation)

## Conflicting spec text
> §B.1 "Input: Silver touchpoints + `silver_session_identity` (v2)."

## Ground truth (delta-plan evidence)
`silver_session_identity` does not exist (it is a Wave A deliverable, WA-16). The live journey builder input is sessionized `silver_touchpoint` (gold_journey_events.py builds from it today; 6,743 rows live). A literal reading blocks all of Wave B on Wave A stitch v2 completion.

## Candidate resolutions
### R1 — Keep silver_touchpoint until stitch v2 lands, then flag-switch (adopted)
The journey builder continues to read `silver_touchpoint`; when WA-16 ships `silver_session_identity`, the builder switches its identity-resolution input behind a per-brand flag (default OFF), with parity on the golden dataset before enabling.
- Trade-offs: `matched_via` provenance is initially derived from silver_identity_map identifier_type rather than stitch output; upgraded when the flag flips.

### R2 — Block Wave B entirely on Wave A stitch v2
- Trade-offs: serializes the program unnecessarily; Wave B API/versioning work has no hard dependency on the new stitch table.

## RECOMMENDED resolution (BINDING)
**R1.** Matches the wave ordering anyway, is flag-gated per §0.5, and keeps every intermediate state shippable.
