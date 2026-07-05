# ADR-0007 — The Analytics Gateway: formalizing the existing serving seam (Redis cache-aside → Trino-over-Iceberg → Fastify BFF)

Status: **Accepted** (2026-06-28).

> **Docs-only / no new deployable.** This ADR does not add, change, or remove any runtime component. It *names* and *formalizes* the serving read-path that is **already built and merged** (Brain V4) as a single architectural seam — the **Analytics Gateway** — so future work has one place that describes how every dashboard, AI surface, mobile client, and partner read reaches Gold without ever touching Gold directly.

## Context

Brain V4 serving is **Trino-over-Iceberg + Redis** (StarRocks is REMOVED — the `brain_serving.mv_*` objects are now **Trino views** in `db/trino/views/*.sql`, e.g. `db/trino/views/mv_gold_revenue_ledger.sql`, each a thin `CREATE OR REPLACE VIEW iceberg.brain_serving.mv_<name>` projection over the Spark-materialized Iceberg mart `iceberg.brain_gold.<table>`). Gold/Silver are pre-materialized by Spark; the views are projection-only (no compute at read time).

The read path that fronts those views is fully implemented across `@brain/metric-engine`, `apps/core` (the Fastify BFF), and `apps/stream-worker`. What was missing is a **named contract** for it. Multiple independent rules — "the app/BFF/metric-engine read ONLY `brain_serving.mv_*`, never a bare Gold/Silver table", "money never blended", "`brand_id`-first", "deterministic-first", "Gold is never hit directly" — are all enforced *inside* this one seam, but nothing in `docs/` declared the seam itself. This ADR is that declaration.

The Gateway is the **sole sanctioned read path** for known, registered metrics. Direct reads of `iceberg.brain_gold.*` / `iceberg.brain_silver.*` from the app/BFF/metric-engine are prohibited (Spark jobs may read the Iceberg catalogs directly — they are the writers, not consumers of the Gateway).

## Decision

Recognize the existing seam as **the Analytics Gateway** with the following fixed shape. No code changes; the citations below are the load-bearing implementation.

```
dashboards / AI / mobile / partner
        │  HTTP (brand from session — D-1, never from request body)
        ▼
Fastify BFF  (apps/core/.../routes/analytics-core.routes.ts)
        │  cachedRead(brandId, metricId, params, compute)
        ▼
ServingCacheReader  (packages/metric-engine/src/serving-cache.ts)
        │  cache-aside via AnalyticsCachePort
        ├── HIT  ──► Redis  (IoredisCacheAdapter — packages/metric-engine/src/analytics-cache.ts)
        └── MISS ──► compute() = the withTrinoBrand closure
                          │  ${BRAND_PREDICATE} → brand_id = ?   (parameterized, fail-closed)
                          ▼
                    Trino-over-Iceberg  (trino-deps.ts + trino-adapter.ts)
                          ▼
                    brain_serving.mv_*  (Trino views over iceberg.brain_gold.*)
                          ▲  GOLD IS NEVER HIT DIRECTLY
out-of-band:  cache.invalidate.v1  ─►  AnalyticsCacheInvalidateConsumer  ─►  brand-scoped Redis eviction
```

### D1 — The Gateway is **cache-aside (read-through) over Redis**, with the metric-engine as the single chokepoint.

The BFF wraps every known-metric read in `cachedRead(...)`, which delegates to `ServingCacheReader.read(brandId, metricId, params, compute)` (`packages/metric-engine/src/serving-cache.ts`, `createServingCacheReader`). On a **hit**, the value is served from Redis; on a **miss**, the `compute()` closure runs the actual Trino read and the result is written back with a TTL. The ~49 metric compute functions and the brand-scoped query seam are **unchanged** — the cache is a transparent wrapper, injected at the composition root and passed to the routes as `deps.servingCache` (see the `cachedRead` helper at `apps/core/src/modules/frontend-api/internal/routes/analytics-core.routes.ts`).

- **Stampede guard.** `IoredisCacheAdapter.getOrSet` (`packages/metric-engine/src/analytics-cache.ts`) coalesces concurrent misses on the same key via an in-process `inFlight` promise map — only the first caller computes, the rest await the same promise (per-instance scope; a distributed SETNX guard can be layered later).
- **Fail-soft.** `serving-cache.ts` never breaks a read because of the cache: a cache **GET** failure before compute falls back to a direct `compute()` (Trino); a **SET** failure after a successful compute returns the value and drops the write; only a real `compute()` (Trino) error propagates — never retried, never swallowed, never double-queried.
- **Safe-OFF.** When the reader is flag-disabled (or `servingCache` is absent), `read` / `cachedRead` is a pure pass-through that calls `compute()` directly (read Trino, no cache touched).
- **Serving version.** The trailing key segment (`servingVersion`, e.g. `v1`) is the serving-materialization version; bumping it invalidates all keys for that version without flushing Redis.

