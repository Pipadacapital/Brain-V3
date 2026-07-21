# ADR-0019 — Serving performance: kill cold-start, harden the cache, pre-bake the read-time-compute marts, close view-drift

- **Status:** Accepted (2026-07-22) — owner-ratified. WS-0 (config 80/20) applied immediately staging→prod; WS-1..WS-5 implemented flag-gated, staging-first.
- **Builds on:** ADR-0014 (Trino removed → `duckdb-serving`), ADR-0016 (near-real-time serving: incremental + chained + warm transform tier), ADR-0017 (identity folded into the tick). Assumes Waves 0–2 already shipped (W1 repartitioned Silver/Gold marts to ~1 file; W2a folded hot-table compaction into the transform tick; the medallion writes marts every `*/5` tick).
- **Deciders:** Owner + platform (principal data architect)
- **Goal:** eliminate the dashboard **cold-start latency** (measured 1000× cold→warm gap; 10–27 s first-hits) so *every* endpoint is consistently sub-second, without a new datastore, without breaking the single-query-ceiling doctrine, and reversibly per workstream behind flags with safe-off defaults.

## Context

A full live-prod dashboard API sweep + direct serving probes (2026-07-22) proved the fault is **cold-start, not read compute**. The read compute is cheap — warm, essentially every endpoint is <100 ms. The coldness is the killer.

**Measured evidence (2026-07-22, live prod):**

1. **Cold-start is the dominant fault — a 1000× cold→warm gap on the *identical* query.** `orders-list` 13,079 ms cold → 15 ms warm; `journey/paths` 11,989 ms → 336 ms; `executive-metrics` 1,726 ms → 10 ms; `insights/briefing` 2,209 ms → 82 ms. Warm, essentially every endpoint is <100 ms.

2. **Slow cold first-hits (all <100 ms warm):** blended-roas 13–15 s, journey/list 16–27 s, abandoned-cart 10–13 s, product-affinity 11.8 s, tracking-health 12.9 s, top-products 6.9 s, products/{id} 6.7 s, identity/customers?segment 7–8 s, medallion-journey 8 s, entitlements 5.4 s, recent-events 3.5 s, data-health 2.8 s, executive-metrics/behavior 1.7–2 s.

3. **The pre-warm is itself broken.** A fresh-epoch log shows `prewarm_s {mv_silver_collector_event: ~300–321s, mv_silver_touchpoint: ~28s}` — ~5 minutes to warm ONE mart, but epochs rotate every `CATALOG_REFRESH_S=60` s. The warm can never keep up, so the pre-warmed set is perpetually behind. Root cause is verified in code (`serving/engine.py:15,40,81,181-213,284-308`): pre-warm runs inside `Epoch.__init__` before the epoch goes live; the keystone view `mv_silver_collector_event` reads `iceberg.brain_silver.silver_collector_event` — the ~700-day-partition **keystone**, which re-fragments under `*/5` MERGE churn. duckdb-iceberg's EXECUTE phase costs ~200 ms/data-file on a **cold** connection (documented `engine.py:68-72`, measured 1,384 files → 289 s), so a fragmented keystone dominates the pre-warm. Wave-2a's `TICK_MAINT_TABLES` hot-table compaction hook exists (`run_all.py:158-200`) but **ships default-empty** (`run_all.py:164-165`), so nothing counters the re-fragmentation.

4. **Pre-warm coverage is only 2 tables.** `DUCKDB_SERVING_PREWARM_TABLES` (`engine.py:81`) covers `mv_silver_collector_event` + `mv_silver_touchpoint`. Every analytics mart (`mv_gold_marketing_attribution`, `mv_gold_customer_scores`, gold product/journey/cart/revenue, etc.) is COLD after each 60 s rotation.

