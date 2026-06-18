# PASS 5 — API Audit (Board: api)

**Reviewer:** Independent principal-level API auditor
**Scope:** `apps/core` BFF + per-module REST interfaces vs `docs/requirements/06_Brain_API_Architecture_and_Contracts.md`
**Method:** Read every route registration in `apps/core/src/main.ts`, `frontend-api/internal/bff.routes.ts`, `workspace-access/.../rest/*.routes.ts`, `notification/.../consent.routes.ts`, `notification/internal/dev.routes.ts`, the connector/pixel route mounts, and the `rbac.ts` / `auth.routes.ts` guards. Cross-checked against contract §1 (design standards), §3 (catalog), §4 (contracts), §8 (security), §9 (versioning).

**Headline:** AuthN/session-revocation/RBAC coverage on the implemented surface is genuinely solid — every protected route runs `validateSessionPreHandler` (NN-3 revocation check) and brand context comes from the JWT, not the body (a real cross-tenant-spoofing defense). But the implemented API **systematically diverges from the frozen contract** on the cross-cutting governance rules the contract calls "mandatory, not optional" (§0 finding 10): the documented `/api/v1/*` domain REST surface is largely **not built** (only a BFF view-model surface exists), the **error envelope shape is wrong** (`request_id`/no `trace_id`), **`X-Correlation-Id` is never echoed**, **rate-limit headers are never emitted**, **`Idempotency-Key` is not enforced on most mutations** (consent writes, connector connect, set-org/set-brand), and money-bearing responses **omit `recognition_label`/`metric_version`** at the envelope. None of these are theoretical — each is a documented contract clause with a concrete, citable code divergence.

---

## CRITICAL

_None._ No unauthenticated route exposes tenant data, and no cross-tenant read path was found on the implemented surface (brand_id is sourced from the verified JWT, RLS is set per-transaction). The most severe issues are High.

---

## HIGH

### H-1 — Documented `/api/v1/*` domain REST contract surface is largely unimplemented; only the BFF view-model surface exists
**Severity:** High · **Category:** Contract adherence / completeness
**Evidence:** Contract §3 catalogs the canonical APIs as the domain REST endpoints (§0 finding 2: "the canonical contracts are the domain REST APIs under `/api/v1/*`"). The actual route inventory (`grep` of all path literals in `apps/core/src`) contains **none** of: `/api/v1/metrics/catalog`, `/api/v1/metrics/{metricId}`, `POST /api/v1/metrics/query` (§3.7, §4.7 — "the keystone read"), `/api/v1/customers`, `/api/v1/customers/{brainId}` (§3.6, §4.8), `/api/v1/customers/{brainId}/consent` (§3.6/§4.16), `/api/v1/identity/merge|unmerge|review-queue` (§3.6/§4.6), `/api/v1/billing/*` (§3.9 — preview/invoices/seal/value-proof, §4.9/§4.10), `/api/v1/recommendations[+respond]` (§3.11/§4.11), `/api/v1/ai/nlq`, `/api/v1/ai/brief`, `/api/v1/ai/queries`, `/mcp` + `/api/v1/mcp/keys` (§3.12), `/api/v1/exports[/{id}]` (§3.7/§4.12), `/api/v1/decision-log` (§3.7), `/api/v1/jobs[/{id}]` (§3.15/§4.14), `/api/v1/privacy/erasure-requests` (§3.16/§4.15), `/api/v1/audit-log` (§3.13), `/api/v1/organization[/rollup]`, `/api/v1/brands/{brandId}/settings|cost-setup|goals|readiness` (§3.3). Instead the analytics/consent/feedback surface is delivered as **BFF view-model GETs** (`/api/v1/analytics/*`, `/api/v1/dashboard/*`, `/api/v1/consent/*`, `/api/v1/feedback/capi/*`) in `bff.routes.ts`.
**Impact (production):** Any external token / MCP client / partner integration written against the frozen contract (`packages/contracts` → OpenAPI, §10) gets 404s. The contract's "same APIs reachable with a token/MCP-key" promise (§0 finding 2) is unmet — there is no non-BFF, non-cookie contract surface at all. `POST /metrics/query` (the registry-bound sole-read keystone, §4.7) does not exist as an API; reads are bespoke per-widget wrappers.
**Root Cause:** Phased build delivered a cookie-only BFF for the web app first; the documented domain REST + MCP surface was deferred without a contract amendment marking those endpoints as not-yet-built.
**Recommended Fix:** Either (a) ship the documented `/api/v1/*` domain endpoints behind Bearer/MCP auth, or (b) amend doc 06 to explicitly scope Phase-1-built endpoints to the BFF surface and move the rest to a "deferred/not-built" section so the contract stops claiming a frozen surface that returns 404.
**Priority:** P1 · **Tenant Impact:** N/A (absence, not leak) · **Detection:** 404 from any contract-conformant external client; OpenAPI contract test (§10) would fail if wired.

