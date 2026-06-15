# Brain — API Architecture & Contract Specification (Phase 1)

**Product:** Brain — the AI-native commerce operating system for DTC brands in India, UAE & GCC.
**Document type:** API Architecture & Contract Specification — the authoritative, implementation-ready definition of every API required for **Phase 1**.
**Status:** Final v1. **Date:** 2026-06-14.
**Source of truth (read these first; this doc must not contradict them):** `01_…BRD`, `02_…Functional_Specification`, `03_…Technology_Stack`, `04_Brain_Architecture_and_Delivery_Plan.md` (esp. §C service catalog, §D API conventions, §E events, §H security), `05_Brain_Implementation_Build_Plan.md` (esp. §5 contracts package, the 13-module catalog).

**Deployables this spec serves (no microservices):** **Collector** (ingest endpoints), **Core modular monolith** (all `/api/v1/*` + MCP), **Stream-worker** (no HTTP API — consumer only), **Next.js frontend** (calls core via the `frontend-api` BFF). The 13 core modules (`workspace-access`, `connector`, `identity`, `measurement`, `attribution`, `analytics`, `billing`, `data-quality`, `ai`, `recommendation`, `notification`, `frontend-api`, `job-orchestration`) are the API owners.

**Scope discipline:** this document defines **Phase-1 APIs only**. Phase-2/3/4 APIs are listed in §11 (Deferred) and must not pollute Phase-1 contracts.

---

## Table of Contents
0. Review Board findings (boundaries · ownership · API-vs-event · versioning · naming)
1. API design standards
2. Domain ownership matrix + interaction-style (API vs Event vs Internal-Call) decisions
3. API catalog (grouped by domain)
4. Complete API contracts (critical endpoints, full schemas)
5. Internal APIs (Collector ↔ Core ↔ Stream-worker)
6. Public (customer-facing) APIs
7. AI APIs
8. API security architecture
9. API versioning strategy
10. OpenAPI generation strategy (from `packages/contracts`)
11. Deferred APIs (Phase 2/3/4 — documented, not built)

---

## 0. Review Board findings

The mandated board (CTO · Principal Solution/Backend/API/Data/Security/AI Architects · VP Eng · ex-Triple Whale · ex-Northbeam) challenged the API design **before** any endpoint was written. The architecture these APIs sit on was already vetted by two prior ARBs (doc 04 §F.0, doc 05 §1A); this review focused on API-specific decisions. Findings and resolutions:

1. **The Analytics API is the *sole DB read path* (ADR-002) — so "Attribution API" and "Customer API" are not separate read engines.** *Resolution:* attribution views, channel-contribution, customer-360, and all metrics are **reads routed through the `analytics` module** (registry-bound). `attribution`/`identity`/`measurement` *own the write/compute logic and the metric definitions*; they do **not** each expose a parallel read stack. This keeps one isolation surface and "same finalized number everywhere."
2. **The `frontend-api` (BFF) is an aggregation tier, not a separate contract surface.** *Resolution:* the canonical contracts are the domain REST APIs under `/api/v1/*`. The web app reaches them through the BFF (httpOnly cookie → short token → fan-out). MCP and external tools reach the *same* APIs with a token/MCP-key. We do **not** publish a separate "BFF API" contract — the BFF returns composed *view-models* assembled from these APIs (e.g. Home/Command-Center).
3. **Prefer events over internal synchronous APIs (anti-API-first).** *Resolution:* Collector→Core, Stream-worker→Core, and connector ingestion are **event-driven** (Redpanda), not REST. The only internal HTTP is health/readiness probes and the job-orchestration trigger contract. §5 keeps internal APIs minimal.
4. **Pixel/webhook ingestion is NOT under `/api/v1`.** *Resolution:* the Collector deployable exposes `/collect` and `/webhook/{connector}` with **accept-before-validate** + HMAC, returning `202` and never a schema 4xx (doc 04 §7/§D.3). These are a distinct, separately-rate-limited surface from the core API.
5. **MCP is read-only and never invokes a Brain-side model (resolves doc 04 C5).** *Resolution:* MCP tools resolve to registry metrics via the Analytics API; the *caller's* LLM is the only model. MCP keys are first-class revocable principals scoped to `brand_id × intersection(issuer authority, requested scopes)`.
6. **"Finalized-only" must be enforceable at the contract layer.** *Resolution:* guarded read endpoints (billing/decision/attribution-bearing) return `409 NON_FINALIZED_ON_GUARDED_ENDPOINT` rather than serving hot/provisional rows; every metric response carries `recognition_label` + `as_of` + `confidence` (doc 04 §D.5, §10.4).
7. **Naming/serialization consistency (ex-TW/ex-Northbeam lens).** *Resolution:* **snake_case JSON wire format** across APIs *and* events — identical field names to the metric registry, the event envelope, and the DB (`value_minor`, `currency_code`, `brand_id`, `economic_effective_at`). Money is always `*_minor: integer` + `currency_code`. This matches the "same name everywhere" ethos and removes a class of mapping bugs. (TypeScript types are generated from the same Zod schemas — §10.)
8. **Versioning: URL-major `/api/v1`, additive-only within a major (doc 04 §E discipline).** *Resolution:* breaking changes → `/api/v2` + a dual-read window; events version per-topic `.v{n}` with **Apicurio FULL_TRANSITIVE** compatibility (doc 04 §6.6). §9.
9. **No raw query / text-to-SQL anywhere.** *Resolution:* `POST /metrics/query` is **registry-bound** (`metric_id` + filters + grain + range), never SQL; NLQ binds to `metric_id` (never SQL); MCP tools are enumerated. (doc 04 §10.9, §11.3.)
10. **Idempotency + correlation + tenant headers are mandatory, not optional (Principal API Architect).** *Resolution:* every mutating endpoint requires `Idempotency-Key`; every request carries/echoes `X-Correlation-Id`; brand-scoped endpoints require `X-Brand-Id` asserted non-null (a missing tenant context is a hard error, never default-to-all). §1.

**Top API-design risks flagged & mitigated:** (a) read-path sprawl → one read path (finding 1); (b) over-building internal REST → events-first (finding 3); (c) hot-number leakage into money/decisions → contract-level 409 guard (finding 6); (d) cross-tenant leakage via API → `X-Brand-Id` non-null assertion + RLS + per-endpoint authz + the isolation-fuzz suite covering the API layer (§8); (e) contract drift → Zod-as-source-of-truth + CI contract test (§10).

### 0.1 Final review addendum (v1.1 — Principal Architect pass, 2026-06-14)
A final board pass closed operational-visibility, consent, privacy, and AI-history gaps and made two ownership boundaries explicit. **No architecture, boundary, deployment, or domain change.** All additions are Phase-1, read-only unless noted.

**New APIs added** (catalog §3 + contracts §4 updated): connector job-visibility — `GET /connectors/{connectorId}/jobs`, `…/jobs/{jobId}` (§3.5); platform job monitoring — `GET /jobs`, `…/{jobRunId}` (§3.15); consent read — `GET /customers/{brainId}/consent` (§3.6); privacy/DSAR — `POST /privacy/erasure-requests`, `GET /privacy/erasure-requests[/{requestId}]` (§3.16; access/portability = `POST /exports {scope:dsar}`); AI query history — `GET /ai/queries[/{queryId}]` (§7.7).

**Clarifications added:** the API Consumer Matrix (§2.3); identity-resolves / analytics-serves customer ownership (§2.4); job-orchestration coordinates + monitors but owns no business logic (§2.4).

**Governance:** every new endpoint inherits §1 — tenant-scoped, cursor-paginated lists, audited, rate-limited; the new reads are GETs (no idempotency key needed), the one new mutation (erasure submit) requires `Idempotency-Key`.

**Final readiness (the freeze gate before `07_Brain_Event_Contracts.md`):**
| Dimension | Rating | Note |
|---|---|---|
| API architecture | ✅ Ready | clean boundaries; one read path; events-first |
| Security | ✅ Ready | Authentik/JWT + revocation + RLS + MCP scoping + webhook HMAC |
| Multi-tenancy | ✅ Ready | `X-Brand-Id` non-null + RLS + API-layer isolation-fuzz |
| Operational support | ✅ Ready | *was the main gap* — closed by connector job rows (§3.5) + platform jobs (§3.15) |
| AI readiness | ✅ Ready | NLQ/MCP/provenance + history (§7.7) + CI eval gates |
| Engineering readiness | ✅ Ready | full catalog + Zod-source-of-truth → OpenAPI/types (§10) |

**Verdict: READY TO FREEZE.** No critical issues remain.

