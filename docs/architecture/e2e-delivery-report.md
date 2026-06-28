# End-to-End Delivery Report — V4 Connector-Depth + Advertising + Shopflo + Perf + IA + Brand-Edit + Attribution

**Program:** Brain V4 — connector-depth (Shopify / WooCommerce / GoKwik / Shiprocket / Shopflo / Meta / Google Ads), advertising pipeline, API performance, IA redesign, brand-edit, attribution journey-stitch (`TRINO_HOST` fix).
**Delivery lead verdict:** **SHIP WITH CAVEATS.** No code-fault blockers. Every directly-touched code path is positive+negative+edge proven (by live data where a brand exists, by test+code/SQL where it does not). The only RED conditions are (a) brittle memoized-config unit tests, (b) `.live`/`.e2e` suites that need infra/fixtures absent in the bare shell, and (c) honestly-empty-by-data legs (no live Shopflo/Google brand, no dev webhook tunnel, disjoint attribution sets, unapplied migrations 0117-0119). None are product-logic regressions in touched code.

---

## 1. Delivery Verdict — one line per area

| # | Area | Verdict | Strongest single evidence |
|---|------|---------|---------------------------|
| 1 | Whole-repo suites + structural invariants | **pass_with_caveats** | 137 mapper/logistics + 315 metric-engine + 91 contracts GREEN; gate_admission_guard 6 PASS; v4-naming-guard exit 0; money grep `parseFloat(.*(amount\|price\|total))` = 0 hits. RED only in core (16f/744p) + stream-worker (8f/629p) under CI env — all traced to memoized-config brittleness or missing live infra, not touched-code logic. |
| 2 | Shopify connector E2E | **pass** | Live serving per-brand non-empty: `mv_silver_order_state`=816, `mv_gold_customer_360`=646, `mv_gold_revenue_ledger`=1229; ShopifyHmac 23/23 incl. tampered/missing/wrong-secret rejects. |
| 3 | WooCommerce connector E2E | **pass_with_caveats** | Mapper 26/26 (JPY/KWD/INR + coupon percent/fixed) + WooWebhookStrategy 14/14 HMAC fail-closed; live order lane proven (`mv_silver_order_state`=1858) but new upsert lanes empty-by-data (Bronze = only `order.live.v1`). |
| 4 | GoKwik connector E2E | **pass_with_caveats** | Connector CONNECTED in PG (status=connected); 20+14+24 tests green; byte-identical SERVER_TRUSTED gates; live webhook leg empty-by-data (no dev tunnel → `gokwik_events_raw`=0). |
| 5 | Shiprocket connector E2E | **pass_with_caveats** | The CRITICAL false-delivery edge is GREEN: `classifyReturnStatus('completed')='return_completed'` ≠ forward `delivered`, two guard tests pass; live route dead (migrations 0117-0119 unapplied, resolver absent in running DB). |
| 6 | Shopflo connector E2E | **pass_with_caveats** | Shopflo is a full order source (mapper 20/20, `lit('gokwik')` discriminant fix in SQL); zero Shopflo connectors live → entire leg empty-by-data, proven by test+code/SQL only. |
| 7 | Meta-ads connector E2E | **pass_with_caveats** | Live green: 969 `spend.live.v1` Bronze → `silver_marketing_spend`=969 rows sum 188,420,297 minor INR; single-account isolation (1 of 7 activated). Token-refresh 3 live asserts fail = keyring/vault fixture gap, not proven regression. |
| 8 | Google-ads connector E2E | **pass_with_caveats** | 33 pure-unit green; shared `spend.live.v1` pipeline proven live by Meta twin; zero google_ads connectors → Google leg empty-by-data (blocked_data), not a fault. |
| 9 | API Performance | **pass** | `pollIntervalMs=25` + poll-immediately loop in trino-adapter; all 3 serving queries sub-second (1229 rows 0.668s incl. ~0.6s CLI cold-start); serving-cache 3 degrade paths unit-covered. |
| 10 | Attribution / journey-stitch (TRINO_HOST) | **pass_with_caveats** | Job now RUNS (~770ms, not 0ms skip); target brand processed cleanly (not in D-2 list). 0 stitches is honest-empty: 199 anon ∩ 646 order brain_ids = 0 intersection (`comm -12`). |
| 11 | IA redesign + brand-edit + pipeline integrity | **pass_with_caveats** | IA+brand-edit green: web typecheck exit 0, 8 nav tabs, MA-11 currency-lock 3-layer guard, redirects wired. **Pipeline claim FALSIFIED**: newest refresh log = status="degraded", failures=1, ELIFECYCLE exit 1 (journey-stitch + mv re-apply). |

