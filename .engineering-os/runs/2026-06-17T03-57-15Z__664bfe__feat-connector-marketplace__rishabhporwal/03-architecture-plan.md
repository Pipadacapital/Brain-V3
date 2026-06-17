# Architecture Plan — feat-connector-marketplace

**Stage:** 2 — Architecture (BINDING)
**Architect:** Architect agent
**Date:** 2026-06-17
**Lane:** HIGH_STAKES (auth, connectors, money, multi_tenancy, outbound_channel, pii, schema_proto, secrets_auth_iam)
**Input (binding):** `02-cto-advisor-review.md` (D-1..D-12 + KEY CLARIFICATION) · `01-requirement.md`
**Paradigm:** **Tier-1 deterministic** — static registry lookup, a state-machine, a lookup table, OAuth flows, DB writes. **Zero model calls. $0/mo model spend. 0 tokens/day.** A model call anywhere in this slice is a paradigm-bypass — reject at review. (Confirmed by intake Paradigm Assessment.)
**Decision:** **GO for builders** — two parallel tracks (`@backend-developer` ∥ `@frontend-web-developer`), commit-per-slice, contracts + migration frozen first as the coordination point.

---

## 0. Codebase reality (grounded — `file:line`, no abstractions)

What already exists and is **reused, not rewritten**:

| Capability | Location | Disposition |
|---|---|---|
| Shopify InitiateOAuth (nonce, state-bound brand) | `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.ts:27` | **Register under dispatch table** (type='shopify'). Untouched. |
| Shopify callback (HMAC-first, brand from `consumeAndGetBrandId(state)`) | `…/HandleOAuthCallbackCommand.ts:75` (brand derivation `:94-99`; `OAuthCallbackInput` has NO brandId `:26-35`) | **Reuse verbatim.** The generic callback dispatches into this. |
| DisconnectCommand (deletes secret + marks disconnected + emits) | `…/DisconnectCommand.ts:24` | **Extend:** flip `health_state→Disconnected`, `safety_rating→blocked`, write audit. |
| ISecretsManager (Shopify-shaped) | `…/infrastructure/secrets/ISecretsManager.ts:18` (`storeShopifyToken`/`getShopifyClientSecret`/`deleteShopifyToken`/`getShopifyToken`) | **Generalize additively** (D-3). Keep old methods for back-compat. |
| LocalSecretsManager / AwsSecretsManager | `…/secrets/LocalSecretsManager.ts:15` / `AwsSecretsManager.ts:28` | Add generic methods. AWS write adds per-brand `EncryptionContext`. |
| IOAuthStateStore (brand-bound nonce, single-use) | `…/infrastructure/state/IOAuthStateStore.ts:12` | Untouched. InProcess impl is the M1 dev stand-in (scale note → Redis later). |
| PgConnectorInstanceRepository | `…/infrastructure/repositories/PgConnectorInstanceRepository.ts:42` | **Extend:** read/write `health_state`+`safety_rating`; generalize `provider` typing off the `'shopify'` literal. |
| GetConnectorStatusQuery (shopify + meta/google coming_soon) | `…/application/queries/GetConnectorStatusQuery.ts:24` | **Replaced** by a catalog-join query (returns all categories + health). |
| Migration 0006 (connector_instance, RLS FORCE, secret_ref, UNIQUE(brand_id,provider), CHECK provider IN ('shopify')) | `db/migrations/0006_connector.sql:19-50` | **NOT touched.** New `0021` is additive. |
| Connector routes (read=analyst+, write=manager+) — **live in `main.ts`, not the BFF module** | `apps/core/src/main.ts:458-505` (scoped `requireRole('analyst')` `:461` / `requireRole('manager')` `:479`) | **This is the "BFF route" surface** in this codebase. Web reaches it via `/api/bff/*` proxy. New generic routes register here. |
| **DIVERGENT callback in main.ts** — reads `query['brand_id']` and **400s if missing** | `apps/core/src/main.ts:422-433` | **BUG vs D-1.** This inline public callback violates MED-CALLBACK-01. The generic `/api/v1/oauth/callback/:type` **replaces** it (brand from state only). |
| RBAC guard `requireRole(min)` + `ROLE_HIERARCHY=['analyst','manager','brand_admin','owner']` | `…/workspace-access/internal/security/rbac.ts:34` + `…/domain/membership/entities.ts:32` | **Reuse** for authz (D-9). |
| Audit writer (DbAuditWriter, **real sha256 — L-02 already closed**) | `packages/audit/src/index.ts:120` (`append()` `:123`); wired `apps/core/src/main.ts:296` (`auditWriter`) | **Reuse** the `auditWriter` instance for connect/disconnect (D-11). |
| Zod contract for connector | `packages/contracts/src/api/connector.api.v1.ts:22` (provider `z.enum(['shopify'])` `:25`; status 3-state `:29`) | **Extend** (I-E01): ConnectorType union, catalog entry, 7-state, generic connect req/resp. |
| Web client (`connectorsApi`, `RawConnectorListEnvelope`, `mapConnectorList`) | `apps/web/lib/api/client.ts:467-561` | **Extend:** catalog list, generic `connect(type)`, keep `.data` unwrap. |
| Web marketplace (`ConnectorsList`/`ConnectorCard`, testids, coming-soon disabled) | `apps/web/components/connectors/connectors-list.tsx:46-220` | **Rebuild category-organized** + health badge. Reuse testids/a11y pattern. |
| Web hooks / types | `apps/web/lib/hooks/use-connectors.ts:8`; `apps/web/lib/api/types.ts:204-216` | Extend (catalog item, health_state). |
| BFF→core proxy base | `apps/web/lib/api/client.ts:52` (`BFF_BASE='/api/bff'`) | Unchanged path; new routes are additive. |

