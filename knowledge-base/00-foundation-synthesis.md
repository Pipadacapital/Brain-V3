# 00 — Foundation Synthesis (Phase 0)

Program: Commerce-OS (PLAN-OF-RECORD.md). Branch: `feat/commerce-os-program`.
Synthesized 2026-07-06 from six ground-truth recon reports (code + LIVE Trino :8090, Apicurio :8080, Neo4j, Redis, Kafka, PG — verified 2026-07-05/06).
Ground-truth hierarchy applied per §0.3: code > live metadata > tests > docs/spec. Every claim below carries file:line or live-metadata evidence. "File exists" ≠ "served live" — drift is flagged wherever found.

---

## 1. Monorepo layout

- pnpm workspace: `apps/*`, `packages/*`, `tools/*` (`pnpm-workspace.yaml`). Turbo tasks: `build`, `typecheck`, `lint`, `test:unit|contract|isolation|parity`, `gen:contracts` (`turbo.json`). **NOTE:** the spec's gate command `pnpm turbo build lint test` (§0.2) does not match actual task names — there is no `test` task.
- **Apps:**
  - `apps/collector` — Fastify edge ingest (`/collect` → Kafka) + serves `/pixel.js`.
  - `apps/core` — modular-monolith Fastify app/BFF: auth, tenancy, connectors, frontend-api (17 route files), identity queries, Trino serving, AI/ask, recommendation/decisions.
  - `apps/stream-worker` — Kafka consumers: identity resolution → Neo4j, journey stitch cron, webhook pipelines, finalization, erasure orchestrator, cache invalidation.
  - `apps/web` — Next.js dashboard.