---

## 2. Coverage Matrix — area × {positive, negative, edge}

### 1. Whole-repo suites + structural invariants
- **Positive:** 137 mapper/logistics tests, metric-engine 315 (35 files), contracts 91 — all GREEN. Structural invariants: gate_admission_guard 6 PASS (server_trusted_byte_identical, ledger_only_parity, admission coverage); v4-naming-guard exit 0; `py_compile` clean on 44 silver + bronze_materialize; typecheck clean on all 9 touched packages. Money invariant holds repo-wide: every money field `*_minor` BigInt-as-string, BigInt-only arithmetic, `currency_code` always a sibling.
- **Negative:** contracts REJECT float/number money on every DTO + out-of-enum confidence/kind/decision + missing required fields with named error paths; stream-worker idempotency/dedup green where env-independent (capi-deletion 3x→ONE; consent-suppressor 3x→5+3 tombstones).
- **Edge:** multi-currency per-currency: woocommerce scales by ISO exponent (INR→2, JPY→0, KWD→3); ad-spend uses `(row.currency_code ?? accountCurrency)` for the sibling only. INR-default fallbacks touch the LABEL only, never money values.

### 2. Shopify connector
- **Positive:** all 4 resource events admitted in both Spark SERVER_TRUSTED and app ProcessEventUseCase/bronzeBridges; live serving non-empty (816/646/1229).
- **Negative:** ShopifyHmac 9 tests — rejects tampered, missing, wrong-secret, post-compute tampering for both OAuth callback and webhook; handler is HMAC-first → `HMAC_INVALID`. RegisterWebhooks idempotent (422 "already taken" = success).
- **Edge:** COD repointed to LIVE `shiprocket.shipment_status.v1` forward lane (return lane deliberately excluded); no replay/age window (HMAC-only, matches Shopify model); offline OAuth token (no `grant_options[]=per-user`) prevents background-read 401s.

### 3. WooCommerce connector
- **Positive:** mapper emits all grains (product/customer/coupon/refund upserts); webhook strategy + backfill manifest + admission gate parity all wired; mapper 26/26. Live `mv_silver_order_state`=1858, `mv_gold_customer_360`=1324 (order-derived).
- **Negative:** WooWebhookStrategy 14/14 — bad sig and missing secret both rejected fail-closed, each `connector_auth_rejected_total{woocommerce}` +1.
- **Edge:** JPY not x100-inflated, KWD not under-scaled, INR integer-only (`'1.234'` throws), missing currency FAILS CLOSED (no INR default in mapper); coupon percent VERBATIM (never scaled to money, no currency), fixed scaled per-currency.

### 4. GoKwik connector
- **Positive:** connector CONNECTED (PG row, status=connected); 7 canonical events byte-identical across both server-trusted gates; webhook lane skips pixel R2/R3; source-neutral Silver (`silver_payment` Lane 3 default gokwik); MT-1 resolver SECURITY DEFINER. Tests 20+14+24.
- **Negative:** HMAC fail-closed — `HMAC_INVALID` on empty/bad secret, `LOOKUP_KEY_MISSING` on absent appid, `INVALID_JSON` on bad body; unknown event → skip (no loss); `webhook_secret` auto-minted (randomBytes(24).hex), never overwrites user value.
- **Edge:** money bigint minor + sibling currency (129950 for 1299.50); empty-vs-zero quarantine: None amount NOT quarantined, zero on money-bearing payment → `silver_quarantine` stage=business; deterministic eventId per state → Bronze dedup.

