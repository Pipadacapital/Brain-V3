# CTO Advisor Review — feat-connector-marketplace
**Stage:** 1 — Intake  
**Reviewer:** Engineering Advisor (cto-advisor)  
**Date:** 2026-06-17T08:00:00Z  
**Decision:** ADVANCE

---

## Lane Confirmation

**Lane:** HIGH_STAKES — confirmed, not downgraded.

**Trigger surfaces validated:**

| Surface | Basis |
|---|---|
| `multi_tenancy` | connector_instance is brand-scoped; RLS FORCE required on every new table |
| `connectors` | the entire feature; OAuth, credential, health model, catalog |
| `auth` | OAuth CSRF state nonce, brand_id derivation from signed state, disconnect revocation |
| `money` | Razorpay catalog stub ships here; no money processing in this slice, but the seam lands |
| `outbound_channel` | OAuth redirect is an outbound request from a brand user's session |
| `pii` | OAuth access tokens are PII-adjacent credentials; per-brand KMS EncryptionContext |
| `schema_proto` | additive migration to extend connector_instance.status CHECK + new health/safety columns |

**Added surface (not in scan):** `secrets_auth_iam` — the ISecretsManager seam boundary and dev vs prod KMS EncryptionContext difference is load-bearing for this feature and must be in scope.

**Persona count:** 4 (compressed — inhabited by reviewer, not spawned). All four are mandatory for high-stakes.

---

## Dependency Pre-flight

Blocker check against `proposed_children[].blocks`:

- feat-m1-app-foundation (the Shopify OAuth/HMAC impl) — SHIPPED (commit facacfe chain, dev-only, verified in journal)
- feat-access-onboarding-flow + feat-members-team-management (the role model: owner/brand_admin/manager/analyst) — SHIPPED (journal 2026-06-16)
- feat-analytics-api-dashboard (the dashboard the connectors will feed) — SHIPPED (journal 2026-06-17)

No blocked dependency. Pre-flight PASSES.

---

## "Make It Less Dumb" Pass

Before personas: what can be deleted, simplified, or deferred from the submitted requirement?

1. **Delete:** `oauth_token_ciphertext` column naming in the requirement text is confusing — the existing architecture stores only `secret_ref` (ARN), never a ciphertext in Postgres. The requirement's phrasing "connector_instance.oauth_token_ciphertext" contradicts NN-2 (I-S09) which is already enforced in 0006. The CORRECT model is: tokens in AWS Secrets Manager, `secret_ref` (ARN) in Postgres. The Architect must not introduce a ciphertext column. Tokens-in-KMS is handled by the ISecretsManager seam; the ciphertext language in the requirement is imprecise and must not be implemented literally. Clarified in D-3.

2. **Simplify:** The catalog is a static TypeScript registry (a `const` object or module file), not a DB table. The requirement says this; confirm and lock it. A DB-backed catalog at this stage is premature: it adds a migration, a CRUD API, and a migration story for zero benefit when the catalog changes are code changes anyway. Lock it to static.

3. **Defer (confirmed already deferred, guard the line):** health detector/eventing, backfill execution, live sync, deep Shopify pull. The 7-state model ships as schema + safety-mapping + honest surface; transitions are connect→Healthy / disconnect→Disconnected only for M1. The detector that *drives* transitions is a later slice. Any code path that smuggles in detector logic (volume anomaly checks, schema violation counts, DQ gate transitions) is out of scope and must be rejected at code review.

4. **Simplify:** InProcessOAuthStateStore is the dev stand-in for the nonce store. It is correct for M1 (single-instance, no horizontal scale in dev/staging). Do not replace with Redis unless scaling demands it; document the scale note as tech-debt.

5. **Simplify:** The generic connect seam needs to be thin enough that Shopify registers without rewrite. The right shape is a dispatch table keyed by connector type — not an abstract base class or plugin registry (scope-defer is already in index.ts: "NO IConnector/BaseConnector/plugin registry"). The Architect must not add one.

---

## Persona Concerns

### Persona 1 — Security / Compliance Officer

**Concern 1 (CRITICAL): brand_id derivation in the generic callback path**