**Single-Primitive sweep: CLEAN, extend-only.** ONE secrets seam (generalize, not fork), ONE audit log (`auditWriter`), ONE RBAC guard (`requireRole`), ONE state store, ONE `connector_instance` table (+2 columns), ONE OAuth callback path (the generic one *replaces* the divergent main.ts inline + the shopify-specific route → no per-connector fork), ONE catalog SoR. **No new service, no new table, no new deployable, no new ADR.** (I-E05 honored.)

---

## 1. Bound seams (each an inline ADR — one line)

- **ADR-CM-1 (Catalog SoR):** the connector catalog is a **static TypeScript `const`** at `apps/core/src/modules/connector/catalog/registry.ts`, the sole SoR for marketplace rendering — *not* a DB table (no `connector_definition`), because catalog changes are code deploys. (D-2)
- **ADR-CM-2 (Generic connect):** `POST /api/v1/connectors {type}` reads the catalog → `coming_soon ⇒ 422`, `oauth ⇒ {oauth_url}` via a **static dispatch table** (no plugin registry / no `IConnector` base class), `credential ⇒ store via secrets seam`; the existing Shopify `InitiateOAuthCommand` is *registered*, not reimplemented. (D-5)
- **ADR-CM-3 (Generic callback):** `GET /api/v1/oauth/callback/:type` derives `brand_id` **exclusively** from `consumeAndGetBrandId(state)` — never body/query/header — and **replaces** the divergent `main.ts:422` inline callback that reads `query['brand_id']`. (D-1)
- **ADR-CM-4 (Secrets generalization):** add `storeSecret/getSecret/deleteSecret` to `ISecretsManager` keyed by `(brandId, connectorRef, payload)`; AWS impl sets per-brand `EncryptionContext:{brand_id, connector_type}`; Shopify-specific methods stay for back-compat, unused by new code; `LocalSecretsManager` **hard-fails if instantiated in production**. (D-3, D-7)
- **ADR-CM-5 (Health model):** 7-state `health_state` + 3-state `safety_rating` are **two additive columns** on `connector_instance` (migration `0021`), *not* a `connector_health` history table; the persisted column is truth, the state→safety map is a TS lookup. (D-4)
- **ADR-CM-6 (UNIQUE):** keep `UNIQUE(brand_id, provider)` for M1 — see §6 justification — and document the multi-instance limit as known debt; **not** widened to `(brand_id, provider, external_id)` this slice.
- **ADR-CM-7 (Authz point):** server-side `requireRole` middleware at the route scope — connect/disconnect = `manager+`; backfill gate = `brand_admin+` (gate only, execution deferred); analyst read-only ⇒ 403 on writes. (D-9)
- **ADR-CM-8 (Envelope):** every new response is `{request_id, data}`; the web client unwraps `.data` at the call site — no 9th mismatch. (D-10)
- **ADR-CM-9 (Audit):** connect + disconnect call `auditWriter.append(...)` (the existing real-sha256 `DbAuditWriter`) — the structural write path, not just an event emit. (D-11)
- **ADR-CM-10 (Deferred line):** detector / backfill-execution / live-sync / DQ-gating / `connector.health.changed` emit are **out of diff** (§9). (D-12)