### D2 — Keys are **`brand_id`-leading**; invalidation is **brand-scoped**.

Every cache key is built by `buildCacheKey(brandId, metricId, paramsHash, servingVersion)` → `${brandId}:${metricId}:${paramsHash}:${servingVersion}` (`packages/metric-engine/src/analytics-cache.ts`). `brand_id` leads **by construction** (callers cannot reorder the args) so:

1. per-brand invalidation is a prefix scan `SCAN 0 MATCH ${brandId}:*`, and
2. any accidental cross-brand leak is detectable from the key alone.

The `paramsHash` is a stable, order-insensitive SHA-256 of the canonicalized params (`hashParams` / `canonicalize` in `serving-cache.ts`) so `{from,to}` and `{to,from}` collide to one entry.

**Brand-scoped invalidation** is event-driven and out-of-band of the read path. A Gold/identity change publishes `cache.invalidate.v1` (suffix `intelligence.cache.invalidate.v1`, `packages/contracts/src/events/cache.invalidate.v1.ts`) via `CacheInvalidatePublisher` (FAIL-OPEN) — typically from `IdentityChangeRecomputeConsumer`. `AnalyticsCacheInvalidateConsumer` (`apps/stream-worker/src/interfaces/consumers/AnalyticsCacheInvalidateConsumer.ts`) consumes it and evicts the brand's keys per the event scope:

- `scope.all` → `SCAN ${brandId}:*` → DEL all matches;
- `scope.key_prefixes` → `SCAN ${brandId}:${prefix}*` per prefix;
- `scope.keys` (exact) → DEL each, **only** if it starts with `${brandId}:`.

Tenant-isolation invariants are enforced in the consumer, not the callers: every SCAN pattern MUST start with `${brandId}:` (a bare `*` scan is a refused P0 breach — guarded twice, defense in depth), `brand_id` comes exclusively from the event envelope, and eviction is **FAIL-SAFE** (Redis errors → log + commit the offset; TTL is the correctness backstop — no DLQ loop for cache busts). Eviction is idempotent (DEL on a missing key is a no-op).

### D3 — On a miss, known metrics route to **Trino-over-Iceberg** (the StarRocks route, replaced by Trino) — never to ad-hoc.