The existing Shopify `HandleOAuthCallbackCommand` already correctly derives `brand_id` from the server-side state record (`stateStore.consumeAndGetBrandId(state)`) and the `OAuthCallbackInput` interface intentionally has no `brandId` field. The risk is in GENERALIZING this: if the Architect creates a new generic callback endpoint `GET /api/v1/oauth/callback/:type` and maps it to a handler, the handler receives `req.params.type` and `req.query`. A naive implementation might be tempted to also accept `brand_id` from `req.body` or `req.query` as a convenience for future connectors. That would be a forged-body attack surface. The binding is: `brand_id` ONLY from the consumed state nonce record, NEVER from query/body/header — and the test must assert this (a request with a forged `brand_id` in the body is rejected / the body value is ignored and the state-derived value is used).

**Concern 2 (HIGH): ISecretsManager seam boundary — is dev a security gap?**

The `LocalSecretsManager` stores tokens in an in-process `Map`. This is correct behavior for dev/test. The security gap is: the existing `ISecretsManager` interface is Shopify-specific — its methods are `storeShopifyToken`, `getShopifyClientSecret`, `deleteShopifyToken`, `getShopifyToken`. The generic connect seam will need a generalized interface (e.g., `storeConnectorToken(connectorType, brandId, credential)` → ARN). If the Architect creates a new generic interface, the dev stub must remain a true stand-in (no tokens in Postgres, fake ARN returned). The prod path requires per-brand KMS `EncryptionContext: {brand_id: <uuid>}` on every secret store call so that cross-brand decryption is structurally impossible even if ARNs leak. This must be in the binding (D-3 and D-7).

**Concern 3 (HIGH): disconnect must actually revoke at the provider**

The existing `DisconnectCommand` deletes the token from Secrets Manager (`deleteShopifyToken`) and marks the connector_instance as `disconnected`. For Shopify, the access token is NOT revoked at the Shopify API — it is only deleted from local storage. For M1 Shopify this is acceptable (the token becomes unreachable). BUT for OAuth connectors with explicit revocation endpoints (Meta, Google), the generic disconnect contract must define whether token revocation at the provider is in-scope for THIS slice. The recommendation is: for this slice, disconnect = delete from Secrets Manager + update status; provider-side revocation is a later slice per-connector. This must be documented explicitly in the non-goals to avoid the Architect silently skipping it without a record.

**Concern 4 (MEDIUM): audit log coverage for connect / disconnect**

The existing connect and disconnect emit events (`connector.connected`, `connector.disconnected`). But neither currently writes to the system-of-record `audit_log` (hash-chained, WORM). For a security-relevant action (a user authorizing data access from an external system), this should land in the audit log, not just as an event. The requirement text does not mention it. Binding: connect + disconnect MUST write an `audit_log` entry via `packages/audit` (the same path as membership changes). This is the sha256-debt reminder: L-02-audit-sha256 waiver is open — audit writes before M1 prod must resolve it, but the structural write path must be established NOW.

**Concern 5 (MEDIUM): Coming-Soon tile coercion via API**

The requirement correctly says no tile ever fakes live and Coming-Soon tiles cannot be connected. The security concern is server-side enforcement: if the catalog is static and the connect endpoint (`POST /api/v1/connectors`) receives `{type: "meta"}`, does the server reject it because `meta` has `connectMethod: 'coming_soon'`? Or does it silently fail at a later step? The server-side check must be: read the catalog definition for the requested type; if `connectMethod === 'coming_soon'`, return 400/422 immediately. The client-side disabled button is a UX convenience, not the gate.

---

### Persona 2 — Integration Realist

**Concern 1 (HIGH): ISecretsManager is Shopify-shaped, not generic**

The current interface has `storeShopifyToken(brandId, shopDomain, accessToken)` — the `shopDomain` parameter is Shopify-specific. A generic seam for Razorpay (key + secret pair, no shop domain) or Meta (long-lived access token, no domain) cannot call this method without a semantic mismatch. The Architect must design a generalized method signature before the generic connect command is written. Options: `storeConnectorToken(connectorType: string, brandId: string, credential: Record<string, string>)` → ARN. The Shopify-specific method can stay for backward compatibility during the refactor but the generic command uses the generic method. The LocalSecretsManager stub must implement the same generic signature.