---

## 2. Migration `0021_connector_health.sql` (additive — DDL sketch)

**Number chosen: `0021`** (latest is `0020_provisional_gmv_as_of.sql`). Additive only; 0006 untouched; existing RLS policies untouched (already two-arg FORCE); `brain_app` GRANT unchanged (columns inherit table grants).

```sql
-- 0021_connector_health.sql — additive: 7-state health + safety on connector_instance.
-- I-E02 (additive only): NO DROP, NO rewrite of 0006. NN-2 unaffected (no token column).
-- RLS already ENABLE+FORCE on connector_instance (0006:42-43); policy untouched.

-- 1) 7-state health (default keeps every existing row valid → 'Healthy').
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS health_state TEXT NOT NULL DEFAULT 'Healthy'
    CHECK (health_state IN
      ('Healthy','Delayed','Failed','Disconnected','RateLimited','TokenExpired','Disabled'));

-- 2) 3-state recommendation safety.
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS safety_rating TEXT NOT NULL DEFAULT 'safe'
    CHECK (safety_rating IN ('safe','degraded','blocked'));

-- 3) EXTEND provider CHECK additively to the Phase-1a catalog providers (even if
--    they ship coming_soon — keeps the column ready when a credential connector lands).
--    Drop+recreate the CHECK CONSTRAINT only (NOT the column) — additive in effect.
ALTER TABLE connector_instance DROP CONSTRAINT IF EXISTS connector_instance_provider_check;
ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
  CHECK (provider IN ('shopify','meta','google_ads','razorpay'));

-- 4) status CHECK: NO change needed this slice — health_state is the new SoR for the
--    7-state surface; the legacy 3-state `status` stays as-is (connect/disconnect still
--    write it for back-compat). Documented: status is legacy, health_state is the surface.
```

**Token-storage note (KEY CLARIFICATION honored):** NO `oauth_token_ciphertext` column. NO `*_token`/`*_ciphertext`/`*_secret`/`*_key`. The ONLY credential reference remains `connector_instance.secret_ref` (ARN). The requirement's "oauth_token_ciphertext" phrasing is **not implemented** — it contradicts NN-2/I-S09 and the 0006 model. Semgrep DDL scan covers `0021`.

**State→safety mapping (TS lookup, `catalog/healthSafety.ts`; column is persisted truth):**

| health_state | safety_rating |
|---|---|
| Healthy | safe |
| Delayed | degraded |
| RateLimited | degraded |
| Failed | blocked |
| Disconnected | blocked |
| TokenExpired | blocked |
| Disabled | blocked |

Transitions THIS slice: connect ⇒ `Healthy`/`safe`; disconnect ⇒ `Disconnected`/`blocked`. No detector (D-12).

---

## 3. Catalog type + entries (`catalog/registry.ts` — the SoR)