### H-2 — Error envelope diverges from the contract: `request_id` instead of `{ error: { code, message, trace_id, details } }`
**Severity:** High · **Category:** Error responses / contract adherence
**Evidence:** Contract §1.5 mandates `{ "error": { "code", "message", "trace_id", "details": {} } }`. Every handler returns `{ request_id, error: { code, message } }` — e.g. `bff.routes.ts:128-131`, `:155-158`, `:347-354`; `main.ts:316-322` (global error handler); `auth.routes.ts:81-91`; `consent.routes.ts:87-90`. `grep trace_id apps/core/src` returns **zero** matches in any error envelope (only the unrelated Meta `fbtrace_id`). The mandated `trace_id` field is absent everywhere; `details` is absent; the top-level key is `request_id` (sibling of `error`, not inside it).
**Impact (production):** Clients/SDKs generated from the contract cannot read `error.trace_id` for support correlation; the documented machine-readable `details` (e.g. validation field breakdown) is inconsistently shaped (`fields` in some handlers, absent in others). The system-prompt's "surface request IDs on error responses (a Stage-4 VETO surface)" is satisfied via `request_id`, but the **contract's** trace_id correlation field is not.
**Root Cause:** An internal error envelope (`request_id`) was standardized in code without reconciling against doc 06 §1.5.
**Recommended Fix:** Either add `trace_id` (the OTel span/correlation id) inside `error{}` and standardize `details`, or amend §1.5 to the implemented `request_id` shape. Do not leave code and contract disagreeing on the wire format.
**Priority:** P1 · **Tenant Impact:** single-tenant (cosmetic per-request) · **Detection:** contract test on error shape; support escalations citing missing trace_id.