**Concern 2 (HIGH): the UNIQUE constraint (brand_id, provider) on connector_instance blocks multi-instance**

Migration 0006 has `CONSTRAINT connector_instance_brand_provider_unique UNIQUE (brand_id, provider)`. This is correct for M1 Shopify (one store per brand). But: the `provider` column currently only allows `'shopify'` (CHECK constraint). The generic connect seam needs to extend the CHECK to include new providers as they land. The additive migration for this slice must: (a) extend the `provider` CHECK to include the Phase-1a providers as they are added to the catalog, even if they ship as Coming-Soon; (b) extend the `status` CHECK to the 7 health states. But also: for credential connectors (Razorpay), a brand might have multiple accounts (different settlements). The UNIQUE constraint on (brand_id, provider) would block a second Razorpay connection. This slice does not implement Razorpay deep, but the constraint must not paint the schema into a corner. Recommendation: extend the UNIQUE to (brand_id, provider, external_id) where external_id is nullable (shopDomain for Shopify) — or accept the M1 one-per-provider limit and document it as a known constraint. The Architect must make this decision explicitly.

**Concern 3 (MEDIUM): connector-type dispatch table vs routing by URL**

The generic connect endpoint is `POST /api/v1/connectors {type}`. The callback is `GET /api/v1/oauth/callback/{type}`. The dispatch from `:type` to the right command (ShopifyInitiateOAuth, future MetaOAuth) should be a static dispatch table in the connector module, not a dynamic require/plugin-registry. The type string must be validated against the catalog before dispatch (unknown type → 400, not 500). The Shopify routes file (`shopifyConnectorRoutes.ts`) currently registers its own routes directly; the generalization must wire these into the common dispatch without duplicating route registration.

---

### Persona 3 — Honesty / Product Skeptic

**Concern 1 (HIGH): errored connector silently undercounted — where exactly is "flagged"?**

The requirement says "a connector in an error state is flagged in the combined view, never silently undercounted." The "combined view" is the Analytics API dashboard and the Connectors marketplace. The marketplace tile showing "Failed" or "Token Expired" is the honest surface in THIS slice. But the combined view also means: when the dashboard computes `realized_gmv`, it must know whether the data feeding it is from a connector that is in `blocked` safety state. In THIS slice the metric engine is read-only and the connector health is separate — but the requirement must define: does the marketplace page show a banner "some connectors are in a degraded state — recommendations may be incomplete"? If yes, the BFF connector-list response must return the health state and safety mapping. The success criterion must name the exact UI artifact. Binding: the connector-list API response includes health_state (one of 7) and safety (safe|degraded|blocked) for each connected instance; the marketplace tile renders this; no aggregation silently excludes a blocked connector's indicator.

**Concern 2 (HIGH): "Skip For Now" must be server-side first-class**

The requirement says Skip For Now is first-class. Currently the only skip-related state is the onboarding_progress column (from feat-access-onboarding-flow). If "Skip For Now" on the marketplace page merely navigates away, it is NOT server-side first-class. Server-side first-class means: a brand with zero connectors can proceed through the entire product flow without being gated; the BFF and any downstream consumer never error or block on the absence of a connector. This is already the non-goal shape ("no source is ever a gate") but it must be verified: does any existing BFF route or middleware return 402/403/redirect if `connector_instance` count = 0 for a brand? If yes, that gate must be removed. The Skip For Now button should persist `shopify_connected: skipped` (or equivalent) to the brand's onboarding_progress, so the onboarding flow does not re-prompt. This is a schema touch (onboarding_progress JSONB field addition — additive, fine).

**Concern 3 (MEDIUM): Coming-Soon tile is un-coachable — verify all paths**

The requirement says "a Coming-Soon tile cannot be connected." The UI enforces this with a disabled button. The server-side enforcement is D-related (server rejects POST /connectors with type=meta). But there is a third surface: the `connectorsApi` client in `apps/web/lib/api/client.ts` has `getShopifyInstallUrl` and `disconnect` — it does NOT have a generic `connect(type)` call yet. The new generic client call must not silently accept any type including coming-soon types. This is a client-contract concern: the TypeScript type for `ConnectorType` in `packages/contracts` must be a discriminated union that makes coming-soon types structurally non-connectable, not just a runtime check.

