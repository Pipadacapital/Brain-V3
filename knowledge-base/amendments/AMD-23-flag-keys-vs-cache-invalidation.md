<!-- SPEC: 0.4 -->
# AMD-23 — `{brand_id}:flag:*` keys vs brand-wide cache invalidation (§0.5 / WA-01)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** WA-01 (packages/platform-flags) and every flag-gated behavior in Waves A–I

## Conflicting spec text
> §0.5 "…every Redis key (`{brand_id}:...`)" — WA-01 specifies flag keys `{brand_id}:flag:{flag_name}`, brand_id FIRST, stored durably (no TTL) in the shared Redis.

## Ground truth (verified 2026-07-06 against the live stack + code)
The pre-existing serving-cache invalidation deletes EVERYTHING brand-prefixed:
- `apps/stream-worker/src/jobs/gold-rewritten-publish/run.ts` emits `cache.invalidate.v1` with `affected_scope.all=true` for EVERY active brand on EVERY refresh-loop Phase-2 pass (its header: "rewrites the brand's whole BI Gold surface, so the honest scope is 'everything for this brand'").
- `AnalyticsCacheInvalidateConsumer.scanAndDelete` then runs `SCAN MATCH ${brandId}:* → DEL` (:194–197, :224–256). The erasure path (AMD-18 R1) publishes the same `scope.all`.

Consequence: per-brand flags stored at `{brand_id}:flag:{name}` would be DELETED for every active brand on every medallion refresh — silently reverting all flag-gated features to OFF (fail-closed direction, but the flag system would be unusable while the refresh loop runs).

## Candidate resolutions
### R1 — Exempt the durable-config namespace `{brand_id}:flag:*` from scan-and-delete (adopted)
The invalidation consumer owns CACHE namespaces (derived, recomputable data). Flags are durable per-brand CONFIG — not derived from Gold, not stale after a rewrite, never legitimately "invalidated" by a data refresh. Add a namespace exemption in the ONE chokepoint (`AnalyticsCacheInvalidateConsumer`): keys matching `${brandId}:flag:*` are skipped by both the exact-key and SCAN delete paths.
- Keeps the §0.5 brand-first key shape verbatim; keeps the tenant-scoped SCAN invariant; additive (a skip, never a broader delete).
- Trade-offs: the consumer must know one config namespace name; any FUTURE durable per-brand config namespace must be added to the same exemption list (documented at the exemption site).

### R2 — Move flags out of the brand-first namespace (e.g. `flag:{brand_id}:{name}`)
- Trade-offs: violates the §0.5 non-negotiable "brand_id first segment of every Redis key", breaks the brand-prefix isolation/audit property, and diverges the TS + Python twins from the spec'd shape for zero functional gain.

## RECOMMENDED resolution (BINDING)
**R1.** Cache invalidation means "cached DERIVED results are stale" — durable config is out of its jurisdiction. Implemented with a spec-named test proving a `scope.all` eviction deletes cache keys but never `{brand_id}:flag:*`.