- **Packages** (26): ad-spend-mapper, ai-gateway-client, attribution-writer, audit, config, connector-core, connector-secrets, contracts, db, events, ga4/gokwik/razorpay/shiprocket/shopflo/shopify/woocommerce-mapper, identity-core, logistics-status, metric-engine, money, observability, pii-vault, pixel-sdk, tenant-context.
- **Tools:** data-quality, isolation-fuzz, parity-oracle, pixel-fixture, seed, load-test (k6), lint (v4-naming-guard, serving-pii-guard).
- **Absent (spec assumes them):** NO `analytics-gateway` (removed 2026-06-28 cleanup, PR #295), NO `platform-flags` (prior feature-flags layer deliberately removed same cleanup), NO `identity-normalization`, NO `semantic-metrics`, NO `testing-golden`, NO `domain-journey`, NO `domain-measurement`, NO `decision-policies`, NO `ai-features`.

## 2. Universal Pixel

- **Two artifacts, manually kept in lock-step.** The served `/pixel.js` is a hand-maintained ~490-line IIFE embedded as `const PIXEL_JS` in `apps/collector/src/interfaces/rest/pixel-asset.route.ts` (routes `/pixel.js` + `/pixel.v0.1.0.js`; header lines 4–6 state it is "CONTRACT-equivalent to @brain/pixel-sdk (NOT yet a literal build artifact)"). `packages/pixel-sdk` is the injectable/testable SDK core — it is NOT what ships, and it lacks `identify`, first-touch persistence, and all auto-instrumentation (`capture.ts` Pixel interface lines 77–102).
- **Public API** `window.brain` (pixel-asset.route.ts:296–318): page, cartItemAdded/Removed/Updated, cartViewed, checkoutStarted, checkoutStep, shippingSelected, paymentInitiated/Succeeded/Failed, orderPlaced, couponApplied, login, signup, identify, track, flush.
- **`brain.identify(traits)` EXISTS** (pixel-asset.route.ts:284–294): email-only, trim+lowercase, **PLAIN UNSALTED SHA-256** via crypto.subtle, emits event_name `identify` with `{hashed_customer_email}`. Dedupe is per-page in-memory (`_identified` object), not sessionStorage.
- **Auto email bridge**: capture-phase form-**submit** listener (lines 394–412) — any submitted form with an email input fires identify. No MutationObserver, no blur detection, no tel/phone capture, and it deliberately reads emails on login forms containing password fields (spec A.1.1 explicitly forbids this).
- **Storage:** localStorage `__brain_anon_id`, `__brain_session` (30-min rolling), `__brain_queue` (max 200, keep-critical eviction + `pixel.dropped` loss marker), `__brain_first_touch`. sessionStorage unused.
- **Downstream:** `apps/stream-worker/src/domain/identity/extract-identifiers.ts:91,199` accepts `hashed_customer_email` as type `pre_hashed_email`, tier=strong, `preHashed:true` (no salt).
- **LIVE HASH-DRIFT BUG:** the pixel bridge comment claims its unsalted hash matches the connectors' `hashed_customer_email` — but `shopify-mapper/index.ts:420` SALTS that field. Pixel identify pre_hashed_email can NEVER equal a connector order hash → the anon→known bridge is silently broken today.

## 3. Consent

- Client `consent()` (pixel-asset.route.ts:142–164): `window.__brainConsent` → Shopify customerPrivacy API → `PIXEL_CONSENT_DEFAULT=granted` env fallback (collector-wide, injected into asset bootstrap at :552) → null. `consent_flags = {analytics, marketing, personalization, ai_processing}`. `packages/pixel-sdk/src/consent.ts` = fail-safe-absent.
- Server enforcement: Silver R3 gate (`db/iceberg/spark/silver/silver_collector_event.py:224–243`) quarantines pixel events with **ABSENT** consent_flags into `brain_silver.silver_consent_rejected` (`_silver_technical.py:567–613`, replayable). **PRESENCE-ONLY: `analytics:false` still passes.** No IAB TCF `__tcfapi`. No per-brand consent config anywhere — `tenancy.brand` has no consent columns.
- Shipped posture is capture-with-quarantine + env default-granted, NOT spec's per-brand default-OFF. Flipping naïvely would zero out pixel data for existing installs.

## 4. Normalization & hashing (three conventions, not one)

1. **Per-brand SALTED** (canonical connector-side): `packages/identity-core/src/index.ts` — `normalizeIdentifier` (:180; email trim+lowercase :186, **no NFC**; phone via custom regex `normalizePhone` :126, `REGION_PREFIX` :107–110 contains **ONLY `IN:'+91'`** — no libphonenumber anywhere in repo); `hashIdentifier` (:219–227) = `sha256(perBrandSalt + '||' + normalized)`. Salt: prod = `tenancy.brand_identity_salt` KMS ciphertext via pii-vault BrandSaltProvider; dev = deterministic `resolveDevSaltHex(brandId)` (conformance vector pinned in dev-salt.test.ts; cross-brand-uncorrelatability is a tested invariant, D-2).
2. **UNSALTED plain SHA-256**: pixel identify bridge client-side (pixel-asset.route.ts:270–295), accepted downstream as distinct `pre_hashed_email` tier.
3. **`hash_salted_bytes`** (hex-byte salt, no separator): AWB/Razorpay/UTR (`db/iceberg/spark/silver/_raw_normalize.py`).
- **Python twin:** `_raw_normalize.py:120–161` — `normalize_email` / `normalize_phone_in` (hardcodes +91) / `hash_identifier(salt_hex||'||'||normalized)`, docstrings state they mirror identity-core.
- **Cross-language tests:** `db/iceberg/spark/silver/_p4_golden/test_{shopify,shopflo,woocommerce,shiprocket}_golden.py` replay TS-captured golden vectors byte-for-byte through the Python ports — fixture-based, NOT property-based.
- Gmail dots/plus: repo does NOT strip — matches spec ADR.

## 5. Connectors — identity fields today

All four mappers extract + hash email/phone at the boundary via salted `hashIdentifier`, raw dropped:
- **Shopify:** `packages/shopify-mapper/src/index.ts:412–446` (orders → `hashed_customer_email`/`hashed_customer_phone`/`storefront_customer_id`); `resources.ts:200–221` (customer.upsert → shopify_customer_id + hashes). Spark twin `silver_shopify_order_normalize.py:74–123` (same salted hash, salts from PG broadcast join).
- **WooCommerce:** `woocommerce-mapper/src/index.ts:313–389`; Spark twin `silver_woocommerce_normalize.py:164–166`.
- **Shopflo:** `shopflo-mapper/src/index.ts:255–288` (checkout_abandoned → **legacy names** `customer_email_hash`/`customer_phone_hash`), 393–401/503–505/715 (orders → standard names + storefront_customer_id), **417–429 emits `checkout_session_id`** (only connector that does).
- **GoKwik:** `gokwik-mapper/src/index.ts:145–155` (hash helpers), 466–468 (order.live.v1), 536–538 (checkout events). `CHECKOUT_ID_KEYS` (:89) feeds only event_id/order_id fallback — **NO checkout_session_id property emitted**. Phone-first (India COD).
- **Canonical slot unused:** `packages/connector-core/src/contracts/CanonicalEvent.ts` defines `pre_hashed_identifiers?` (documented as unsalted 64-hex, separate namespace) — populated by ZERO mappers; resolver reads both, canonical wins (extract-identifiers.ts:91–100).
- **Resolver consumption** (extract-identifiers.ts:61–130): `hashed_customer_email|customer_email_hash`, `hashed_customer_phone|customer_phone_hash` (preHashed strong tier), `customer_id|storefront_customer_id`, `brain_anon_id`, `device_id`, weak signals (cookie/ip/fingerprint/session_id). `checkout_session_id` is NOT an identity key anywhere.

## 6. Identity domain

### 6.1 Identity Bridge (resolver pipeline)
`apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` (subscribes the **Bronze collector topic** `dev.collector.event.v1`, :53) → `application/ResolveIdentityUseCase.ts` (extract→normalize→salt-hash→resolve→Neo4j write, commit-after-write) → `domain/identity/IdentityResolver.ts` (pure union-find: 0 match=mint, 1=link, ≥2 strong=merge, canonical=**LOWEST-UUID** :286–288, cycle-guard→review) → `infrastructure/neo4j/Neo4jIdentityRepository.ts` (writeOutcome :291–380).
- Identifier model is **TIERED, hard-coded, identical for all brands** (IdentityResolver.ts:137–230): strong (email, phone, pre_hashed_*, storefront_customer_id) merge keys; medium (device_id, anon_id) resolve-only, discarded if ambiguous (:225–229 — never-silent-overwrite honored); weak → ProbabilisticMatcher only. Per-brand config exists ONLY for phone-guard (threshold + suppression window, :78–81). **NO ordered per-brand identity priority, no priority versioning.**
- Real-time upsert IS live (stream-worker running, IdentityBridgeConsumer wired at main.ts:343). No ≤50ms p99 benchmark exists.

### 6.2 Live Neo4j graph (NOT the spec's model)
`(:Identifier {brand_id,type,hash})` **15,105** (pre_hashed_email 9,595; pre_hashed_phone 1,667; storefront_customer_id 1,580; session_id 1,244; anon_id 1,019) `-[:IDENTIFIES {tier,is_active,created_at,+confidence/matcher/rule_version}]->` `(:Customer {brand_id,brain_id,lifecycle_state,first_identified_at,created_at,resolution_consent,ai_processing_consent[,merged_into]})` **3,787**; IDENTIFIES 15,128; `ALIAS_OF {merge_id,valid_from,valid_to,rule_version}` 11; `(:MergeEvent)` 3; `(:MergeReview)` 20 (12 pending/8 merged). **No `(:BrainId)`, no `OBSERVED_WITH {first_seen,last_seen,source,count}`** — no last_seen/count anywhere (grep Neo4jIdentityRepository.ts = 0).

### 6.3 silver_identity_map — LIVE schema verbatim (Trino DESCRIBE iceberg.brain_silver.silver_identity_map)
```
brand_id              varchar
identifier_hash       varchar
identifier_type       varchar
brain_id              varchar
customer_ref          varchar
confidence            double
effective_from        timestamp(6) with time zone
effective_to          timestamp(6) with time zone
replaced_by_brain_id  varchar
merge_event_id        varchar
is_current            boolean
updated_at            timestamp(6) with time zone
```
14,902 rows (14,886 current / 16 superseded). **VALID-TIME ONLY — no system-time pair.** It is a deterministic batch PROJECTION of Neo4j (`db/iceberg/spark/silver/silver_identity_map.py`, MERGE on (brand_id, identifier_hash, brain_id, effective_from)), rebuilt per run — not per-write bi-temporal appends; as-of(T_system) is unanswerable. `db/trino/views/mv_silver_identity_map.sql` = thin all-intervals projection, zero app callers. **`identity_current_v` / `identity_asof` DO NOT EXIST** (closest: `silver_identity_alias`, `_je_identity_{conf,asof}` temp views inside gold_journey_events.py:146–182, `_snap_as_of.py as_of_sql()` over snap_identity_link).

### 6.4 ops.silver_identity_link (PG) — the load-bearing projection
`(brand_id uuid, identifier_type, identifier_value, brain_id uuid, tier, is_active, updated_at; PK brand+type+value)`, 14,837 rows. Writer: `apps/stream-worker/src/jobs/identity-export/run.ts` (Neo4j→PG, watermark + tombstone sweep + canonical-alias F2). **FOUR load-bearing readers:** `capi-source.query.ts:162` (CAPI), `journey-stitch-from-identity.ts:135`, `silver_order_state.py:138` (JDBC, order recognition), `gold_revenue_ledger.py:141` (JDBC). Spec calls it "legacy dual-written" — it is the PRIMARY projection.

### 6.5 Merge / unmerge machinery
- Merge: deterministic, audited — MergeEvent nodes + ALIAS_OF intervals (Neo4jIdentityRepository.ts:354–380) + append-only PG `audit.identity_audit` with reversible Command+inverse+evidence (`IdentityAuditDecisionLog.ts`; action CHECK mint|link|merge|unmerge|rebind|erase) + `identity.merged.v1` emitted. Survivor = lowest UUID (deterministic merge_id sha256-of-pair depends on it). No `actor` field.
- MergeReview queue live: Neo4j nodes; `GET/POST /api/v1/identity/merge-reviews[/resolve]` (`identity.routes.ts:326–373`); UI `/identity?tab=merge-review`. Input = probabilistic weak-signal reviews + cycle-guard conflicts.
- **Unmerge EXISTS end-to-end:** API route + `merge-admin.ts:82 unmergeCustomer` → `neo4j-identity-reader.ts:298` (closes ALIAS_OF valid_to, lifecycle 'split') + UI "Split (unmerge)" button (`customer-profile-content.tsx:329–333`). Emits NO event; triggers NO journey re-version restoration.

### 6.6 Stitch today
`apps/stream-worker/src/jobs/journey-stitch-from-identity.ts` — **Node cron, not Spark**: per brand, FULL-SCAN `DISTINCT brain_anon_id` from mv_silver_touchpoint (:110), hash, look up ops.silver_identity_link anon links, UNAMBIGUOUS-ONLY (:143–154), join mv_gold_revenue_ledger orders, upsert PG `connector_journey_stitch_map` at **ORDER grain**. Single-key (anon only). No silver_session_identity, no silver_stitch_conflicts (ambiguity only counted), no watermark, no 90-day recency rule (no last_seen exists to check).
- **Kafka identity lane (live topics):** `{dev,prod}.identity.{minted,linked,merged,suppressed,review_queued}.v1`. **`identity.map.changed.v1` does not exist.** `IdentityChangeRecomputeConsumer` consumes merged/suppressed → `ops.scoped_recompute_request` + `cache.invalidate.v1` — mart-scoped recompute, not identifier-keyed re-stitch.

### 6.7 Probabilistic layer
Rule-based review-gated matcher today: `ProbabilisticMatcher.ts` (matcher_id 'probabilistic-fellegi-sunter', weak signals, score capped sub-exact, **can never auto-merge** — routes to MergeReview). Quarantine-from-revenue holds by construction (writes no identity links). NO Splink (grep=0), no silver_probabilistic_stitch, no customer_sessions_extended_v, no model docs/holdout, no `estimated:true`.

### 6.8 Real-time touchpoint cache
Redis (brainv3-redis-1) dbsize=14: only serving analytics cache keys + connector-ratelimit. **ZERO `{brand}:tp:{brain}` keys; no touchpoint-cache consumer code** (grep tp:/touchpointCache = 0).

## 7. Journey domain

### 7.1 journey_events — LIVE schema verbatim (Trino DESCRIBE iceberg.brain_gold.journey_events; 6,743 rows; 3 snapshots, all 2026-07-05)
```
brand_id varchar, brain_id varchar, touchpoint_id varchar, source_event_ref varchar,
data_version integer, is_current boolean, sequence_number bigint,
occurred_at timestamp(6) wtz, session_key integer, event_category varchar,
event_type varchar, channel varchar, campaign varchar,
revenue_minor bigint, currency_code varchar, product_handles array(varchar),
attribution_signals map(varchar,varchar), identity_confidence double,
is_composite boolean, composite_order_key varchar,
ingested_at timestamptz, updated_at timestamptz,
brain_id_asof varchar, identity_confidence_asof double
```
**NO matched_via, NO identity_basis, NO journey_version** — versioning is PER-TOUCHPOINT `data_version` + `is_current`, PK (brand_id, touchpoint_id, data_version).
- Builder: `db/iceberg/spark/gold/gold_journey_events.py` — input `brain_silver.silver_touchpoint` (has stitched_brain_id, session_key/session_seq, utm_*/click-ids; NO matched_via); brain_id = COALESCE(stitched_brain_id, 'anonymous_'||anon) (:217); sequence_number ordered (occurred_at, touch_seq) (:268–271); idempotent MERGE; in-row DG-2 as-of pair from silver_identity_map intervals (:243–258).
- Re-versioning: `gold_journey_events_reversion.py` — **watermark-poll batch** (silver_job_watermark on silver_identity_map.updated_at, :166–171), detects merges (is_current=false AND replaced_by_brain_id NOT NULL, :174–178), resolves chains, flip-then-copy to data_version+1, crash-safe. NOT a Kafka consumer; merge-only (no unmerge/restitch); **no journey_version_log** (grep=0 repo-wide).

### 7.2 Journey APIs (apps/core frontend-api, brand from session)
- `GET /api/v1/analytics/journey/events?brainId=&cursor=&limit=` (analytics-journey.routes.ts:930) — current projection via `mv_journey_events_current` (WHERE is_current), keyset cursor on sequence_number (metric-engine/journey-events.ts), limit 1..100. No X-Journey-Version header, no matched_via/session_id/url_path/as_of.
- `GET /api/v1/analytics/journey/timeline?orderId=|anonId=` (:864) — order→anon via PG connector_journey_stitch_map; full journey, no lookback window, no identity_evidence.
- NO compare endpoint. **NO Redis cache on ANY journey route** — serving-ttl.ts has a 'journey' 15m tier but only insights_briefing maps to it; journey reads hit Trino directly.

### 7.3 Replay substrate
No as_of param/replayed flag/time-travel query anywhere in serving. Building blocks: in-row brain_id_asof pair, bi-temporal(valid) silver_identity_map intervals (never deleted), snap_identity_link + `_snap_as_of.as_of_sql` (proven by snap_identity_link_asof_test.py), full is_current=false version history in journey_events. **Snapshot retention kills time-travel:** `medallion_maintenance.py` SNAPSHOT_TTL_MS = 7 days, swept daily (v4-refresh-loop.sh:478); live journey_events has 3 snapshots spanning <1h.

## 8. Revenue ledger & attribution

- **Recognition rules (code-verified,** `db/iceberg/spark/gold/gold_revenue_ledger.py:284–315`): 6 signed-bigint events — `provisional_recognition` (+, every order at booking), `finalization` (+, PREPAID only, past per-brand `tenancy.brand.prepaid_recognition_horizon_days`, not refunded/voided/cancelled), `cod_delivery_confirmed` (+), `cod_rto_clawback` (−), `cancellation` (−), `refund` (−, refunded AND not cancelled). Deterministic `ledger_event_id = sha2(brand||order||event_type||economic_effective_at)`; idempotent MERGE. Note: "prepaid at capture" (spec C.1) is NOT the rule — it's a two-stage provisional/finalized model.
- **Attribution:** `gold_attribution_credit.py` reads `silver_touchpoint` directly (:120) + recognized basis finalization ∪ cod_delivery_confirmed (:73); unstitched = honestly UNATTRIBUTED. TS twin `reconcile-attribution.ts`. Attribution does NOT consume journey_events — the B.5.4 flag seam is the silver_touchpoint read in both drivers.
- **Reconciliation surfaces:** parity-oracle toleranceMinor=0n enforced (`tools/parity-oracle/src/parity.test.ts:250,258–263`); metric-engine attribution-reconciliation returns exact residual; DQ Bronze-vs-Kafka maxRowCountDelta=100 warn / freshness 2h error (`tools/data-quality/src/index.ts:85–125`). The 3-way reconcile (₹1,746,754,034 exact) is a one-off — NOT a repeatable harness.

## 9. Measurement baselines (Wave C ancestors)

Every planned fact table has a Silver-tier ancestor; none has the `gold_measurement_*` shape:
- **Refunds:** `silver_refund.py` (brand_id, event_id, refund_id, order_id, amount_minor, currency_code, reason, status, occurred_at, order_unresolved; Stage-2 timing gate). **LIVE: 0 rows — 100% of refund events quarantined** (84 rows, reason=refund_before_order) because `shopify-mapper/resources.ts:288` emits occurred_at=1970-01-01 (epoch-0 fallback). Gold exposure = ledger reversal only.
- **Settlements:** `silver_settlement.py` (amount/fee/tax_minor, settlement_id/at, utr/dispute hashes) from razorpay lane (manifest + mapper real, 2y backfill). LIVE 0 rows (razorpay never synced); `gold_settlement_summary` registry-enabled but **table absent live** (entity-incremental skips ensure_gold_table on empty source).
- **Fees:** only inside razorpay settlements (fee_minor+tax_minor) + pct-config `billing.cost_input` types. No per-order fee fact; no shopify/shopflo/gokwik fee capture.
- **Costs:** NO cost facts anywhere. shiprocket-mapper has zero freight fields; silver_shipment has no money columns; product.upsert has NO cost field (resources.ts:85 = price_minor + inventory_quantity). Config seam only: `billing.cost_input` (0055; scope global|sku|category, amount_minor|pct_bps, effective_from/to) + POST /api/v1/costs — LIVE 0 rows. No CSV ingest, no gold_product_costs.
- **Spend:** `silver_marketing_spend.py` — canonical grain exists (PK (brand_id, spend_event_id), stat_date/platform/campaign_id/spend_minor/currency + enrichment). **LIVE 30,482 rows**, served (mv_silver_marketing_spend), consumed by gold_cac/campaign marts + metric-engine ROAS.
- **Inventory:** `silver_inventory_level.py` (point-in-time levels, not movements). LIVE 0 rows despite 7 product.upsert.v1 events, no quarantine — unexplained gap.
- **Contribution margin:** `gold_contribution_margin.py` LIVE (14 rows incl. BHD/KWD/OMR) but brand×currency LIFETIME totals from pct_bps config, not per-order. **Naming collision:** today's CM1 = revenue−COGS−variable (= spec CM2); today's CM2 = CM1−marketing (= spec CM3). Twin TS compute `metric-engine/contribution-margin.ts` is the SERVED path (Gold mart's mv was pruned — zero readers). Data smell: one brand cm2 = −1,488,422,342 (lifetime marketing > revenue).
- **New-customer:** NO per-order is_new_customer anywhere. Customer-grain ingredients: `silver_customer.py:78–79` first_seen_at/first_identified_at (from Neo4j export — 2,718 Customer nodes; PG identity schema dropped by 0101).
- **Money:** `packages/money/src/index.ts:33–42` — BHD/KWD/OMR/IQD/JOD/LYD/TND=3, JPY-class=0, CLF/UYW=4; roundToMinorBankers returns adjustment_minor; tests lock KWD=3 / 'KWD 12.500'. **§1.2 already satisfied.**
- **Order lifecycle:** silver_order_state.py:283–345 recognition→lifecycle fold (placed/confirmed/delivered/cancelled/rto/refunded, is_terminal). No economics_state, no settlement linkage.

## 10. Serving / gateway / caching

- **"Analytics Gateway" = a documented SEAM, not a service** (ADR-0007, Accepted 2026-06-28): apps/core frontend-api routes → `cachedRead` → `ServingCacheReader` (metric-engine/serving-cache.ts) → Redis cache-aside (analytics-cache.ts; 2-layer stampede guard: in-process inFlight + Redis SET-NX `${key}:lock` :15–22,115) → on miss `withTrinoBrand` (trino-deps.ts) with fail-closed `${BRAND_PREDICATE}` → `trino-adapter.ts` (the ONLY Trino talker) → `iceberg.brain_serving.mv_*`.
- Cache key: `${brandId}:${metricId}:${paramsHash16}:${servingVersion}` (brand-leading; sorted-key sha256/16). TTL tiers (serving-ttl.ts:26–72): executive 5m, attribution 10m, journey 15m, product 30m, analytics_long 60m; unmapped → TRINO_SERVING_CACHE_TTL_MS 300s. Invalidation: `cache.invalidate.v1` → AnalyticsCacheInvalidateConsumer → brand-scoped SCAN `${brandId}:*` (bare `*` refused). **Superset of spec §1.11.2** (which asks `{brand}:q:{hash}` + 3 classes) — adopting spec verbatim would regress.
- **Gaps:** NO per-brand Trino concurrency gate (grep semaphore/p-limit in trino-adapter/deps = 0); crypto-shred does NOT invalidate cache (ErasureOrchestrator never publishes cache.invalidate); no realtime/no-cache tier.
- **Pre-aggs:** Gold marts ARE the pre-aggs (Spark Iceberg, refresh loop); mv_* are projection-only; no interactive:/slow: flags in any registry.
- **View drift:** 46 view SQL files in db/trino/views, only **39 live** in iceberg.brain_serving.
- **Metric registry (proto-D.2):** compile-time TS METRIC_REGISTRY, **22 metric ids** (registry.ts:116 — realized_revenue…cohort_retention; each {readSeam, recognitionLabels, toleranceMinor, description}); METRIC_ID_ENUM auto-derived (resolver-schema.ts:27 — code comments stale at "16"). query-route.ts: routeKnownMetric → cache_hit|trino_serving; routeAiAdHocTrino throws NotImplementedYet.
- **Semantic layer:** nothing named semantic_*; knowledge-base/{semantic,contracts,gates,amendments,models,privacy} all EMPTY. Proto-entities live: mv_gold_customer_360, mv_journey_events_current/journey_timeline, mv_gold_product_detail, mv_gold_campaign_performance/attribution + mv_silver_marketing_spend, mv_silver_order_state/order_line.

## 11. MCP / LiteLLM / flags / AI

- **MCP:** 11 read-only tools (2 NLQ: list_metrics, resolve_and_compute + 9 lookups), SoT `packages/ai-gateway-client/src/mcp-tools.ts:76–191`, brand_id from principal never input, CI gate writeToolCount===0 (`tools/isolation-fuzz/src/mcp.test.ts`), mounted via `dispatch-wiring.ts` over metric-engine seams. Tools reach Trino TRANSITIVELY (ai-gateway-client's sole dep IS @brain/metric-engine, which contains trino-adapter.ts) → CONTRACT-F's literal "no Trino client dependency" test would fail today; the real enforced invariant is "no SQL emission, certified seams only".
- **LiteLLM:** `infra/litellm.config.yaml` is essentially F.1 pre-built (small/large model aliases, cost routing, per-tenant virtual keys w/ monthly budgets, otel) — but the compose service is **COMMENTED OUT** (docker-compose.yml:194–223, "DISABLED 2026-07-02", opt-in `ai` profile); no container runs. Client seam intact (`ai-gateway-client/src/client.ts`, fail-closed, 256-token budget). No `ops_llm_calls` — closest is PG `ai_provenance` (append-only; NO tokens/cost columns).
- **BAI:** POST /api/v1/ask → askBrain → metric-engine sole read path — BAI and dashboards already share one chokepoint for the 22 certified metrics. Prompt = `prompt-registry/resolver-prompt.ts` (git-backed TS; no prompts/ dir). NLQ golden: `ai/evaluation/golden-set.json` (1 file).
- **Flags:** NO flag system. Only static env booleans (config/core.ts:39 CAPI_PASSBACK_ENABLED, :77/:87 TRINO_*_CACHE_ENABLED; stream-worker.ts:111 BRONZE_PG_WRITE_ENABLED; BRONZE_SOURCE). Prior feature-flags layer deliberately REMOVED (#295). Any new `{brand_id}:flag:*` keys must use the sanctioned key builder (no-raw-redis-key ESLint rule).
- **Recommendation/decision substrate (pre-G/H):** apps/core/modules/recommendation (detectors registry, confidence-gate, outcomes), recommendation_action ledger (0082), decisions.routes.ts Morning Brief + append-only decision_log — a WORKING recommend-only surface. Zero hits: gold_recommendations, gold_decisions, action.requested, execution_mode, decision-policies, /v1/features, `{brand}:feat:`.
- **gold_ai_features:** exists in CODE (gold_ai_features.py + mv sql + ai-features.ts read seam) but **absent live** (no Iceberg table, view unapplied, not in refresh loop); shape is WIDE current-state, not spec's EAV point-in-time. Conflicts with the CI-enforced "features are RUNTIME" invariant (CLAUDE.md, v4-naming-guard).

## 12. Privacy / crypto-shred

- `packages/pii-vault`: per-brand AND per-subject DEK (subject_keyring; KMS prod; invalidate() hook).
- `EraseSubjectUseCase.ts` 6-step ordered orchestrator: DEK shred (SECURITY DEFINER shred_subject_keyring 0115) + erase_contact_pii_for_customer (0100), surrogate brain_id tombstone, scoped Gold re-projection, **step 4 Iceberg snapshot compaction = REGISTERED-DISABLED NotImplementedYet** (shredded subjects resurrectable from old snapshots; explicitly documented "Do NOT claim I-S05 conformance"), CAPI deletion, FORCE-RLS pii_erasure_log. ErasureOrchestratorConsumer idempotent + DLQ, **publishes no cache.invalidate** (Redis holds erased-subject aggregates until TTL, max 60m).
- NO shred-manifest (knowledge-base/privacy/ empty). Lake tiers are hash-only by design — "key destruction across bronze/silver/gold" satisfied indirectly, needs written mapping.

## 13. Schema governance / Kafka

- **Apicurio LIVE (:8080, v2 REST):** exactly ONE artifact — group `brain`, `collector.event.v1`, AVRO (CollectorEventV1: schema_version, event_id, brand_id, correlation_id, event_name, occurred_at, ingested_at?, hashed_user_id?, hashed_session_id?, properties map<string>). `GET /admin/rules → []` and artifact rules → [] — **NO compatibility rule exists live** despite docker-compose.yml:546–547 REGISTRY_COMPAT_DEFAULT_RULE=FULL_TRANSITIVE (env present in container; does not materialize a rule in apicurio-registry-mem 2.6.3).
- **BUG:** `packages/events/src/index.ts` validateSchemaCompatibility POSTs `.../versions/latest/compatibility` which does not exist in Apicurio 2.6 (live 404 verified) and maps 404 → `{compatible:true}` — compat checking has never checked anything.
- All other ~48 live topics carry JSON governed only by zod (`packages/contracts/src/events/*.ts`); one .avsc in repo. Event-names like refund.recorded.v1/spend.live.v1 are payloads INSIDE the one generic collector envelope — per-event-name governance ≠ per-topic Avro.
- **Topic naming convention** (kafka-init docker-compose.yml:360–399, matches live): `{env}.{domain}.{name}.v{N}` (env ∈ dev|prod, both created); raw lanes `{env}.{provider}.{entity}.raw.v1` (9); EXCEPTION: internal fan-out `{env}.brain.{entity}` unversioned; singleton `control-iceberg`. Partitions 12, RF 1, auto-create OFF. CollectorEventV1 event_name is a free string — 'identify' is admissible without schema work.
- Stale doc: infra/kafka/topics.yml:87–93 still lists removed settlement/spend-ledger-bridge consumers.

## 14. Test / golden / lint baselines

- **Golden dataset:** NO packages/testing-golden, no deterministic multi-brand generator, no snapshot harness. Primitives: tools/pixel-fixture (send-event.mjs, seed-touchpoints.mjs — real-collector injection), tools/seed, tools/load-test k6 (ingest/serving incl. dedup harness), tools/parity-oracle (comparison pattern).
- **ESLint boundaries:** rich flat config (eslint.config.mjs: app-to-app ban, reach-around ban, metric-engine fence, no-raw-redis-key, no-float-money, no-pci-card-fields) — but enforces MODULE fences, not ports-and-adapters (nothing bans ioredis/kafkajs/neo4j-driver imports from domain/). **`pnpm lint:boundaries` currently FAILS: 16 errors/3 warnings** (14 metric-engine fence violations across ml/notification/recommendation/workspace-access + 2 missing-rule-definition errors at EraseSubjectUseCase.ts:90, Backfill.ts:263).
- CI naming/architecture guard: tools/lint/v4-naming-guard.sh (blocking in pr.yml) — forbids retired-DB refs, dbt, **feature precompute**, new StarRocks coupling.

---

## 15. Spec-vs-repo vocabulary map

| Spec term | Repo ground truth |
|---|---|
| "Analytics Gateway (Fastify)" | The ADR-0007 SEAM: `apps/core/src/modules/frontend-api` + `@brain/metric-engine` (ServingCacheReader → trino-adapter) + stream-worker invalidate consumer. Not a deployable. |
| "Identity Bridge" | `apps/stream-worker` IdentityBridgeConsumer → ResolveIdentityUseCase → IdentityResolver → Neo4jIdentityRepository. |
| "Universal Pixel package" | TWO artifacts: served hand-maintained IIFE in `apps/collector/.../pixel-asset.route.ts` (what ships) + `packages/pixel-sdk` (SDK core, lacks identify). |
| `(:BrainId)` + `OBSERVED_WITH` | `(:Customer {brain_id,...})` + `IDENTIFIES {tier,is_active,created_at}` (no first/last_seen/count/source). |
| `email_sha256` / `phone_sha256` / `platform_customer_id` | `hashed_customer_email` / `hashed_customer_phone` / `storefront_customer_id` (+ Shopflo legacy `customer_email_hash`/`customer_phone_hash`); canonical unused slot `pre_hashed_identifiers`. |
| "Silver canonical envelope (Avro fields)" | Iceberg `iceberg.brain_silver.silver_collector_event` (14 cols; payload = JSON varchar); additive mechanism = payload properties + promoted nullable columns (precedent: anonymous_id/device_id widen-backfill). |
| `identity.map.changed.v1` | Does not exist. Live lane: `{env}.identity.{minted,linked,merged,suppressed,review_queued}.v1`. |
| "legacy ops.silver_identity_link" | The load-bearing PRIMARY projection (4 readers: revenue ledger, order state, CAPI, stitch). |
| "the stitch (Spark)" | Node/TS cron `journey-stitch-from-identity.ts`, order-grain, PG output. |
| `journey_version` per brain_id | Per-touchpoint `data_version` + `is_current`, PK (brand_id, touchpoint_id, data_version). |
| "Iceberg time-travel replay" | 7-day snapshot TTL sweep; replay substrate = retained version rows + bi-temporal(valid) identity map + snap_identity_link as-of seam + brain_id_asof. |
| "metric registry (16 metrics)" | TS METRIC_REGISTRY, 22 metrics (registry.ts:116). |
| "gold_measurement_*" | Existing ancestors: silver_refund / silver_settlement (+gold_settlement_summary) / silver_marketing_spend / silver_inventory_level / gold_contribution_margin / billing.cost_input. |
| Spec CM1/CM2/CM3 | Live CM1 = spec CM2; live CM2 = spec CM3 (gold_contribution_margin.py + metric-engine twin). |
| "prepaid at capture" | Two-stage: provisional_recognition at booking → finalization after per-brand horizon. |
| "LiteLLM configuration (live)" | infra/litellm.config.yaml rich but compose service commented out (`ai` profile, disabled 2026-07-02). |
| `{brand_id}:q:{hash}` cache key | `${brandId}:${metricId}:${paramsHash}:${servingVersion}` + 5 TTL tiers + version-bump invalidation (superset). |
| "packages/platform-flags" | Nothing; prior flags layer deliberately removed (#295); must be built fresh via sanctioned key builder. |
| "Apicurio Avro everywhere, BACKWARD" | 1 artifact, no live compat rule, repo doctrine FULL_TRANSITIVE, ~48 JSON+zod topics; compat-check client is a silent no-op (404→compatible bug). |