`packages/metric-engine/src/query-route.ts` is the routing authority. `routeKnownMetric(cacheHit)` returns the `KnownMetricRoute` union — `cache_hit` on a hit, otherwise the serving route `trino_serving` (renamed from the historical `starrocks_serving` as this ADR's follow-up refactor; under V4 that route resolves to the `brain_serving.mv_*` **Trino views over Iceberg**, StarRocks having been replaced by Trino). The return **type** makes it impossible for a known metric to return `trino_adhoc`:

- `trino_adhoc` is **additive, read-only, operator/explicit-exploration only** — it is registered in the enum (so references are greppable) but is **never** a valid outcome of `routeKnownMetric`.
- AI/model-originated SQL → Trino is **disabled by policy**: `routeAiAdHocTrino` unconditionally throws `NotImplementedYet` (registered, not silently absent, so enabling it is a deliberate reviewed change). Covered by `packages/metric-engine/src/trino-routing.test.ts`.

The miss-path read itself goes through `withTrinoBrand` (`packages/metric-engine/src/trino-deps.ts`), the Trino analogue of `withSilverBrand`. Trino's REST API has no session-variable row policy, so **SQL predicate injection is the load-bearing isolation**: the caller's SQL MUST contain the one shared `${BRAND_PREDICATE}` sentinel (owned by `trino-deps.ts`, re-exported from `silver-deps.ts`), which `runScoped` replaces with a **parameterized** `brand_id = ?` (`brandId` appended to params). A missing sentinel **throws (fail-closed)** — an un-scoped query that would run cross-brand is refused, never run. `brandId` comes from the session (D-1), never from the request body. The concrete HTTP adapter is `packages/metric-engine/src/trino-adapter.ts` (the only file that talks to Trino), which resolves the two-part `brain_serving.mv_*` name against the default `iceberg` catalog → `iceberg.brain_serving.mv_*` (the views in `db/trino/views/`).

### D4 — **Gold is NEVER hit directly.** The Gateway is the only sanctioned read path.

The BFF/metric-engine read **only** `brain_serving.mv_*` (Trino views) — never a bare `iceberg.brain_gold.*` / `iceberg.brain_silver.*` table. The views are thin projections over the Spark-built marts; the marts are written by Spark and read by the views, not by the app. This is the same invariant the V4 naming guard enforces in CI (`tools/lint/v4-naming-guard.sh`). The Gateway is the single front door; "Gold is never hit directly" is a property of routing *through* it.

### D5 — **Sub-second SLA posture.** Deterministic Tier-0; zero model calls on the hot path.

Serving is fast by construction, not by tuning:

- Gold/Silver are **pre-materialized by Spark** before any read; the Trino views are projection-only (no read-time compute).
- A **cache hit** is a single Redis GET.
- A **cache miss** is one projection read over already-materialized Iceberg, then a cache write — the stampede guard ensures only one such read per hot key under concurrency.
- The routing tier is **Deterministic (Tier 0 — zero model calls, zero tokens)** (`query-route.ts`): known metrics are pre-computed or cached; no model call sits on any hot path. Ad-hoc Trino (a compute-cost path) is gated to operator use only.

Serving freshness is observable out-of-band (`apps/core/src/modules/data-quality/internal/application/queries/get-serving-freshness.ts`) so staleness is measurable rather than guessed.

### D6 — Invariants the Gateway preserves (carried through, not introduced here).

- **Money** = `bigint` MINOR units + sibling `currency_code` — never blended, never a float. Values pass through the cache and views as-is (e.g. `mv_gold_revenue_ledger`'s `amount_minor`/`fee_minor` + `currency_code`).
- **Confidence** = INTEGER 0–100, never blended with money.
- **PII hash-only** — `brain_id` / hashes only flow through serving; no raw email/phone in Silver/Gold or in cache values.
- **`brand_id`-first** on every cache key and every served row (D2/D3).
- **Deterministic-first** (D5).

## Scope

This ADR is **documentation only**:
- **No** new service, topic, table, view, or migration.
- **No** change to `serving-cache.ts`, `analytics-cache.ts`, `query-route.ts`, `trino-deps.ts`, `trino-adapter.ts`, the BFF routes, or the invalidate consumer.
- It names the existing seam "the Analytics Gateway" and records its contract so future readers have one authoritative description.

## Consequences

- **+** One named seam for every analytics consumer (dashboards, AI, mobile, partner). Reviews can point at "the Analytics Gateway" instead of re-deriving the path. The "Gold is never hit directly", "`brand_id`-first", and "deterministic-first" invariants now have a documented home.
- **+** Future serving work (a distributed stampede guard, a new consumer surface, an SLA dashboard) has a stable contract to extend rather than reinvent.
- **−** ~~A naming debt is recorded, not paid: the `query-route.ts` enum member `starrocks_serving` is a historical name that now means "the `brain_serving.mv_*` Trino views over Iceberg." Renaming it is a follow-up refactor (touches the enum + tests), intentionally out of scope for this docs-only ADR.~~ **PAID (follow-up executed):** the enum member is now `trino_serving` (rename touched only the enum + its docstrings + `trino-routing.test.ts`; the value was never persisted or exported beyond the package, so no alias was needed).

## References (real paths, grep-confirmed)

- Cache-aside reader: `packages/metric-engine/src/serving-cache.ts` (`createServingCacheReader`, `hashParams`) — tests: `packages/metric-engine/src/serving-cache.test.ts`
- Cache port + adapter + key builder: `packages/metric-engine/src/analytics-cache.ts` (`AnalyticsCachePort`, `IoredisCacheAdapter`, `buildCacheKey`, `getOrSet`)
- Routing authority: `packages/metric-engine/src/query-route.ts` (`routeKnownMetric`, `routeAiAdHocTrino`, `QueryRoute`) — tests: `packages/metric-engine/src/trino-routing.test.ts`
- Trino brand-scoped seam: `packages/metric-engine/src/trino-deps.ts` (`withTrinoBrand`, `BRAND_PREDICATE`, `TrinoScope.runScoped`)
- Trino HTTP adapter: `packages/metric-engine/src/trino-adapter.ts`
- BFF analytics routes (the chokepoint wrap): `apps/core/src/modules/frontend-api/internal/routes/analytics-core.routes.ts` (`cachedRead`)
- Invalidation consumer: `apps/stream-worker/src/interfaces/consumers/AnalyticsCacheInvalidateConsumer.ts`; publisher: `apps/stream-worker/src/infrastructure/kafka/CacheInvalidatePublisher.ts`; trigger: `apps/stream-worker/src/interfaces/consumers/IdentityChangeRecomputeConsumer.ts`
- Invalidation event contract: `packages/contracts/src/events/cache.invalidate.v1.ts` (`CACHE_INVALIDATE_V1_TOPIC_SUFFIX = 'intelligence.cache.invalidate.v1'`)
- Trino serving views (`brain_serving.mv_*` over `iceberg.brain_gold.*`): `db/trino/views/*.sql` (e.g. `db/trino/views/mv_gold_revenue_ledger.sql`) + `db/trino/views/run-trino-views.sh`
- Serving freshness observability: `apps/core/src/modules/data-quality/internal/application/queries/get-serving-freshness.ts`
- Related: [ADR-0002](0002-iceberg-bronze-spark-streaming.md) (Iceberg as system of record), [ADR-0004](0004-neo4j-identity-sor.md) (identity SoR); CI invariant guard `tools/lint/v4-naming-guard.sh`
