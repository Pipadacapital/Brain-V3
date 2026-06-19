# Attack Surface Analysis (2026-06-19)

**Auditor verdict:** The externally-reachable attack surface is **small and well-defended**. Every public write path (event ingest, all three webhooks, the OAuth callback, the BFF) carries an explicit, code-verified authn/authz control: HMAC-first signature checks, server-side OAuth state nonces, jti-bound double-submit CSRF, and session-revocation preHandlers. **brand_id is never sourced from an attacker-controlled body on any webhook** — it is resolved from a `SECURITY DEFINER` DB row (MT-1). The read-only MCP surface is provably non-mutating (`writeToolCount === 0`). The real, exploitable weaknesses are **internal boundary-enforcement failures** (dead ESLint fences) that remove the CI backstop protecting the per-tenant data seam — not open front doors. **Headline: 0 verified open-door auth bypasses on the external perimeter; the highest-severity multi-tenant risk is a structurally-inert ESLint fence (RS-1/ARC-2) that no longer guards the `withBrandTxn`/`withSilverBrand` brand-predicate seam.**

---

## 1. Entry-point inventory (trust boundaries)

| # | Surface | Path | Deployable | Trust boundary | Auth model |
|---|---------|------|-----------|----------------|------------|
| E1 | Event ingest | `POST /collect`, `POST /v1/events` | collector | **Internet → spool** (untrusted) | None (accept-before-validate); admission gate only |
| E2 | Pixel asset | `GET /pixel.js` | collector | Internet → static JS | Public, unauthenticated by design |
| E3 | Shopify webhook | `POST /api/v1/webhooks/shopify` | core | Shopify → live lane | HMAC-SHA256 (X-Shopify-Hmac-Sha256) |
| E4 | Razorpay webhook | `POST /api/v1/webhooks/razorpay` | core | Razorpay → live lane | HMAC-SHA256 (X-Razorpay-Signature) + replay window |
| E5 | Shopflo webhook | `POST /api/v1/webhooks/shopflo` | core | Shopflo → live lane | HMAC (ShopfloHmac VO) |
| E6 | OAuth callbacks | `/api/v1/connectors/shopify/callback`, Meta, Google Ads | core | Vendor → connector store | HMAC + server-side state nonce |
| E7 | BFF session/data | `/api/v1/bff/*` | core | Browser → core | httpOnly cookie + jti-bound CSRF + session-revocation preHandler |
| E8 | Auth/workspace/brand/member | `/api/v1/auth/*`, `/api/v1/workspace/*`, `/api/v1/brand/*`, member routes | core | Browser/client → core | Bearer/cookie session + RBAC |
| E9 | Consent (DPDP) | consent.routes (`/api/v1/...`) | core | Browser → core | session preHandler |
| E10 | MCP tools | metric-engine read tool registry | core `ai` module | Model/agent → metric read | **Read-only, `writeToolCount===0`** |
| E11 | Dev routes | `/api/v1/dev/*`, devShopifySync | core | local only | **NODE_ENV-gated (not registered in prod)** |

---

## 2. Per-surface authn/authz posture (with evidence)

### E1 — Event ingest (`/collect`) — *accept-before-validate, intentionally unauthenticated*
- No schema validation, no auth on the handler — by design (D-1 invariant). `apps/collector/src/interfaces/rest/collect.route.ts:25-29` accepts raw JSON and the spool INSERT is the durability anchor.
- **Admission gate present, not auth:** `edge-guard.ts:51-65` fixed-window rate-limit keyed on `properties.install_token`; token-less bodies counted under a shared `__tokenless__` bucket (`edge-guard.ts:38,52`) so a token-fuzzing flood cannot exhaust memory (bucket cap `edge-guard.ts:47,57-60`). Origin allowlist `edge-guard.ts:69-73`; empty allowlist = allow-all (dev default — **prod must set it**). `bodyLimit: 1 MiB` at `apps/collector/src/main.ts:128`.
- **Stateless by mandate:** edge guard NEVER sets a cookie (REC-4, `edge-guard.ts:15,88`).
- **Trust-boundary note:** `install_token` and `brand_id` arrive in the body and are *attacker-controlled here* — the collector does NOT trust them; identity/brand resolution happens downstream in the stream-worker. This is the correct posture but means **abuse spend is paid in spool/stream cost before quarantine** (R2 downstream).
- **Tenant leak vector:** none at E1 — the collector writes to a single spool, brand attribution is deferred.