### H-3 — `Idempotency-Key` not enforced on most mutating endpoints (contract §1.8: "Every POST/PATCH/PUT/DELETE requires Idempotency-Key")
**Severity:** High · **Category:** Idempotency
**Evidence:** §1.8: every mutation requires `Idempotency-Key`, cached 24h, replayed; same key+different body → `409 IDEMPOTENCY_CONFLICT`. Reality:
- **Consent writes have no key at all:** `consent.routes.ts` `POST /consent/grant` (:97), `/consent/withdraw` (:156) — `grep idempotency consent.routes.ts` = none. A retried grant/withdraw inserts duplicate append-only SoR rows.
- **Connector connect** `POST /api/v1/connectors` (`main.ts:956`) reads no `Idempotency-Key`; a retried Razorpay/Shopflo/GoKwik connect (`main.ts:1026-1253`) calls `connectorRepo.save` with a fresh `randomUUID()` instance id each time → **duplicate connector_instance rows + duplicate stored secrets**.
- **set-org / set-brand / onboarding/advance / session/refresh / register / bff/session** mutate state with no idempotency key.
- Where a key *is* read (`main.ts:1321` disconnect, `:1600/:1616` pixel, `pixelRoutes.ts:44/84`, `shopifyConnectorRoutes.ts:171`), it falls back to `?? randomUUID()` — so a **missing header is silently accepted** rather than rejected, and there is no 24h replay cache or `409 IDEMPOTENCY_CONFLICT` on same-key-different-body. The only place that *requires* the header is `member.routes.ts` (:372/:428/:475/:550 → `MISSING_IDEMPOTENCY_KEY`).
**Impact (production):** Network retry / double-click on connector connect creates duplicate `connector_instance` rows and duplicate secret writes; duplicate consent rows pollute the append-only compliance SoR; no replay protection on auth/session mutations. The contract's idempotency guarantee is unmet for almost the entire write surface.
**Root Cause:** Idempotency was implemented as a downstream dedup detail (where commands happen to be idempotent) rather than as the contract-level header gate §1.8 requires; only member.routes wired the gate.
**Recommended Fix:** Add a shared idempotency preHandler (Redis-backed 24h cache keyed on `brand_id + key + route + body-hash`) applied to every POST/PATCH/PUT/DELETE; reject missing keys with 400 and same-key-different-body with `409 IDEMPOTENCY_CONFLICT`. Start with connector-connect and consent-write (the duplicating ones).
**Priority:** P1 · **Tenant Impact:** single-tenant data corruption (dup rows/secrets) · **Detection:** duplicate connector_instance rows per brand; duplicate consent_record rows; user reports of "connected twice".

### H-4 — `X-Correlation-Id` never echoed on responses (contract §1.4/§1.9: "echoed in responses")
**Severity:** High · **Category:** Contract adherence / observability
**Evidence:** §1.4: "`X-Correlation-Id` echoed on every response." §1.9: "propagated … echoed in responses." `main.ts:238-241` *ingests/generates* the correlation id into `request.headers['x-correlation-id']`, but `grep` for any `reply.header(...correlation...)` / `setHeader(...Correlation...)` across `apps/core/src` returns **zero**. The id is folded into the per-request `correlationId` and into log lines, but is **not** set as a response header on any route.
**Impact (production):** A browser/SDK client cannot read back the correlation id from the response headers to attach to a support ticket or to stitch a client-side trace — breaking the documented end-to-end correlation contract. (The system-prompt also calls for the correlation id surfaced on responses.)
**Root Cause:** Correlation handling was implemented inbound + in logs only; the response-header echo was missed.
**Recommended Fix:** Add an `onSend` hook that sets `reply.header('x-correlation-id', request.headers['x-correlation-id'])` globally.
**Priority:** P1 · **Tenant Impact:** single-tenant (observability) · **Detection:** missing response header on any `/api/v1` call; trace-stitching gaps.