```ts
// apps/core/src/modules/connector/catalog/registry.ts — the single SoR (D-2).
export type ConnectorCategory =
  | 'storefront' | 'ads' | 'payments' | 'logistics' | 'messaging' | 'crm' | 'analytics';
export type ConnectMethod = 'oauth' | 'credential' | 'coming_soon';

export interface ConnectorDefinition {
  id: string;                 // canonical type key (matches provider CHECK where it has a backend)
  category: ConnectorCategory;
  displayName: string;
  connectMethod: ConnectMethod;
  availability: 'available' | 'coming_soon';  // M1 availability for THIS slice
  description: string;        // for the tile
}

export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  // storefront
  { id: 'shopify',    category: 'storefront', displayName: 'Shopify',    connectMethod: 'oauth',       availability: 'available',   description: 'Sync orders, products, customers.' },
  { id: 'woocommerce',category: 'storefront', displayName: 'WooCommerce',connectMethod: 'coming_soon', availability: 'coming_soon', description: 'WordPress storefront sync.' },
  // ads
  { id: 'meta',       category: 'ads',        displayName: 'Meta Ads',   connectMethod: 'oauth',       availability: 'coming_soon', description: 'Campaign spend & performance.' },
  { id: 'google_ads', category: 'ads',        displayName: 'Google Ads', connectMethod: 'oauth',       availability: 'coming_soon', description: 'Search & shopping campaigns.' },
  // payments
  { id: 'razorpay',   category: 'payments',   displayName: 'Razorpay',   connectMethod: 'credential',  availability: 'coming_soon', description: 'Settlement reconciliation.' },
  // logistics
  { id: 'shiprocket', category: 'logistics',  displayName: 'Shiprocket', connectMethod: 'coming_soon', availability: 'coming_soon', description: 'Shipping & delivery status.' },
  // messaging
  { id: 'whatsapp',   category: 'messaging',  displayName: 'WhatsApp',   connectMethod: 'coming_soon', availability: 'coming_soon', description: 'Customer messaging.' },
  // crm
  { id: 'hubspot',    category: 'crm',        displayName: 'HubSpot',    connectMethod: 'coming_soon', availability: 'coming_soon', description: 'CRM contacts & deals.' },
  // analytics
  { id: 'ga4',        category: 'analytics',  displayName: 'Google Analytics 4', connectMethod: 'coming_soon', availability: 'coming_soon', description: 'Web analytics.' },
] as const;
```

