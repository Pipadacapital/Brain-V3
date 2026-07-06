<!-- SPEC: 0.4 -->
# AMD-14 — Journey API paths + "Analytics Gateway" (B.3)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** B.3 (journey APIs)

## Conflicting spec text
> §B.3 "Journey APIs (Fastify gateway; …) — `GET /v1/customers/{brain_id}/journey?cursor=&limit=` […] `GET /v1/journeys/trace?order_id=` […] `GET /v1/journeys/compare?left=&right=`"

The spec assumes a standalone Analytics Gateway service with its own path namespace.

## Ground truth (delta-plan evidence)
No standalone gateway exists — `analytics-gateway` was deliberately removed in cleanup PR #295; the serving seam is the core BFF (ADR-0007). Live analogs already exist there: `GET /api/v1/analytics/journey/events` (analytics-journey.routes.ts:930, keyset cursor + contract) and `/api/v1/analytics/journey/timeline` (:864). `compare` has no analog.

## Candidate resolutions
### R1 — Extend/alias the existing BFF routes (adopted)
- `journey` timeline ≙ extend `/api/v1/analytics/journey/events` (+ `X-Journey-Version`, matched_via/session_id/url_path fields); `trace` ≙ extend `/journey/timeline` (+ lookback window + identity_evidence); `compare` = NEW route in the same namespace with `t_minus_conversion_ms`.
- Tenant from auth session (already the pattern — never query params); Redis via ServingCacheReader 'journey' tier.
- Trade-offs: spec path strings differ from live paths; the mapping above is the contract of record (optional thin aliases may be added, but no parallel implementation).

### R2 — Parallel-build the spec paths on a new gateway
- Trade-offs: duplicates two live endpoints and resurrects a service the repo deliberately deleted; double maintenance + parity burden.

## RECOMMENDED resolution (BINDING)
**R1.** Additive route extension on the sanctioned serving seam; honors the repo's ADR-0007 architecture decision.