---

### Persona 4 — Scale / Cost Realist and Multi-Tenancy Skeptic

**Concern 1 (HIGH): 7-state health as a column on connector_instance vs a separate table**

The 7 health states (Healthy / Delayed / Failed / Disconnected / Rate Limited / Token Expired / Disabled) and the safety mapping (safe | degraded | blocked) can be modeled two ways:

Option A: Two new columns on `connector_instance` — `health_state TEXT CHECK(...)` + `safety TEXT CHECK(...)`. Simple, no join, one row per connector.

Option B: A new `connector_health` table — separate from `connector_instance`, enabling health history, the health detector to write independently, and future partitioning.

For THIS slice, Option A is correct (Simplicity First). The detector is deferred; no history is needed yet; the connector_instance already carries status. The migration should ADD two columns to connector_instance: `health_state` (with 7-value CHECK) and `safety_rating` (with 3-value CHECK). BOTH must have RLS FORCE on connector_instance (already exists). The separate-table option is premature for M1. This must be locked in the binding (D-4) to prevent the Architect from over-engineering a full health event table.

**Concern 2 (HIGH): RLS on any new tables — dev superuser masks RLS**

The lessons learned and MEMORY.md both record: dev connects as superuser `brain`; RLS only truly enforced under prod `brain_app`. The existing `connector_instance` RLS uses `FORCE ROW LEVEL SECURITY` — correct. Any new table in this migration (if a health table is added despite recommendation against) must also have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + a two-arg `current_setting('app.current_brand_id', TRUE)` policy. The isolation test for this slice MUST use `SET ROLE brain_app` (not the superuser) and assert cross-brand connector reads = 0. This is D-8.

**Concern 3 (MEDIUM): catalog as a DB table is premature — enforce static registry**

A DB-backed catalog (a `connector_definition` table) would require: a migration, CRUD endpoints, seeding, and a cache-invalidation story. For a catalog that changes on every code deployment anyway, this is pure overhead. The catalog must be a static TypeScript module in the connector module's `catalog/` directory, imported at startup, and never persisted to the DB. The catalog IS the code; deploying new catalog entries IS deploying new code. This is D-5.

**Concern 4 (MEDIUM): InProcessOAuthStateStore is single-instance — document the scale note**

`InProcessOAuthStateStore` stores nonces in memory. If the core monolith scales horizontally (multiple pods), a nonce stored on Pod A will not be found on Pod B when the OAuth callback lands. For M1 single-instance dev this is fine. The binding must document this as a known scale-blocker and reserve the Redis migration path (the IOAuthStateStore seam exists; wire Redis as the production impl when scaling is needed).

---

## Binding Decisions (D-1 through D-12)

The Architect MUST honor every D-item. No D-item may be silently relaxed; a challenge requires a Challenge-Framework entry back to the Engineering Advisor.

**D-1 — brand_id from signed state ONLY, never body/query**
In the generic OAuth callback handler (`POST /api/v1/oauth/callback/:type` or equivalent), `brand_id` is derived EXCLUSIVELY from the consumed server-side state nonce record. The handler accepts no `brand_id` from `req.body`, `req.query`, or `req.headers`. A test MUST assert that a request with a forged `brand_id` in the body is ignored (the state-derived value is used, not the body value). This is a non-negotiable carry-forward of MED-CALLBACK-01 from the Shopify impl.

**D-2 — connector catalog = static TypeScript registry, sole SoR for marketplace rendering**
The connector catalog is a `const` exported from `apps/core/src/modules/connector/catalog/` — a TypeScript module, NOT a DB table. It is the single source of truth for: connector id, category, display name, connectMethod (`oauth | credential | coming_soon`), and M1 availability. The web client derives all tile rendering from the API response that is itself derived from this registry. No DB migration creates a `connector_definition` table. The Architect binds the exact shape (see below: catalog entry shape).

