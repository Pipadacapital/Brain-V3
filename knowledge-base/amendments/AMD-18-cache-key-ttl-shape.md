<!-- SPEC: 0.4 -->
# AMD-18 — Redis cache key/TTL shape (§1.11.2)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** §1.11 serving work in every wave; B.3 journey cache tier

## Conflicting spec text
> §1.11(2) "Redis result caching at the gateway: key `{brand_id}:q:{normalized_query_hash}`, TTL per freshness class (`realtime` = no cache, `hourly` = 15 min, `daily` = 4 h). Cache entries crypto-shred-invalidated by brand."

## Ground truth (delta-plan evidence)
The live implementation is a **superset**: keys `${brandId}:${metricId}:${paramsHash}:${servingVersion}` with 5 TTL tiers, SETNX stampede locks, and brand-scoped + version-bump invalidation (analytics-cache.ts / serving-ttl.ts; ADR-0007 D2). Gaps vs spec: no realtime/no-cache class, and **crypto-shred never invalidates the cache** (erasure publishes no cache.invalidate — TTL max 60m is the only backstop; a §1.3 defect, fix-item not amendment).

## Candidate resolutions
### R1 — Ratify the live key shape as satisfying §1.11.2 (adopted)
- The live `{brand_id}:{metricId}:{paramsHash}:{servingVersion}` shape ≥ spec's `{brand_id}:q:{hash}` (brand-first, deterministic, invalidatable — plus version-bump invalidation the spec lacks).
- ADD the missing `no-cache`/realtime tier to serving-ttl.
- Wire erasure → `cache.invalidate.v1` scope.all (ErasureOrchestratorConsumer + existing CacheInvalidatePublisher) as the §1.3 fix.
- Trade-offs: key format documented here rather than matching spec string literally.

### R2 — Adopt the spec key verbatim
- Trade-offs: a regression — loses metricId observability, servingVersion invalidation, and tiered TTLs; forces a live-cache migration for zero gain.

## RECOMMENDED resolution (BINDING)
**R1.** The live shape is a strict functional superset; ratify + close the two real gaps (no-cache tier, shred invalidation) additively.