### E2 — Pixel asset (`/pixel.js`) — *public static JS, no secrets*
- `apps/collector/src/interfaces/rest/pixel-asset.route.ts:124-134` serves JS with `Cache-Control: public, max-age=300`. The boot config (`install_token`, `brand_id`) is injected by the host page (`window.__brain`, line 11-31), not embedded in the served asset — so the asset itself leaks nothing. `credentials:"omit"` on the collect fetch (line 86). **No finding.**

### E3/E4/E5 — Webhooks — *HMAC-first, brand from DB row (strongest surface)*
- **HMAC is the first write-gating operation** and uses `timingSafeEqual` with length-guard: `ShopifyHmac.ts:46-57` (OAuth) / `:79-88` (webhook, base64); Razorpay handler enforces NN-4 ordering at `razorpayWebhookHandler.ts:119-230` — invalid/missing signature ⇒ 401, no DB write.
- **MT-1 (multi-tenant authority):** `brand_id` is resolved from `resolve_razorpay_connector_by_account($1)` SECURITY DEFINER fn (`razorpayWebhookHandler.ts:165-191,279-281`) and **NEVER from the webhook body** (explicit at `:21,280,376`). The Kafka partition key is `brand_id` (`:389`), preserving tenant isolation downstream.
- **Replay protection:** 5-min age window + Redis SET-NX dedup on `event_id` (`razorpayWebhookHandler.ts:232-277`). Age-fail ⇒ 400, duplicate ⇒ 409.
- **PII discipline:** raw `payment_id`/UTR hashed at the boundary with per-brand salt (`:349-368`); raw IDs kept out of logs (C5, `:302,320`); `webhook_secret`/`secret_ref` never logged or returned (I-S09/NN-2, `:25-26`).
- **Assessment:** This is the best-defended write surface in the repo. **No verified finding.** Residual risk: secret-lookup-then-HMAC ordering means an unauthenticated caller can trigger a DB `SELECT` + a Secrets Manager fetch *before* HMAC validation (`razorpayWebhookHandler.ts:163-220`) — a low-grade unauthenticated-resource-consumption vector (DoS amplification on the connector-lookup path), but no data exposure since both paths dead-end at 401.

### E6 — OAuth callbacks — *state nonce server-side, brand not from query*
- `HandleOAuthCallbackCommand.ts:88-93` validates a **server-stored, brand-bound, single-use, ≤15-min state nonce** (`IOAuthStateStore`); `brandId` is derived from the state record, **NOT the query string** (MED-CALLBACK-01, `:32,89-90`). Callback is CSRF-exempt at the app hook (`apps/core/src/main.ts:277`) precisely because state-validation substitutes for CSRF. **No finding.**

### E7 — BFF — *layered: cookie + jti-bound CSRF + revocation preHandler*
- Session-revocation preHandler on **every** protected BFF route (NN-3, `bff.routes.ts:3,103,124-156`); httpOnly cookie → Bearer bridge (`main.ts:252-254`).
- **CSRF is jti-bound double-submit (SEC-0009-M02):** the CSRF token = `HMAC(cookieSecret, "csrf:" + jti)` (`csrf.ts:35-37`), compared constant-time (`csrf.ts:40-47`), and the app-wide hook checks cookie===header **AND** header===`HMAC(jti)` (`main.ts:287-294`). This binds the token to the session and auto-invalidates on session rotation — stronger than vanilla double-submit. CSRF only enforced when authenticating via the session cookie (`main.ts:266`); Bearer-only and listed public mutations are exempt (`main.ts:268-278`).
- **Assessment:** sound. **No verified finding.** Auditor note: `jtiFromJwt` decodes the JWT payload *without* signature verification (`csrf.ts:20-32`) — acceptable because the token's security derives from the server-secret HMAC, and `validateSession` verifies the signature separately; flagged only so a future refactor does not start *trusting* the unverified jti for anything else.

