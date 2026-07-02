# Brain — Implementation & Build Plan (Repository, Module Layout, Tooling)

**Product:** Brain — the AI-native commerce operating system for DTC brands in India, UAE & GCC.
**Document type:** The bridge from architecture to a buildable repository — repo strategy, monorepo layout, per-service/module structure, shared libraries & contracts, build system, config/secrets, database & migrations, local-dev bootstrap, testing/CI wiring, build order, and the Sprint-0 setup checklist.
**Status:** Final v1.1 — repository structure refined by the Architecture Review Board (see §1A). **Date:** 2026-06-14.
**Derived strictly from (source of truth — do not contradict):** `01_…BRD`, `02_…Functional_Specification`, `03_…Technology_Stack`, and especially **`04_Brain_Architecture_and_Delivery_Plan.md`** (the 3 deployables, the M1–M12 module catalog in §C, the ADRs in §B, the DDL in §F, and the roadmap in §18/§O).

**How to read this.** Doc 04 answers *what* the architecture is. This doc answers *"clone the repo and start — where does everything go, in what order, with what tooling."* It introduces **no new architecture decisions**; every choice traces to a doc-04 ADR. Where this doc proposes a tool doc 04 didn't name (a monorepo runner, a migration tool), it is flagged **[BUILD-TOOLING CHOICE]** for confirmation — these are reversible and do not affect the architecture.

---

## Table of Contents
1. Repository strategy
1A. Architecture Review Board — repository-structure refinement (findings · naming conventions · change log · evolution)
2. The monorepo layout
3. The core monolith — internal module structure (13 modules)
4. The Collector & stream-worker structure
5. Shared packages & the contract source-of-truth
6. The build system (Turborepo) & the `--affected` CI matrix
7. Enforcing the modular monolith (import boundaries & guard lints)
8. Configuration, environment & secrets
9. Database, migrations & the dbt project
10. Local development bootstrap
11. Testing layout & the CI gate mapping
12. CI/CD wiring (GitHub Actions → ArgoCD)
13. The build order (dependency-ordered)
14. Sprint-0 setup checklist
15. Engineering conventions & Definition of Done
16. Build-tooling choices to confirm

---

## 1. Repository strategy

**Decision: a single TypeScript monorepo** (`brain/`). This follows directly from the frozen decisions in doc 04:
- **ADR-007 (TS everywhere)** → one language, one toolchain, shared types across frontend/backend/stream.
- **ADR-001 (modular monolith, 3 deployables)** → most code is one app with internal modules; a monorepo keeps those modules + shared libraries + infra in one place with enforced boundaries, and makes the later *extraction* of a module into its own deployable a move-a-folder operation, not a repo split.
- **ADR-002/004 (one read path, in-process metric engine)** → the metric engine is a shared *package* imported in-process by the Analytics API; that only works cleanly in a monorepo.

A polyrepo is rejected for Phase 1: it would force premature service boundaries (the exact over-split the ARB warned against) and duplicate the shared contract/types/metric-engine across repos.

**Runner: Turborepo** **[BUILD-TOOLING CHOICE]** — package-level task pipelines, local + remote build cache, and `--affected` to drive the CI deploy matrix. (Nx is the alternative; Turborepo is lighter and fits the TS-only, small-team posture.)

**Package manager: pnpm** **[BUILD-TOOLING CHOICE]** — workspaces + content-addressed store + strict peer resolution (keeps the module boundaries honest).

---

## 1A. Architecture Review Board — repository-structure refinement (2026-06-14)

A senior board (CTO · VP Eng · Principal Solution/Backend/Platform/Data/AI Architects · Staff Data Engineer · ex-Triple Whale & ex-Northbeam architects) challenged the §2–§5 structure for a **4–8-engineer team**, optimizing for clarity, ownership, and clean future evolution — *not* theoretical scale. §2–§5 below are updated to the result; the findings, the naming standard, the change log, and the evolution strategy live here.

> **Where this lives:** the repository structure is in *this* document (the Implementation & Build Plan). It was refined **in place — no new document was created.** Doc 04 §C (the higher-level service catalog) still carries the pre-refinement module labels; the **naming map** in §1A.3 reconciles the two — the boundaries and decisions are identical, only four labels changed and one module was added.

### 1A.1 Findings — correct / improved / risks

**Endorsed and kept unchanged.** The 3-deployables-+-web shape; the modular monolith with `index.ts`-public / `internal/`-fenced modules; `apps/` may never import `apps/`; the contract-as-source-of-truth (`packages/contracts`); the in-process `metric-engine` package; the Collector's durability-in-the-spool; the build order; the Sprint-0 checklist. The board found the *direction* correct — the work was naming plus two boundary refinements, nothing structural.

