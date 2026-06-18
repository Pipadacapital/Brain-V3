# 05 — Architecture: feat-journey-touchpoint (Phase 4 — Journey / silver.touchpoint)

**Stage:** 2 (Architect, binding plan) · **req_id:** `feat-journey-touchpoint` · **Lane:** high_stakes (data plane, multi-tenancy, identity-adjacent)
**Paradigm:** **Tier-0 deterministic** (zero model calls, $0/mo, 0 tokens/day). Sessionization = a windowed SQL fold; cart-stitch = a deterministic key read-back from identity; metric seam = integer COUNT/share. **No statistical/ML/fuzzy anywhere** (D-5 — REJECT probabilistic stitch). Justification: every output is a pure function of append-only Bronze + the deterministic stitch map; replay-stable by construction. A model call here would be a paradigm violation.

**The pattern we follow verbatim:** the just-shipped Silver tier (`feat-silver-tier-order-state`). `silver.touchpoint` is the SECOND Silver mart, built exactly like `silver.order_state`: dbt staging→intermediate→mart into StarRocks `brain_silver`; dbt is the cross-brand ETL writer; per-brand isolation lives ONLY at the metric-engine read seam (`withSilverBrand`), proven NON-INERT by an isolation-fuzz mutation test; non-additive math in the metric-engine (ADR-004); the UI reaches Silver ONLY through BFF → analytics use-case → seam (I-ST01).

---

## §1 — Touchpoint SOURCE read + dev boundary

**Source:** SDK journey events live in Postgres `bronze_events` (migration `0016_bronze_events.sql`) — `event_type='page.viewed'` (94 real rows) plus `cart.viewed` / `cart.item_added`. The journey signal is entirely inside the `payload JSONB` column, in the exact shape the pixel-SDK emits (`packages/pixel-sdk/src/capture.ts:62-77`, `types.ts:40-52`):

```
payload.properties.brain_anon_id   (TEXT — the anon journey key)
payload.properties.session_id      (TEXT — SDK 30-min session; we re-derive, see §2)
payload.properties.utm             ({source,medium,campaign,term,content})
payload.properties.click_ids       ({fbclid,gclid,ttclid})
payload.properties.referrer, .landing_path, .device
```

**DECISION — read via the existing `brain_oltp_pg` JDBC catalog + a uuid→text read-shim view** (the same mechanism `silver.order_state` already uses), NOT the Iceberg Bronze catalog.
- **Why JDBC, not Iceberg:** the Iceberg Bronze catalog is the *prod* read path but Bronze-in-Iceberg is **not yet in the repo** (M1 Bronze = Postgres `bronze_events`, per 13-roadmap §13.5 and `0016` header). Picking Iceberg now would block the slice on an unbuilt foundation. JDBC is the smallest reversible option and reuses a proven seam.
- **The shim:** StarRocks' JDBC catalog cannot read Postgres `uuid` columns (UNKNOWN_TYPE — documented in `db/starrocks/oltp_pg_read_shim.sql:6-8`). `bronze_events.brand_id` and the payload-extracted `brain_id` are uuid/uuid-bearing. So we add ONE read-shim view mirroring `silver_order_ledger_src`:
  - `db/starrocks/bronze_touchpoint_src.sql` — `CREATE OR REPLACE VIEW bronze_touchpoint_src AS SELECT brand_id::text AS brand_id, event_id::text AS event_id, event_type, occurred_at, payload FROM bronze_events WHERE event_type IN ('page.viewed','cart.viewed','cart.item_added');` (JSONB `payload` rides through as text/JSON; the staging model extracts fields with StarRocks `get_json_string`). Additive + reversible (`DROP VIEW IF EXISTS bronze_touchpoint_src`); applied by `make journey-catalog`; **consumes no migration number** (read-path setup, exactly like the order shim).

**Dev boundary (honest, identical to the order_state source):** the JDBC catalog connects to Postgres as superuser `brain`, which **BYPASSES RLS** → this source is **cross-brand by construction**. That is the correct ETL-writer posture (dbt builds Silver for all brands). Per-brand isolation is enforced downstream at the metric-engine read seam (§4/§5), NEVER here. **PROD SWAP:** the staging source's `_sources.yml` entry + the one staging model are the only files that change when Bronze graduates to the Iceberg catalog (native string brand_id → shim disappears); intermediate + mart never name a catalog.