**APIs that map to events in doc 07 (the handoff).** Doc 06 is already events-first — **no API is removed or replaced by an event.** The synchronous REST endpoints are the correct human/operator contracts; their *side-effect propagation* is event-based and those event contracts are owned by **doc 07**:
- `/collect`, `/webhook/{connector}` → emit `raw.*` / connector events — doc 06 owns the HTTP accept contract; **doc 07 owns the event payloads.**
- `POST /connectors/{id}/sync|backfill` → sync-command / `backfill.requested`.
- `POST /identity/merge|unmerge`, review-resolve → `merge.committed` / `unmerge.committed` / `alias.repointed`.
- `POST /recommendations/{id}/respond` → writes the Decision Log + emits `decision.recorded`.
- `POST /billing/period/{period}/seal` → `billing.period.sealed`.
- `POST /privacy/erasure-requests` → `erasure.requested` (consumed by the crypto-shred job).
- Consent withdrawal → `consent.withdrawn`.
- **Pure events, no API at all (fully doc 07):** identity resolution, attribution credit/clawback, recommendation generation, notification fan-out, DQ signals, connector health changes. (Job *status* is a read API by design — you pull status, you don't "event" a query.)

### 0.2 Final review addendum (v1.2 — operational-hardening pass, 2026-06-14)
A final pass added operational/governance guardrails — **no architecture, boundary, deployment, or domain change.**
- **Added:** API lifecycle stages (§9.1); query cost guardrails (§1.13); caching strategy (§1.14); API SLO targets (§1.15); feature-flag ownership (§2.5); collector throughput & abuse protection (§8.9); reserved Phase-2+ architecture — partner/programmatic API access + outbound-webhook framework (§11.1).
- **Final consistency review:** **Critical — none.** **Medium — the operational gaps above** (query cost limits, collector abuse/back-pressure, cache freshness, SLO targets) — *now closed.* **Low — none outstanding for Phase 1** (lifecycle/partner/webhook reserved deliberately).
- **Readiness (the freeze gate before `07_Brain_Event_Contracts.md`):**

| Dimension | Rating |
|---|---|
| API architecture | ✅ Ready |
| Security | ✅ Ready |
| Multi-tenancy | ✅ Ready |
| Operational support | ✅ Ready |
| Performance | ✅ Ready (cost guardrails + cache + SLOs) |
| AI readiness | ✅ Ready |
| Engineering readiness | ✅ Ready |

**Verdict: FROZEN-READY — proceed to `07_Brain_Event_Contracts.md`.**

---

## 1. API design standards

### 1.1 Versioning & base path
- All core APIs under **`/api/v1`** (URL-major versioning). MCP under `/mcp`. Collector ingest under `/collect`, `/webhook/{connector}` (un-versioned edge — its contract is the Avro event schema, governed by Apicurio).
- One major version live at a time in Phase 1; `/api/v2` only on a breaking change (§9).

### 1.2 Naming conventions
- **Resources are plural nouns**, kebab-case in paths: `/brands`, `/connectors`, `/customers`, `/metrics`, `/billing/invoices`, `/notifications`.
- **Path params** in camelCase: `/brands/{brandId}`, `/connectors/{connectorId}`, `/customers/{brainId}`.
- **Non-CRUD actions** as a sub-resource verb: `POST /identity/merge`, `POST /connectors/{connectorId}/sync`, `POST /billing/period/{period}/seal`, `POST /recommendations/{recommendationId}/respond`.
- **JSON body fields: `snake_case`** (matches the event envelope + metric registry + DB). Money: `*_minor` (integer) + `currency_code` (ISO-4217). Timestamps: ISO-8601 UTC (`...Z`). IDs: typed string prefixes (`brd_`, `con_`, `usr_`, `bid_`, `inv_`, `snp_`, `rec_`, `ntf_`, `mcpk_`) over UUID v7.

### 1.3 Request standards
- `Content-Type: application/json` for bodies. UTF-8.
- All inputs validated by **Zod** at the edge (four-layer validation); unknown fields rejected (`422`).
- Brand-scoped endpoints **require** `X-Brand-Id`; the server sets the Postgres tenant context from it and **asserts non-null before any query**.

### 1.4 Response standards
- Success bodies are objects (never bare arrays — wrap lists in `{ "data": [...], "page": {...} }`).
- Money always paired (`*_minor` + `currency_code`). Every metric-bearing response carries `metric_version`, `as_of`, `recognition_label` (`provisional|settling|finalized`), and `confidence` where applicable.
- `X-Correlation-Id` echoed on every response.

### 1.5 Error standards
Uniform envelope; HTTP status + a stable machine `code`:
```json
{ "error": { "code": "STRING_CODE", "message": "human readable", "trace_id": "...", "details": {} } }
```
| Status | Meaning | Example `code` |
|---|---|---|
| 400 | malformed request | `BAD_REQUEST` |
| 401 | unauthenticated / token invalid or revoked | `UNAUTHENTICATED`, `TOKEN_REVOKED` |
| 403 | authenticated but not permitted / wrong brand | `FORBIDDEN`, `CROSS_BRAND_DENIED` |
| 404 | not found (or not visible in this brand) | `NOT_FOUND` |
| 409 | conflict / state / guard | `IDEMPOTENCY_CONFLICT`, `ALREADY_SEALED`, `CYCLE_DETECTED`, `NON_FINALIZED_ON_GUARDED_ENDPOINT` |
| 422 | schema/validation failure | `VALIDATION_FAILED`, `AI_CONSENT_MISSING` |
| 429 | rate/limit/budget exceeded | `RATE_LIMITED`, `BUDGET_EXHAUSTED`, `LIMIT_ROWS` |
| 500 | server error (trace_id always present) | `INTERNAL` |

### 1.6 Pagination, filtering, sorting
- **Cursor (keyset) pagination only — OFFSET is banned** (api-discipline). `?limit=<=200&cursor=<opaque>` → `{ "data":[...], "page": { "next_cursor": "...|null", "has_more": true } }`.
- **Filtering:** explicit typed query params per endpoint (e.g. `?state=Healthy`, `?from=2026-05-01&to=2026-05-31&channel=meta`). No generic query DSL on public APIs.
- **Sorting:** `?sort=field` / `?sort=-field` (prefix `-` = desc); only allowlisted fields per endpoint.

### 1.7 Rate limiting
- Token-bucket, **tenant-scoped** (`brand_id`), returned via `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `Retry-After`. Defaults: read 120/min/brand, mutations 30/min/brand, NLQ 20/min/brand, MCP per-key configurable, `/collect` high-throughput per-brand pixel-key bucket.

### 1.8 Idempotency
- **Every** `POST`/`PATCH`/`PUT`/`DELETE` requires `Idempotency-Key: <uuid>`; the result is cached 24h and replayed on repeat (same key + same body → same response; same key + different body → `409 IDEMPOTENCY_CONFLICT`). `/collect` dedups on the event's own `event_id`.

### 1.9 Correlation IDs
- `X-Correlation-Id` accepted from the client or generated; propagated through Redpanda envelopes, OTel spans, and logs; echoed in responses. Every log line + span also carries `brand_id` (PII-redacted).

### 1.10 Tenant headers
- `X-Brand-Id: brd_…` required on brand-scoped endpoints. Org-scoped (Owner rollup, billing-at-org) endpoints omit it. The Owner rollup reads **N isolated brand reads stitched at the presentation layer**, never a cross-brand query.

### 1.11 Audit requirements
- Every mutation, every AI/NLQ/MCP query, every export, every billing/role/connector/identity change writes to the **hash-chained, WORM-anchored audit log** (doc 04 §F.1.2). AI calls additionally write provenance (model+version, prompt-hash, metric-binding, snapshot pins).

### 1.12 Security requirements (summary; full in §8)
- AuthN via **Authentik OIDC**; access JWT (15 min) + rotating refresh (7 d); a **revocation denylist** checked on **every** protected action. AuthZ is by **permission** (4 roles) enforced in JWT claims + Postgres RLS + MCP scopes — never in app code. TLS everywhere; per-brand KMS; secrets via Secrets Manager.

### 1.13 Query cost guardrails (`/metrics/query` and all reads)
To protect StarRocks now and the Iceberg/Trino path later, every registry-bound query is **bounded at the contract layer** (enforced by the Analytics API, not left to the engine):
- **Max lookback:** 24 months (= Bronze retention) → beyond, `422 LOOKBACK_EXCEEDED`.
- **Max grain dimensions:** ≤ 4 per query → beyond, `422 TOO_MANY_DIMENSIONS`.
- **Max rows:** 10,000/response (cursor-paginate beyond); hard ceiling 50,000 → `429 LIMIT_ROWS`.
- **Query timeout:** 10 s interactive → `429 LIMIT_TIMEOUT` (never a partial result).
- **Result size:** ≤ 5 MB → `429 LIMIT_ROWS` (narrow the query, or use Exports).
- **Concurrency:** per-brand in-flight-query cap → excess `429 RATE_LIMITED` + `Retry-After`.
Bulk/large extracts go through **Exports** (async, §3.7), never the interactive path. **MCP inherits these limits** (its typed errors, §7.4). Limits are per-plan configurable but have hard ceilings.

### 1.14 Caching strategy (the Analytics API owns its cache)
The Analytics API (sole read path) owns a single **Redis** read-through cache (tenant-scoped keys via `tenant-context.brandKey()`):
- **Cache key** = `brand_id + metric_id + metric_version + filters_hash + grain + as_of` — `metric_version` in the key means a definition change auto-busts.
- **TTLs by surface:** dashboard widgets / metrics **30–60 s** · Customer 360 **60 s** · connector health **15 s** · recommendations **60 s** · **billing preview not cached** (money, read-on-demand). **Finalized** reads may cache longer; **provisional/hot** reads get a short TTL and never reach guarded endpoints (the 409 guard).
- **Invalidation principle:** TTL + event-nudged — a new finalized ledger window, a connector resync, or a merge/unmerge bumps the relevant `as_of`/`metric_version`, so stale keys fall out naturally (**no manual purge bus**).
- **Freshness expectation:** numbers are fresh within their surface's TTL; the response always returns `as_of` so the UI shows real freshness.
This is one Redis cache in front of one read path — **not** a distributed cache mesh.

### 1.15 API SLO targets (Phase 1 — aligns with doc 04 §I; engineering goals, not contractual SLAs)
| API class | Availability | Latency p95 | Freshness |
|---|---|---|---|
| Auth (login/refresh) | 99.9% | < 300 ms | n/a |
| Metrics query / `{metricId}` | 99.9% | < 800 ms | within surface TTL; `as_of` returned |
| Customer 360 | 99.9% | < 800 ms | < 60 s |
| Connector health | 99.9% | < 300 ms | < 15 s |
| Recommendations | 99.9% | < 800 ms | from last finalized window |
| Billing preview | 99.9% | < 1.5 s | finalized rows only |
| NLQ | 99.5% | < 4 s (narration) | number deterministic; `as_of` returned |
| `/collect` (ingest) | **99.95% accept+ack** | < 50 ms ack | n/a (durability in spool) |
Error-budget burn alerts per doc 04 §I.2–§I.3. The collector's 99.95% is the strictest (billing-integrity surface).

---

## 2. Domain ownership matrix + interaction-style decisions

### 2.1 Domain ownership matrix
"Public API" = customer/operator-facing under `/api/v1`. "Internal" = in-process module call or internal HTTP. Events = doc 04 §E.

| Domain (module) | Owns | Public API | Internal | Key events (produced ▸ / consumed ◂) |
|---|---|---|---|---|
| **workspace-access** | orgs, brands, users, roles, sessions, invites, audit | Auth, Users, Organization, Brands, Members/Invites, Settings, Audit-log | in-proc | ▸ `audit.action.logged`, `workspace.member.changed`, `permission.revoked` · ◂ `billing.degraded.readonly` |
| **connector** | connector lifecycle, OAuth, cursors, backfill, settlement, tracking-plan | Connectors, Catalog, Tracking-plan, Pixel-config | in-proc + Collector webhooks | ▸ `connector.connected`, `order.upserted`, `settlement.received`, `backfill.requested` · ◂ `connector.health.changed` |
| **identity** | Brain ID, alias graph, merge/unmerge, phone guard, review queue, PII vault | Customers (360 read), Identity merge/unmerge, Review-queue | async writer (off Bronze) | ▸ `brain_id.minted`, `alias.repointed`, `merge.committed`, `unmerge.committed` · ◂ `identity.resolution.requested` |
| **measurement** | metric registry, the deterministic metric engine, FX, cost-confidence | Metrics-catalog (read), Cost-setup, Goals | **library** (no HTTP) | — |
| **attribution** | journey, credit ledger, two-pass + clawback, channel contribution | *(read via analytics)* | jobs + in-proc | ▸ `credit.provisional.assigned`, `credit.finalized`, `credit.clawed_back` · ◂ `ledger.finalized`, `order.upserted` |
| **analytics** | **the sole DB read path**, semantic layer, finalized-only policy | Metrics query, Attribution views, Decision-log, Exports | in-proc | ▸ `audit.query.logged` |
| **billing** | meter, cap, true-up, seal, invoice, dunning, entitlement | Billing (preview/invoices/seal/value-proof/subscription/payment-method) | jobs | ▸ `billing.period.sealed`, `billing.degraded.readonly`, `trueup.posted` · ◂ `ledger.finalized` |
| **data-quality** | DQ grade, gating table, quality signals | Data-quality (read), Tracking-health (read) | in-proc | ▸ `dq.grade.updated` · ◂ `dq.signal.raised`, `connector.health.changed` |
| **ai** | NLQ, MCP server, prompt registry, eval, provenance | NLQ, Brief, MCP, MCP-keys | gateway-client (LiteLLM) | ▸ `nlq.query.resolved`, `ai.provenance.recorded` |
| **recommendation** | deterministic threshold detectors → recommendation contract | Recommendations (read + respond) | in-proc | ▸ `recommendation.generated` · ◂ `ledger.finalized`, `dq.signal.raised` |
| **notification** | 3 tiers + the single send/consent chokepoint | Notifications, Notification-preferences | in-proc | ▸ `notification.sent`, `send.suppressed` · ◂ `recommendation.generated`, `connector.health.changed`, `dq.signal.raised`, `consent.withdrawn` |
| **frontend-api** | BFF: cookie↔token, CSRF, view-model fan-out | *(composes the above; no own contract)* | in-proc | — |
| **job-orchestration** | cron catalog, overlap-lock, backfill orchestration | *(internal trigger only)* | internal HTTP/CLI (Argo) | ▸ `job.started/completed/failed` · ◂ `backfill.requested` |

### 2.2 Interaction-style decision (API vs Event vs Internal-Call)
| Interaction | Style | Reasoning |
|---|---|---|
| Pixel/app event capture | **Event** (via `/collect` accept→spool→Redpanda) | high volume, fire-and-forget, durability-in-spool; a synchronous API round-trip per event is wrong. |
| Connector order/settlement ingestion | **Event** (webhook → Collector → Redpanda; or poll job → Redpanda) | async, replayable, same-code-path live & backfill. |
| Connect/disconnect/retry a connector | **REST** | operator-initiated, synchronous, needs an immediate result + status. |
| Identity resolution | **Event** (async writer off Bronze) | must not block the 99.95% path; eventually-consistent is fine (money reads finalized only). |
| Merge / unmerge / resolve-review | **REST** | human-initiated, needs a synchronous confirmation + audit entry. |
| Attribution credit/clawback compute | **Event/jobs** | derived, runs on ledger events; not request-driven. |
| Reading any metric / attribution view / customer 360 | **REST (read via analytics)** | synchronous query, registry-bound. |
| Recommendation generation | **Event/internal** (detectors on `ledger.finalized` / `dq.signal.raised`) | reactive, not request-driven. |
| Reading Top-3 / responding to a recommendation | **REST** | operator interaction; the response writes the Decision Log synchronously. |
| Notification fan-out | **Event** internally; **REST** to read/ack/prefs | delivery is reactive; the inbox + preferences are request-driven. |
| Billing period seal | **Internal job** (Argo) + **REST** preview/confirm | sealing is scheduled/owner-confirmed; preview is a read. |
| Cross-module within core (e.g. analytics → metric-engine) | **Internal-call** (in-process) | same deployable; an event or REST hop would be pure overhead. |
| Collector → Core, Stream-worker → Core | **Event** (never REST) | decoupled, durable; §5. |

### 2.3 API Consumer Matrix
Who actually calls each major API. *Dashboard* = web via the BFF; *NLQ/MCP* = AI surfaces; internal consumers are named modules.
| API | External / UI consumers | Internal consumers |
|---|---|---|
| Metrics query / `{metricId}` | Dashboard, NLQ, MCP, Exports | Recommendation engine, Billing (preview), Morning Brief |
| Customer 360 / Customers | Dashboard, MCP | Recommendation engine |
| Customer consent (read) | Dashboard, Ops/Support | Notification chokepoint (suppression) |
| Attribution views / channel-contribution | Dashboard, MCP | Recommendation engine |
| Recommendations + respond | Dashboard, Morning Brief | Decision Log |
| Connector health | Dashboard | Recommendation engine (detectors), Notification |
| Connector jobs (sync/backfill status) | Dashboard, Ops/Support | — |
| Platform jobs (`/jobs`) | Dashboard (Owner), Ops/Support | — |
| Data-quality / tracking-health | Dashboard | Recommendation engine, Billing (cap gate) |
| Billing preview / invoices / value-proof | Dashboard | — |
| Notifications + preferences | Dashboard, mobile-web/push | — |
| NLQ | Dashboard | — |
| MCP tools | the brand's own LLM / agent | — |
| AI query history | Dashboard, Ops/Support | — |
| Exports (report/full/dsar) | Dashboard | Offboarding, DSAR |
| Audit log | Dashboard (Owner/Brand Admin), Ops/Support | — |

### 2.4 Ownership clarifications (boundary guards)
**Customer — `identity` resolves, `analytics` serves.**
- **`identity` owns** Brain ID, the identity graph, the `brain_id_alias` graph, merge/unmerge logic, the phone guard, the review queue, the PII vault, and per-profile identity-confidence. All identity *writes* (`/identity/merge`, `/identity/unmerge`, review-resolve) are identity-owned.
- **`analytics` owns** the Customer 360 *read model*, customer analytics, and insights — served through the sole read path. `GET /customers/...` is an **analytics-served read of an identity-resolved + analytics-derived model.**
- **Rule:** `analytics` must never resolve, merge, or mint identity; `identity` must never compute customer analytics. The Customer 360 read is fully rebuildable from the identity graph + the lakehouse.

**Jobs — `job-orchestration` coordinates; the domains own the logic.**
- **`job-orchestration` owns** scheduling, the cron catalog, overlap-locks, run tracking, the trigger contract, and the **read-only job-visibility APIs (§3.15)**.
- The **business logic of every job lives in its domain module**: billing-seal in `billing`, attribution rebuild/clawback in `attribution`, DQ recalculation in `data-quality`, identity erasure/crypto-shred in `identity`, sync/backfill in `connector`, parity/reconciliation in `analytics`/`measurement`. `job-orchestration` invokes those domains' job entrypoints; it owns **no** business logic itself.

### 2.5 Feature-flag ownership (consistency with doc 05 `packages/feature-flags`)
- **Evaluation** is owned by **`packages/feature-flags`** (a shared library, in-process; doc 05 §1A.1 #8): `enabled(key, { brandId })` / `variant(...)`, tenant-aware, Redis-cached.
- **Definitions** (the typed flag registry + defaults + owner) live in the library's `definitions.ts`; **per-brand overrides** live in a small Postgres table read by the evaluator.
- **Configuration is operational, not product-facing in Phase 1** — flags are set by Brain staff via the internal `admin`/`platform` surface, not by a public tenant API. Categories: `connector.<type>.enabled`, `recommendation.<detector>.enabled`, `ai.<capability>.enabled`, `beta.<feature>`.
- **Distinct from entitlements:** plan-paid feature access lives in `billing` (entitlement); feature-flags handle ops kill-switches + beta/rollout. The evaluator may read entitlements as one input.
- **No public flag API in Phase 1** (a tenant-facing flag/admin API is Phase 2+, §11.1). This is intentionally **not** a LaunchDarkly clone; the Phase-4 progressive-delivery/canary infra is separate (doc 04).

---

## 3. API catalog (grouped by domain)

Each row: **Endpoint · Method · Purpose · Owner · Consumer · Auth · Authz (permission) · Idempotent · Sync/Async.** Consumer key: **W**=web (via BFF), **X**=external/3rd-party token, **M**=MCP, **S**=system/Argo.

### 3.1 Authentication APIs — `workspace-access`
| Endpoint | M | Purpose | Consumer | Auth | Authz | Idem | S/A |
|---|---|---|---|---|---|---|---|
| `/api/v1/auth/register` | POST | create org + Owner | W/X | public | — | ✓ | sync |
| `/api/v1/auth/login` | POST | password/Google login | W/X | public | — | ✓ | sync |
| `/api/v1/auth/mfa/verify` | POST | second factor | W/X | partial-token | — | ✓ | sync |
| `/api/v1/auth/token/refresh` | POST | rotate refresh→access | W/X | refresh token | — | ✓ | sync |
| `/api/v1/auth/logout` | POST | end session(s) (`?scope=all`) | W/X | bearer | self | ✓ | sync |
| `/api/v1/auth/password/forgot` | POST | request reset magic link | W/X | public | — | ✓ | sync |
| `/api/v1/auth/password/reset` | POST | set new password via link | W/X | reset token | — | ✓ | sync |
| `/api/v1/auth/email/verify` | POST | verify email via link | W/X | verify token | — | ✓ | sync |
| `/api/v1/auth/revoke` | POST | revoke session/key/token | W | bearer | Owner/self | ✓ | sync |

### 3.2 User APIs — `workspace-access`
`GET /users/me` · `PATCH /users/me` · `GET /users/me/sessions` · `DELETE /users/me/sessions/{sessionId}` — self-scoped.

### 3.3 Organization & Brand APIs — `workspace-access`
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/organization` | GET | caller's org | member | — |
| `/api/v1/organization` | PATCH | update org | Owner | ✓ |
| `/api/v1/organization/rollup` | GET | cross-brand rollup (N isolated reads) | Owner | — |
| `/api/v1/organization/ownership-transfer` | POST | transfer (step-up MFA) | Owner | ✓ |
| `/api/v1/brands` | GET | list accessible brands | member | — |
| `/api/v1/brands` | POST | create brand | Owner | ✓ |
| `/api/v1/brands/{brandId}` | GET/PATCH | read/update brand | Brand Admin+ | ✓(PATCH) |
| `/api/v1/brands/{brandId}` | DELETE | export-then-delete | Owner | ✓ |
| `/api/v1/brands/{brandId}/readiness` | GET | Brand Readiness Score | member | — |
| `/api/v1/brands/{brandId}/settings` | GET/PUT | consolidated settings (currency/tz/revenue-def/consent-text/attribution-model) | Brand Admin+ | ✓(PUT) |
| `/api/v1/brands/{brandId}/cost-setup` | GET/PUT | cost inputs (→ cost-confidence) | Brand Admin/Owner | ✓ |
| `/api/v1/brands/{brandId}/goals` | GET/POST/PATCH/DELETE | goals + RAG | Brand Admin+ | ✓ |

### 3.4 Member & Invite APIs — `workspace-access`
`GET /brands/{brandId}/members` · `POST /brands/{brandId}/members` (invite) · `PATCH /brands/{brandId}/members/{userId}` (role) · `DELETE /brands/{brandId}/members/{userId}` (remove) · `POST /invites/{token}/accept`. Authz: Owner / Brand Admin per the invite hierarchy.

### 3.5 Connector & Pixel APIs — `connector`
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/connectors/catalog` | GET | marketplace catalog + honest status | member | — |
| `/api/v1/connectors` | GET | brand's connectors | member | — |
| `/api/v1/connectors` | POST | connect (OAuth/credentials) | Owner/Brand Admin/Manager | ✓ |
| `/api/v1/connectors/{connectorId}` | GET | connector detail | member | — |
| `/api/v1/connectors/{connectorId}` | DELETE | disconnect (revoke tokens) | Owner/Brand Admin/Manager | ✓ |
| `/api/v1/connectors/{connectorId}/health` | GET | seven-state health + freshness + rec-safety | member | — |
| `/api/v1/connectors/{connectorId}/sync` | POST | `{action: start\|pause\|resume\|retry}` | Owner/Brand Admin/Manager | ✓ |
| `/api/v1/connectors/{connectorId}/backfill` | POST | trigger 24-mo backfill (backfill lane) | Owner/Brand Admin | ✓ |
| `/api/v1/connectors/{connectorId}/tracking-plan` | GET/PUT | event-governance surface | Owner/Brand Admin/Manager | ✓(PUT) |
| `/api/v1/connectors/{connectorId}/jobs` | GET | list sync/backfill/retry jobs (status + progress) — operability | member | — |
| `/api/v1/connectors/{connectorId}/jobs/{jobId}` | GET | job detail: records processed, cursor, error reason, timing | member | — |
| `/api/v1/brands/{brandId}/pixel` | GET | pixel snippet + key + install status | Owner/Brand Admin/Manager | — |
| `/api/v1/oauth/callback/{connectorType}` | GET | OAuth redirect handler | public(state-signed) | — |

### 3.6 Identity & Customer APIs — `identity` (reads via `analytics`)
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/customers` | GET | search/list (PII-minimized) | `customer.read` | — |
| `/api/v1/customers/{brainId}` | GET | Customer 360 (PII-min per role; analytics-served read of an identity-resolved model — §2.4) | `customer.read` | — |
| `/api/v1/customers/{brainId}/consent` | GET | consent state + history (analytics/marketing/ai_processing/personalization) | `customer.read` | — |
| `/api/v1/identity/merge` | POST | manual merge (versioned rule) | Brand Admin/Owner | ✓ |
| `/api/v1/identity/unmerge` | POST | reverse a merge | Brand Admin/Owner | ✓ |
| `/api/v1/identity/review-queue` | GET | phone-guard conflict queue | Brand Admin/Owner | — |
| `/api/v1/identity/review-queue/{reviewId}/resolve` | POST | `{action: merge\|keep_apart}` | Brand Admin/Owner | ✓ |

### 3.7 Measurement / Analytics / Attribution APIs — `analytics` (+ `measurement` defs)
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/metrics/catalog` | GET | registered metric definitions (+ versions) | member | — |
| `/api/v1/metrics/{metricId}` | GET | resolve one metric (filters via query) | permission-gated | — |
| `/api/v1/metrics/query` | POST | registry-bound multi-metric/grain query (NEVER SQL) | permission-gated | — |
| `/api/v1/attribution/orders/{orderId}/journey` | GET | per-order journey + credit | Manager+ | — |
| `/api/v1/attribution/channel-contribution` | GET | closed-sum contribution (range+method+confidence) | member | — |
| `/api/v1/decision-log` | GET | the Decision Log (append-only) | member | — |
| `/api/v1/exports` | POST | `{scope: report\|full_brand\|dsar}` (async) | report:member; full/dsar:Owner/Brand Admin | ✓ |
| `/api/v1/exports/{exportId}` | GET | export status + signed URL | requester | — |

### 3.8 Data-Quality APIs — `data-quality`
`GET /api/v1/brands/{brandId}/data-quality` (grade + sub-scores + what it gates) · `GET /api/v1/brands/{brandId}/tracking-health` (event-quality, client-vs-server match-rate, tracking-dark). Authz: member.

### 3.9 Billing APIs — `billing`
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/billing/subscription` | GET | plan, tier, state | Owner/Brand Admin(r) | — |
| `/api/v1/billing/preview` | GET | `?period=` inspectable pre-invoice | Owner(act)/Brand Admin(view) | — |
| `/api/v1/billing/invoices` | GET | invoice history | Owner/Brand Admin(r) | — |
| `/api/v1/billing/invoices/{invoiceId}` | GET | invoice detail (self-explaining lines) | Owner/Brand Admin(r) | — |
| `/api/v1/billing/period/{period}/seal` | POST | seal the meter snapshot | system(Argo)/Owner-confirm | ✓ |
| `/api/v1/billing/value-proof` | GET | recovered-CM2/fee ratios | Owner/Brand Admin | — |
| `/api/v1/billing/payment-method` | PUT | set gateway token | Owner | ✓ |

### 3.10 Notification APIs — `notification`
`GET /api/v1/notifications` (filter by tier) · `POST /api/v1/notifications/{notificationId}/ack` · `GET /api/v1/notifications/preferences` · `PUT /api/v1/notifications/preferences`. Authz: self/role-scoped.

### 3.11 Recommendation APIs — `recommendation`
`GET /api/v1/recommendations` (Top-3 / queues, each = the recommendation contract) · `POST /api/v1/recommendations/{recommendationId}/respond` (`{action: approve|reject|edit|ask_why, ...}` → Decision Log). This is the **AI Feedback API** for Phase 1 (recommend-only). Authz: read=member; respond=Manager+ (execution-class per the approval matrix).

### 3.12 AI & MCP APIs — `ai` (see §7 for full contracts)
`POST /api/v1/ai/nlq` · `GET /api/v1/ai/brief` (latest Morning Brief) · `GET /api/v1/ai/queries[/{queryId}]` (AI query history + provenance, §7.7) · `GET/POST/DELETE /api/v1/mcp/keys` · `POST /mcp` (tool-call endpoint). Internal/CI: prompt-registry + eval (§7.6).

### 3.13 Admin & Audit APIs — `workspace-access` / `platform`
`GET /api/v1/audit-log` (brand-scoped viewer) · `POST /api/v1/admin/staff-access-grants` (time-boxed, customer-consented) · `GET /api/v1/admin/staff-access-grants`. Authz: Owner/Brand Admin (audit-log); Brain-staff + customer-consent (grants).

### 3.14 Internal Platform APIs — see §5
Health/readiness probes per deployable; job-orchestration trigger (Argo-only).

### 3.15 Platform Job Monitoring APIs — `job-orchestration` (read-only)
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/jobs` | GET | list platform job runs (`?type=&status=&brand_id=`): billing-seal · attribution-rebuild · dq-recalc · retention · backfill · parity/reconciliation | Owner/Brand Admin (brand-scoped); org-level jobs → Owner | — |
| `/api/v1/jobs/{jobRunId}` | GET | run detail: type, status, progress, started/finished, error, triggering event | Owner/Brand Admin | — |

**Read-only by design** — on-demand *triggering* stays the internal, service-token-authenticated path (§5); there is **no public job-write API** in Phase 1. Answers the ops questions: is the billing seal done? is the attribution rebuild stuck? did retention/erasure run?

### 3.16 Privacy & DSAR APIs — `identity` (intake/track) + `job-orchestration` (execute)
| Endpoint | M | Purpose | Authz | Idem |
|---|---|---|---|---|
| `/api/v1/privacy/erasure-requests` | POST | submit a data-subject erasure (DPDP/PDPL/GDPR) by `brain_id` or identifier → crypto-shred job | Owner/Brand Admin | ✓ |
| `/api/v1/privacy/erasure-requests` | GET | list erasure requests + status | Owner/Brand Admin | — |
| `/api/v1/privacy/erasure-requests/{requestId}` | GET | status: received → shredding → completed/certified | Owner/Brand Admin | — |

Access/portability (the subject-access export) = `POST /api/v1/exports { "scope": "dsar" }` (§3.7). Consent **read** = §3.6; consent **write/withdrawal** is event-driven (the brand's CMP → `/collect` consent snapshot; withdrawal emits `consent.withdrawn` — doc 07). The brand is the **controller**; Brain is the **processor** executing the request.

---

## 4. Complete API contracts (critical endpoints)

> Full Zod schemas in `packages/contracts` are the machine source of truth (§10); the JSON below is the human contract. CRUD endpoints not shown follow the same envelope, headers, and error table. **All headers below apply to every `/api/v1` call** unless noted: `Authorization: Bearer <jwt>` (or BFF cookie + `X-CSRF-Token`), `X-Brand-Id` (brand-scoped), `X-Correlation-Id` (optional in, always out), `Idempotency-Key` (mutations).

### 4.1 `POST /api/v1/auth/login`
**Desc:** authenticate; returns access + rotating refresh. **Auth:** public. **Rate:** 10/min/IP. **Audit:** login attempt (success/failure, no password).
```jsonc
// Request
{ "method": "password", "email": "ops@brand.com", "password": "••••" }
// or { "method": "google", "id_token": "<oidc-id-token>" }
// 200
{ "access_token": "jwt", "expires_in": 900, "refresh_token": "opaque", "mfa_required": false,
  "memberships": [{ "brand_id": "brd_…", "role": "brand_admin" }] }
// 423 { "error": { "code": "MFA_REQUIRED", "message": "...", "trace_id": "..." } }
```
**Errors:** 401 `INVALID_CREDENTIALS` · 422 `VALIDATION_FAILED` · 429 `RATE_LIMITED`.

### 4.2 `POST /api/v1/brands` (Owner only)
**Audit:** brand.created. **Rate:** 30/min/brand-org.
```jsonc
// Request
{ "name": "Acme DTC", "website_url": "https://acme.com", "industry": "apparel",
  "region": "IN", "base_currency": "INR", "timezone": "Asia/Kolkata",
  "revenue_definition": "realized" }
// 201
{ "brand_id": "brd_7f…", "state": "onboarding", "readiness_score": 0, "created_at": "2026-06-14T…Z" }
```
**Errors:** 403 `NOT_OWNER` · 422 `VALIDATION_FAILED` (currency/timezone invalid → hard-fail) · 409 `IDEMPOTENCY_CONFLICT`. **Perms:** `brand.create`.

### 4.3 `POST /api/v1/connectors` (connect)
**Audit:** connector.connect. **Perms:** `integration.connect`.
```jsonc
// Request
{ "type": "shopify", "auth_method": "oauth", "config": { "shop": "acme.myshopify.com" } }
// 201
{ "connector_id": "con_…", "state": "disconnected", "oauth_url": "https://…", "settlement_capable": false }
```
**Errors:** 403 `FORBIDDEN` · 422 `VALIDATION_FAILED` · 409 (already connected).

### 4.4 `GET /api/v1/connectors/{connectorId}/health`
```jsonc
// 200
{ "connector_id": "con_…", "state": "Healthy",
  "freshness": { "last_event_at": "…Z", "last_success_at": "…Z", "lag_seconds": 42, "cadence": "webhook" },
  "recommendation_safety": "safe", "data_completeness": 0.98, "owner_action": null }
```
`state ∈ Healthy|Delayed|Failed|Disconnected|RateLimited|TokenExpired|Disabled`.

### 4.5 `POST /collect` (Collector deployable — **not** `/api/v1`)
**Auth:** pixel HMAC key (per-brand). **Behavior:** accept-before-validate → durable spool → 202. **Never** returns a schema 4xx.
```jsonc
// Request (one event)
{ "event_id": "evt_uuid", "brand_id": "brd_…", "occurred_at": "…Z", "schema": "purchase.v2",
  "consent": { "analytics": true, "marketing": false, "ai_processing": true, "personalization": true },
  "payload": { "order_id": "…", "value_minor": 249900, "currency_code": "INR",
               "click_ids": { "fbclid": "…", "gclid": "…" }, "source": "server" } }
// 202 { "accepted": true }
// 503 { "error": { "code": "SPOOL_FULL" } }  + Retry-After    (back-pressure, client retries)
```
**Webhook variant:** `POST /webhook/{connector}` with HMAC signature header (`X-Brain-Signature`), same accept-before-validate.

### 4.6 `POST /api/v1/identity/merge`
**Perms:** `identity.merge` (Brand Admin/Owner). **Audit + Decision-Log.**
```jsonc
// Request
{ "profile_a": "bid_…", "profile_b": "bid_…", "reason": "manual_review", "rule_version": "v3" }
// 200
{ "merge_event_id": "mev_…", "canonical_brain_id": "bid_…", "alias_repointed": true }
// 409 { "error": { "code": "CYCLE_DETECTED", "message": "routed to review", "details": { "review_id": "…" } } }
```

### 4.7 `POST /api/v1/metrics/query` (registry-bound; the keystone read)
**Perms:** permission-gated per metric. **Behavior:** binds `metric_id` + filters + grain + range; the metric engine computes; **finalized-only on guarded endpoints**. **Never** raw SQL.
```jsonc
// Request
{ "metric_id": "channel_contribution", "filters": { "period": "2026-05" },
  "grain": ["channel"], "currency_code": "INR" }
// 200
{ "metric_id": "channel_contribution", "metric_version": "2026.06", "as_of": "2026-06-14",
  "currency_code": "INR",
  "rows": [ { "channel": "meta", "contribution_minor": 100000000, "method": "rule_based",
              "confidence": "High", "spend_minor": 32000000 } ],
  "unattributed_residual_minor": 4200000, "closed_sum_check": "balanced" }
// 409 NON_FINALIZED_ON_GUARDED_ENDPOINT   (if a guarded metric would serve hot/provisional rows)
```
Single-metric sibling: `GET /api/v1/metrics/{metricId}?grain=day&from=…&to=…&channel=meta` → `{ "value_minor", "currency_code", "metric_version", "as_of", "recognition_label", "confidence": { "band", "effective" } }`.

### 4.8 `GET /api/v1/customers/{brainId}` (Customer 360)
**Perms:** `customer.read` (Analyst → PII-minimized).
```jsonc
// 200
{ "brain_id": "bid_…", "identity_confidence": "High", "completeness": 0.82, "as_of": "2026-06-14",
  "identifiers": [ { "type": "email_hash", "linked_at": "…Z" } ],
  "lifetime_realized_cm2_minor": 18200000, "currency_code": "INR",
  "timeline": [ { "type": "order", "ref": "ord_…", "occurred_at": "…Z" } ] }
```

### 4.9 `GET /api/v1/billing/preview?period=2026-05`
**Perms:** Owner (act) / Brand Admin (view). **Reads finalized rows only.**
```jsonc
// 200
{ "period": "2026-05", "snapshot_id": "snp_…", "currency_code": "INR",
  "realized_gmv_minor": 500000000, "fx_basis": "realization-date", "tier": "growth", "tier_pct_bps": 75,
  "cap": { "applied": false, "reason": "cost_confidence=Estimated", "trueup_recorded_minor": 100000000 },
  "min_fee_minor": 1500000, "fee_minor": 3750000,
  "tax": { "cgst_minor": 337500, "sgst_minor": 337500 }, "total_minor": 4425000,
  "lines": [ { "label": "realized_gmv", "links_to": "realized_revenue_ledger", "metric_version": "2026.06" } ] }
```

### 4.10 `POST /api/v1/billing/period/{period}/seal`
**Perms:** system(Argo) or Owner-confirm. **Audit.** → `{ "snapshot_id": "snp_…", "sealed_at": "…Z", "immutable": true }`; `409 ALREADY_SEALED`.

### 4.11 `POST /api/v1/recommendations/{recommendationId}/respond` (AI Feedback)
**Perms:** Manager+ (per approval matrix). **Audit + Decision-Log.**
```jsonc
// Request
{ "action": "reject", "reason": "seasonal, expected", "edited_params": null }
// 200 { "recommendation_id": "rec_…", "logged": true, "decision_log_id": "dec_…" }
```

### 4.12 `POST /api/v1/exports`
```jsonc
// Request
{ "scope": "report", "target": { "metric_id": "realized_cm2", "filters": {"period":"2026-05"} }, "format": "csv" }
// 202 { "export_id": "exp_…", "status": "processing" }
// later: GET /exports/{exportId} → { "status": "ready", "url": "https://…signed", "expires_at": "…Z" }
```
`scope ∈ report|full_brand|dsar`; full_brand/dsar are Owner/Brand Admin + audited.

### 4.13 `GET /api/v1/connectors/{connectorId}/jobs/{jobId}` (operability)
**Perms:** member. Answers: *is the sync running? is the backfill stuck? how much is processed? why did it fail?*
```jsonc
// 200
{ "job_id": "cjob_…", "connector_id": "con_…", "type": "backfill", "lane": "backfill",
  "status": "running", "progress": { "records_processed": 1840000, "estimated_total": 2400000, "pct": 76 },
  "cursor": "2025-11-03T…Z", "started_at": "…Z", "updated_at": "…Z", "finished_at": null,
  "error": null, "retry_count": 0 }
// status ∈ queued|running|paused|succeeded|failed|rate_limited
// "stuck" = status=running but updated_at is stale; "why failed" = error{code,message}.
```
List sibling `GET /connectors/{connectorId}/jobs?status=&type=` → cursor-paginated `{ data:[…job summaries…], page:{…} }`.

### 4.14 `GET /api/v1/jobs/{jobRunId}` (platform job, read-only)
**Perms:** Owner/Brand Admin.
```jsonc
// 200
{ "job_run_id": "jr_…", "type": "billing_seal", "brand_id": "brd_…", "status": "succeeded",
  "progress": { "pct": 100 }, "started_at": "…Z", "finished_at": "…Z",
  "triggered_by": { "kind": "schedule|event|operator", "ref": "ledger.finalized" }, "error": null }
// type ∈ billing_seal|attribution_rebuild|dq_recalc|retention|backfill|parity_reconciliation|erasure
```

### 4.15 `POST /api/v1/privacy/erasure-requests`
**Perms:** Owner/Brand Admin. **Audit.** **Behavior:** emits `erasure.requested` → crypto-shred the PII-vault row + tombstone the graph node to an opaque surrogate + re-project marts; ledger/Decision-Log rows survive on the surrogate (doc 04 §F.5).
```jsonc
// Request
{ "subject": { "by": "brain_id", "value": "bid_…" }, "reason": "dpdp_erasure", "requested_by": "controller" }
// 202
{ "request_id": "ers_…", "status": "received", "subject_brain_id": "bid_…", "submitted_at": "…Z" }
```

### 4.16 `GET /api/v1/customers/{brainId}/consent`
**Perms:** `customer.read`.
```jsonc
// 200
{ "brain_id": "bid_…", "as_of": "…Z",
  "consent": { "analytics": "granted", "marketing": "withdrawn", "ai_processing": "granted", "personalization": "granted" },
  "history": [ { "category": "marketing", "state": "withdrawn", "effective_at": "…Z", "source": "cmp" } ] }
// state ∈ granted|withdrawn|never. Write/withdrawal is event-driven (doc 07 consent.withdrawn).
```

### 4.17 `GET /api/v1/ai/queries/{queryId}` (AI auditability)
**Perms:** member (own brand); full provenance to Owner/Brand Admin. **PII-redacted.**
```jsonc
// 200
{ "query_id": "aiq_…", "asked_at": "…Z", "question": "…", "answer": "…",
  "metric_binding": { "metric_id": "realized_cm2", "filters": { "channel": "meta", "period": "2026-05" } },
  "value_minor": 4521000, "currency_code": "INR", "confidence": { "band": "Medium" },
  "provenance": { "model": "claude-haiku", "model_version": "…", "prompt_hash": "sha256:…",
                  "snapshot_id": "…", "metric_version": "2026.06", "cost_minor": 12, "latency_ms": 840 },
  "decision_log_ref": "dec_…" }
```

---

## 5. Internal APIs (Collector ↔ Core ↔ Stream-worker)

**Principle: prefer events; internal HTTP only where unavoidable.** There are **no** synchronous internal REST APIs between the deployables for data flow — they communicate via Redpanda.

| From → To | Mechanism | Why not REST |
|---|---|---|
| Collector → Core | **Event** (`raw.*` topics) | accept-before-validate decouples; durability lives in the spool |
| Stream-worker → Core (identity, silver, signals) | **Event** (`identity.resolution.requested`, `dq.signal.raised`, …) | async, replayable, no hot-path coupling |
| Core → Stream-worker | none (Core writes events the worker consumes) | — |
| Argo jobs → Core | **Internal HTTP trigger** *or* the core image's **job entrypoint (CLI)** | the only internal synchronous surface; see below |

**The two internal HTTP surfaces that DO exist:**
1. **Health/readiness** (every deployable): `GET /healthz` (live), `GET /readyz` (ready — Collector ready ⇔ spool + producer healthy), `GET /livez`. Unauthenticated, cluster-internal only (NetworkPolicy).
2. **Job-orchestration trigger** (`job-orchestration` module): `POST /internal/jobs/{job}/run` with body `{ "brand_id"?, "params": {} }`, authenticated by an **internal service token** (mTLS / IRSA), callable only from the `jobs` namespace. Backs `backfill.requested`, the parity-convergence monitor, `starrocks-rebuild`, retention/erasure. Overlap-locked per `(job, brand_id)`. (Most batch jobs run as the core image's `--mode=job` entrypoint invoked by Argo — no HTTP at all; this trigger exists only for on-demand/operator-initiated runs.)

No other internal APIs are defined for Phase 1 — adding them would re-introduce the service coupling ADR-001 avoids. (The read-only **job-visibility** side is a *public* operator API — §3.5 connector jobs + §3.15 platform jobs — **not** internal; only the *trigger* is internal.)

---

## 6. Public (customer-facing) APIs

These are the operator/agency-facing surfaces (the catalog §3 rows marked W/X), grouped by job-to-be-done:
- **Onboarding & access:** Auth (§3.1), Users (§3.2), Organization/Brands/Members/Settings (§3.3–3.4).
- **Connect the stack:** Connectors + Catalog + Tracking-plan + Pixel-config (§3.5).
- **See the customer:** Customers / Customer 360 + Identity merge/unmerge/review (§3.6).
- **Honest numbers:** Metrics query + catalog, Attribution views, Decision-log, Data-quality, Exports (§3.7–3.8).
- **Money:** Billing preview/invoices/value-proof/subscription/payment-method (§3.9).
- **Day-to-day:** Notifications + preferences (§3.10), Recommendations + respond (§3.11), AI NLQ + Brief (§7), MCP (§7).
- **Pull-your-own-data:** **MCP** (read-only) + **Exports** — the activation substitute for the (deliberately excluded) generic CDP reverse-ETL.

All public APIs: tenant-scoped via `X-Brand-Id`, permission-gated, audited, rate-limited, registry-bound for any number.

---

## 7. AI APIs (`ai` module)

### 7.1 NLQ — `POST /api/v1/ai/nlq`
**Perms:** member + `ai_processing` consent (per-profile use checked at the Analytics-API boundary; `422 AI_CONSENT_MISSING` otherwise). **Behavior:** binds question → `metric_id` (+filters/grain/range) → metric engine computes → model **narrates** (untrusted-text-enveloped) → faithfulness check → response. **Never** SQL; the model never invents numbers. **Audit + provenance.** **Rate:** 20/min/brand; budget-aware.
```jsonc
// Request
{ "question": "What was realized CM2 from Meta last month?" }
// 200 (answered)
{ "answer": "Realized CM2 from Meta in May was ₹45,210…",
  "metric_binding": { "metric_id": "realized_cm2", "filters": { "channel": "meta", "period": "2026-05" }, "grain": [], "realization_label": "realized" },
  "value_minor": 4521000, "currency_code": "INR", "as_of": "2026-06-14",
  "confidence": { "band": "Medium", "effective": "min(cost,attribution)" },
  "report_link": "/analytics/...", "provenance_id": "aiprov_…" }
// 200 (low confidence / ambiguous) → clarify, never guess
{ "action": "clarify", "question": "Did you mean placed or realized revenue?" }
```
**Errors:** 422 `AI_CONSENT_MISSING` · 429 `BUDGET_EXHAUSTED` (returns the deterministic number with `narration_status:"unavailable_budget"` where possible) · 429 `RATE_LIMITED`.

### 7.2 Morning Brief — `GET /api/v1/ai/brief`
Returns the latest brief view-model (≤3 actions, each = the recommendation contract). Delivery to email/WhatsApp is push (notification chokepoint); this endpoint is the in-product read.
```jsonc
// 200
{ "brief_id": "brief_…", "generated_at": "…Z", "as_of": "2026-06-14",
  "actions": [ { "recommendation_id": "rec_…", "problem": "...", "evidence": [ { "metric_id": "cm2_realized", "value_minor": 412300, "confidence": "High" } ],
                 "recommended_action": { "type": "review_campaign_budget", "target_id": "camp_88" },
                 "expected_impact": { "metric_id": "cm2_realized", "direction": "up" }, "risk": "low", "reversibility": "reversible", "confidence": "High" } ],
  "summary": "on pace, pending settlement" }
```

### 7.3 Recommendations — `GET /api/v1/recommendations` + respond (§3.11/§4.11)
Phase-1 recommendations are **deterministic detector output** rendering the recommendation contract; `respond` is the feedback loop into the Decision Log. (The model only fills the prose `explanation`, never the eligibility/confidence/metric fields — eligibility-unwritable contract test.)

### 7.4 MCP — `POST /mcp` + key management
**Read-only governed tools; no Brain-side model in the path.** Key = `brand_id × intersection(issuer authority, requested scopes)`; first-class revocable principal; shown once; expiring.
```jsonc
// POST /api/v1/mcp/keys  (Owner/Brand Admin)
{ "name": "my-agent", "scopes": ["metric.read"], "expires_in_days": 30 }
// 201 { "mcp_key_id": "mcpk_…", "key": "shown-once-secret", "scopes": ["metric.read"] }

// POST /mcp   (caller = the brand's own LLM; header: Authorization: Mcp-Key <key>)
{ "tool": "get_metric", "args": { "metric_id": "realized_cm2", "period": "2026-05" } }
// 200 → identical number to the dashboard (resolved via Analytics API, registry-bound)
// 429 { "error": { "code": "LIMIT_ROWS|LIMIT_RATE|LIMIT_TIMEOUT|LIMIT_BUDGET" } }   // never a silent partial
```
**Tools (Phase 1):** `get_metric`, `get_revenue` (realized+placed labeled), `get_cm2`, `get_orders`, `get_customers` (PII-min), `get_channel_contribution`, `get_connector_health`. Each maps to a registry `metric_id`; no SQL, no free-form filters. **In the CI isolation suite:** Brand-A key → Brand-B data = fail-closed; revoked/expired = fail-closed; scope-escalation denied.

### 7.5 AI Feedback API
= `POST /api/v1/recommendations/{id}/respond` (§4.11) for Phase 1. (Thumbs-on-NLQ-answers feedback is a Phase-2 add — §11.)

### 7.6 Prompt Registry & AI Evaluation (internal / CI — not customer-facing)
- **Prompt registry** is content-hash-versioned and promoted **only through CI eval gates** (doc 04 §N.4). Phase-1 surfaces: an **internal/admin** read `GET /internal/ai/prompts` (active hashes per task) — not a public runtime API; prompt *changes* happen via git + CI, not an API.
- **AI evaluation** (resolution false-bind→0, injection, faithfulness) runs in **CI** (`tools/eval`) and as a scheduled regression — **not** a runtime public API. No Phase-1 public eval endpoint.

### 7.7 AI query history & provenance — `GET /api/v1/ai/queries`, `GET /api/v1/ai/queries/{queryId}`
Lets operators/support answer *"what was asked, what was answered, which metrics were used, what confidence, what provenance"* without trawling the full Decision Log. The list is cursor-paginated, tenant-scoped, PII-redacted; the detail is §4.17. Backed by the same `ai.provenance.recorded` record (doc 04 §11.4.5) — the Decision Log remains the system of record; this is the focused AI-query view. **Auth:** member (own brand); full provenance fields to Owner/Brand Admin. **Audit:** the read itself is audited (AI/MCP queries are audited per §1.11).

---

## 8. API security architecture

### 8.1 Authentik integration & JWT
- Browser/login → **Authentik OIDC** (auth-code + PKCE, MFA). Authentik issues the **access JWT (15 min)** + **rotating refresh (7 d)**. Core validates signature against Authentik JWKS (`iss/aud/exp`), then checks the revocation denylist.
- **Claims:** `sub, brand_id[], active_brand, role, perms[], sid, jti, amr(mfa)`. Step-up MFA (`acr`) required for Owner-only actions (billing, brand-create, ownership-transfer).

### 8.2 Refresh & revocation
- Refresh rotation with reuse-detection (a replayed refresh revokes the whole token family). **Revocation backbone:** short access tokens + a Redis **denylist checked on every protected action**; revoking a user/role/MCP-key/integration writes the denylist synchronously and fans out (access-removal is immediate; access-add applies on next action).

### 8.3 RBAC enforcement (defense in depth)
Permission (not role label) gates every action, enforced at **three layers**: (1) JWT `perms[]` claim at the API edge; (2) Postgres **RLS** (`brand_id = current_setting('app.current_brand_id')`, non-owner DB role, asserted non-null); (3) MCP **scopes**. A forgotten check at one layer is caught by the next.

### 8.4 Tenant isolation at the API layer
`X-Brand-Id` is required and **asserted non-null** before any query; the API sets the RLS tenant context from it; cross-brand access → `403 CROSS_BRAND_DENIED`, logged, P0. The Owner rollup is **N isolated reads stitched at presentation**, never a cross-brand query. The isolation-fuzz CI suite exercises the **API layer** (a Brand-A token requesting Brand-B → zero rows / 403/404).

### 8.5 API keys & MCP keys
- **MCP keys:** brand-scoped, scope = intersection(issuer authority, requested), hashed at rest, shown once, expiring, revocable principals (§7.4).
- No long-lived "API keys" for the core write API in Phase 1 — programmatic access is **read-only via MCP**; write access is interactive (JWT/cookie). (A service-to-service key program is Phase-2 if a partner needs write — §11.)

### 8.6 Connector credentials
OAuth tokens / API keys for third-party connectors are stored **encrypted under the per-brand KMS data key** in the vault, never returned in full by any API; refreshed server-side; revoked immediately on disconnect.

### 8.7 Webhook verification & signature validation
Inbound webhooks (`/webhook/{connector}`) carry an **HMAC signature** (`X-Brain-Signature`, per-connector secret) verified before acceptance; the pixel `/collect` is authenticated by a **per-brand pixel HMAC key**; `brand_id` is taken from the verified key, **never** trusted from the body. OAuth redirect `state` is signed to prevent CSRF.

### 8.8 Secrets management
All secrets (DB, IdP client secret, LiteLLM master, connector secrets) live in **AWS Secrets Manager**, fetched via **IRSA** (no static creds), never in env files/logs; per-brand KMS for tenant data + connector tokens + the PII vault.

### 8.9 Collector throughput & abuse protection (protecting the 99.95% guarantee)
`/collect` and `/webhook/{connector}` are a distinct, hardened edge:
- **Per-pixel-key + per-brand rate buckets** with a **burst allowance** (token bucket); over-limit → `429` + `Retry-After`. Sized for real sale-day spikes, not to throttle legitimate traffic.
- **Spool protection / back-pressure:** as the durable spool nears capacity → `503 SPOOL_FULL` + `Retry-After`; the client SDK buffers + retries (never a silent drop — the durability contract holds).
- **Key hygiene:** pixel keys are per-brand, **rotatable**, and **revocable**; `brand_id` is taken from the verified key, **never** the body. Anomalous per-key volume → alert + optional auto-throttle of that key only.
- **Edge controls:** CloudFront + WAF (rate-based + bot rules) in front; payload-size cap; webhook HMAC (`X-Brain-Signature`) verified **before** acceptance; OAuth `state` signed.
- **Isolation under load:** the live ingest lane is isolated from the backfill lane (separate topics/consumer groups, doc 04 §6.4) so abuse or a backfill storm cannot starve live ingestion.
- **Abuse handling is async:** the edge accepts-and-acks fast; bot/datacenter-IP classification happens downstream (flagged, excluded from analytics + match-rate, doc 04 §7.4.8) — so abuse detection never blocks the ack path.

---

## 9. API versioning strategy

### 9.1 API lifecycle stages (lightweight governance)
Every endpoint carries a lifecycle stage (OpenAPI `x-lifecycle` extension + an `X-API-Lifecycle` response header) to prevent API sprawl and unmanaged legacy endpoints:
| Stage | Meaning | Stability |
|---|---|---|
| **Experimental** | internal/preview | no compatibility promise; not for external use |
| **Beta** | usable, feedback-stage | additive changes only; breaking changes flagged |
| **GA** | the default for Phase-1 endpoints | additive-only within `/api/v1` |
| **Deprecated** | superseded, still served | `Deprecation` + `Sunset` headers; 90-day default notice |
| **Sunset** | past the window, nearing removal | `299` warning header; removal date published |
| **Removed** | gone | `410 Gone` |
All Phase-1 endpoints ship **GA** unless explicitly marked. A stage transition is a CI-tracked change; the contract-test gate (§10) fails on any breaking change to a GA endpoint. No extra tooling — these stages live in the OpenAPI metadata already generated from `packages/contracts`.

- **URL-major (`/api/v1`).** Only one major live in Phase 1.
- **Additive-only within a major:** new optional fields, new endpoints, new enum values (consumers must tolerate unknown enum values) are non-breaking and ship without a version bump.
- **Breaking changes** (removing/renaming a field, changing a type, tightening validation) → **`/api/v2`** with a **dual-read window** (both majors served) and a published **deprecation → sunset** timeline (default: 90-day deprecation notice via `Deprecation` + `Sunset` response headers, then removal). The contract-testing gate (`buf`-style breaking-change check on the generated OpenAPI/Avro) **fails CI** on an unintended breaking change.
- **Events** version per-topic `.v{n}` with **Apicurio FULL_TRANSITIVE** compatibility for all Bronze-materialized streams (doc 04 §6.6); old events stay replayable forever (the replay guarantee).
- **Metric definitions** are independently versioned (`metric_version` in every response) so historical reports remain reproducible even as definitions evolve.

---

## 10. OpenAPI generation strategy (from `packages/contracts`)

`packages/contracts` is the **single source of truth** (doc 05 §5). Flow:
```
Zod schemas (hand-authored, snake_case)
   ├─► TypeScript types          (z.infer — imported by every app/package)
   ├─► OpenAPI 3.1 spec          (zod-to-openapi → /openapi.json + Swagger UI)
   ├─► Avro schemas → Apicurio   (events; registered + compatibility-checked)
   └─► MCP tool schemas          (generated from the same Zod definitions)
```
- **One change to a Zod schema regenerates types + OpenAPI + Avro + MCP schemas;** CI **fails on uncommitted drift** (the contract-testing gate) and on a breaking change (buf-style diff).
- **SDKs:** the OpenAPI 3.1 spec generates a typed client SDK (openapi-typescript / openapi-fetch) for the web app and for external consumers; the internal apps import the Zod types directly (no codegen hop).
- **Request/response validation at runtime** uses the *same* Zod schemas (edge validation = the contract), so the served behavior can never diverge from the published spec.
- **Publishing:** `GET /api/v1/openapi.json` (the live spec) + a versioned Swagger UI; the spec is also emitted as a CI artifact for SDK pipelines.

---

## 11. Deferred APIs (Phase 2/3/4 — documented, NOT built in Phase 1)

Kept out of Phase-1 contracts deliberately (per the architecture phasing):
- **Phase 2:** acquisition-module reads (MER/aMER/CAC/LTV:CAC) [extend `/metrics`], executive-lens view-models, RFM segments, the **holdout/exposure capture** write APIs, an NLQ-answer thumbs feedback API, autocapture config.
- **Phase 3:** **Lifecycle/Outbound APIs** (segments, campaigns, sends — gated by the consent chokepoint), **AI ticket-management APIs**, **MMM/incrementality** read endpoints (the `channel_contribution` *contract* already exists — method swaps to `mmm`/`holdout` with **zero API change**), prediction reads, the Shared Audience Builder, a service-to-service **write** key program.
- **Phase 4:** **auto-execute / agent** APIs (enable class, kill-switch, auto-revert), progressive-delivery/flag-targeting admin APIs.
- **Phase 5:** portfolio rollup APIs, enterprise residency/SSO-config APIs, the custom-integration framework, cross-brand benchmarking reads.

### 11.1 Reserved architecture — Phase 2+ (reserve only; DO NOT build in Phase 1)
Two integration surfaces are *architecturally reserved* so Phase-1 choices don't preclude them — **no endpoints ship now**, this only confirms the Phase-1 design extends cleanly:
- **Partner / programmatic API access (Phase 2+).** A **service-account + scoped API-key** model for agencies, partners, ERP, and external BI — distinct from interactive user JWTs and from read-only MCP keys. Reserved: keys are first-class revocable principals on the **same denylist backbone (§8.2)**, scoped per `brand_id` × permission set; **write** access (beyond Phase-1's interactive-only writes) arrives here behind the same RBAC + idempotency + audit; the `/api/v1` contract + the OpenAPI-generated SDK (§10) are already the substrate. *Phase-1 programmatic access remains **read-only via MCP**.*
- **Outbound webhook framework (Phase 2+).** A mechanism to notify external systems of `connector.failed`, `export.completed`, `billing.period.sealed`, `recommendation.approved`, `dq.alert`, etc. Reserved: subscriptions brand-scoped; deliveries **signed (HMAC), retried with backoff, DLQ'd**; payloads derive from the **doc-07 event contracts** (the events already exist — this is a delivery transport, not new domain logic). *Phase-1 outbound is limited to consent-gated **CAPI passback** (doc 04 §7.4.10); general outbound webhooks are Phase 2+.*

**Anti-scope-creep rule:** a capability appears in a Phase-1 contract only if it is required for the Phase-1a/1b/1c exit criteria (doc 04 §O.3). The channel-contribution and confidence contracts are *shaped* for Phase-3 MMM now (reserved fields), but **no MMM endpoint ships in Phase 1**.

---

*End of API Architecture & Contract Specification (Phase 1). Companions: `01`–`05`. Machine source of truth for schemas: `packages/contracts` (Zod → OpenAPI/Avro/types/MCP).*