**Improved.**
1. **Jargon removed —** `bff` → **`frontend-api`**. A new engineer can't decode "BFF"; "frontend-api" is self-evident.
2. **Misleading name fixed —** `scheduler` → **`job-orchestration`**. The *scheduler* is Argo; this module is only the orchestration *contract* (cron catalog, overlap-locks, backfill triggers) that Argo executes. *(This also answers the "does scheduler belong in the monolith?" review: **yes — but only the thin orchestration contract**. The execution engine is Argo; its workflow specs live in `infra/argocd/`.)*
3. **Implementation suffix dropped —** `analytics-api` → **`analytics`**. Every other module is a domain noun; "-api" was the odd one out, and the module already *is* the API/read-path, so the suffix added nothing.
4. **Connector internals restructured (not split)** so it can't become a God module — `catalog / connection / sync / settlement / sources-by-category` (§3.1). Adding a new source is a new folder under `sources/`, never a change to the engine.
5. **AI internals restructured** so `ai/` can't become a dumping ground — `gateway / nlq / mcp / prompt-registry / evaluation / provenance` (§3.2). Recommendation stays its own module (it's deterministic, not LLM).
6. **One domain made explicit (strong justification) —** **`data-quality`**: the DQ grade + the gating table gate the billing cap, recommendation eligibility, *and* metric rendering. That logic is too load-bearing to scatter across billing/recommendation/measurement, so it gets one owner.
7. **`workspace-access` kept (final-pass reversal).** An interim rename to `workspace` was considered and **rejected**: (a) `workspace` alone hides the access/RBAC half of the module's responsibility; (b) in Brain's own vocabulary **"workspace" is a synonym for "brand"** (BRD §5.1), so a `workspace` module would mislead a newcomer into thinking it manages the brand entity. The compound **`workspace-access`** names both halves — tenancy (orgs/brands) *and* access (users/roles/permissions/invites/sessions) — and is the single clearest name for the full responsibility set. (Splitting into `workspace` + `access` was also rejected for a small team — orgs/brands/users/roles are tightly coupled; `access` stays an *extract-later* candidate, §1A.4.)
8. **Lightweight `packages/feature-flags` added as a Phase-1 package (final-pass reversal).** A simple, tenant-aware flag evaluator earns its place from day one for **operational safety**: kill a misbehaving connector, recommendation detector, or AI capability *for one brand without a deploy*; gate beta features and experimental AI prompts; phase connector enablement. It is **static config + a small per-brand override table + an `enabled(key, {brandId})` evaluator**, audited via `packages/audit` — explicitly **not** a LaunchDarkly-style targeting/percentage engine, and **distinct from the Phase-4 progressive-delivery/canary infra** (which shifts deploy traffic and arms the 60-second autonomy kill switch). Plan-paid **entitlements stay in `billing`**; the flag evaluator may read them as one input. Structure: `packages/feature-flags/{index.ts (enabled/variant), definitions.ts (typed flag registry + defaults + owner), store.ts (per-brand overrides + Redis cache)}`; flag categories `connector.<type>.enabled · recommendation.<detector>.enabled · ai.<capability>.enabled · beta.<feature>`.