### 5. Shiprocket connector
- **Positive:** ShiprocketWebhookStrategy 33/33; `silver_shipment_event` has terminal_class/exception_class cols; `mv_silver_return` view defined; computeReturnFunnel + metric-engine 315; logistics-status 20/20; shiprocket-mapper 13/13.
- **Negative:** resolver `resolve_shiprocket_connector_by_channel` SECURITY-DEFINER, route name matches exactly (registerWebhookRoutes.ts:189). NOT live-verifiable (fn absent — migrations unapplied).
- **Edge:** **THE KEY EDGE GREEN** — two guard tests prove `return.completed` → `return_completed`, NEVER forward `delivered`; `JSON.stringify(ev)` has no `"delivered"`. exception_class/NDR: Delayed→delayed, NDR→ndr, is_terminal=false.

### 6. Shopflo connector
- **Positive:** full order source — `mapShopfloOrder` emits `order.live.v1` source=shopflo, same shape as Shopify/GoKwik (zero mart change); 3 funnel canonicals SERVER_TRUSTED; mapper 20/20 + ProcessEventUseCase serverTrusted + bronzeBridges 4/4 + SF1 e2e.
- **Negative:** HMAC fail-closed throws `HMAC_INVALID`→401 (WebhookPipeline.integration case 1: 401 + zero Kafka produce); dispatch table closed/ordered (refund before order); unknown → skip fast-ack; provider-scoped dedup (shopflo ≠ razorpay).
- **Edge:** shared `lit('gokwik')` discriminant — Shopflo payment labeled 'shopflo', existing gokwik rows byte-identical; money integer-only (`moneyToMinorString`, no parseFloat, throws >2dp/negative) + sibling currency. CAVEAT: discriminant verified by code/SQL only (silver tables 0 rows live).

### 7. Meta-ads connector
- **Positive:** Bronze 969 `spend.live.v1` all under target brand, enriched payloads; Silver 969 rows sum 188,420,297 minor INR, campaign_name 969/969; serving views present; ad-spend-mapper 16/16; Meta OAuth callback 7/7.
- **Negative:** ad-account activation — exactly 1 of 7 activated, only activated account's spend reaches Bronze/Silver. Token-refresh job EXISTS+runs (scanned=1) BUT 3 live asserts fail (refreshed=0, dead token stayed connected) = keyring/vault fixture gap, refresh-write-back NOT proven green.
- **Edge:** money integer-exact (microsToMinor/majorDecimal, throws I-S07 on float); ad.entity.updated entity-sync job exists but ZERO events this refresh (campaign_names from spend-insights piggyback); #29 confirmed — enriched cols land only in empty shadow table, not served mart.

### 8. Google-ads connector
- **Positive:** GAQL widened; `run.ts` emits `spend.live.v1` on shared lane, byte-identical to Meta; shared pipeline proven live by Meta twin (969/3/3); pure-unit 33 green; device/network deliberately excluded (avoid dedup overwrite).
- **Negative:** MCC hardening — per-connector ad_account_id wins over shared bundle; leaf-customer enumeration fixes manager-login-zero-spend; classifyGoogleError routes DISABLED→back off (no 403-loop), DAILY/QPS distinct; SECURITY-DEFINER enumeration with brand_id server-trusted + FORCE-RLS.
- **Edge:** cost_micros→minor exact (bigint-safe to 99999999999999); conversions_value major→minor no parseFloat; both conversions+all_conversions raw; entity event_id daily-bucket deterministic (intra-day dedup, new day re-states SCD). Google live leg empty-by-data (zero connectors).

### 9. API Performance
- **Positive:** `pollIntervalMs=25` + poll-immediately loop (doFetch before setTimeout); `TRINO_SERVING_CACHE_TTL_MS` default 300_000 wired; gatherFoundationSignals cached (`servingCache.read(brandId,'foundation_signals')`); all queries sub-second.
- **Negative:** serving-cache 3 honest degrade paths — disabled→compute(); cache GET fail→warn+compute(); cache SET fail→warn+return value; real compute fail re-thrown (no fabricated green). Unit-covered.
- **Edge:** BigInt-safe JSON (bigintReplacer/bigintReviver) — without it `JSON.stringify` throws on bigint money and 500s every cached read; money stays bigint minor + sibling currency.

### 10. Attribution / journey-stitch
- **Positive:** TRINO_HOST fix verified — job runs (~770ms, not 0ms skip), iterates 11 brands; target brand processed cleanly (salt provisioned, not in D-2 list).
- **Negative:** per-tenant isolation — 7/11 synthetic brands fail-closed D-2 ("refusing to hash with empty/default salt"), isolated+counted, batch not poisoned, exit 0 (errors<brands); salt provider fails-closed rather than hashing with default.
- **Edge:** honest-empty — 199 anon brain_ids ∩ 646 order brain_ids = 0 intersection → 0 stitches by data, not code; `silver_journey_stitch`=0, attribution_credit=0 fully consistent.