### H-5 — Rate-limit headers never emitted; no tenant-scoped rate limiting on the read/analytics surface
**Severity:** High · **Category:** Rate limiting
**Evidence:** §1.7 mandates token-bucket **tenant-scoped (`brand_id`)** limits returned via `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `Retry-After`, with defaults (read 120/min/brand, mutations 30/min/brand, NLQ 20/min/brand). Reality: `grep X-RateLimit apps/core/src` = **zero**; `X-RateLimit-Limit`/`-Remaining` are never set. Rate limiting exists **only** on auth/IP paths (`auth.routes.ts` login/register/refresh/forgot keyed by IP/email; `bff.routes.ts:166-175` session/register) — all **IP/email-scoped, not brand-scoped**. The entire BFF analytics surface (`/api/v1/analytics/*`, `/api/v1/dashboard/*`, ~30 routes), `/api/v1/ask` (the NLQ-class route, §1.7 says 20/min/brand), and consent reads have **no rate limit at all**. `Retry-After` is set only on the auth 429s, never with `X-RateLimit-*`.
**Impact (production):** `/api/v1/ask` (LLM-resolver-backed, `bff.routes.ts:1217`) and every analytics widget can be hammered per-session with no per-brand budget — cost-amplification and StarRocks/metric-engine load with no §1.13 concurrency cap surfaced. Clients get no rate-limit headers to back off gracefully.
**Root Cause:** Rate limiting was scoped to brute-force protection on auth only; the contract's per-brand read/mutation/NLQ buckets + headers were not built.
**Recommended Fix:** Add a brand-scoped token-bucket preHandler (read/mutation/NLQ tiers) on `/api/v1/*` BFF routes, emit `X-RateLimit-*` + `Retry-After` always, and gate `/api/v1/ask` at the §1.7 NLQ rate.
**Priority:** P1 · **Tenant Impact:** multi-tenant (a noisy brand/session degrades shared metric-engine + LLM cost) · **Detection:** cost spike on the resolver gateway; StarRocks/pg load with no 429s.

---

## MEDIUM

### M-1 — Money/metric-bearing BFF responses omit `recognition_label` / `metric_version` at the response envelope (§1.4)
**Severity:** Medium · **Category:** Contract adherence
**Evidence:** §1.4: "Every metric-bearing response carries `metric_version`, `as_of`, `recognition_label` (`provisional|settling|finalized`), and `confidence` where applicable." §4.7/§4.9 show these on the wire. The BFF money routes return whatever the analytics use-case yields under `data` without an enforced envelope: `realized-revenue` (`bff.routes.ts:1193-1198`) returns `snapshot` as-is; `kpi-summary`/`recognition-breakdown`/`settlements`/`cod-mix`/attribution routes wrap `result` directly. `recognition_label`/`metric_version` appear in analytics SQL internals (`get-revenue-metrics.ts`, `get-recent-activity.ts`) but are not guaranteed in the response contract shape, and `as_of` is present only on some routes. No `metric_version` is surfaced on any BFF money response.
**Impact:** UI/clients cannot uniformly display recognition state + metric version freshness; the "same finalized number everywhere, with its label" guarantee is per-route ad hoc. The §6 guarded-endpoint `409 NON_FINALIZED_ON_GUARDED_ENDPOINT` contract is also absent on the implemented surface.
**Root Cause:** Per-widget DTOs were shaped by each use-case rather than a shared metric-response envelope.
**Recommended Fix:** Define one metric-response envelope (`value_minor`+`currency_code`+`metric_version`+`as_of`+`recognition_label`+`confidence`) and enforce it on every money route; add the §6 finalized-only guard where money/decisions are served.
**Priority:** P2 · **Tenant Impact:** single-tenant (correctness/clarity) · **Detection:** UI shows no recognition label/version; contract test on metric envelope.

### M-2 — Brand context taken from JWT, not the `X-Brand-Id` header the contract requires (§1.3/§1.10)
**Severity:** Medium · **Category:** Contract adherence / multi-tenancy
**Evidence:** §1.3: "Brand-scoped endpoints **require** `X-Brand-Id`; the server … asserts non-null before any query." §1.10 likewise. Code never reads `X-Brand-Id`: `grep x-brand-id apps/core/src` returns only two **comments** in `bff.routes.ts:8` and `:729` ("if X-Brand-Id is present, it must match auth.brandId") — there is no code that reads or asserts the header. Brand is sourced exclusively from `auth.brandId` (JWT), e.g. `main.ts:710-716 getBrandId`, every analytics route `auth.brandId`.
**Impact:** Security-wise this is **safer** than the contract (JWT brand can't be spoofed via a header), so this is a positive divergence — but it is still a divergence from a frozen contract clause, and any external client coded to pass `X-Brand-Id` to select among multiple brands on one token cannot do so (the active brand is fixed in the session, switched only via `set-brand`). The `X-Brand-Id`-present-must-match assertion the comment promises (`:729`) is **not implemented**.
**Root Cause:** Session-cookie model resolves brand into the JWT; header-based brand selection was not needed for the web app and not reconciled with the contract.
**Recommended Fix:** Amend §1.3/§1.10 to "brand from session JWT (BFF) OR `X-Brand-Id` (token clients), asserted against membership," and implement the present-must-match check the comment claims — or drop the misleading comment.
**Priority:** P2 · **Tenant Impact:** multi-tenant (brand selection model) · **Detection:** external multi-brand token client can't target a non-active brand.

### M-3 — Inconsistent success-status semantics: connector connect / pixel returns 200 where the contract specifies 201
**Severity:** Medium · **Category:** RESTfulness / contract adherence
**Evidence:** §4.3 `POST /connectors` → **201** with `{connector_id, state, oauth_url, settlement_capable}`. Implementation returns **200** for both the OAuth path (`main.ts:1000`) and credential connects (`:1096`, `:1174`, `:1249`, `:1282`), and the response body is `{kind, oauth_url}` / `{kind, connected, connector_instance_id}` — neither the field names (`connector_id`, `state`, `settlement_capable`) nor the status code match §4.3. The generic Shopify connect also lacks the contract's `connector_id`/`state` fields.
**Impact:** Clients keying on 201-created or on `connector_id`/`state` break; resource-creation semantics are inconsistent (pixel provision correctly uses 201/200 at `:1607`, connector connect does not).
**Root Cause:** Connect was modeled as "initiate OAuth / store creds" returning an ad-hoc DTO rather than the §4.3 resource-creation contract.
**Recommended Fix:** Return 201 + the §4.3 body fields on successful resource creation; keep 200 only for the idempotent already-connected replay.
**Priority:** P2 · **Tenant Impact:** single-tenant · **Detection:** client integration breakage on status/field assertions.

### M-4 — Bare-list / non-cursor responses on `recent-activity` and `recent-events` (contract §1.4 bans bare arrays; §1.6 mandates cursor pagination)
**Severity:** Medium · **Category:** Pagination
**Evidence:** §1.4: "wrap lists in `{ data:[...], page:{...} }`"; §1.6: cursor (keyset) only, `limit<=200`. `recent-activity` (`bff.routes.ts:1438-1471`) and `recent-events` (`:2335-2368`) take `?limit=` (capped at 50), return `{ data: { rows: [...] } }` with **no `page`/`next_cursor`/`has_more`** — a bounded `LIMIT N` read with no keyset cursor. There is no way to page beyond the first N. (Credit where due: `brand.routes.ts:190-191` and `member.routes.ts:186-187` correctly implement `next_cursor`/`has_more`.)
**Impact:** These feeds silently truncate at 50 with no continuation; clients can't paginate. Minor because they are "latest N" widgets, but they violate the list-shape + pagination standard.
**Root Cause:** Modeled as fixed-size activity widgets, not paginated collections.
**Recommended Fix:** Either return `{ data:[...], page:{next_cursor, has_more} }` with keyset pagination, or document these as explicitly non-paginated capped feeds in the contract.
**Priority:** P2 · **Tenant Impact:** single-tenant · **Detection:** truncated activity feed; client can't load more.

### M-5 — Consent write/check endpoints not in the API contract; consent `check` mutates audit state on a non-idempotent POST with no rate limit
**Severity:** Medium · **Category:** Contract adherence / idempotency
**Evidence:** Contract models consent **write/withdrawal as event-driven** (§3.16: "consent write/withdrawal is event-driven (the brand's CMP → `/collect` … withdrawal emits `consent.withdrawn`)") and consent **read** via `GET /customers/{brainId}/consent` (§3.6). The implementation instead exposes operator **REST writes** `POST /api/v1/consent/grant|withdraw|check` (`consent.routes.ts:97/156/224`) that are not in the §3 catalog. `POST /consent/check` (:224) writes an `audit_log` row on every call (`:264-279`) — a side-effecting, non-idempotent POST with no `Idempotency-Key` and no rate limit, so it can flood the gate-activity audit feed.
**Impact:** Undocumented surface (drift); the audited probe can be abused to spam the compliance audit log; no replay protection.
**Root Cause:** Track-C operator tooling added a synchronous consent surface not reconciled with the events-first consent design.
**Recommended Fix:** Add these to the contract (or route writes through the event path), add `Idempotency-Key` + a per-brand rate limit, and make `check` non-auditing or audited only on real sends.
**Priority:** P2 · **Tenant Impact:** single-tenant (audit-log spam) · **Detection:** gate-activity feed flooded by repeated probes.

### M-6 — CSRF-exempt `set-brand`/`set-org` TOCTOU + `bff/csrf` issues a random (non-session-bound) token pre-session
**Severity:** Medium · **Category:** AuthZ / session
**Evidence:** `bff.routes.ts:533-537` documents a known TOCTOU on `set-brand`: "remove+set-brand within the same millisecond leaves a sub-ms window where a removed user re-mints before the revocation check catches up; acceptable for M1." `set-org` does an explicit membership check (`:482-499`) but `set-brand` relies on `switchBrandContext` internally (`:574`). Separately, `GET /api/v1/bff/csrf` (`:94-106`) issues `randomUUID()` (not session-bound) when no session cookie is present — fine for exempt routes, but the token is then cached client-side and the binding only takes effect after session establishment.
**Impact:** A just-removed member can, in a race, re-mint a brand-scoped session for a sub-ms window. Low exploitability, but it is a documented authz soft spot on a mutation.
**Root Cause:** Accepted M1 trade-off.
**Recommended Fix:** Add the same explicit membership-revocation re-check inside `switchBrandContext` transaction as `set-org` has, closing the window.
**Priority:** P2 · **Tenant Impact:** multi-tenant (brand-scoped session for a removed member) · **Detection:** brand-scoped session audit on removed members.

---

## LOW

### L-1 — `/api/v1/dev/*` routes exist on the `/api/v1` surface (env-gated) — namespace pollution
**Severity:** Low · **Category:** RESTfulness / hygiene
**Evidence:** `dev.routes.ts:18` `GET /api/v1/dev/last-email-link` and `devShopifySyncRoutes` `GET /api/v1/dev/shopify/validate-sync` are mounted under the versioned API surface, gated by `if (nodeEnv !== 'production')` (`main.ts:492-495`, `:616-619`). The env gate is correct (two independent gates documented), but placing dev tooling under `/api/v1/dev/*` pollutes the contract namespace and risks accidental prod exposure if the env check ever regresses. `last-email-link` returns verify/reset/invite tokens with no auth (acceptable only because dev-only).
**Impact:** None in prod (not mounted). Contract-namespace hygiene + a single-point-of-failure env check guarding token disclosure.
**Root Cause:** Dev helpers placed under the API prefix for convenience.
**Recommended Fix:** Move dev routes under a non-versioned `/__dev/*` prefix and add a startup assertion that `/__dev` is never registered when `NODE_ENV=production`.
**Priority:** P3 · **Tenant Impact:** single-tenant (dev only) · **Detection:** route present in a prod build.

### L-2 — Path param style: contract says camelCase `{brandId}`/`{connectorId}` (§1.2); implementation uses `:id`
**Severity:** Low · **Category:** Naming conventions
**Evidence:** §1.2: path params camelCase — `/brands/{brandId}`, `/connectors/{connectorId}`. Implemented routes use generic `:id` (`main.ts:904 /connectors/:id/status`, `:1318 /connectors/:id`, `:1389 /connectors/:id/sync`, `brand.routes.ts /brands/:id`, `member.routes.ts /members/:id`). Cosmetic, but a documented naming divergence and slightly less self-documenting.
**Impact:** None functional; OpenAPI param names differ from the contract examples.
**Recommended Fix:** Rename params to `:brandId`/`:connectorId` to match §1.2, or relax §1.2.
**Priority:** P3 · **Tenant Impact:** none · **Detection:** contract/param-name diff.

### L-3 — Validation error status inconsistent: 400 vs the contract's 422 for schema failures
**Severity:** Low · **Category:** Error responses
**Evidence:** §1.5 maps **422** to `VALIDATION_FAILED` (schema/validation). Auth/member/consent routes correctly return 422 (`auth.routes.ts:81`, `consent.routes.ts:117`). But the BFF query-schema routes return **400 `INVALID_DATE`/`INVALID_PARAMS`** on Fastify schema-validation failure (`bff.routes.ts:1157`, `:1305`, `:1360`, `:1502`, `:1922`, etc.). §1.5 reserves 400 for `BAD_REQUEST` (malformed) and 422 for schema/validation — the date-pattern failures are schema failures and should be 422 per the table.
**Impact:** Inconsistent status semantics across the API for the same class of failure.
**Recommended Fix:** Standardize schema-validation failures to 422 (or document the BFF query-validation 400 exception).
**Priority:** P3 · **Tenant Impact:** none · **Detection:** client status-code assertions.

---

## What is genuinely correct (verified, not assumed)
- **AuthN + session revocation on every protected route:** `validateSessionPreHandler` (`auth.routes.ts:403-446`) parses the JWT **and** checks the revocation denylist on every call (NN-3); wired on all BFF protected routes (`bffProtectedPreHandler`), connector/pixel/backfill/sync scopes (`main.ts:862, 946, 1378, 1556, 1592`), member/brand/workspace routes, and consent routes.
- **RBAC coarse gate from JWT claims:** `requireRole` (`rbac.ts:34-57`) reads role from the verified JWT, with a real hierarchy; backfill correctly tightens to `brand_admin` (`main.ts:1423/1490`) while sync allows `manager` (`:1382`); negative controls documented (Manager→403 on backfill).
- **No body-sourced brand_id (anti cross-tenant):** brand always from `auth.brandId` (`getBrandId` `main.ts:710`; every analytics route); `set-org` does an explicit membership check before re-minting (`bff.routes.ts:482-499`).
- **CSRF double-submit + session-bound HMAC** on cookie-authenticated mutations (`main.ts:264-302`), with a correct, narrow exempt list for session-establishing/OAuth/HMAC-webhook routes.
- **Webhooks/OAuth callbacks** are public-by-design but HMAC/state-nonce protected and CSRF-exempt — correct per §0 finding 4 / §4.5.
- **Cursor pagination done right** on `brands` and `members` lists (`brand.routes.ts:190`, `member.routes.ts:186`) — no OFFSET.
- **Secrets never in responses/audit payloads** (I-S09 comments backed by code: connector connect audit payloads carry only `connector_type`).

## Verdict
The implemented API has a **strong security spine** (revocation-checked session on every route, JWT-sourced brand, RBAC from claims, CSRF, HMAC webhooks) and no critical auth/tenant-leak holes on the built surface. However, it is **not contract-conformant**: the canonical `/api/v1/*` domain + MCP surface in doc 06 §3/§4 is mostly **unbuilt** (only a cookie-bound BFF view-model surface exists, H-1), and the cross-cutting governance rules the contract itself flags as "mandatory, not optional" are systematically missing — **wrong error envelope** (no `trace_id`, H-2), **idempotency not enforced** on most mutations including duplicating connector-connect and consent-write (H-3), **`X-Correlation-Id` never echoed** (H-4), and **no tenant-scoped rate limiting or rate-limit headers** on the entire read/NLQ surface (H-5). The net: the code is safer than the contract in one place (JWT brand vs `X-Brand-Id`) but diverges from the frozen contract in many governance dimensions. These are P1 reconciliation items — either build to the contract or amend the contract, but code and `06_Brain_API_Architecture_and_Contracts.md` must stop disagreeing on the wire.