**D-3 — token storage: ARN in Postgres, token in Secrets Manager, per-brand KMS EncryptionContext**
Tokens NEVER land in Postgres. The schema rule (NN-2 / I-S09) already enforces this via the Semgrep DDL scan. The new generic `ISecretsManager` interface must use a method signature of the form `storeConnectorToken(connectorType: string, brandId: string, credential: Record<string, string>): Promise<SecretWriteResult>` where the `SecretWriteResult.arn` is stored in `connector_instance.secret_ref`. In prod, every Secrets Manager write uses `KMSKeyId` scoped with `EncryptionContext: { brand_id: <uuid>, connector_type: <string> }` — per-brand decryption isolation. The `LocalSecretsManager` dev stub extends to implement the generic method; the existing Shopify-specific methods are kept for backward compatibility during the refactor but are not called by the generic connect path.

**D-4 — 7-state health model as TWO NEW COLUMNS on connector_instance (NOT a separate table)**
The additive migration (`0021_connector_health.sql` or the next available number) adds to `connector_instance`:
- `health_state TEXT NOT NULL DEFAULT 'Healthy' CHECK (health_state IN ('Healthy','Delayed','Failed','Disconnected','Rate Limited','Token Expired','Disabled'))`
- `safety_rating TEXT NOT NULL DEFAULT 'safe' CHECK (safety_rating IN ('safe','degraded','blocked'))`

The existing `status` column (`CHECK (status IN ('connected','disconnected','error'))`) is EXTENDED additively — NOT dropped. The migration adds the new CHECK values, keeping backward-compatible existing values. On connect → `health_state='Healthy'`, `safety_rating='safe'`. On disconnect → `health_state='Disconnected'`, `safety_rating='blocked'`. No health detector logic is implemented in this slice. No `connector_health` history table.

**D-5 — generic connect contract: POST /api/v1/connectors (type) returns oauth_url | credential intake; server rejects coming_soon types**
The connect endpoint is `POST /api/v1/connectors` with body `{type: ConnectorType}`. The handler:
1. Looks up the catalog entry for `type`.
2. If `connectMethod === 'coming_soon'` → 422 ("connector not yet available").
3. If `connectMethod === 'oauth'` → dispatches to the type's InitiateOAuth command → returns `{oauth_url: string}`.
4. If `connectMethod === 'credential'` → accepts `{credentials: Record<string, string>}` → stores via generic `storeConnectorToken` → returns `{connected: true}`.
The Shopify InitiateOAuth is registered under `type='shopify'` in the dispatch table. The existing Shopify-specific route (`/connectors/shopify/install`) may remain as a redirect wrapper or be deprecated — the Architect decides, but the generic path is the canonical path.

**D-6 — additive migration only (I-E02); no destructive rewrite of 0006**
Migration 0006 is NOT modified. The new migration:
- EXTENDs `connector_instance.provider` CHECK to add new provider values as they are added to the catalog.
- ADDs `health_state` and `safety_rating` columns (D-4).
- EXTENDs `connector_instance.status` CHECK if needed (additive only).
- Does NOT DROP any column. Does NOT ALTER the existing RLS policies (they are already two-arg FORCE).
- Adds RLS policy on any net-new table (none expected if D-4 is followed).

**D-7 — dev ISecretsManager seam is an honest stand-in, not a security gap**
The `LocalSecretsManager` is ONLY active when `NODE_ENV !== 'production'` or when explicitly injected in tests. The DI wiring in the connector module's composition root must hard-fail if `LocalSecretsManager` is instantiated in production. A runtime check: `if (process.env.NODE_ENV === 'production' && secretsManager instanceof LocalSecretsManager) throw new Error(...)` — or better, the production composition root only imports `AwsSecretsManager`. The `LocalSecretsManager` is not a security gap as long as this boundary is respected; it IS a gap if it can silently activate in production.

**D-8 — RLS FORCE under brain_app; isolation test mandatory; dev superuser masks RLS (carry-in)**
Per the durable memory: dev connects as superuser `brain`; RLS only enforced under `brain_app`. ALL isolation tests in this feature MUST assert cross-brand connector reads under `SET ROLE brain_app`. The test `cross-brand connector reads = 0 under brain_app` is a mandatory acceptance criterion. The QA agent will not PASS this slice without a non-inert negative control (a brand A connector must not appear in a brand B query under `brain_app`, not under the superuser).