5. **Redis cache-miss falls through to a cold serving scan** = the 10–16 s hit; cache only helps once warmed. `IoredisCacheAdapter.getOrSet` (`packages/metric-engine/src/analytics-cache.ts:230-300`) is strictly get-or-compute: on TTL expiry the entry is *gone* and the next reader blocks on the full cold compute. The 2-layer stampede guard (in-process promise map + Redis SET-NX) only collapses *concurrent* misses — the *first* miss after every TTL boundary still pays full cold cost, synchronously, in the user's request. And `blended_roas` / `order_status_mix` route through `semanticRouter.route` (semantic-serving), which touches **no** Redis at all — every hit is a cold scan (explains blended-roas 13–15 s with no warm persistence).

6. **View-drift / silent-500s.** `gold_contribution_margin.py` and `gold_order_economics.py` are built every Gold pass (`db/iceberg/duckdb/gold/`) but have **no serving views** (`views/` defines only `mv_gold_customer_scores`, `mv_gold_revenue_ledger`, `mv_silver_collector_event`, `mv_silver_touchpoint`, `mv_bronze_collector_events_connect`). Nothing today reads `mv_gold_contribution_margin` / `mv_gold_order_economics` as a live dashboard read (`contribution-margin.ts` recomputes from `mv_gold_revenue_ledger` + `mv_silver_marketing_spend` + PG; `gold_order_economics` appears only as a lineage-registry table ref in `metric-lineage.ts`). So this is **dead transform compute** (marts built, never served) plus an **unenforced drift hazard**: nothing fails CI when an endpoint references an `mv_` that `views/` doesn't define. Recurring `POST /v1/query 500` in serving logs corresponds to any such reference; core fail-safes the 500 to an empty chart (returns 200 with an empty chart, not an error) — a silent-failure class.

7. **Read-time compute on the worst few.** `blended-roas` FX-blends spend × attribution × revenue over the date range at read time (`apps/core/.../get-channel-roas.ts`); `identity/customers?segment` folds the segment label from `gold_customer_scores` at read time via `getCustomerSegmentMembers` (`packages/metric-engine/src/customer-scores-batch.ts` — a **full brand scan** that re-derives the segment ladder in TS, duplicated from the deleted `_segment_rules.py`, a drift hazard). These belong pre-baked in the transform tier per the single-query-ceiling doctrine.