**Considered and deliberately NOT done (kept simple for a small team — and where I disagree with the brief, I say so).**
- **`connector` → `integration`** (the domain language in doc 04 §4 leans "integration"): **rejected.** "integration" is ambiguous in a codebase (collides with *integration testing*); `connector` is unambiguous, already singular, and engineer-clear. The rename would have *reduced* clarity. *(You asked me to disagree where it adds value — this is one.)*
- **Splitting `workspace-access` into two modules:** rejected — see finding #7.
- **New modules `admin`, `support`, `search`, `experimentation`:** **not added now.** Internal-admin/ops is thin in Phase 1 → it lives in `platform/` + `workspace-access` (staff grants) and becomes its own module in Phase 2 when the internal console grows. `support` = Phase 3 (AI ticketing). `search` is served by the `analytics` read-path initially; a dedicated module only if it outgrows that. `experimentation` = Phase 2 capture (schema reserved in `db/` now, no module yet). Adding any of these now is complexity a small team pays for with no Phase-1 return. *(Feature-flags, previously in this list, was promoted to a Phase-1 package — finding #8.)*

**Risks identified & mitigated.** (a) `connector` and `ai` were the God-module risks → the internal restructures (§3.1/§3.2) plus the rule *"a new source/capability is a new **folder**, never a new branch in a 2000-line file."* (b) `measurement` / `attribution` / `analytics` sound alike → one-line boundary headers on each (§3). (c) The audit writer was homeless (buried in `workspace-access`) yet cross-cutting → extracted to **`packages/audit`**. (d) Money math risked scattering → **`packages/money`** as its one home (enforces the minor-units invariant). Module count moves **12 → 13** — acceptable, because modules are *folders in one deployable*, not services; 13 clear domains across 4–8 engineers improves ownership rather than adding operational cost.

### 1A.2 Naming conventions (the repo-wide standard)

| Scope | Rule | ✅ / ✗ |
|---|---|---|
| Top-level dirs | plural container nouns (they hold many of a thing); mass nouns stay singular | `apps/` `packages/` `tools/` ✅ · `db/` `infra/` ✅ |
| **Modules** (`core/modules/*`) | **singular business-domain noun**; no `-api` / `-service` / `-manager` suffix; no abbreviations | `identity` `billing` `attribution` ✅ · `bills` `notifications` `bff` ✗ |
| Apps (`apps/*`) | the deployable's role, kebab-case | `collector` `stream-worker` `core` `web` ✅ |
| Packages (`packages/*`) | what the library *is*, kebab-case; `-core` / `-client` suffix only when it genuinely is one | `metric-engine` `tenant-context` `identity-core` `ai-gateway-client` ✅ |
| Sub-folders in a module | the capability, singular | `connection/` `sync/` `settlement/` `nlq/` `mcp/` ✅ |
| Files | kebab-case `.ts`; tests co-located `*.test.ts` | `merge-engine.ts` + `merge-engine.test.ts` ✅ |
| Prefer | business/domain terms over technical jargon | `frontend-api` not `bff`; `job-orchestration` not `scheduler` |
| Abbreviations | allowed **only** when industry-universal (a senior engineer needs no gloss) | ✅ `db` `ui` `ai` `adr` `dbt` `eval` · ✗ `bff` `mgmt` `attr` `conn` |
| Forbid | ambiguous abbreviations; mixing domain + implementation in one name; inconsistent singular/plural | not `bff`, not `analytics-api`, not `notifications` |

**The newcomer test (the bar every name must pass):** *a senior engineer opens the repo for the first time and understands every top-level folder and every module within minutes, with no explanation.* The refined names pass it.

### 1A.3 Change log + naming map (vs doc 04 §C)

| Action | Items |
|---|---|
| **Keep as-is** | `apps/` (collector, stream-worker, core, web); packages contracts, metric-engine, tenant-context, identity-core, db, events, observability, ai-gateway-client, config, ui; modules **workspace-access**, connector, identity, measurement, attribution, billing, recommendation, notification; `db/` `infra/` `tools/`; the import-boundary rules; build order; Sprint-0 |
| **Renamed (capabilities unchanged)** | `analytics-api` → `analytics` · `bff` → `frontend-api` · `scheduler` → `job-orchestration` |
| **Restructured (internal only)** | `connector/` (§3.1) · `ai/` (§3.2) |
| **Added** | module **`data-quality`** · **`packages/feature-flags`** (lightweight, Phase 1) · **`packages/audit`** · **`packages/money`** · repo-local **`docs/`** (`adr/` `runbooks/` `playbooks/` `architecture/`) |
| **Removed** | none — every capability is preserved 1:1 |

**Naming map (doc 04 §C → this doc §3):** `analytics-api`=`analytics` · `bff`=`frontend-api` · `scheduler`=`job-orchestration` · **+ new module** `data-quality`. `workspace-access` and "Analytics API" (the component) are **unchanged** and already consistent across both docs. (An interim `workspace` rename was reverted — finding #7.)

### 1A.4 Future evolution strategy (Phase 1 → 2 → 3) + extraction triggers

**Extract early: none.** Modular-monolith-first means *nothing* extracts in Phase 1; clean seams make later extraction mechanical, not urgent.

| Module | Disposition | Extraction trigger (business · traffic · team · operational) |
|---|---|---|
| `identity` | **Extract — Phase 2** | probabilistic identity / multi-surface reuse · resolution QPS on the hot path · a dedicated identity squad · independent scaling of the alias graph + Redis cache |
| `billing` | **Extract — Phase 2** | enterprise contracts / revenue-recognition audits · (not traffic) · a finance-eng owner · compliance isolation + a separate deploy cadence |
| `ai` (the Python-needing parts: MMM, predictions) | **Extract — Phase 3** as a Python ML service | MMM / incrementality / predictions · model-inference load · ML engineers (Python) · a GPU/Python runtime distinct from the TS stack |
| `connector` → `sync/` only | **Extract — Phase 3 (if needed)** | — · backfill-storm / connector fan-out volume · — · isolate ingestion load from the API tier |
| `access` (currently inside `workspace`) | **Maybe extract — Phase 2+** | user management becomes a shared, multi-product concern · — · a platform/identity squad · — |
| `analytics` | **Keep inside** (it *is* core's read path) | scale via read-replicas + cache, never by extracting the module |
| `workspace`, `measurement`, `attribution`, `recommendation`, `notification`, `frontend-api`, `job-orchestration`, `data-quality` | **Keep inside (long-term)** | thin/glue or tightly coupled to core; no extraction justified |

**Repo-local `docs/` (the operational-readiness review):** **recommended — add it.** `docs/adr/` (one ADR per decision; CI can require an ADR for any module-boundary change), `docs/runbooks/` (the DR + incident runbooks — RB-1 RDS PITR, RB-2 EKS recovery, RB-3 StarRocks rebuild), `docs/playbooks/` (on-call, connector-onboarding, the incident severity ladder), and `docs/architecture/` (a pointer to the canonical Brain-docs `01`–`05`, not a copy). Reasoning for a small team: decisions and runbooks versioned next to the code, reviewed in the same PRs, beat a wiki that rots — while the large product/architecture specs stay in Brain-docs (single source of truth, not duplicated).

---

## 2. The monorepo layout

```
brain/
├── apps/                                  # the deployables + the web frontend
│   ├── collector/                         # Deployable 1 — Fastify + durable spool (§4)
│   ├── stream-worker/                     # Deployable 2 — KafkaJS consumers (live + backfill)
│   ├── core/                              # Deployable 3 — the modular monolith (§3)
│   └── web/                               # Next.js frontend (talks ONLY to the frontend-api module in core)
│
├── packages/                              # shared libraries (the seams that keep the monolith modular)
│   ├── contracts/                         # THE source of truth: Zod schemas → OpenAPI + Avro + types (§5)
│   ├── metric-engine/                     # the in-process deterministic metric engine (ADR-004)
│   ├── money/                             # minor-unit + currency-code helpers — the ONE home for money math/format
│   ├── tenant-context/                    # brand_id propagation + assertion helpers (§H isolation seams)
│   ├── identity-core/                     # alias/union-find/hash lib (shared by core identity module + stream-worker)
│   ├── feature-flags/                     # lightweight tenant-aware flag evaluator — enabled(key,{brandId}); ops kill-switch + beta gating (§1A.1 #8)
│   ├── audit/                             # hash-chained, WORM-anchored audit writer (cross-cutting — any module calls it)
│   ├── db/                                # Postgres client, RLS session helper, migration runner
│   ├── events/                            # Redpanda wrappers, envelope, topic registry — brand-prefixed composite partition keys, FULL_TRANSITIVE schemas, (brand_id,event_id) dedup, no-PII-in-events (doc 04 §6.6)
│   ├── observability/                     # OTel setup, brand_id span/log enrichment, redaction
│   ├── ai-gateway-client/                 # LiteLLM client, untrusted-text envelope, prompt-registry client
│   ├── config/                            # Zod-validated env schema (§8)
│   └── ui/                                # Shadcn-based shared UI primitives (status-never-colour-only)
│
├── db/
│   ├── migrations/                        # Postgres migrations (control plane, identity, billing, audit)
│   ├── starrocks/                         # StarRocks Silver/Gold DDL (versioned)
│   ├── iceberg/                           # Bronze table + Glue bootstrap (Terraform-driven)
│   └── dbt/                               # the dbt project: staging → intermediate → marts (§9)
│
├── infra/
│   ├── terraform/                         # AWS (VPC, EKS, RDS, S3/Glue, KMS, Redpanda Cloud, etc.)
│   ├── helm/                              # one chart per deployable (collector/stream-worker/core/litellm)
│   └── argocd/                            # app-of-apps; per-env overlays (staging/prod); Argo Workflow specs
│
├── tools/
│   ├── parity-oracle/                     # CI golden-fixture independent reference (§F parity)
│   ├── eval/                              # NLQ resolution + injection + faithfulness golden-sets (§N.5)
│   └── isolation-fuzz/                    # cross-tenant negative-test harness (every layer + seams)
│
├── docs/                                  # repo-local engineering docs (§1A.4)
│   ├── adr/                               # Architecture Decision Records (one per decision; CI requires an ADR for a boundary change)
│   ├── runbooks/                          # DR + incident runbooks (RB-1 RDS PITR · RB-2 EKS recovery · RB-3 StarRocks rebuild)
│   ├── playbooks/                         # on-call · connector-onboarding · incident severity ladder
│   └── architecture/                      # pointer to the canonical Brain-docs 01–05 (specs stay there, not duplicated)
│
├── .github/workflows/                     # CI (§12)
├── docker-compose.yml + compose profiles  # local dev (§10)
├── turbo.json                             # the build pipeline (§6)
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

**The rule that protects the architecture:** an `app/` may depend on `packages/`, never on another `app/`; a `package/` never depends on an `app/`. Cross-module communication inside `core/` is in-process function calls through a module's public interface (or an event), never a reach-around into another module's internals. Enforced by lint (§7).

---

## 3. The core monolith — internal module structure (13 modules)

`apps/core/` is organized **by bounded context, never by `controllers/services/models`** (DDD discipline). Each module exposes a narrow public interface (`index.ts`) and fences everything else under `internal/`, so it can later be extracted to its own deployable (ADR-001 triggers, §1A.4) with no caller change. Thirteen modules (refined from doc-04 §C — see the §1A.3 naming map):

```
apps/core/src/
├── main.ts                                # Fastify bootstrap, plugin registration, OTel init
├── platform/                              # cross-cutting: auth, tenant-context, RLS session, revocation denylist, thin internal-ops console
├── server/                                # route registration, error envelope, rate-limit, idempotency middleware
└── modules/                               # 13 bounded contexts — each: index.ts (PUBLIC) + internal/ (fenced)
    ├── workspace-access/                  # orgs, brands, users, roles, permissions, invites, sessions, access mgmt (tenancy + access)
    ├── connector/                         # third-party integrations — restructured internally (§3.1)
    ├── identity/                          # customer Brain ID, alias graph, merge/unmerge, phone guard, PII vault
    ├── measurement/                       # metric registry + cost/FX inputs (engine = packages/metric-engine)
    ├── attribution/                       # journey, credit ledger, two-pass + clawback, channel contribution
    ├── analytics/                         # THE sole DB read path; semantic layer; finalized-only policy        (was analytics-api)
    ├── billing/                           # meter, cap, true-up, seal, inspectable bill, invoice, dunning, entitlement
    ├── data-quality/                      # DQ grade + the gating table + quality-signal consumption            (NEW — §1A.1)
    ├── ai/                                # AI gateway/NLQ/MCP/registry/eval/provenance — restructured internally (§3.2)
    ├── recommendation/                    # deterministic threshold detectors → recommendation contract
    ├── notification/                      # 3 tiers + the SINGLE send/consent chokepoint (ADR-012)
    ├── frontend-api/                      # Backend-for-Frontend: cookie↔token, CSRF, view-model fan-out; NO DB  (was bff)
    └── job-orchestration/                 # cron catalog + overlap-lock + backfill orchestration; Argo executes  (was scheduler)
```

**The three "analytics-y" modules, disambiguated in one line each:** `measurement` *defines* metrics · `attribution` *computes* who drove realized revenue · `analytics` *serves* them (the only DB reader). Every module follows the same internal shape — `index.ts` (public) + `routes/` + `domain/` + `internal/` (fenced).

### 3.1 `connector/` internals — so it never becomes a God module
One bounded context (all connectors share the lifecycle/sync/health machinery), structured so **adding a source is dropping a folder under `sources/`, never editing the engine**:
```
modules/connector/
├── index.ts
├── catalog/        # the marketplace catalog, honest status, the tracking-plan governance surface
├── connection/     # connect/disconnect, OAuth, credential-vault refs, the seven health states
├── sync/           # the sync engine: cursors, backfill orchestration, retry/backoff, freshness SLOs
├── settlement/     # settlement-report reconciliation (marketplace + payment gateway) — the realized-revenue wedge
├── sources/        # per-source adapters grouped by category (a new connector = a new folder here)
│   ├── storefront/     # shopify, woocommerce
│   ├── advertising/    # meta, google-ads
│   ├── payment/        # razorpay (+ settlement)
│   ├── logistics/      # shiprocket, delhivery
│   ├── messaging/      # whatsapp, klaviyo
│   └── marketplace/    # amazon, flipkart, noon
└── internal/
```

### 3.2 `ai/` internals — so it never becomes a dumping ground
```
modules/ai/
├── index.ts
├── gateway/         # LiteLLM client, model routing, budgets, fallback (wraps packages/ai-gateway-client)
├── nlq/             # question→metric_id intent resolution + binding + the false-bind guard
├── mcp/             # read-only MCP server, governed tools, key scoping
├── prompt-registry/ # content-hash-versioned prompts + promotion pointers
├── evaluation/      # eval hooks (the golden-sets themselves live in tools/eval)
├── provenance/      # AI provenance writer → packages/audit / Decision Log
└── internal/
```
**Recommendation is deliberately a *separate* module** (`recommendation/`), not inside `ai/` — Phase-1 recommendations are deterministic threshold detectors, not LLM output. The **agent framework (Phase 4)** lands here later as `ai/agent/`.

**Extraction path (ADR-001, §1A.4):** when a trigger fires, `modules/identity/` → `apps/identity-service/` (gRPC behind the *same* `index.ts` + a Redis alias cache, Phase 2); `modules/billing/` → `apps/billing-service/` (Phase 2); the `ai/` capabilities needing Python (MMM/predictions) → a separate Python ML service (Phase 3). Each is a contained move because nothing imported the module's `internal/`.

---

### 3.3 First-party capture & connector build artifacts (build artifacts, **not** services)

The Brand-Owned Data Foundation (doc 04 §2.5) requires these **buildable artifacts**. None is a new deployable/service — they are SDKs/packages/extensions/in-process logic that feed the existing **collector → stream-worker → Bronze** path. The deployable count stays **3 + web** (ADR-001).

| Artifact | What it is | Home (no new deployable) |
|---|---|---|
| **Brain Pixel SDK (`brain.js`)** | versioned client script: anon-id + 30-min session mgmt, click-ID/UTM capture, `_fbc`/`_fbp`, event queue + offline retry, consent-awareness, **cart-attribute stitch writer** | `packages/pixel-sdk` → published static asset loaded on the merchant store |
| **Server-side first-party cookie setter** | sets the durable first-party cookie over the per-tenant CNAME (defeats ITP's JS-cookie cap) | a handler inside `apps/collector` |
| **Shopify Web Pixel extension + theme injection** | Shopify-sandbox pixel + `cart.attributes` writer + checkout capture | Shopify app bundle (distribution artifact) |
| **WooCommerce plugin** | header injection of `brain.js` + checkout/order-meta stitch + order/refund hooks | WP plugin (distribution artifact) |
| **Cart-stitch components** | client writer + webhook-side parser recovering `brain_anon_id`+click IDs+UTMs from the order payload | `packages/pixel-sdk` (write) + `core/modules/connector` parser (read) |
| **Post-purchase survey widget** | "how did you hear about us" → `collection.survey_response` (doc 07) → `survey_responses` (doc 08 §35) | storefront widget + collector ingest |
| **Connector framework + Connector SDK** | the canonical OAuth → idempotent-UPSERT → canonical-event → cursor/late-repull pattern as a reusable in-module SDK (a new source = a **folder, not a new branch**, §3.1) | `core/modules/connector/internal/sdk` |
| **Journey-builder logic** | sessionization → ordered touchpoint timeline per Brain ID (`silver.touchpoint`); **derived, replayable from Bronze — not a service/SoR** | `core/modules/attribution/internal/journey` (dbt + in-proc) |

The pixel SDK + store extensions are distributed **to the merchant storefront**; everything server-side rides the collector/stream-worker/core already enumerated in §2–§4.

## 4. The Collector & stream-worker structure

```
apps/collector/src/
├── main.ts
├── intake/            # POST /collect, /webhook/{connector}; HMAC verify; brand_id from key registry
├── envelope/          # build the universal envelope + consent snapshot + event_id
├── spool/             # the durable disk WAL — fsync → ACK (the 99.95% guarantee lives HERE, ADR-003)
├── drainer/           # async drain → lane router → Redpanda producer (swappable)
└── health/            # startup/ready/live probes (ready = producer + spool healthy)

apps/stream-worker/src/
├── main.ts
├── consumers/
│   ├── live.ts        # live consumer group
│   └── backfill.ts    # SEPARATE consumer group, concurrency-capped (load isolation, §6.4)
├── pipeline/          # HOT PATH (ingest SLA): accept→validate(Apicurio)→dedup(brand_id,event_id)→Bronze · DOWNSTREAM (own consumer groups off Bronze): enrich · sessionize · bot-filter · quality (identity resolves async) — doc 04 §6.6 H3
├── identity-bridge/   # hash via packages/identity-core → emit identity.resolution.requested (async)
└── sinks/             # Silver PK upserts; Bronze materialization handoff
```
Both import `packages/events`, `packages/contracts`, `packages/observability`, `packages/tenant-context`. The Collector's durability contract is in `spool/` so the producer (KafkaJS now, librdkafka/Go later — ADR-003) can swap with no contract change.

---

## 5. Shared packages & the contract source-of-truth

**`packages/contracts/` is the single source of truth for every interface.** Authoring flow (the stack's "Zod doubles as types" discipline):

```
Zod schemas (hand-authored)  ──┬──►  TypeScript types        (imported everywhere)
                               ├──►  OpenAPI spec            (REST APIs, §D — generated)
                               ├──►  Avro schemas → Apicurio (events, §E — generated + registered)
                               └──►  MCP tool schemas        (§N.7 — generated)
```
- One change to a Zod schema regenerates types + OpenAPI + Avro; CI fails on an uncommitted drift (the contract-testing gate). This is what makes "the proto/schema is the contract" real for a TS stack.
- `packages/metric-engine/` is pure, deterministic, dependency-light (no DB, no network) so the **parity oracle** (`tools/parity-oracle/`) can run it against an independent reference on golden fixtures. It is imported **only** by `core/modules/analytics` and `core/modules/measurement` (lint-enforced — ADR-004).
- `packages/identity-core/` carries the normalization + per-brand-salt hashing **with CI conformance vectors** (ADR-008) so the stream-worker and core resolve identifiers identically.
- `packages/audit/` is the hash-chained, WORM-anchored writer (§F.1.2) any module calls via `audit.record(...)`; `packages/money/` holds the minor-unit + currency helpers so the money-as-minor-units invariant lives in one place (and the float-ban lint has one home to point at).

---

## 6. The build system (Turborepo) & the `--affected` CI matrix

`turbo.json` (illustrative):
```jsonc
{
  "pipeline": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "typecheck": { "dependsOn": ["^build"] },
    "lint":      {},
    "test:unit": { "dependsOn": ["^build"] },
    "test:contract": { "dependsOn": ["^build"] },         // contracts vs generated OpenAPI/Avro
    "test:isolation": { "dependsOn": ["^build"] },         // cross-tenant negative tests
    "test:parity":    { "dependsOn": ["^build"] },         // metric-engine vs reference oracle
    "gen:contracts":  { "outputs": ["packages/contracts/generated/**"] }
  }
}
```
- **Remote cache** (S3-backed) so CI and every dev share build/test results — unchanged packages are never rebuilt.
- **`turbo run … --affected`** computes the changed-package set per PR and drives the **CI deploy matrix**: only the deployables whose dependency graph changed get built, scanned, and synced. (A change to `packages/metric-engine` correctly rebuilds `core`; a change to `apps/web` does not touch `collector`.)

---

## 7. Enforcing the modular monolith (import boundaries & guard lints)

The "modular monolith" is only real if the boundaries are *mechanically* enforced — otherwise it rots into a big ball of mud. ESLint rules (CI-blocking, Phase-1a):

1. **Module isolation** (`no-restricted-imports` / `eslint-plugin-boundaries`): a module may import another module's `index.ts` only — importing `modules/*/internal/**` or `modules/*/domain/**` across module borders fails the build.
2. **App-to-app ban:** `apps/*` cannot import `apps/*`.
3. **Metric-engine fencing:** only `analytics` and `measurement` may import `packages/metric-engine`.
4. **No non-additive SQL** (custom lint over `db/dbt/`): flags `round`, ratio, allocation, FX functions in dbt models — that math belongs only in `metric-engine` (ADR-004).
5. **Tenant-safe cache keys** (custom lint): raw Redis key construction is banned; all keys go through `packages/tenant-context`'s `brandKey()` helper (§H isolation seam).
6. **No PII in logs** (custom lint + a runtime redaction processor): bans logging known PII fields; enforced hardest on `identity/`.
7. **Eligibility-unwritable** (contract test, Phase-1a): the AI model-output schema must be disjoint from the eligibility/confidence/metric schema (§N.5).

---

## 8. Configuration, environment & secrets

- **12-factor config**, all env vars validated by a **Zod schema in `packages/config`** at process start — a missing/invalid var is a hard boot failure, never a silent default.
- **No secrets in the repo or env files.** Local dev uses a git-ignored `.env.local`; staging/prod inject via **External-Secrets → AWS Secrets Manager** (IRSA, no static creds — §K.5).
- **Per-brand KMS bootstrap:** brand creation (M1) generates a per-brand **data key (DEK)** wrapped by a regional CMK and stores the wrapped DEK in `brand_keyring` (ADR-013) — this is the crypto-shred target. The bootstrap is a `db/` + Terraform-coordinated step, codified so it can't be forgotten.
- **Config surfaces per deployable** are typed and documented in `packages/config` (e.g. `REDPANDA_BROKERS`, `DB_URL`, `LITELLM_BASE_URL`, `BRAND_KMS_CMK_ARN`).

---

## 9. Database, migrations & the dbt project

- **Postgres migrations** in `db/migrations/`, run by a versioned migration tool **[BUILD-TOOLING CHOICE]** (recommend `node-pg-migrate` or `drizzle-kit` — both are TS-native and let RLS policies + the no-UPDATE/DELETE grant on `audit_log` be expressed in plain SQL migrations). Each migration: forward + rollback; RLS `ENABLE` + policy is part of the table's own migration; the app connects as a **non-owner role** (never the migration role).
- **RLS bootstrap:** a base migration creates the non-owner app role, the `current_setting('app.current_brand_id')` convention, and the policy template; every brand-scoped table's migration applies it. The isolation-fuzz harness (`tools/isolation-fuzz/`) tests it.
- **StarRocks DDL** in `db/starrocks/` (versioned `.sql`, applied by an Argo job) — Silver PK tables + Gold marts (§F.2). **Iceberg/Glue** Bronze tables are created by Terraform + a bootstrap job (§F.3), partitioned `(bucket(brand_id), days(occurred_at))`.
- **dbt project** in `db/dbt/`: `staging/` (1:1 Bronze read + dedup on `(brand_id, event_id)`) → `intermediate/` (normalize, identity projection) → `marts/` (Silver + Gold). Tests: dbt schema tests + the **closed-sum** and **bounded-restatement-window** assertions as dbt tests (§F.6). Runs scheduled off-peak via Argo with StarRocks resource groups.

---

## 10. Local development bootstrap

Per doc 04 §17 — `docker-compose` with **profiles per zone**, so a dev brings up only what a ticket needs (the full stack is memory-heavy).

```
# default `up` = control-plane + serving (where most feature work happens)
pnpm dev                 # = docker compose --profile core up  +  turbo run dev --filter=core --filter=web
# bring up the strict-SLA path only when needed
pnpm dev:ingest          # = compose --profile ingest up (redpanda, apicurio) + collector + stream-worker
pnpm dev:full            # everything (heavy)
```
- **Real containers** (fidelity matters): Postgres, Redis, the IdP, Redpanda, Apicurio, MinIO (S3), a local Iceberg REST catalog (lakekeeper/Nessie), StarRocks, LiteLLM, Grafana/Loki. **LocalStack** emulates the thin AWS-API surface (S3/Secrets/KMS/EventBridge).
- **Seed:** `pnpm seed` creates 2 demo brands + a demo connector + sample events — and the isolation-fuzz suite runs against them so a dev can prove cross-brand isolation locally before pushing.
- **Run the gates locally:** `pnpm test:isolation`, `pnpm test:parity` are runnable on a laptop (they're the non-negotiable Phase-1a gates).

---

## 11. Testing layout & the CI gate mapping

Tests live **next to the code** (`*.test.ts`) plus three cross-cutting harnesses in `tools/`. Mapping to the doc-04 CI gates:

| Test type | Lives in | Gate (phase) |
|---|---|---|
| Unit | each package/module | 1a blocking |
| Contract (Zod ↔ generated OpenAPI/Avro) | `packages/contracts` | 1a blocking |
| **Tenant-isolation negative** (stores + seams + StarRocks + MCP) | `tools/isolation-fuzz` | 1a blocking |
| **Parity golden-fixture** (engine vs reference) | `tools/parity-oracle` | 1a blocking |
| **Decision-path purity** (no hot/non-finalized to guarded endpoints) | `apps/core/modules/analytics` | 1a blocking |
| **Eligibility-unwritable** contract | `apps/core/modules/ai` | 1a blocking |
| Integration (real containers) + real-network smoke | per app | pre-merge |
| **NLQ resolution eval / injection / faithfulness** (false-bind→0) | `tools/eval` | 1c blocking |
| a11y (WCAG 2.2 AA, status-never-colour-only) | `apps/web` | 1c blocking |
| Runtime parity-convergence monitor | `db/dbt` + Argo job | runtime (hourly) |

---

## 12. CI/CD wiring (GitHub Actions → ArgoCD)

```
.github/workflows/
├── pr.yml         # on PR: turbo --affected → lint · typecheck · unit · contract · isolation · parity · purity
│                  #        → docker build (affected apps) → trivy scan → smoke
├── deploy.yml       # on merge: build+sign(cosign) → push ECR (immutable digest)
│                  #        → bump Helm values (digest pin) → commit to gitops repo
└── eval.yml       # on prompt/model/registry change: NLQ resolution + injection + faithfulness gates
```
- **OIDC → AWS** (no static keys). **`--affected`** keeps PR CI fast.
- **ArgoCD app-of-apps** in `infra/argocd/`: per-env overlays (staging/prod, separate accounts); auto-sync with `selfHeal + prune`; **auto-rollback on health-probe failure**; `revisionHistoryLimit: 10` for one-command rollback. Prod sync is a manual promotion after staging smoke. (Canary/flag/60s-kill-switch is Phase-4, not built before there's autonomy to gate.)

---

## 13. The build order (dependency-ordered)

Build bottom-up so each layer compiles against a stable layer beneath it. This is the package/service sequence (it maps onto the Sprint plan in doc 04 §O.2):

```
1. packages/config + packages/contracts        # env schema + the contract source-of-truth
2. packages/db (+ RLS bootstrap) + db/migrations
3. packages/tenant-context + packages/observability   # the isolation + tracing seams
4. packages/events (+ Apicurio topic registry)
5. apps/core skeleton: platform/ + server/ + packages/audit + packages/feature-flags + core/workspace-access + RLS + audit chain   ← Sprint 0
6. tools/isolation-fuzz + tools/parity-oracle  (the non-negotiable gates, green before features)
7. packages/metric-engine + packages/money + core/measurement + core/analytics + core/data-quality   # the read path + grade/gating
8. apps/collector (spool) + apps/stream-worker + Bronze materialization        # the write path
9. packages/identity-core + core/identity
10. db/dbt (Silver/Gold) + gold.realized_revenue_ledger
11. core/connector (Shopify, Meta) + apps/web + core/frontend-api
   ── Phase-1a complete ──
12. core/billing (+ entitlement) + core/notification (chokepoint) + Razorpay/Google Ads  → Phase-1b
13. core/attribution + core/ai + core/recommendation + core/job-orchestration + MCP        → Phase-1c
```

---

## 14. Sprint-0 setup checklist (before feature work)

Concrete tasks to stand up the repo and the guardrails (ties to doc 04 §O.2 "S0"):
- [ ] `brain/` monorepo initialized: pnpm workspaces + Turborepo + `tsconfig.base.json` + ESLint with the boundary rules (§7).
- [ ] `packages/config` (Zod env schema) + `packages/contracts` skeleton + the codegen pipeline (Zod→OpenAPI/Avro/types) wired and CI-checked.
- [ ] Terraform: 2 AWS accounts (staging/prod), one EKS cluster (namespaced), RDS, S3+Glue, KMS (cmk-root + per-brand DEK path), Redpanda Cloud, ElastiCache, ECR, Secrets Manager — applied to staging.
- [ ] `db/migrations` base: non-owner app role, RLS policy template, hash-chained `audit_log` with **no UPDATE/DELETE grant**, `brand_keyring`.
- [ ] `apps/core` skeleton: Fastify + OTel + tenant-context middleware (non-null assertion) + revocation-denylist check + the four health probes.
- [ ] `apps/web` skeleton: Next.js + Shadcn + the `frontend-api` (Backend-for-Frontend) cookie↔token + CSRF.
- [ ] CI: `pr.yml` running lint + typecheck + unit + **isolation negative-test** + **parity golden-fixture** + build + trivy; ArgoCD app-of-apps deploying to staging with auto-rollback.
- [ ] `docker-compose` profiles + `pnpm dev`/`pnpm seed` working on a laptop; isolation + parity tests runnable locally.
- [ ] **Exit:** create 2 brands; a query with null tenant context hard-errors; a cross-brand query returns zero rows; the isolation negative-test and parity golden-fixture are green in CI. (= doc 04 §O.3 "1a" first checks.)

---

## 15. Engineering conventions & Definition of Done

- **Money** = `*_minor: bigint` + `currency_code` always paired; floats for money are lint-banned.
- **IDs** = app-generated UUID v7; tenant-scoped PKs lead with `brand_id`.
- **Every mutating endpoint** takes an `Idempotency-Key`; every brand-scoped query runs under a non-null tenant context.
- **Commits/PRs:** trunk-based, short-lived branches, conventional commits; one PR = one vertical slice.
- **Definition of Done (per PR):** types + lint + unit green · contracts regenerated & committed · **isolation negative-test green** · **parity gate green** (if it touches a metric) · real-network smoke for any new service · OTel spans carry `brand_id` · no PII in logs · audit entry written for any sensitive action · docs/ updated if a contract or invariant changed.

---

## 16. Build-tooling choices to confirm

These are reversible build-tooling picks (not architecture); confirm or swap before Sprint 0:
1. **Monorepo runner:** Turborepo (vs Nx). *Recommended: Turborepo* — lighter for a TS-only small team.
2. **Package manager:** pnpm (vs npm/yarn). *Recommended: pnpm* — strict boundaries + fast.
3. **Postgres migrations:** node-pg-migrate or drizzle-kit (vs Prisma Migrate). *Recommended: node-pg-migrate* — plain-SQL migrations make RLS policies + grant revocations explicit (Prisma's abstraction fights RLS).
4. **Codegen:** Zod → `zod-to-openapi` + `@kafkajs/confluent-schema-registry` Avro path (vs hand-written specs). *Recommended: generate from Zod* — one source of truth.
5. **Remote build cache backend:** Turborepo remote cache on S3 (vs Vercel). *Recommended: S3* — stays in-account/in-region.

None of these affect the architecture in doc 04; they affect developer ergonomics only.

---

*End of Implementation & Build Plan. Companions: `01`–`03` (requirements/spec/stack), `04_Brain_Architecture_and_Delivery_Plan.md` (the architecture + Part F implementation blueprint this plan operationalizes).*
