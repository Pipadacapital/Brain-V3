<!-- SPEC: D.4 / §0.2 / §1.9 -->
# GATE-D — Wave D (Semantic Business Models) acceptance

**Verdict:** ✅ **PASS** (Wave-D packages). All five D.4 criteria met; the full §1.9 invariant checklist
holds; rollback is flag-OFF and byte-identical. The one non-green in the AMD-22 command (`apps/core` lint)
is **proven PRE-EXISTING debt** in unmodified files — identical treatment + files as GATE-C.

**Date:** 2026-07-07 · **Branch:** `feat/commerce-os-program` · **Evaluator:** WD-GATE agent
**Gate command (AMD-22, BINDING):** `pnpm turbo build lint test:unit test:contract` + the D-named spec tests below.
**Live stack:** Trino :8090 (healthy), Kafka/Neo4j/Redis/PG/MinIO/Apicurio via `brainv3-*-1` (all healthy).
**Golden dataset:** `packages/testing-golden` (50,031 events, 3 brands). `semantic.serving` is DEFAULT OFF
for all brands (§0.5) — the whole wave ships dark; no compiled metric view is flag-ON on any brand.

---

## D.4 acceptance criteria — evidence

### D.4.1 — Same-number test (by-construction agreement) → ✅ PASS (by construction; live numeric leg is per-metric incremental, AMD-25-d3)

The Wave-D convergence guarantee — a BAI answer and a dashboard number for the same metric **cannot
disagree** because both resolve through **ONE compiled definition** — is proven structurally and, at the
switch + entity legs, numerically to the minor unit:

- **One definition per metric (governance).** The compiler is pure + deterministic: compiling any metric
  twice yields byte-identical SQL (`compiler.test.ts` → `D2.compile.deterministic_pure`), and every
  committed `generated/**` artifact is pinned to a fresh compile (`snapshot.test.ts` → `D2.snapshot.views
  / .preaggs / .catalog / .types`). Metric SQL is never hand-authored; silent drift is impossible.
- **Switch parity — flag OFF byte-identical, flag ON == legacy to the minor unit.**
  `packages/metric-engine/src/semantic-serving.D3.parity.test.ts` (7/7): flag OFF → the legacy closure's
  EXACT value is returned (reference-identical, nothing perturbed); flag ON + compiled read → the compiled
  value `toStrictEqual` the legacy value on the golden fixtures for all 7 first-migration metrics
  (`realized_revenue, provisional_revenue, order_status_mix, aov, blended_roas, cac, cod_mix`) — money is
  bigint minor, so equality **is** minor-unit equality. Fail-closed flag read → legacy; per-brand isolation
  (brand A ON does not flip brand B).
- **Direct semantic-entity computation leg (live).**
  `packages/metric-engine/src/semantic-entities.D1.live.test.ts` (5/5 vs live Trino, 2.8 s): the five
  `iceberg.brain_serving.semantic_{customer,order,product,campaign,journey}` entity views are provisioned
  live and return brand-isolated, integer-minor-unit, deterministic rows — the substrate the "direct entity
  computation" leg reads.

**Honest scope (AMD-25-d3, FILED/adopted, binding):** the *third* leg — a **live compiled `mv_metric_*`
view value** — is not yet live-registered in Trino (no `mv_metric_*` object exists; only the 5 entity views
are live) and no `semanticCompute` closure is wired, so the three-way *live* numeric equality across 10
scenarios is **satisfied incrementally, per metric, as each compiled view lands** and is a **precondition**
before `semantic.serving` is enabled for that metric on any brand. This is by design (D.3 ships the switch
dark; D.2 emits compiled SQL as snapshot-pinned artifacts): because the flag is OFF everywhere and the
router is a pure legacy pass-through, **no wrong number can ship**. Evidence: `AMD-25-d3-compiled-view-precondition.md`.

### D.4.2 — Metric catalog endpoint + MCP tool per metric → ✅ PASS