**D-9 — authz server-side, not just UI-hidden**
The BFF route for `POST /api/v1/connectors` and `DELETE /api/v1/connectors/:id` must check the authenticated user's role from the JWT before dispatching. Allowed roles: Owner, Brand Admin, Manager. Analyst receives 403. The backfill gate (Owner / Brand Admin only) is enforced here as a middleware check, even though backfill execution is a later slice. The authz check uses the JWT `role` claim (the `IdentityAdapter` / Authentik JWT pattern already established). No authz in the UI alone.

**D-10 — envelope discipline: BFF returns {request_id, data}; client unwraps .data (no 9th mismatch)**
The new connector-list endpoint response follows the `{request_id: string, data: ConnectorListItem[]}` envelope (the same shape as `RawConnectorListEnvelope` in `connectorsApi`). The web client unwraps `.data`. The new generic connect endpoint response follows the same envelope. Any new hook or client function in `apps/web/lib/api/client.ts` uses `bffFetch<T>` and the response shape is unwrapped at the call site with `const { data } = await bffFetch(...)`. The QA VETO criterion: no PR is approved where a client reads `response.oauth_url` without unwrapping the envelope first.

**D-11 — audit log: connect and disconnect write an audit_log entry**
`connector.connected` and `connector.disconnected` are security-relevant events. They MUST write to the `audit_log` table via `packages/audit` (not just emit a Redpanda event). The audit entry carries: `brand_id`, `actor_user_id`, `action` ('connector.connected' | 'connector.disconnected'), `connector_type`, `connector_instance_id`. The sha256 hash-chain debt (L-02-audit-sha256) is still open — the write path must be established now; the hash function will be resolved before M1 prod. This is additive to existing audit coverage.

**D-12 — deferred boundary is a hard line: detector / backfill / live-sync NOT in this slice**
The following are explicitly OUT of scope and will be rejected at code review:
- Any logic that reads live data to compute connector health transitions (the health detector).
- Any Argo Workflow or Redpanda consumer that pulls historical data (backfill execution).
- Any webhook registration or polling cursor advancement (live sync).
- Any DQ gating (A+→D grade transitions).
The only health transitions in this slice are: connect → `Healthy`, disconnect → `Disconnected`. Any implementation that smuggles in the detector (even "just as a stub") is out of scope. Stubs with no tests are tech debt with no value at this stage.

---

## Success Criteria (for Stage 6 final reviewer)

The final reviewer will verify ALL of the following. An unmet criterion blocks PASS.

1. **Catalog renders all categories:** the marketplace page shows all 7 categories (storefront, ads, payments, logistics, messaging, CRM, analytics) with at least one tile per category. Coming-Soon tiles have `connectMethod === 'coming_soon'` in the catalog and render as disabled.

2. **Coming-Soon is un-connectable server-side:** `POST /api/v1/connectors {type: "meta"}` (or any coming-soon type) returns 422. Verified by automated test, not just UI state.

3. **Brand_id from signed state (forged-body rejected):** a test sends a valid OAuth callback with a crafted `brand_id` in the request body; the response uses the state-derived `brand_id`, not the body value. Forged body = test asserts the state-derived brand is used.

4. **Token never in Postgres, never in response:** no column in `connector_instance` stores a token value. The connect API response does NOT include the token or ARN. The disconnect API returns no credential. Verified by schema inspection + response payload assertion.

5. **7-state health + safety on connector_instance:** migration adds `health_state` and `safety_rating` columns. On connect, instance shows `health_state='Healthy', safety_rating='safe'`. On disconnect, instance shows `health_state='Disconnected', safety_rating='blocked'`. State machine test covers all 7 states and 3 safety values with correct mapping.

6. **Safety mapping is complete and correct:** a test asserts the full mapping table: `Healthy→safe`, `Delayed→degraded`, `Failed→blocked`, `Disconnected→blocked`, `Rate Limited→degraded`, `Token Expired→blocked`, `Disabled→blocked`.