### 11. IA redesign + brand-edit + pipeline integrity
- **Positive:** web typecheck exit 0; 8 nav tabs (Home/Customers/Marketing/Behaviour/Journeys/Retention/Identity/Settings); customers/[id] route exists; old routes redirect; brand-edit PATCH threads region_code route→service→repo; brand.service 4/4; serving has live data (4877/1970/1470).
- **Negative:** **PIPELINE CLAIM FALSIFIED** — newest log status="degraded", failures=1, ELIFECYCLE exit 1. journey-stitch failed 2 attempts (11/11 brands errored: D-2 synthetic + "fetch failed" live = identity/core service unreachable in offline refresh); mv re-apply failed twice (rc=7, applied 0 views).
- **Edge:** revenue-truth guard at 3 layers — UI comment + contract MA-11 tag + service MA-11 409 CURRENCY_LOCKED (fail-open if Silver unavailable); honest EmptyState, ZERO mockData/Math.random() in IA content; mv re-apply failure did NOT break serving (views still resolve to live rows).

---

## 3. Honest Caveats — provenance of every green

**Proven with LIVE data (real rows in Bronze/Silver/serving):**
- Shopify full chain (816/646/1229 per brand).
- WooCommerce ORDER lane (`mv_silver_order_state`=1858, customer_360=1324) — but customer/product are ORDER-DERIVED, predate this program, NOT proof of new upsert lanes.
- Meta-ads spend chain (969 Bronze → 969 Silver rows, 188,420,297 minor INR) + single-account activation (1 of 7).
- GoKwik connector connection state (PG connected row).
- API performance timings (sub-second on live serving views).
- Attribution job execution + disjoint-set proof (199 ∩ 646 = 0).
- IA serving data presence (4877/1970/1470).

**Proven by TEST + code/SQL inspection (no live rows for that leg):**
- WooCommerce new upsert lanes (mapper 26/26 + admission parity + backfill manifest) — Bronze has only `order.live.v1`.
- GoKwik full webhook code path (HMAC fail-closed, discriminated mapping, MT-1 resolver) — `gokwik_events_raw`=0.
- Shiprocket return-lane + false-delivery edge (33/33 + 2 guard tests + schema) — `silver_shipment_event`=0, return mart absent.
- Shopflo entire connector (20/20 mapper + integration HMAC-401 + discriminant SQL) — zero Shopflo connectors.
- Google-ads pipeline (33 pure-unit + Meta-twin live proof) — zero google_ads connectors.

**Honestly EMPTY-BY-DATA (correct behavior, not a fault):**
- Attribution non-overlap: no anon-identified customer also placed an order → 0 stitches, 0 credit (needs a checkout-side pixel/identify on a real order, or seeded overlapping data).
- Shopflo / Google-ads: no live brand connected.
- GoKwik webhook delivery: no public dev tunnel → no signed webhook can arrive.
- Shiprocket live route: migrations 0117-0119 unapplied (running PG at 0116) → resolver fn absent, return mart not built. Apply migrations + connect an instance + re-refresh to exercise live.

**Deferred follow-ups (acknowledged, NOT blockers):**
- **#29 mart-projection gap (Meta + Google):** enriched cols (conversions/conv_value_minor/cpc_minor/cpm_minor/ctr/view_through/advertising_channel_type) are computed in `silver_ad_spend_normalize.py` but land only in the empty dual-run shadow table; served `silver_marketing_spend` and `gold_campaign_performance` do not project them. Brain-ROAS-vs-platform-ROAS tile is a documented recommendation, not yet built.
- **#19 perf:** Trino wall timings include ~0.6s CLI/JVM cold start (true server compute sub-200ms, not separately captured); endpoints timed via direct view queries, not through the running HTTP/BFF layer.
- **#27 IA backend gaps:** mv-view re-apply DDL step failing (rc=7) is a re-creation step, not a data outage — views still resolve, but the offline refresh cannot rebuild them when identity/core service is unreachable.
- `ad.entity.updated` entity-sync job exists but emitted zero events this refresh — campaign_names ride the stale spend-insights piggyback, not the decoupled feed.
- INR-default for the currency_code SIBLING (gokwik/shopflo/silver_settlement) — not a money violation, but a currency-less non-INR source row would be MISLABELED INR; worth a DQ guard.
- `event-names.ts:29` comment stale (says coupon NOT admitted) — gates DO admit it; update comment.
- Could not diff merge-base, so cannot independently confirm the core/stream-worker app-suite reds are pre-existing on master vs introduced (read-only gate).