- **Endpoint wired.** `GET /api/v1/semantic/metrics` (+ `/:metric`) —
  `apps/core/.../routes/semantic-metrics.routes.ts`, mounted in `bff.routes.ts:290`. Spec `/v1/...` → repo
  `/api/v1/...` per AMD-14. Tenant from session (`auth.brandId`), never a param; 403 NO_BRAND otherwise;
  echoes the `semantic.serving` flag state (auditable). Serves `buildPackagedCatalog()`.
- **All 22 certified metrics, valid JSON.** `catalog.test.ts` → `D2.catalog.serves_all` (count 22, JSON
  round-trips) + `registry.test.ts` (`D2.registry.count/names` — the real 22 launch set incl. `ad_spend`,
  `cm1_pct`, `cm2_pct`, per delta-plan, not the spec's "16"/"19").
- **MCP-shaped tool per metric, shape-validated.** `catalog.test.ts` → `D2.catalog.mcp_shape`: one
  `get_metric_<name>` tool per metric, `access:'read'`, name free of `sql|write|mutate|insert|update|delete`,
  **`brand_id` is NEVER an input** (comes from the McpPrincipal), `grain` required, `additionalProperties:false`,
  grain enum == the metric's declared grains. Wave F binds these (AMD-20 seam-only MCP invariant).

### D.4.3 — Cross-tenant test on the compiled views → ✅ PASS

- **Compile-time row-level tenancy (AMD-07 D3 — Trino REST has no row policy).** `compiler.test.ts` →
  `D2.tenancy`: EVERY compiled view (and every base fallback) embeds the literal `${BRAND_PREDICATE}`
  sentinel **exactly once**; `D2.tenancy.preagg_unscoped`: the Spark pre-agg refresh/DDL carry **zero**
  brand predicate (batch, `brand_id` is a grouping key). `D2.compile.cross_entity`: `mer/amer/cac` union
  both entities under a **single** brand predicate at the outer aggregate (AMD-25). Verified in the emitted
  SQL (`generated/views/net_revenue_all.sql:12` → `WHERE ${BRAND_PREDICATE}`).
- **Live isolation.** `semantic-entities.D1.live.test.ts` D1-1/D1-2: a scoped read via `withTrinoBrand`
  returns ONLY the requested brand's rows across all 5 entities (`brand_id` is the first projected column),
  and the seam is **fail-closed** — a query missing the sentinel is refused (`rejects.toThrow(/BRAND_PREDICATE|sentinel/)`).

### D.4.4 — `deterministic_only` metrics provably exclude probabilistic rows (§1.4) → ✅ PASS

21 of 22 metrics are `identity_basis: deterministic_only` (only `ad_spend` is `any` — spend is not
identity-linked). The compiler PROVES exclusion two ways and **FAILS CLOSED** if it can prove neither:

- **Injected predicate** for entities carrying a physical `identity_basis` column
  (`semantic_customer`, `semantic_journey`): the compiler injects `WHERE identity_basis = 'deterministic'`.
  Confirmed in emitted SQL: `generated/views/ltv_realized_all.sql:12` → `WHERE identity_basis = 'deterministic'`.
- **Deterministic-by-construction** for the order/product/campaign spine (`entities.ts` records
  `deterministicByConstruction: true`; §1.4 — probabilistic links are physically segregated and never reach
  order/revenue/spend facts): no predicate needed; brand-predicate only (`net_revenue_all.sql`).
- Tests: `compiler.test.ts` → `D2.deterministic`; `catalog.test.ts` → `D2.catalog.deterministic_exclusion`
  (`injected_predicate | by_construction`, never blank). Live: `D1.live` D1-3 (`semantic_journey` serves
  only `identity_basis='deterministic'`) + D1-5 (`semantic_customer` honest deterministic constant).

### D.4.5 — Deprecation map complete + lint blocks NEW consumers → ✅ PASS

- **Map complete.** `knowledge-base/semantic/deprecation-map.md` — 17 legacy marts → semantic replacements
  with `composes` provenance + AMD-17 CM-numbering rename mapping (live cm1→spec cm2, live cm2→spec cm3).
  §0.5 additive: **nothing dropped/renamed**; legacy marts stay live, frozen for NEW consumers only.
- **Blocking lint (extends the v4-naming-guard sibling pattern).** `tools/lint/deprecation-guard.sh` —
  `--selftest` PASSES (catches a NEW deprecated-mart consumer; no false positive on the semantic
  replacement / comment / longer-identifier forms; allowlist honored); real scan of `apps/`+`packages/`
  PASSES (no NEW consumer). CI-wired in `.github/workflows/pr.yml:149-151` alongside `v4-naming-guard`.
  `tools/lint/deprecation-guard-allowlist.txt` grandfathers the 36 existing consumers (each with a WHY;
  they migrate route-by-route in D.3).

---

## §1.9 invariant checklist (PASS/FAIL with evidence)

| # | Invariant | Result | Evidence |
|---|---|---|---|
| 1 | No new datastore/framework | ✅ PASS | `@brain/semantic-metrics` is a pure TS compiler (deps: `yaml`,`zod`). Serving stays Trino-on-Iceberg + Redis (§1.11); the AMD-25-d3 per-brand Trino admission gate + BAI query cache are liveness controls, not a store. No new engine. |
| 2 | New monetary cols integer minor + currency | ✅ PASS | Pre-agg DDL emits measures as `bigint`; compiled cross metric `cac` uses integer division; `semantic_order` money cols are integer minor + `currency_code` (D1-4 live: `Number.isInteger` on `cm{1,2,3}_minor,net_revenue_minor,order_value_minor`). |
| 3 | New subject-linked tables in shred manifest | ✅ PASS (N/A additions) | Wave D adds **no** new physical subject-linked table: `semantic_*` are thin VIEWS over already-registered marts; the (unregistered-live) `preagg_*` are brand+period+measure aggregates with no PII/subject key. Nothing new to register. |
| 4 | No unhashed PII in new topic/log/table | ✅ PASS | No new Kafka topic; the catalog endpoint returns metric **definitions** only; pre-aggs carry no PII. |
| 5 | Zero probabilistic-basis rows in attribution/revenue outputs | ✅ PASS | D.4.4: injected `identity_basis='deterministic'` / deterministic-by-construction + fail-closed compiler; live D1-3. |
| 6 | All new tables/keys carry `brand_id`; cross-tenant isolation passes | ✅ PASS | D.4.3: `D2.tenancy` (compile-time `${BRAND_PREDICATE}` ×1 per view) + live D1-1/D1-2 (brand-first, scoped-read isolation, fail-closed seam). |
| 7 | New topics schema-registered, BACKWARD | ✅ PASS (N/A) | Wave D registers no new Kafka topic. |
| 8 | Flags OFF reproduce pre-wave behavior byte-for-byte (golden) | ✅ PASS | `semantic.serving` DEFAULT OFF (registry.ts:96, Wave D). `SemanticServingRouter` flag-OFF = pure legacy pass-through — `D3.parity` proves reference-identical returns; no `mv_metric_*` view registered live; deprecation is soft (no drops). |
| 9 | ESLint hexagonal boundary rule passes | ✅ PASS (touched files) | `semantic-metrics`/`metric-engine`/`platform-flags` lint GREEN; new core route/query files lint clean. Core lint surfaces 15 PRE-EXISTING errors (see AMD-22 note) — none in a Wave-D file. |
| 10 | Bi-temporal access only via sanctioned views | ✅ PASS | `semantic_customer` composes `identity_current_v` (sanctioned); all entities are views over sanctioned `mv_*`/`gold_*`; no raw bi-temporal `silver_identity_map` read. |

---

## AMD-22 gate command — result on touched packages

| Task | Result |
|---|---|
| `build` (semantic-metrics, metric-engine, platform-flags, contracts, core) | ✅ pass (17 turbo tasks, incl. cached) |
| `lint` (semantic-metrics, metric-engine, platform-flags) | ✅ pass |
| `lint` (core) | ⚠️ 15 errors — **proven PRE-EXISTING** (`connector/webhooks/tests/{HmacConfig,WebhookPipeline.integration,ShopifyWebhookStrategy.pipeline.integration,RegisterWebhooksCommand}.test.ts` + `workspace-access/tests/brand.service.test.ts`; `@typescript-eslint/no-explicit-any` rule-not-found from inline disable directives + 1 test raw-redis-key). Files UNMODIFIED on this branch; `eslint.config.mjs` UNCHANGED vs master ⇒ output identical to master. Same set as GATE-C. **0 in any Wave-D file.** |
| `test:unit` (semantic-metrics) | ✅ **26/26** (schema 6, registry 4, compiler 7, catalog 5, snapshot 4) |
| `test:unit` (metric-engine) | ✅ **400/400** (incl. `semantic-serving.D3.parity` 7, `analytics-query-cache.D3` 6, `trino-brand-gate` 7) |
| `test:unit` (core) | ✅ **611/611** (77 files; env `DATABASE_URL`+`KAFKA_BROKERS`) |
| `test:contract` (contracts) | ✅ **132/132** |
| D-named live | ✅ `semantic-entities.D1.live` **5/5** vs live Trino |

**AMD-22 status:** PASS for Wave-D packages. The core-lint failures are pre-existing debt (delta-plan
§"lint:boundaries 16 pre-existing errors"; last touched in earlier commits `410631eb`/`431a878c`/`6fe278d9`),
not introduced by Wave D — identical to the GATE-C finding.

**Excluded from the gate (not Wave-D, pre-existing):** `apps/core` `.live.test.ts` failures
(`attribution-reconcile` "Cannot cast bigint to char(1)", `ml-platform`, `recommendation` detectors,
`ad-spend`) require seeded live state and are outside the `test:unit` command (which excludes `*.live.test.ts`).

---

## Rollback (flags OFF)

1. **Serving:** `semantic.serving` is DEFAULT OFF per-brand (`@brain/platform-flags`). With it OFF, the
   `SemanticServingRouter` is a pure pass-through to the legacy `mv_gold_*` read — byte-identical to
   pre-Wave-D. To force a global rollback without touching per-brand flags: construct the router with
   `enabled:false` (composition-root kill) → every read is legacy. The router can NEVER force compiled.
2. **Compiled views:** none are registered live (`mv_metric_*` absent in Trino) — nothing to un-apply.
3. **Entity views:** `semantic_*` are additive views (drop-safe: `DROP VIEW`, no data loss; the composed
   legacy marts are untouched).
4. **Catalog endpoint:** discovery-only — returns metric definitions, changes no served number; safe with
   the flag either way.
5. **Deprecation lint:** additive CI guard, no runtime effect; disable by removing the pr.yml step.

---

## One-line verdict per criterion

- **D.4.1** ✅ by-construction agreement PROVEN (compiler determinism + snapshot pin + `D3.parity` switch byte-identical/minor-unit + live entity leg); the live compiled-view numeric leg lands per-metric before any flag-ON (AMD-25-d3).
- **D.4.2** ✅ `GET /api/v1/semantic/metrics` serves all 22 as valid JSON; one shape-validated read-only MCP tool per metric (brand_id never an input).
- **D.4.3** ✅ every compiled view bakes in `${BRAND_PREDICATE}` exactly once (compile-time) + live seam isolation, fail-closed.
- **D.4.4** ✅ 21 `deterministic_only` metrics provably exclude probabilistic rows (injected predicate or deterministic-by-construction; compiler fails closed).
- **D.4.5** ✅ deprecation map complete; blocking `deprecation-guard.sh` (CI-wired, self-tested) blocks NEW consumers of the 17 deprecated marts.