7. **Authz negative controls:** a Manager can connect but gets 403 on any backfill endpoint. An Analyst gets 403 on connect. Verified by automated role tests.

8. **Cross-brand isolation under brain_app:** brand A's connector_instance is not visible to brand B's session under `SET ROLE brain_app`. Non-inert negative control: the test asserts a count of 0, not just no error. Verified by isolation test.

9. **Audit log entries for connect + disconnect:** after a connect flow, the `audit_log` table contains an entry with `action='connector.connected'` and the correct `brand_id` and `actor_user_id`. Same for disconnect. Verified by live DB assertion.

10. **Skip For Now is first-class:** a brand with zero connectors can reach the dashboard without a gate. If the BFF has any route that returns non-2xx because `connector_instance` count = 0, that gate is removed or exempted in this slice.

11. **Envelope discipline:** all new API responses follow `{request_id, data}`. Web client unwraps `.data`. Verified by contract test.

12. **Playwright e2e:** marketplace page renders categories + truthful tiles, Skip For Now navigates without error, an OAuth tile's connect button initiates the OAuth flow (returns a redirect to `oauth_url`).

13. **No detector/backfill/live-sync code in the diff:** reviewer grep for any `backfill`, `live-sync`, `health-detector`, `volume-anomaly`, or `connector.health.changed` event emit in the new code. Any hit is a scope violation.

---

## Scope Cuts

The following are confirmed OUT OF SCOPE for this slice. The Architect must not include them:

- Health state transitions driven by live data (the detector is a later slice).
- Backfill execution, Argo Workflow for historical pulls, or any Redpanda consumer for connector data.
- Live sync: webhooks, polling+cursor advancement, settlement file ingestion.
- Provider-side OAuth revocation (Meta/Google revocation endpoints) — disconnect deletes from Secrets Manager only.
- GCC connectors (Salla/Zid/Noon/Tabby/Tamara).
- A `connector_definition` DB table — catalog is static code only.
- An IConnector/BaseConnector/plugin registry — dispatch table is sufficient.
- Real per-brand KMS wiring in dev — ISecretsManager seam stands in.
- The health *detector* eventing (`connector.health.changed`).

---

## Paradigm Assessment

This feature is entirely **Tier-1 deterministic** (ADR-013 / cost-routing-paradigms). No model calls. No ML inference. The catalog is a static registry lookup. The health state is a simple state machine. The safety mapping is a lookup table. Connect/disconnect are OAuth flows and database writes. Cost: $0/month in model spend. No effort-tier declarations needed (no model paths). The marketplace UI renders from a deterministic API response.

No cost-routing concern for this feature.

---

## Canon Check

No invariant violated. No ADR amended. Relevant invariants confirmed in scope:

- **I-S01** (brand isolation): connector_instance RLS FORCE + brain_app isolation test (D-8).
- **I-S09** (secrets never in DB): NN-2 carries forward; token in Secrets Manager, ARN only in Postgres (D-3).
- **I-E02** (additive migration only): 0006 not touched; new migration is additive (D-6).
- **I-E05** (simplicity-first, no new deployable): confirmed — only existing core + web touched (D-5 shape).
- **I-E01** (contract-first): Zod contract in `packages/contracts` for the new endpoint shapes is required before implementation. The Architect must update the contracts package before writing route handlers.

No new ADR needed. No STACK change. No new deployable. No new third-party dependency anticipated.

---

## Decision

**ADVANCE** — the requirement is sound, Canon-aligned, and worth doing. It is the entry layer the entire connector-ingestion epic hangs on. Twelve binding decisions declared. Scope is well-bounded. The four persona concerns range from CRITICAL to MEDIUM; all have dispositions and are folded into the D-bindings. No escalation trigger met.

**Stage 2 (Architect):** resolve the `connector_instance` UNIQUE constraint question (D-4 note: one-per-provider vs (brand_id, provider, external_id)), bind the catalog entry shape (TypeScript interface), bind the generic `ISecretsManager` method signature, design the dispatch table, plan the migration number and columns, and define the `ConnectorType` discriminated union in `packages/contracts` before writing any route handler. Tracks: `@backend-developer` + `@frontend-web-developer` in parallel after the migration and contracts are committed.