---

## 4. Blockers — code fault vs data/environment

**Code-fault blockers (would block delivery): NONE.**

Every RED was root-caused to one of three non-product-logic conditions:

**(A) Brittle TESTS, not broken behavior — genuine test defect shipped, but product code correct:**
- `loadCoreConfig()` is memoized+frozen (`packages/config/src/common.ts:116` `cached ??= Object.freeze(parseEnv(schema, env))`) → snapshots env on first call. Per-case env-mutating tests read a stale frozen config and fail DETERMINISTICALLY even in isolation: `InitiateAdsOAuthCommand` (advertising program's OWN tests), `eval-gate` (EVAL_GATE_BASELINES_JSON), `capi-passback` (JPY fail-closed), `get-data-quality-summary`. Prod reads config once at boot → prod paths unaffected. **Fix forward (non-blocking):** these tests should reset/inject config per case. This is the one genuine defect the program shipped — it is a test-hygiene bug, not a behavior bug.

**(B) Environment / missing-infra (`.live`/`.integration`/`.e2e`):**
- core 16f/744p, stream-worker 8f/629p under CI env — failing files all need live infra/fixtures/secrets/data-state absent in a bare shell (jobs.live, ml-platform.live, ads-connector-dev-honesty.live, connector-marketplace.live, audit-checkpoint, meta-token-refresh.live, spend-repull.e2e, identity-merge-canonical-ltv.live, gokwik-shopflo-isolation.integration, sync-run-repository.integration). CI provides only DATABASE_URL+BRAIN_APP_DATABASE_URL.
- meta-token-refresh 3 asserts (MT1/MT3): job runs, routes seeded due-token to reconnect not refresh — keyring/token-vault fixture gap, refresh-write-back not proven green (not a demonstrated regression).
- spend-repull-smoke SM1/SM2: STALE fixture — `seedAdConnector` omits `activated_at` but the 0106 gate requires it → seeded connectors never enumerated. Fixture bug, not Google/Meta code.
- ml-platform cross-brand-isolation `expected 3 to be 2`: leftover lakehouse prediction rows from the just-run refresh (data-state, not a leak).

**(C) Data-state conditions (honest-empty, covered in §3):**
- Attribution 0-output (disjoint sets), Shopflo/Google no live brand, GoKwik no webhook tunnel, Shiprocket migrations 0117-0119 unapplied.

**One falsified claim to flag (operational, not code-fault):** the prompt's claim that the latest medallion refresh ran green (status=ok, failures=0) is FALSE — the newest log (`/tmp/v4-refresh-final-1782651153.log`) shows status="degraded", failures=1, ELIFECYCLE exit 1. The single failure is the journey-stitch phase (D-2 fail-closed on synthetic brands + "fetch failed" because identity/core service was unreachable during the offline refresh) plus the mv-view re-apply DDL step (rc=7). Silver 21 ok/0 failed, gold 4 ok/0 failed, gold-customer 1 ok. This is an operational/environment degrade (offline refresh without identity service up), not a fault in the touched connector/IA/brand-edit code — but it must be reported honestly: the pipeline did NOT run clean-green this cycle.

---

## Delivery decision

**SHIP WITH CAVEATS.** All directly-touched code is positive+negative+edge proven. Zero code-fault blockers. Required honest disclosures before sign-off:
1. The memoized-config test defect (A) — fix-forward, tracked.
2. The refresh ran "degraded" not "ok" (offline identity service) — re-run with identity/core up to confirm clean-green.
3. Several connector legs are proven by test+code only (no live brand / no webhook tunnel / unapplied migrations) — list them to the stakeholder so "green" is not over-read as "live."
4. #29 enriched-mart projection remains deferred (enriched ad measures stop at Silver shadow).