> ASSUMPTION: real `page.viewed` rows carry `payload.properties.brain_anon_id` (the SDK always sets it — `capture.ts:62`). Rows predating the SDK that lack it are dropped at staging with a counted `_dropped_no_anon` reason (dev-honesty; surfaced in the UI coverage line). Do NOT synthesize an anon_id.

---

## §2 — Sessionization + first/last-touch grain (dbt Silver mart `silver.touchpoint`)

**THE dbt-vs-stream-worker DECISION: build it as a dbt Silver mart (replay-from-Bronze), NOT in stream-worker.**

Rationale (reconciling the roadmap's "sessionize in stream-worker" note, 13-roadmap §Phase-4):
1. **Silver-tier consistency** — `silver.order_state` set the precedent: derived Silver = a dbt mart reproducible from Bronze. A streaming sessionizer would be a *second* lineage for the same Silver layer (drift risk + a parity oracle we'd have to maintain).
2. **Replay-safe / idempotent** — re-running dbt must yield byte-identical `silver.touchpoint` (the §5 verify target). A windowed SQL fold over append-only Bronze is deterministic; a stateful streaming window is not trivially replay-identical.
3. **No new deployable / topic / envelope (I-E05)** — a stream-worker sessionizer would mean a new consumer group + stateful window store; the dbt path adds zero runtime surface. The streaming path stays a documented later optimization (Non-goal; roadmap "if dbt-mart now, streaming is a later optimization").
4. **Thin real data (94 events)** — batch is correct at this volume; streaming earns its complexity only at scale (graduation trigger documented below).

> GRADUATION TRIGGER (documented, not built now): when real SDK page-view volume exceeds ~the freshness SLA the dbt cron can meet (e.g. journeys must be < 5 min fresh for an in-session use-case), graduate sessionization to a stream-worker consumer writing the SAME `silver.touchpoint` shape, with a parity oracle (streaming vs dbt-recompute). Until then: dbt.

**Models (mirror order_state staging→intermediate→mart exactly):**

- **Staging `stg_touchpoint_events` (view):** 1 row per journey Bronze event. Reads `source('bronze','bronze_touchpoint_src')`; extracts `brain_anon_id`, `session_id`, `utm.*`, `click_ids.*`, `referrer`, `landing_path` from `payload` via `get_json_string`. Dedup on `(brand_id, event_id)` (the Bronze idempotency key — `0016:36`). Drops rows with NULL `brain_anon_id` (counted). NO business logic.
- **Intermediate `int_touchpoint_sessionized` (view):** the 30-min inactivity sessionization fold.
  - **Grain in:** 1 row per journey event, ordered by `(brand_id, brain_anon_id, occurred_at)`.
  - **Session boundary:** a new session starts when `occurred_at - lag(occurred_at) over (partition by brand_id, brain_anon_id order by occurred_at) > interval 30 minute` OR `lag` is NULL. Sessions numbered by a running sum of the boundary flag → `session_seq`; `session_key = murmur_hash3_32(brand_id || brain_anon_id || session_seq)` (deterministic, replay-stable — same hashing primitive the Makefile already uses for the order fingerprint, Makefile:63).
  - **Channel derivation (deterministic, no model):** `channel` from a fixed precedence ladder — click_id present → paid (`fbclid`→meta, `gclid`→google, `ttclid`→tiktok); else `utm.medium` mapped (`cpc/ppc`→paid, `email`→email, `social`→organic_social, `referral`→referral); else referrer-host non-empty → referral; else → direct. The ladder is a `case` expression in SQL (a deterministic CASE, never a classifier).
  - **First/last-touch ordering:** `row_number() over (partition by brand_id, brain_anon_id order by occurred_at asc)` → `touch_seq`; `is_first_touch = (touch_seq = 1)`; `is_last_touch` = last by `occurred_at desc` per anon. UTM/source/medium/campaign/click-id are carried on each touch row.
- **Mart `silver_touchpoint` (StarRocks PRIMARY KEY upsert table):** the replay-stable projection. **GRAIN: 1 row per `(brand_id, brain_anon_id, touch_seq)`** — every touch in order, with first/last flags and session linkage. (Per-touch grain — NOT one-row-per-session — because §4 needs both the first-touch mix AND the full timeline; a session-grain mart would lose the timeline. First/last are flags on this grain, not separate marts.)
  - **Keys/dist/order:** `keys=['brand_id','brain_anon_id','touch_seq']`, `distributed_by=['brand_id','brain_anon_id']`, `order_by=['brand_id','brain_anon_id','touch_seq']`, `buckets=8`, `replication_num=1` — identical config block to `silver_order_state.sql:28-43`.
  - **Columns:** `brand_id, brain_anon_id, session_key, session_seq, touch_seq, is_first_touch (bool), is_last_touch (bool), occurred_at, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid, gclid, ttclid, referrer_host, landing_path, stitched_brain_id (nullable — joined from §3), event_type, updated_at`. **No money column** (touchpoints are not monetary); counts are derived non-additively in the engine (§4), never stored.
  - **Replay-safe:** pure ordering over append-only Bronze + the deterministic session/touch numbering → re-run yields identical rows. Proven by §5 verify.

> ASSUMPTION: SDK `session_id` exists on rows but we **re-derive** the 30-min window in dbt rather than trust the client-stamped `session_id`, so Silver is reproducible-from-Bronze independent of client clock skew. We carry the raw `session_id` as a column for cross-check but key sessions on the server-derived `session_key`.

---

## §3 — Deterministic cart-stitch map (additive migration `0031`)

**THE design (mirrors `connector_razorpay_order_map`, `0027:86-113`):** a brand-scoped lookup table populated at order-webhook time, projecting the anon journey key onto the known order/brain_id. **Deterministic — reads `brain_anon_id` BACK from the order payload; NEVER infers (D-5).**

**Migration `db/migrations/0031_connector_journey_stitch_map.sql`** (next number after 0030; the Silver tier consumed none):
```
CREATE TABLE IF NOT EXISTS connector_journey_stitch_map (
  brand_id          UUID  NOT NULL,            -- RLS anchor (I-S01)
  order_id          TEXT  NOT NULL,            -- Brain ledger spine key (= ledger.order_id)
  stitched_anon_id  TEXT  NOT NULL,            -- brain_anon_id read BACK from the order (deterministic)
  brain_id          UUID  NULL,                -- resolved known identity (from identity graph)
  click_ids         JSONB NULL,                -- {fbclid,gclid,ttclid} captured at order time
  utms              JSONB NULL,                -- {source,medium,campaign,term,content}
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, order_id)             -- tenant-first composite PK (idempotent upsert)
);
```
- **RLS:** ENABLE + FORCE + the NN-1 two-arg `PERMISSIVE FOR ALL TO brain_app USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)` policy verbatim, plus the NN-1 assertion DO-block and a FORCE-RLS post-migration assertion (copy `0027:103-113,389-455`). Grants: `SELECT, INSERT, UPDATE` (upsert on webhook re-delivery — a lookup table, not append-only).
- **Index:** `(brand_id, stitched_anon_id)` for the §2 mart join.
- **Populated by:** the existing Shopify webhook handler (`apps/core/.../shopifyWebhookHandler.ts:3` — step 3 "Parse order → map via @brain/shopify-mapper") + `@brain/shopify-mapper`. The mapper (`packages/shopify-mapper/src/index.ts:30`) gains a deterministic projection: read `brain_anon_id` / utm / click_ids from the Shopify order's `note_attributes` (the storefront pixel writes them at checkout) and surface them on `OrderProperties`. The webhook handler, AFTER brand resolution (under the brand GUC), upserts `connector_journey_stitch_map` by `(brand_id, order_id)`. **Idempotent** (PK upsert) → webhook replay produces no new rows (I-ST04).
- **brain_id read-back:** when `note_attributes.brain_anon_id` is present, the handler resolves the known `brain_id` via the existing identity read path (deterministic alias lookup — `feat-identity-graph`); NO probabilistic merge. NULL `brain_id` is honest (anon not yet linked).
- **Silver join:** `silver_touchpoint.stitched_brain_id` is a LEFT JOIN in the mart from `bronze_touchpoint_src`-derived `brain_anon_id` → `connector_journey_stitch_map.stitched_anon_id` (read into Silver via the SAME JDBC catalog + a uuid→text entry on the existing/extended read-shim). Anon journeys with no order stay un-stitched (NULL) — that IS the stitch-hit-rate denominator (§4).

> ASSUMPTION: the storefront pixel forwards `brain_anon_id` (+ utm/click_ids) into Shopify checkout `note_attributes` so the order webhook can read them back. If a given dev order lacks them (the 94 real events are page-views, not orders), stitch coverage is honestly low → §5 synthetic fixtures supply matched anon↔order pairs for a richer demo, CLEARLY labelled. We never fabricate a stitch.

---

## §4 — metric-engine journey seam + BFF + UI

**Three non-additive reads over `silver.touchpoint`, in the metric-engine (ADR-004), through `withSilverBrand` (the sole reader, I-ST01).** New file `packages/metric-engine/src/journey-mix.ts` (sibling of `order-status-mix.ts`), each fn using `scope.runScoped` with `${BRAND_PREDICATE}` exactly as `order-status-mix.ts:131-142`:

1. **`computeFirstTouchMix(brandId, deps, range)`** — COUNT + integer-basis-point share of journeys by `channel` WHERE `is_first_touch` over `[from,to]`. Reuses the `ratePct` integer-share helper (`order-status-mix.ts:86-93`) — no float. Honest `hasData=false` on zero rows.
2. **`computeStitchHitRate(brandId, deps, range)`** — `stitched = COUNT(DISTINCT brain_anon_id) WHERE stitched_brain_id IS NOT NULL`; `total = COUNT(DISTINCT brain_anon_id)`; `hitPct = ratePct(stitched, total)`. Integer math; honest no_data.
3. **`computeTouchpointTimeline(brandId, deps, orderId|brainAnonId)`** — ordered touch rows (`touch_seq` asc) for one journey: `channel, utm_*, click_ids, occurred_at, is_first/last_touch`. A read projection (no aggregation), still through the seam.

**Registry:** add `'journey_first_touch_mix' | 'journey_stitch_rate' | 'journey_timeline'` to the `MetricId` union (`registry.ts:16-24`) and a `readSeam` value `'silver_touchpoint'` (`registry.ts:31-45`), with three `METRIC_REGISTRY` entries mirroring the `order_status_mix` block (`registry.ts:182-204`): `recognitionLabels: []`, `toleranceMinor: 0`, descriptions noting non-additive-in-engine + seam-scoped + sole-emitter. Update `registry.test.ts` coverage.

**metric-engine `index.ts`:** export the three compute fns + their types (mirror `index.ts:62-76`).

**BFF (`apps/core/src/modules/frontend-api/internal/bff.routes.ts`):** three routes mirroring the order-status-mix route (`bff.routes.ts:1787-1838`) — `GET /api/v1/analytics/journey/first-touch-mix?from&to`, `/journey/stitch-rate?from&to`, `/journey/timeline?orderId=`. Each: brandId from session (D-1, never body); call the analytics use-case (NOT raw SQL); 404/empty → honest no_data; `data_source` passed through (`'synthetic'` when the journey is fixture-backed — §5). Uses the already-wired `srPool` (`main.ts:347-360`, `bff.routes.ts:77`).

**analytics use-cases (`apps/core/src/modules/analytics/internal/application/queries/`):** `get-journey-first-touch-mix.ts`, `get-journey-stitch-rate.ts`, `get-journey-timeline.ts` — thin wrappers (mirror `get-order-status-mix.ts`), bigint→string serialization, honest discriminated-union result, `data_source` flag. Export from `analytics/index.ts` (mirror the order-status-mix exports block).

**UI (every build ships a stakeholder-visible surface):** new route `apps/web/app/(dashboard)/analytics/journey/page.tsx` + `journey-content.tsx` (mirror `analytics/order-status/`), with: a first-touch channel-mix chart (`components/analytics/first-touch-mix-chart.tsx`), a stitch-hit-rate KPI card, and a touchpoint-timeline list for a selected order. Honest empty/loading/error states + a **"Synthetic (dev)"** badge on any panel whose `data_source==='synthetic'` (reuse the existing badge pattern from the order-status surface). Add the nav entry in `apps/web/app/(dashboard)/layout.tsx`. Wire `apps/web/lib/api/client.ts` + `types.ts` + `lib/hooks/use-analytics.ts` (mirror the order-status hook).

---

## §5 — Per-brand isolation proof (non-inert) + synthetic-fixture dev boundary

**Isolation proof (the part that matters):** add `tools/isolation-fuzz/src/silver-touchpoint.test.ts`, a near-copy of `silver-order-state.test.ts`:
- Seeds one brand-A + one brand-B `silver.touchpoint` row (throwaway brand-ids), exercising the REAL `withSilverBrand` seam imported from `@brain/metric-engine` (what passes is what ships).
- **[positive]** `withSilverBrand(brandA)` returns ONLY brand-A touchpoints, zero brand-B.
- **[mutation / NON-INERT proof]** the SAME seam with `__unsafeDisableBrandPredicate: true` MUST leak brand-B rows; if it does not, the predicate was inert → the test FAILS LOUD (`silver-deps.ts:118-126` is the mechanism). This is the exact R1/M-01 demand.
- PENDs (visibly skipped, never silently green) when StarRocks/the mart is unreachable.

Because the journey reads go through the SAME `withSilverBrand` seam as order_state, the isolation guarantee is structural — a caller cannot forget the predicate (it's substituted at the seam from `${BRAND_PREDICATE}`). **Prod graduation:** apply `db/starrocks/row_policy_template.sql` to `silver_touchpoint` on a managed cluster; the seam predicate becomes defense-in-depth.

**Synthetic-fixture dev boundary (dev-honesty):**
- **Real path proven first:** the dbt mart MUST build from the 94 real `page.viewed` events (thin but real) — `make journey-build` + the replay-verify must pass on real Bronze before any fixture is loaded.
- **Synthetic enrichment, clearly labelled:** a fixture loader `db/dbt/seeds/journey_synthetic_fixtures.sql` (or a `tools/` seed script) inserts CLEARLY-LABELLED synthetic `bronze_events` (a flagged `payload.properties._synthetic=true`) forming richer multi-touch journeys + matched order/anon pairs (so stitch-hit-rate is demoable). Every metric-engine result carries `data_source='synthetic'` whenever the window includes fixture rows; the UI badges it. Coverage (real vs synthetic touch count) is surfaced honestly on the journey page. **Never fake coverage** — the synthetic flag rides through to the UI.

**Replay-idempotency proof:** add `make journey-verify` (mirror `silver-verify`, Makefile:65-77) — run dbt TWICE, diff a content fingerprint over `silver.touchpoint` (`murmur_hash3_32` of the stable columns), assert byte-identical. Plus dbt tests `db/dbt/tests/assert_touchpoint_grain.sql` (1 row per `(brand_id,brain_anon_id,touch_seq)`), `assert_touchpoint_replay.sql`, `assert_touchpoint_no_money.sql` (no float/money column smuggled in) — mirror `tests/assert_order_state_*.sql`.

---

## The 3 tracks (exact file targets)

### Track 1 — @data-engineer (the `silver.touchpoint` mart + stitch map + isolation/replay)
**Acceptance contract (REQUIRED pass-1):** real-Bronze build green BEFORE fixtures; `make journey-verify` byte-identical (replay-idempotent); deterministic stitch (read-back only, no inference); RLS NN-1 + FORCE assertions on `0031`; isolation-fuzz mutation test leaks brand-B when predicate disabled (non-inert); no money/float column in the mart; dev-honesty `_synthetic` flag rides to the mart.
- `db/migrations/0031_connector_journey_stitch_map.sql` (RLS ENABLE+FORCE, NN-1 policy + assertion, FORCE assert, grants S/I/U, index)
- `db/starrocks/bronze_touchpoint_src.sql` (uuid→text + JSONB read-shim view; no migration number)
- extend `db/starrocks/oltp_pg_read_shim.sql` OR a sibling view for `connector_journey_stitch_map` (uuid→text)
- `db/dbt/models/staging/stg_touchpoint_events.sql` + `_sources.yml` (add `bronze` source: `bronze_touchpoint_src`, `connector_journey_stitch_map`)
- `db/dbt/models/intermediate/int_touchpoint_sessionized.sql` (30-min window, session_key, channel ladder, first/last-touch)
- `db/dbt/models/marts/silver_touchpoint.sql` + `_silver_touchpoint.yml` (PRIMARY KEY upsert table, per-touch grain)
- `db/dbt/tests/assert_touchpoint_grain.sql`, `assert_touchpoint_replay.sql`, `assert_touchpoint_no_money.sql`
- `Makefile` — add `journey-catalog` / `journey-run` / `journey-build` / `journey-verify` (mirror `silver-*`)
- `db/dbt/seeds/journey_synthetic_fixtures.sql` (clearly-labelled synthetic; loaded only after real build proven)
- `tools/isolation-fuzz/src/silver-touchpoint.test.ts` (positive + NON-INERT mutation)
- `packages/shopify-mapper/src/index.ts` (project `brain_anon_id`/utm/click_ids from `note_attributes` onto `OrderProperties` — deterministic)
- `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts` (upsert `connector_journey_stitch_map` under brand GUC, idempotent by `(brand_id,order_id)`)

### Track 2 — @backend-developer (the metric-engine journey seam + BFF + use-cases)
**Acceptance contract (REQUIRED pass-1):** all three reads through `withSilverBrand` (`${BRAND_PREDICATE}`, never a hand-written brand filter); integer basis-point share (`ratePct`) — no float; honest `no_data` discriminant; brandId from session (D-1); registry entries + `registry.test.ts` green; `data_source` flag plumbed; bigint→string serialization.
- `packages/metric-engine/src/journey-mix.ts` (`computeFirstTouchMix`, `computeStitchHitRate`, `computeTouchpointTimeline`)
- `packages/metric-engine/src/journey-mix.test.ts`
- `packages/metric-engine/src/registry.ts` (MetricId union +3, readSeam `'silver_touchpoint'`, 3 entries) + `registry.test.ts`
- `packages/metric-engine/src/index.ts` (export the 3 fns + types)
- `apps/core/src/modules/analytics/internal/application/queries/get-journey-first-touch-mix.ts`, `get-journey-stitch-rate.ts`, `get-journey-timeline.ts`
- `apps/core/src/modules/analytics/index.ts` (export the 3 use-cases + types)
- `apps/core/src/modules/frontend-api/internal/bff.routes.ts` (3 journey routes mirroring `:1787-1838`, session brandId, no raw SQL, `data_source`)

### Track 3 — @frontend-web-developer (the journey/first-touch UI)
**Acceptance contract (REQUIRED pass-1):** never queries StarRocks (BFF only, I-ST01); honest empty/loading/error states; **"Synthetic (dev)" badge** on `data_source==='synthetic'` panels; mobile-responsive; nav entry added.
- `apps/web/app/(dashboard)/analytics/journey/page.tsx` + `journey-content.tsx`
- `apps/web/components/analytics/first-touch-mix-chart.tsx`, `stitch-rate-card.tsx`, `touchpoint-timeline.tsx`
- `apps/web/lib/api/client.ts` + `types.ts` (3 journey response types) + `lib/hooks/use-analytics.ts` (3 hooks)
- `apps/web/app/(dashboard)/layout.tsx` (nav entry "Journey")

---

## Alternatives considered + rejection
- **Stream-worker sessionization** (the roadmap note) — REJECTED for now: a second Silver lineage, harder replay-identity, a new consumer/state store (I-E05 surface). Documented as a scale-graduation trigger (§2). Reversible: the mart shape is identical, so streaming can later write the same table behind a parity oracle.
- **Postgres-OLTP `touchpoint` table** — REJECTED (requirement + roadmap): touchpoints are derived analytics, not OLTP truth → belongs in Silver, not a transactional table.
- **Journey microservice** — REJECTED (I-E05, no new deployable): the attribution module owns `silver.touchpoint` as a derived layer; the seam lives in the existing metric-engine.
- **Probabilistic / ML / fuzzy stitch** — REJECTED (D-5): cart-stitch reads `brain_anon_id` BACK from the order; deterministic only.
- **Session-grain mart (one row per session)** — REJECTED: loses the per-touch timeline §4 needs; first/last are flags on the per-touch grain instead.

## Cost estimate
Tier-0 deterministic: **0 tokens/day, $0/mo incremental model spend.** Marginal compute = one additional dbt mart on the existing cron (seconds at 94+fixture rows) + three integer aggregations per dashboard load through the existing srPool. No new infra, no new deployable, no new topic.

## Over-engineering self-check: PASS
Two new dbt models + one mart + one additive migration + one metric file (3 fns) + 3 thin use-cases/routes + one UI page — all clones of shipped patterns. No new primitive, no new service, no new envelope. Single-Primitive sweep CLEAN: extends the Silver mart pattern, the `withSilverBrand` seam, the `connector_*_order_map` pattern, and the analytics BFF/UI chain — nothing forked.