### E10 — MCP tool surface — *provably read-only*
- `apps/core/src/modules/ai/mcp/tools.ts:15-22` re-exports the registry from `@brain/ai-gateway-client`; `mcp-tools.ts:64` computes `writeToolCount = MCP_TOOLS.filter(t => t.access !== 'read').length` and the CI assertion in `tools/isolation-fuzz/src/mcp.test.ts` rejects any non-read tool (I-S08). All tools `access:'read'` (`mcp-tools.ts:45,52`). **No excessive-agency / insecure-tool finding** — the agentic surface cannot mutate state or run SQL.

### E11 — Dev routes — *correctly prod-gated*
- `dev.routes.ts:5-6` registered only when `NODE_ENV !== 'production'`; `main.ts:493` gates `registerDevRoutes`. The dev route exposes email action links (`/api/v1/dev/last-email-link`) — a real account-takeover vector **if it ever leaks into prod**. Gating is correct today; **the risk is a future env-config regression**, so this belongs on the production-readiness watch-list, not as a current vuln.

---

## 3. Security findings mapped to the surface (verified, with evidence)

| Surface | Finding | Severity (verified) | Evidence | Exploitability / leak vector |
|---------|---------|---------------------|----------|------------------------------|
| Internal seam protecting E3-E10 data path | **RS-1 / ARC-2: metric-engine ESLint fence is structurally inert** | **High** | `eslint.config.mjs:54-99` ('app' descriptor at L56 precedes 'core-module' at L58 ⇒ every `apps/core/*` file classifies as type `app`; fence `from:['core-module',...]` is unsatisfiable). Confirmed `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` exits 0 with the rule at level 2. No `@brain/*` import resolver wired (only `eslint-import-resolver-node`). | **Multi-tenant leak vector (latent, not live).** The fence was the CI backstop guaranteeing the metric-engine is only reached through the brand-predicate seam (`withBrandTxn`/`withSilverBrand`). With it dead, any future module can import metric-engine and **bypass the brand predicate undetected** ⇒ cross-tenant read. 9 prod files in `ai`/`attribution`/`data-quality`/`frontend-api` already import it (`credit-writer.ts:34-35`, `get-metric-trust.ts:14-15`, `bff.routes.ts:79-82`, `resolver-prompt.ts:13`). No live leak proven; the *guard* is gone. |
| Attribution → OLAP | **ARC-2: direct StarRocks read outside Analytics API** | **High** | `apps/core/src/modules/attribution/internal/credit-writer.ts:160-167` runs `SELECT` on `brain_silver.silver_touchpoint` via `withSilverBrand`; class exported from `attribution/index.ts:46-48`. | Brand predicate **is** applied via `withSilverBrand`, so isolation holds in practice — but this read sits *outside* the Analytics API's single isolation fuzz surface, so a future predicate change there is not covered by the isolation test suite. Latent tenant-leak surface expansion. |
| BFF (E7) → workspace-access | **ARC-1: BFF reaches into workspace-access/internal in 10 places** | Medium | `apps/core/src/modules/frontend-api/internal/bff.routes.ts:45-53,72-73` import `MembershipRepository`/`OrganizationRepository`/`OnboardingService`/`RateLimiter`/login keys from internal paths absent from `workspace-access/index.ts`; `eslint.config.mjs:102-114` no-restricted-imports never matches relative `../../` specifiers (verified `eslint bff.routes.ts` exits 0). | No runtime/auth impact. Risk: a per-brand RLS change on membership queries would **not** be inherited by the BFF automatically — a maintainability/isolation-drift vector, not an open door. |
| All connector identity hashing (E3-E5) | **DP-1: phone-guard threshold logic duplicated & divergent** | High (DDD) | `apps/stream-worker/src/domain/identity/IdentityResolver.ts:117-159` uses `existingCount+1 > threshold` while dead `SharedUtilityPolicy.evaluate` (`SharedUtilityPolicy.ts:26-66`) uses `> threshold`. | The phone-guard is the abuse control preventing a shared/spoofed phone from over-merging identities across customers. The *live* logic is in IdentityResolver (correct path), but the divergent dead policy means any reviewer reasoning from `SharedUtilityPolicy` mis-models the guard. Identity-merge integrity risk if the wrong copy is ever wired. |
| Connector cursor mgmt (repull jobs feeding E3-E5 brands) | **CQ-1: cursor/sync-state copied across 4 repull jobs** | Medium | `razorpay-settlement-repull/run.ts:360-520`, `gokwik-awb-repull/run.ts:296-438`, `meta-spend-repull/run.ts:268-365`, `shopify-repull/run.ts:440-497`. | A security/GUC hardening fix to cursor handling must land in 4 copies; brands whose connector maps to an unpatched copy silently miss it. (Note: current copies are GUC-consistent — the earlier "GUC drift" claim was disproven; this is drift *risk*, not a live gap.) |
| Stream-worker pools (E3-E5 ingest path) | **CQ-5: 8 worker pools omit idle/statement timeouts** | Low | `apps/stream-worker/src/main.ts:199,243,263,294` + 4 repull pools vs governed `LedgerWriter.ts:67-68` / `IdentityRepository.ts:45-46`. | DoS/resource-exhaustion: a stuck query holds a connection with no `statement_timeout`, and a slow tenant repull can starve another tenant's sync — service-wide, all tenants. |