8. **Healthy counter-examples (the fix works when a mart is warm/small/cached):** all `dashboard/*`, funnel, engagement, journey/first-touch-mix + stitch-rate, attribution/*, logistics/*, consent/*, connectors/*, revenue-timeseries, kpi-summary, orders-list (warm), products/categories — all <100 ms.

**Synthesis.** There is not one fault but four independent, independently-shippable ones: (i) the serving pre-warm/rotation converges the wrong way and wastes 5 min warming the keystone nobody's warm-path needs; (ii) the Redis cache serves cold on every TTL boundary and skips two hot endpoints entirely; (iii) two Gold marts recompute at read time instead of being served; (iv) view-drift is unenforced. Each is fixed at the correct tier, and none requires an architectural reversal.

## Decision

**One coherent plan, five flag-gated workstreams, each reversible with a safe-off default. The cheapest, highest-leverage config change ships FIRST and de-risks the rest before any code change.**

### WS-0 — 80/20 config-only de-risk (zero code, ships first, staging-first)

Two env changes on the serving Deployment + transform worker, no code:

- **Widen + re-target pre-warm to the dashboard working set; drop the keystone from it.** Set `DUCKDB_SERVING_PREWARM_TABLES` to the marts dashboards hit warm-cheap (all ~1-file post-Wave-1, so the whole set warms in a few seconds — well inside a 60 s epoch build): `mv_gold_revenue_ledger, mv_gold_customer_scores` today, growing to the WS-3 additions. **Remove `mv_silver_collector_event`** — it is the keystone, only read by the 3 Bronze-operational endpoints (data-health / tracking-health / recent-events), which already carry a 5-min Redis TTL bounding them to one scan per 5 min. Warming a 300 s keystone on every 60 s epoch is strictly worse than letting that TTL absorb the single cold scan. This single change removes cold-start for every mart endpoint and stops the broken 300 s pre-warm.
- **Turn on hot-table compaction in the tick.** Set `TICK_MAINT_TABLES=silver_collector_event,silver_touchpoint` on the transform worker (`run_all.py:158-200` already parses it; ships empty). This halts the keystone re-fragmentation that made cold scans of it 300 s, so even the TTL-absorbed keystone scan drops to seconds.

WS-0 is fully reversible (unset the two env vars) and requires no merge. It is expected to remove the dominant cold-start class on its own; WS-1–WS-4 make the guarantee structural and durable.

### WS-1 — Serving: hold-warm + signal-driven rotation (make pre-warm convergent)

The rotation's only jobs are (a) re-apply views whose Gold dependency didn't exist at the last epoch, and (b) recover a poisoned attach (`engine.py:11-24`). Freshness for *already-applied* views is commit-driven on re-query — rotation is **not** the freshness path. So decouple rotation cadence from warmth:

- **D1 — Rotate on signal, not on a fixed clock.** Add a localhost-only `POST /internal/rotate` to `serving/server.py` that calls the already-public `Engine.rotate_once` (thread-safe request). The transform tick, at end-of-tick (after the Gold pass + tick-compaction), POSTs it — rotation becomes **write-driven**. The 60 s clock drops to a slow self-heal backstop (`DUCKDB_SERVING_CATALOG_REFRESH_S=600`). Since marts land every `*/5`, the epoch rotates ~once per 5 min and holds a **warm** connection the rest of the time. Flag: `DUCKDB_SERVING_ROTATE_ON_SIGNAL` (default OFF → today's unconditional 60 s clock; ON → signal + 600 s backstop). Fail-open: a failed rotate POST logs and never fails the tick (mirrors the existing fail-open `run_cache_bust`).
- **D2 — Skip a rotation when nothing needs it.** `_rotate_loop` (`engine.py:302-308`) rotates only if the last epoch had non-empty `views_skipped` (a Gold dep may now exist) OR a poisoned-attach flag is set OR the signal fired. Otherwise it **holds the warm epoch**. This gives the low-risk half of "stop rotating" (hold the warm connection in steady state) **without** losing self-heal — a newly-deployed view still triggers a rotation via the `views_skipped` path. Flag: `DUCKDB_SERVING_ROTATE_ON_SKIP_ONLY` (default OFF → today's behavior).

Net: an epoch, once warm, **stays** warm until there's genuinely new Gold to pick up; the keystone is off the pre-warm path (WS-0); the working-set marts pre-warm in seconds on the rare real rotation.

### WS-2 — Cache: stale-while-revalidate + cover the uncached hot endpoints

The user must never synchronously block on a cold scan.

- **D3 — Stale-while-revalidate (soft/hard TTL).** Give each cached value two ages — a **soft** age (serve-fresh-until) and a **hard** age (evict-after). On a read between soft and hard, serve the stale value **immediately** and trigger a **background** recompute (single-flight, reusing the existing SET-NX + in-process-promise stampede guards in `analytics-cache.ts:230-300`). The user gets the last-good value in <10 ms; the cold scan happens off the request path. Only a fully-cold (past-hard, or never-seen) key blocks — and WS-4 warm-on-write means that key was pre-filled before any user arrived. Flag: `SERVING_CACHE_SWR` (default OFF → today's strict get-or-set). Soft/hard tiers extend the existing per-dataset `serving-ttl.ts` tiers (soft = today's TTL; hard = a small multiple), so no new tuning surface for datasets that don't opt in.
- **D4 — Cache the two uncached hot endpoints.** Route `blended_roas` and `order_status_mix` through the same `servingCache.read` path with an appropriate `serving-ttl.ts` tier, so they stop cold-scanning on every hit. This is a seam change (wrap the existing `semanticRouter.route` compute in the cache), not new SQL. Flag: covered by `SERVING_CACHE_SWR` + a tier entry; safe-off = today's uncached path.

### WS-3 — Transform: pre-bake the read-time-compute marts, then serve them

Move the read-time compute to the transform tier and serve the pre-baked result — the single-query-ceiling doctrine.

- **D5 — Serve the two dead marts + repoint their readers.** `gold_contribution_margin` and `gold_order_economics` are already built every Gold pass. Add thin views `views/mv_gold_contribution_margin.sql` and `views/mv_gold_order_economics.sql` (`SELECT … FROM iceberg.brain_gold.gold_<mart>`, brand-scoped via `${BRAND_PREDICATE}`), and repoint the readers to read the mart instead of recomputing (`contribution-margin.ts` reads `mv_gold_contribution_margin`; the order-economics lineage ref resolves to a real view). This turns dead transform compute into served compute and removes a read-time recompute. Flag: `SERVING_CONTRIB_MARGIN_FROM_MART` (default OFF → today's live recompute; parity-gated before ON — the mart result must match the live recompute to the money-byte, `money = bigint minor + currency_code`, never blended).
- **D6 — Pre-bake channel-ROAS and the customer-segment label.** Add a `gold_channel_roas` mart (FX-blended spend × attribution × revenue, pre-computed per the date grain the endpoint reads) with a `mv_gold_channel_roas` view, and repoint `get-channel-roas.ts`. Add the derived `segment` label as a **column on `gold_customer_scores`** (computed once in the Gold pass from the canonical segment ladder), and repoint `getCustomerSegmentMembers` to filter on that column instead of re-deriving the ladder in TS — killing the full brand scan **and** the ladder-drift hazard (the ladder lives in exactly one place, the Gold pass). Flags: `SERVING_CHANNEL_ROAS_FROM_MART`, `SERVING_SEGMENT_FROM_MART` (both default OFF, parity-gated).

### WS-4 — Warm-on-write from the transform tick (kill the cold-first-hit at the source)

The writer that produces a fresh mart is the entity that knows it's fresh. After the Gold pass + tick-compaction, `run_all.py` warms both tiers **before** any user arrives:

- **D7 — Signal serving to rotate (WS-1 D1) AND pre-fill the app's hot keys.** POST a new internal core endpoint `POST /internal/serving/warm` (cluster-internal, service-token-gated, mounted **outside** `/api/v1` — not a browser route). Body: `{ brands, datasets }` (or `all`). Core iterates the hot dataset allowlist (the measured slow-cold set: executive_metrics, kpi_summary, orders_list, revenue_timeseries, data_health, tracking_health, blended_roas, order_status_mix) × active brands and calls the **existing** `servingCache.read` for the default window (last-35-day) — reusing the exact compute closures, no query duplication, no new SQL. This primes the identical keys real requests hit. Flag: `SERVING_WARM_ON_WRITE` (default OFF → staged rollout; ON after bake). Fail-open: a warm POST failure logs and never fails the tick.

### WS-5 — View-drift guard (make the silent-500 class impossible)

- **D8 — CI guard: every `mv_*` an endpoint references must exist in `views/`.** Add a check (extending `tools/lint/v4-naming-guard.sh` or a sibling lint) that greps `apps/**` + `packages/**` for `mv_*` references and fails if any referenced `mv_*` view is not defined in `db/iceberg/duckdb/views/*.sql`. This converts the silent runtime 500-→-empty-chart into a blocking CI failure at author time — the durable fix is a guard, not a scramble to build phantom views. No flag (a lint gate); reversible by reverting the guard commit.

## Options considered

- **Stop rotating entirely (set `CATALOG_REFRESH_S` very high / 0).** Rejected as the *primary* fix: it abandons self-heal — a newly-deployed Gold view never gets reapplied and its endpoint silently 500s indefinitely. WS-1 D2 takes the safe half of this (hold-warm in steady state) while preserving self-heal via the `views_skipped` trigger.
- **Warm the keystone on every epoch (widen pre-warm to include `mv_silver_collector_event`).** Rejected: that IS the 300 s. WS-0 does the opposite — drops the keystone from pre-warm and lets its 5-min Redis TTL absorb the single cold scan, while WS-0 compaction stops the re-fragmentation that made it 300 s in the first place.
- **Parallel pre-warm (build epoch N+1 in a background thread while N serves).** Considered; **not needed** once WS-0 removes the keystone from the pre-warm set — the remaining working-set marts warm in seconds, so the existing synchronous overlap-warm (`engine.py:284-300` already keeps the old epoch serving until `fresh` is built) is sufficient. Parallel pre-warm is held in reserve as a later hardening if the working set ever grows past the epoch-build budget; it is not on the critical path.
- **Bronze partition-spec / prune the forever-retained `collector_events_connect` lift (AUD-IMPL-025).** Deferred — a genuinely larger change to the Bronze operational table; the 5-min Redis TTL on the 3 Bronze-operational endpoints bounds their cost acceptably in the interim. Revisit as its own ADR.
- **Build phantom `mv_gold_contribution_margin` / `mv_gold_order_economics` views to chase the silent-500.** Rejected as framed: nothing reads them as a live dashboard read today, so building views to satisfy a phantom read is the wrong move. WS-3 D5 instead serves the *already-built* marts and repoints the *actual* readers (retiring their read-time recompute), and WS-5 D8 makes any future drift a CI failure rather than a runtime silent-500.
- **A hot Redis counter tier for sub-second tiles (ADR-0016 D5).** Out of scope — the measured need is "sub-second when warm," which WS-0–WS-4 deliver on the batch path. The hot tier stays deferred until a tile demands sub-*minute*.

## Consequences

**Positive**
- Cold-start eliminated: the working-set marts stay warm (WS-0 + WS-1), the cache serves stale-then-revalidate (WS-2), the writer pre-fills hot keys before users arrive (WS-4). Every endpoint converges to its measured <100 ms warm number.
- Read compute moves to the transform tier where it belongs (WS-3): two dead marts become served, two read-time recomputes and a TS-side segment ladder are retired — net less code and one source of truth for the segment ladder.
- The silent-500-→-empty-chart class becomes a CI failure (WS-5), not a production surprise.
- No new datastore; single-query-ceiling, `brand_id`-first + `${BRAND_PREDICATE}`, and money-as-bigint-minor are all preserved.

**Negative / risks**
- **Signal-driven rotation (WS-1)** makes serving depend on the tick's rotate POST for prompt freshness; mitigated by the 600 s clock backstop (freshness never worse than today's 60 s→600 s bound, and commit-driven re-query already refreshes applied views) and fail-open on the tick side.
- **Stale-while-revalidate (WS-2)** can serve a value up to the hard-TTL stale; mitigated by keeping hard = a small multiple of soft, and by warm-on-write refilling before the soft boundary in steady state.
- **Pre-baked marts (WS-3)** carry the classic incremental-vs-recompute parity hazard; mitigated by shipping each behind a flag with a money-byte parity gate against the current live recompute before default-on.
- **Warm-on-write (WS-4)** adds per-tick warm cost; bounded by the hot-dataset allowlist × active brands, fail-open, and OFF by default until bake.

## Kill switches / rollback

Every workstream is a single env flip or a git revert, no data migration:

- WS-0: unset `DUCKDB_SERVING_PREWARM_TABLES` override + `TICK_MAINT_TABLES` → today's config.
- WS-1: `DUCKDB_SERVING_ROTATE_ON_SIGNAL=0`, `DUCKDB_SERVING_ROTATE_ON_SKIP_ONLY=0`, `DUCKDB_SERVING_CATALOG_REFRESH_S=60` → today's unconditional 60 s clock.
- WS-2: `SERVING_CACHE_SWR=0` → today's strict get-or-set; blended-roas/order-status-mix fall back to their current (uncached) path.
- WS-3: `SERVING_CONTRIB_MARGIN_FROM_MART=0`, `SERVING_CHANNEL_ROAS_FROM_MART=0`, `SERVING_SEGMENT_FROM_MART=0` → today's live recompute. Views are additive (no reader depends on them when the flag is OFF).
- WS-4: `SERVING_WARM_ON_WRITE=0` → tick posts no warm signal.
- WS-5: revert the guard commit.

All flags default **OFF** at ship; each flips ON only after a staging bake (+ parity gate for WS-3).

## Staged rollout (staging-first)

1. **WS-0 (config-only, staging → prod):** widen/re-target pre-warm, drop the keystone, turn on `TICK_MAINT_TABLES`. Measure cold-start on the sweep endpoints. Expected to remove the dominant cold-start class alone. **De-risks everything below before any code merges.**
2. **WS-5 (CI guard):** land the view-drift lint immediately (blocks future drift; independent of the runtime fixes).
3. **WS-1 (serving hold-warm + signal rotation):** ship behind flags OFF, bake in staging with the rotate POST wired, flip ON after confirming freshness ≤ backstop and no stale-view class.
4. **WS-2 (SWR + cache the 2 hot endpoints):** ship OFF, bake, flip ON.
5. **WS-4 (warm-on-write):** ship OFF, bake, flip ON after WS-1/WS-2 are ON (it depends on the rotate signal + cache path).
6. **WS-3 (pre-baked marts):** ship each mart+view+reader behind its flag OFF, run the money-byte parity gate against the live recompute, flip ON per mart. Delete the retired read-time recompute paths once the flags are default-ON and baked (delete-what-you-replace).

## Prioritized fix list (quickest-highest-impact first)

1. **WS-0 config (zero code, minutes):** drop the keystone from `DUCKDB_SERVING_PREWARM_TABLES`, widen it to the ~1-file working-set marts, set `TICK_MAINT_TABLES=silver_collector_event,silver_touchpoint`. Removes the broken 300 s pre-warm and the dominant cold-start. **80/20 — do this before anything else.**
2. **WS-5 CI guard:** make view-drift a build failure. Cheap, prevents the silent-500 class permanently.
3. **WS-1 serving hold-warm + signal rotation:** structural guarantee that a warm epoch stays warm; small, flag-gated `engine.py`/`server.py` change.
4. **WS-2 SWR + cache blended-roas/order-status-mix:** user never blocks on a cold scan; cache-layer change, no new SQL.
5. **WS-4 warm-on-write:** pre-fill hot keys from the tick so the first user is warm; internal endpoint + tick hook.
6. **WS-3 pre-baked marts (contribution-margin, order-economics, channel-roas, segment label):** move read-time compute to the transform tier; largest, parity-gated, per-mart flags. Do last — WS-0/WS-1/WS-2/WS-4 already deliver sub-second on the current read paths; WS-3 is the durable single-query-ceiling cleanup + retires dead compute.

## Invariants preserved

- **Single-query-ceiling doctrine:** WS-3 moves heavy read-time compute into pre-baked transform-tier marts; serving reads warm pre-baked marts, one query on one node.
- **`brand_id`-first + `${BRAND_PREDICATE}`:** every new view/mart is brand-scoped through the same seam; warm-on-write iterates per active brand.
- **Money = bigint minor + `currency_code`:** the pre-baked contribution-margin / order-economics / channel-roas marts keep money as bigint minor with a sibling currency_code, never blended, never a float; parity-gated to the money-byte against the live recompute.
- **No new datastore; DuckDB-on-Iceberg + Redis analytics cache unchanged.** No Trino, no StarRocks, no dbt, no Spark reintroduced (ADR-0014/0015/0016 respected).
- **Additive, flag-gated, reversible, safe-off defaults, delete-what-you-replace** — no parallel stale paths left behind once a workstream is default-ON.