**Phase-1a binding (intake):** `shopify` = oauth **available**; `meta`/`google_ads`/`razorpay` ship with their real `connectMethod` but `availability: 'coming_soon'` for THIS slice; long-tail = `coming_soon`. **All 7 categories have ≥1 tile** (success criterion #1). The server-side connect gate keys off the **effective method**: a definition with `availability:'coming_soon'` is treated as un-connectable (422) **regardless** of its `connectMethod`, so a Phase-1a oauth-but-coming-soon (meta) is rejected exactly like a long-tail coming_soon.

**Helper (`catalog/index.ts`):** `getDefinition(type)`, `isConnectable(def) = def.availability === 'available'`, `mapHealthToSafety(state)`.

---

## 4. The A↔B interface contract (FROZEN FIRST — parallelization point)

All three shapes land in `packages/contracts/src/api/connector.api.v1.ts` (I-E01) before either track writes a handler. Track A produces the envelope; Track B consumes `.data`.

```ts
// ── ConnectorType discriminated by connectability (Persona-3 C3: coming-soon
//    is structurally non-connectable at the type level, not just runtime). ──
export const ConnectableConnectorType = z.enum(['shopify']); // only available+method!=coming_soon in M1
export const ConnectorTypeSchema = z.string(); // any catalog id (for catalog rendering)

// ── Catalog + status join (the marketplace GET response) ──
export const MarketplaceTileSchema = z.object({
  id: z.string(),
  category: z.enum(['storefront','ads','payments','logistics','messaging','crm','analytics']),
  display_name: z.string(),
  description: z.string(),
  connect_method: z.enum(['oauth','credential','coming_soon']),
  available: z.boolean(),                         // false ⇒ tile disabled, un-connectable
  // present only when this brand has an instance:
  instance: z.object({
    id: z.string().uuid(),
    status: z.enum(['connected','disconnected','error']),     // legacy 3-state
    health_state: z.enum(['Healthy','Delayed','Failed','Disconnected','RateLimited','TokenExpired','Disabled']),
    safety_rating: z.enum(['safe','degraded','blocked']),
    shop_domain: z.string().nullable(),
    connected_at: z.string().datetime({ offset: true }).nullable(),
    // NN-2: NO secret_ref, NO token in this response (success criterion #4).
  }).nullable(),
});
export const MarketplaceListResponseSchema = z.object({
  request_id: z.string(),
  data: z.object({ tiles: z.array(MarketplaceTileSchema) }),  // grouped client-side by category
});

// ── Generic connect req/resp ──
export const ConnectRequestSchema = z.object({
  type: z.string(),                               // validated against catalog server-side
  shop_domain: z.string().optional(),             // oauth(shopify) needs it
  credentials: z.record(z.string()).optional(),   // credential connectors
});
export const ConnectResponseSchema = z.object({
  request_id: z.string(),
  data: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('oauth'), oauth_url: z.string().url() }),
    z.object({ kind: z.literal('credential'), connected: z.literal(true) }),
  ]),
});
// coming_soon ⇒ 422 { request_id, error:{ code:'CONNECTOR_NOT_AVAILABLE' } } (not in data union).
```

**Contract freeze = the green light for both tracks to start in parallel.** Track A owns producing it; Track B mocks against it.

---

## 5. Generic connect / callback / disconnect contract (Track A internals)

**Dispatch table** (`catalog/dispatch.ts`) — static, no registry:
```ts
interface OAuthDispatch { initiate(input:{brandId,shopDomain?,callbackUrl}): Promise<{oauth_url:string}>; }
const OAUTH_DISPATCH: Record<string, OAuthDispatch> = {
  shopify: { initiate: (i) => initiateOAuth.execute({...}).then(r => ({ oauth_url: r.installUrl })) },
  // meta/google_ads: NOT registered this slice (they're coming_soon → 422 before dispatch).
};
```

`POST /api/v1/connectors` handler order:
1. `requireRole('manager')` (scope preHandler, D-9).
2. `def = getDefinition(type)`; unknown ⇒ 400 `UNKNOWN_CONNECTOR_TYPE`.
3. `!isConnectable(def)` (availability!=='available') ⇒ **422 `CONNECTOR_NOT_AVAILABLE`** (success criterion #2). This catches meta/google_ads/razorpay/long-tail.
4. `def.connectMethod==='oauth'` ⇒ `OAUTH_DISPATCH[type].initiate(...)` ⇒ `{kind:'oauth',oauth_url}`. Shopify requires `shop_domain` (400 if missing).
5. `def.connectMethod==='credential'` ⇒ `secrets.storeSecret(brandId, {connectorType:type}, credentials)` ⇒ write `connector_instance` (`health_state='Healthy'`,`safety_rating='safe'`) ⇒ audit ⇒ `{kind:'credential',connected:true}`. (No available credential connector ships M1, but the path is bound + unit-tested.)

`GET /api/v1/oauth/callback/:type` (PUBLIC — HMAC/state is the auth, no session guard):
- Dispatches to the type's callback command. For shopify ⇒ existing `HandleOAuthCallbackCommand.execute({query, idempotencyKey})` **unchanged** — brand_id from `consumeAndGetBrandId(state)` only (D-1). On success, set `health_state='Healthy'`, write audit. **Replaces** `main.ts:422-433` (delete the `brand_id`-from-query inline handler).
- `idempotencyKey = \`${type}-oauth-${state}\`` (NO brand_id in the key — it's not known pre-state-consume, and that's the point).

`DELETE /api/v1/connectors/:id`:
1. `requireRole('manager')`.
2. Existing `DisconnectCommand` extended: after `secretsManager.deleteSecret(secret_ref)` + status flip, set `health_state='Disconnected'`,`safety_rating='blocked'`; write audit `connector.disconnected`.
- Provider-side revocation = **out of scope** (intake §Scope Cuts) — delete-from-secrets only.

**Backfill gate (D-9, execution deferred):** register `POST /api/v1/connectors/:id/backfill` under `requireRole('brand_admin')` returning **501 `NOT_IMPLEMENTED`** (the gate is real + role-tested; execution is a later slice). This makes the Manager-can-connect-but-not-backfill negative control (criterion #7) testable now.

**Audit entries (D-11)** via existing `auditWriter`:
`{ brand_id, actor_id: auth.userId, actor_role: auth.role, action: 'connector.connected'|'connector.disconnected', entity_type:'connector_instance', entity_id: connectorInstanceId, payload:{ connector_type } }` — NO token, NO secret_ref in payload (I-S02/I-S09).

---

## 6. UNIQUE constraint decision (ADR-CM-6 — explicit, justified)

**Decision: KEEP `UNIQUE(brand_id, provider)` for M1. Do NOT widen to `(brand_id, provider, external_id)` this slice.**

Justification: (a) M1 ships exactly one connectable connector (shopify) and Shopify is genuinely one-store-per-brand; (b) the only multi-instance case is Razorpay-multiple-settlement-accounts which is `coming_soon` this slice with zero write path; (c) widening now requires deciding `external_id` semantics per-connector (shop_domain? razorpay account id?) with no consumer to validate against — that's speculative schema. **Reversibility:** widening later is itself additive (drop the 2-col UNIQUE, add a 3-col UNIQUE with nullable `external_id`) — `0021` does NOT paint us in because no FK or app code assumes one-row-per-provider beyond the connect path, which already does upsert-by-(brand,provider). Documented as known limit `KNOWN-CM-01: one instance per (brand,provider) until a multi-account connector lands`.

---

## 7. Track split + commit-per-slice checkpoints

Prior builders died on ~61-min infra socket timeouts — **only committed work survived**. Each slice below is an independent commit; a builder commits at every ✓ checkpoint, never batches.

### Track A — `@backend-developer` (branch `feat/connector-marketplace`, base master HEAD)

**A0 (FREEZE — blocks B start):** contracts in `connector.api.v1.ts` (§4 shapes) + `catalog/registry.ts` (§3) + `catalog/healthSafety.ts` map + `catalog/index.ts` helpers. **Commit ✓** "contracts+catalog frozen". *(2–5 min tasks: add 4 Zod schemas at `connector.api.v1.ts:48`; create registry const; create map.)*

**A1 — migration:** `db/migrations/0021_connector_health.sql` (§2) + extend `PgConnectorInstanceRepository` (`:14` row type +2 cols, `:27` rowToEntity, `:92` INSERT cols, `:125` UPDATE SET) + extend `ConnectorInstance` entity props for health. **Commit ✓** "0021 + repo health columns". *(migration file; row interface; 3 SQL edits.)*

**A2 — secrets generalization (D-3/D-7):** add `storeSecret/getSecret/deleteSecret` to `ISecretsManager.ts:18`; implement in `LocalSecretsManager.ts:15` (+ **prod hard-fail** guard) and `AwsSecretsManager.ts:28` (+ per-brand `EncryptionContext`). **Commit ✓** "generic secrets seam". *(interface 3 methods; 2 impls; 1 prod-guard in `main.ts:355` composition root.)*

**A3 — generic connect/callback/disconnect + dispatch + authz:** `catalog/dispatch.ts`; new routes in `main.ts` (POST `/api/v1/connectors`, GET `/api/v1/oauth/callback/:type`, backfill 501 gate); **delete divergent callback `main.ts:422-433`**; extend `DisconnectCommand.ts:32` for health+audit; marketplace GET query (catalog⨝instance). Wire `auditWriter` into connect/disconnect. **Commit ✓** "generic seam + authz + audit". *(dispatch; 3 route blocks; 1 deletion; disconnect edit; status query.)*

**A4 — live tests (the proof):** see §8. **Commit ✓** "Track A live tests green". Run under `BRAIN_APP_DATABASE_URL` (brain_app pool — dev superuser masks RLS, MEMORY).

### Track B — `@frontend-web-developer` (same branch, starts after A0 commit)

**B0:** extend `apps/web/lib/api/types.ts:207` `ConnectorListItem` → `MarketplaceTile` (category, connect_method, available, instance.health_state/safety_rating); add `ConnectorCategory`/`HealthState` types. **Commit ✓** "web types from contract".

**B1:** `connectorsApi` in `client.ts:530` — add `listCatalog()` (GET `/v1/connectors`, unwrap `.data.tiles`), `connect(type, opts)` (POST, unwrap `.data`, discriminate oauth/credential), keep `disconnect`. New `RawMarketplaceEnvelope` + `mapTiles`. **Commit ✓** "web client catalog+connect". *(D-10: `const {data}=await bffFetch(...)` at call site — no `response.oauth_url` without unwrap.)*

**B2:** rebuild `connectors-list.tsx` category-organized: group tiles by category, truthful per-tile status (Not Connected / Connect / Coming Soon / health-state badge when connected), coming-soon disabled + un-connectable, **errored connector flagged** (safety `blocked`/`degraded` shows a badge — never silently undercounted), health badge renders one of 7 states. Reuse a11y icon+label pattern (`:25-44`). data-testids: `marketplace-category-{cat}`, `connector-card-{id}`, `btn-connect-{id}`, `btn-disconnect-{id}`, `health-badge-{id}`, `coming-soon-{id}`, `btn-skip-for-now`. **Commit ✓** "category marketplace UI".

**B3 — Skip-For-Now first-class:** a `Skip For Now` button on the marketplace + verify NO BFF route gates on `connector_instance count = 0` (criterion #10 — grep dashboard/onboarding routes; the onboarding completeness check at `bff.routes.ts:862` is informational, not a gate — confirm it doesn't 4xx). Persist skip to `onboarding_progress` if the onboarding flow re-prompts (additive JSONB write via existing onboarding advance route). **Commit ✓** "skip-for-now first-class".

**B4 — Playwright e2e:** see §8. **Commit ✓** "Track B e2e green".

**Parallelization:** B0–B2 proceed against the frozen §4 contract while A1–A3 build the server. They converge at A4/B4 (live + e2e need the real server). No cross-track file collisions: A owns `apps/core/**` + migration + contracts; B owns `apps/web/**` (B0 edits `types.ts` which A does not touch).

---

## 8. Test plan → mapped to intake success criteria (#1–#13)

**Track A (live, `SET ROLE brain_app` where isolation is asserted):**
- `catalog.test.ts` — all 7 categories present, ≥1 tile each; shopify=available, meta/google/razorpay=coming_soon → **#1**.
- `connect.coming-soon.live.test.ts` — `POST /connectors {type:'meta'}` ⇒ **422**; `{type:'razorpay'}` ⇒ 422; `{type:'shopify'}` ⇒ 200 oauth_url → **#2**.
- `callback.forged-body.live.test.ts` — valid state + **forged `brand_id` in body**; assert the instance is created under the **state-derived** brand, body value ignored → **#3** (reuse `HandleOAuthCallbackCommand.test.ts` harness).
- `token-never-leaks.test.ts` — schema introspection: no `*_token`/`*_ciphertext` column; connect + disconnect response payloads contain no token / no `secret_ref` → **#4**.
- `health-state.test.ts` — connect⇒`Healthy`/`safe`, disconnect⇒`Disconnected`/`blocked`; full 7→3 mapping table asserted → **#5, #6**.
- `authz.live.test.ts` — Manager connect 200 + backfill **403** (brand_admin gate); Analyst connect **403** → **#7**.
- `isolation.brain_app.live.test.ts` — brand A connector NOT visible to brand B under `SET ROLE brain_app`; **non-inert**: assert `count === 0` (seed A via super pool, query as B via app pool — reuse `realized-revenue-ledger.live.test.ts:41-90` dual-pool harness) → **#8**.
- `audit.live.test.ts` — after connect, `audit_log` has `action='connector.connected'` + correct `brand_id`/`actor_id`; same for disconnect → **#9**.
- `envelope.test.ts` — every new response is `{request_id,data}`; contract-shape assert → **#11**.

**Track B (Playwright + contract):**
- `marketplace.spec.ts` — categories render + truthful tiles (no faked-live), Skip-For-Now navigates with no error, an OAuth tile's Connect initiates (redirect to `oauth_url`) → **#12, #10**.
- coming-soon tile disabled assertion → **#1/#2 UI side**.

**Scope-guard (reviewer, #13):** grep diff for `backfill` (execution), `live-sync`, `health-detector`, `volume-anomaly`, `connector.health.changed` — any hit is a violation. The 501 backfill gate is the ONLY allowed `backfill` reference and has no execution body.

**Real-network smoke:** the OAuth initiate path returns a real Shopify `oauth_url` (live test hits the install-URL build; full Shopify token exchange needs staging env — carry-forward C5, documented, not blocking M1 dev).

---

## 9. OUT OF THIS SLICE (D-12 — hard line, reject at review)

- Health **detector** — any logic reading live data to drive health transitions (volume-anomaly, schema-violation, match-rate, tracking-dark). Only connect⇒Healthy / disconnect⇒Disconnected this slice.
- **Backfill execution** — the 24-month paged pull, `prod.backfill.*` topics, Argo Workflow, any Redpanda consumer for connector data. (Only the `brand_admin+` **gate** at 501 ships.)
- **Live sync** — webhooks, polling+cursor advancement, settlement-file ingestion, freshness targets.
- **DQ gating** — A+→D grade transitions, recommendation-safety driving exclusion logic (the *surface* ships; the *gating engine* does not).
- **`connector.health.changed`** event emit.
- **Provider-side OAuth revocation** (Meta/Google revoke endpoints) — disconnect deletes from Secrets Manager only.
- Deep Shopify pull, Razorpay/Meta/Google deep connectors (catalog tiles only), GCC connectors, a `connector_definition` DB table, an `IConnector`/`BaseConnector`/plugin registry, real per-brand KMS wiring in dev (ISecretsManager stands in), Redis state store (InProcess is M1; scale note recorded).

---

## 10. Risk / reversibility

- **Reversibility:** `0021` is purely additive (2 columns w/ defaults + a widened CHECK) — back-out = `DROP COLUMN health_state, safety_rating` + restore the narrow provider CHECK; no data loss (legacy `status` untouched). The generic routes are additive; deleting `main.ts:422-433` is replacing a buggy path (D-1) with a correct one. Secrets generalization is additive (old methods retained).
- **Top risk — the divergent callback (`main.ts:422`):** it reads `brand_id` from query and 400s without it. The generic callback **must fully replace it** or D-1 is violated *and* the existing Shopify connect breaks. Folded into A3 as a REQUIRED pass-1 item + the forged-body test (#3) is the guard.
- **RLS masking:** dev runs as superuser `brain` (MEMORY) — isolation tests are inert unless run under `brain_app`. A4 isolation test MUST use the brain_app pool; QA vetoes otherwise (D-8).
- **Envelope drift:** 8 prior bugs. B1 binds `.data` unwrap at the call site; `envelope.test.ts` + the QA VETO catch a 9th.
- **Cost:** $0/mo, 0 tokens/day (Tier-1). No model path exists; introducing one is a paradigm-bypass.
- **No deploy-pipeline track needed beyond existing:** no new service/deployable (I-E05) — core + web only; the existing affected-only build + per-service deploy + canary path covers both (mirrors `feat-analytics-api-dashboard` D-10/D-11). No new GitOps app.

---

## 11. Acceptance contract (persona must-fixes folded as pass-1 REQUIRED items)

Every item below is REQUIRED on builder pass 1 (a miss is a rework bounce, not a "later"):

1. **[Sec-C1/D-1]** Generic callback derives brand_id from state ONLY; `main.ts:422` divergent handler DELETED; forged-body test passes. *(Track A)*
2. **[Sec-C2/Int-C1/D-3]** Generic `storeSecret/getSecret/deleteSecret`; Shopify methods kept but unused by new code; LocalSecretsManager prod hard-fail. *(A)*
3. **[Sec-C3]** Disconnect = delete-from-secrets + status/health flip; NO provider revocation (documented non-goal). *(A)*
4. **[Sec-C4/D-11]** connect + disconnect call `auditWriter.append`. *(A)*
5. **[Sec-C5/D-5/#2]** Server rejects coming-soon (and coming-soon-availability oauth like meta) with 422. *(A)*
6. **[Int-C2/ADR-CM-6]** UNIQUE(brand_id,provider) kept; KNOWN-CM-01 documented. *(A)*
7. **[Int-C3]** Static dispatch table; unknown type ⇒ 400 (not 500); Shopify routes not duplicated. *(A)*
8. **[Hon-C1/#5/#6]** marketplace response includes health_state + safety_rating; tile renders it; blocked/degraded never silently dropped. *(A+B)*
9. **[Hon-C2/#10]** Skip-For-Now first-class; no BFF route 4xx on zero connectors. *(B, verify A)*
10. **[Hon-C3]** `ConnectorType`/`ConnectableConnectorType` discriminated — coming-soon non-connectable at the type level + runtime. *(A0 contract)*
11. **[Scale-C1/D-4]** 2 columns on connector_instance, NOT a health table. *(A)*
12. **[Scale-C2/D-8]** Isolation test under `SET ROLE brain_app`, non-inert (count===0). *(A)*
13. **[Scale-C3/D-2]** Catalog static TS, no DB table. *(A0)*
14. **[Scale-C4]** InProcessOAuthStateStore documented as scale-blocker → Redis path reserved. *(A, doc only)*
15. **[D-9/#7]** Authz: connect/disconnect manager+, backfill brand_admin+ (501 gate), analyst 403. *(A)*
16. **[D-10/#11]** `{request_id,data}` envelope; client `.data` unwrap at call site. *(A+B)*
17. **[D-12/#13]** No detector/backfill-exec/live-sync/DQ/health-event code in diff. *(both)*

---

**HANDOFF state:** `dev-parallel` · owners: `@backend-developer` (Track A, lead — owns A0 contract freeze) + `@frontend-web-developer` (Track B, starts post-A0). Stage 3.