---

## 4. Trust-boundary map (data flow)

```
INTERNET (untrusted)
  │  install_token, brand_id in body — NOT trusted at edge
  ▼
[E1 /collect] edgeGuard(rate-limit+origin) → spool INSERT → drainer → Kafka
  │  brand attribution deferred to stream-worker (quarantine on bad token)
  ▼
VENDOR (semi-trusted, must prove identity)
  │  HMAC + replay window
  ▼
[E3/E4/E5 webhooks] HMAC-FIRST(401) → replay(400/409) → brand_id from SECURITY DEFINER row (MT-1) → Kafka key=brand_id
  ▼
BROWSER (authenticated session)
  │  httpOnly cookie + jti-bound CSRF
  ▼
[E7/E8 BFF + auth/workspace] session-revocation preHandler (NN-3) → RBAC → metric-engine read seam
                                                                          │
                                            ⚠ RS-1/ARC-2: ESLint fence here is INERT
                                            ⚠ the withBrandTxn/withSilverBrand predicate
                                              is the ONLY remaining tenant guard
  ▼
METRIC-ENGINE / OLAP (StarRocks Silver) — brand-predicate-scoped
```

**The single most important trust boundary in the system — the brand-scoped metric-engine read seam — has lost its CI enforcement backstop (RS-1/ARC-2). Tenant isolation now rests entirely on developers remembering to route through `withBrandTxn`/`withSilverBrand`, with no automated guard to catch a regression.**

---

## 5. Exploitable-path summary

- **No verified open-door authentication bypass** on any external surface (E1-E11). Every write path enforces its declared control in code.
- **Highest live multi-tenant risk: the inert ESLint fence (RS-1/ARC-2, High).** It is not itself a leak, but it is the removed guardrail that would otherwise catch the leak. **P1 fix:** reorder `core-module` before `app` in `eslint.config.mjs` and add `eslint-import-resolver-typescript`; then route `credit-writer.ts:160-167` through the Analytics API.
- **Identity-merge integrity (DP-1, High):** divergent phone-guard threshold logic — converge on the live IdentityResolver semantics and delete the dead policy + its tests.
- **Low-grade unauthenticated resource consumption** on the webhook connector-lookup path (DB SELECT + Secrets fetch before HMAC) and on the timeout-less worker pools (CQ-5) — DoS amplification, no data exposure.
- **Config-regression watch-list (not current vulns):** edge-guard origin allowlist defaults to allow-all (`edge-guard.ts:70`) — prod must set it; dev email-link routes (E11) are prod-gated only by `NODE_ENV` — a deploy-config error re-opens an account-takeover surface.
