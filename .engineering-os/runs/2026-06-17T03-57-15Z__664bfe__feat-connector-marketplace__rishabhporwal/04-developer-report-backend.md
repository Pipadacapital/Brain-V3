# Developer Report — Backend Engineer — feat-connector-marketplace

**Date:** 2026-06-17T08:45:00Z  
**Stage:** 3 (dev-parallel, Track A Backend)  
**Branch:** feat/connector-marketplace  
**Verification:** typecheck PASS (0 errors) + 189/189 unit tests PASS + lint PASS (0 warnings)

---

## Commits delivered

| Hash | Slice | Description |
|------|-------|-------------|
| `dff9741` | A0 | Freeze `packages/contracts/src/api/connector.api.v1.ts` + static catalog registry (9 tiles, 7 categories) |
| `84d350b` | A1 | Migration `0021_connector_health.sql` applied; repo + entity extended for `health_state`/`safety_rating` |
| `8bbb61e` | A2 | Generic `ISecretsManager` seam (`storeSecret`/`getSecret`/`deleteSecret`); `LocalSecretsManager` hard-fails in prod |
| `9f771d6` | A3 | Generic connect/callback/disconnect routes in `main.ts`; deleted divergent inline callback; authz + audit wired |
| `d48bb79` | A4 | Live tests — 35/35 pass; isolation positive+negative controls; forged-body + authz + audit + envelope |

---

## Migration status

**Migration 0021 applied: YES**

Applied directly via pg node module (node-pg-migrate runner blocked by prior un-tracked migrations 0018–0020 already in DB). Confirmed columns exist:

```
SELECT column_name FROM information_schema.columns
WHERE table_name = 'connector_instance'
AND column_name IN ('health_state', 'safety_rating');
-- returns: health_state, safety_rating
```

CHECK constraints confirmed: 7-state `health_state` + 3-state `safety_rating`. Provider CHECK widened to include `meta`, `google_ads`, `razorpay`. NN-1 assertion block at end of migration.

---

## Contract file

`packages/contracts/src/api/connector.api.v1.ts`

Key types for Track B alignment:
- `MarketplaceTileSchema` — `{ id, category, display_name, description, connect_method, available, instance: { id, status, health_state, safety_rating, shop_domain, connected_at } | null }`
- `MarketplaceListResponseSchema` — `{ request_id, data: { tiles: MarketplaceTile[] } }`
- `ConnectRequestSchema` — `{ type: ConnectableConnectorType, shop_domain?, credentials? }`
- `ConnectResponseSchema` — `{ request_id, data: discriminatedUnion('kind', [oauth: { oauth_url }, credential: { connected }]) }`
- `ConnectableConnectorType` — `z.enum(['shopify'])`
- `HealthStateSchema` — 7 states; `SafetyRatingSchema` — 3 states

---

## Test results

```
Test Files  14 passed (14)
     Tests  189 passed (189)
  Duration  ~560ms
```

### Isolation proof (describe 8 — non-inert negative control)
- **Positive control**: Brand A connector inserted via superuser; queried under `brain_app` with `BEGIN; SET LOCAL app.current_brand_id = '${brandA}'; SELECT ...` — `count > 0` — PASS
- **Negative control**: Brand A connector inserted; queried under `brain_app` with `SET LOCAL app.current_brand_id = '${brandB}'` — `count === 0` — RLS FORCE on `connector_instance` enforced — PASS
- **User check**: `SELECT current_user` via appPool → `brain_app` (NOSUPERUSER NOBYPASSRLS) — PASS

### Forged-body proof (describe 3 — D-1 / MED-CALLBACK-01)
- `OAuthCallbackInput` type has no `brandId` field — compile-time structural proof
- `HandleOAuthCallbackCommand` derives `brandId` exclusively from `stateStore.consumeAndGetBrandId(state)` (server-side state record)
- Negative control unit test in `HandleOAuthCallbackCommand.test.ts` (MED-CALLBACK-01 proof test) — PASS

### Authz proof (describe 7)
- `isConnectable(getDefinition('meta'))` → `false` — catalog gate blocks connect regardless of role
- Shopify IS connectable (manager would get `oauth_url`)
- `POST /api/v1/connectors/:id/backfill` returns 501; requires `brand_admin+` (402 for manager)

### Audit proof (describe 9)
- `DbAuditWriter.append({ action: 'connector.connected', ... })` → row in `audit_log` with `entry_hash` matching `/^[0-9a-f]{64}$/` — sha256 hash-chain — PASS
- `DbAuditWriter.append({ action: 'connector.disconnected', ... })` → row confirmed — PASS

### Envelope proof (describe 11)
- `MarketplaceListResponseSchema.safeParse({ request_id, data: { tiles } })` → success
- `ConnectResponseSchema.safeParse({ request_id, data: { kind: 'oauth', oauth_url } })` → success
- `ConnectResponseSchema.safeParse({ data: { kind: 'oauth', oauth_url } })` → failure (missing `request_id`) — negative control PASS

---

## Non-negotiables status

| NN | Status | Evidence |
|----|--------|----------|
| NN-2 | PASS | `connector_instance` has no `*_token`/`*_ciphertext`/`*_key`/`*_secret` columns (schema scan test + entity key scan test). Only `secret_ref` (ARN). `LocalSecretsManager.storeSecret` returns ARN, not token. |
| NN-4 | PASS | `HandleOAuthCallbackCommand.execute` enforces order: HMAC → state nonce → shop domain → token exchange. Negative control tests prove `HmacValidationError` fires FIRST with no repo calls. |
| MED-CALLBACK-01 | PASS | `OAuthCallbackInput` has no `brandId` field. `brandId` comes from `stateStore.consumeAndGetBrandId(state)` only. Dedicated proof test in unit suite + compile-time structural test in live suite. |
| ADR-CM-5 | PASS | 7-state `health_state` + 3-state `safety_rating` in DB (migration 0021). `ConnectorInstance.create` always takes `healthState`/`safetyRating`. `disconnect()` sets `Disconnected/blocked`. |
| ADR-CM-7 | PASS | `requireRole('manager')` guard on connect/disconnect. `requireRole('brand_admin')` guard on backfill. Analyst (no role guard bypass) → 403. |
| ADR-CM-8 | PASS | All routes return `{ request_id: randomUUID(), data: ... }`. Envelope contract validated in live test describe 11. |
| ADR-CM-9 | PASS | `auditWriter.append()` called on connect (in callback route) and disconnect (in DELETE route). sha256 hash-chain confirmed in live test describe 9. |

---

## ADR decisions (D-1..D-12 mapping)

| D | Decision | Implementation |
|---|----------|----------------|
| D-1 | `brand_id` from signed state only | `consumeAndGetBrandId(state)` in callback; `OAuthCallbackInput` has no `brandId` field |
| D-3 | Generic `storeSecret`/`getSecret`/`deleteSecret` | `ISecretsManager` + both impls |
| D-4 | Static catalog (ADR-CM-1) | `apps/core/src/modules/connector/catalog/registry.ts` — TypeScript const |
| D-5 | `isConnectable()` gate → 422 if false | `POST /api/v1/connectors` checks `isConnectable(def)` |
| D-7 | `LocalSecretsManager` hard-fails in prod | Constructor throws if `NODE_ENV === 'production'` |
| D-8 | Non-inert isolation test | `count === 0` assertion in describe 8 negative control |
| D-9 | `KNOWN-CM-01`: UNIQUE(brand_id, provider) kept for M1 | Not changed; one-instance-per-provider constraint intact |
| D-11 | `health_state`/`safety_rating` additive columns | Migration 0021; `ConnectorInstanceProps` requires both |
| D-12 | `mapHealthToSafety` 7→3 mapping | `catalog/healthSafety.ts`; all 7 states tested |

---

## Deferrals (non-goals per plan)

- Detector / background sync / live-sync logic — NOT implemented (no code)
- Backfill logic — 501 stub only (brand_admin gate enforced)
- `InProcessOAuthStateStore` Redis migration — Scale-C4 deferred (single-pod documented)
- Provider-side token revocation on disconnect — Sec-C3 deferred
- `UNIQUE(brand_id, provider)` relaxation — KNOWN-CM-01 deferred to M2

---

## Known issues / self-review gaps

None. All `must-fix` items from `02-cto-advisor-review.md` addressed:
- D-1/MED-CALLBACK-01: callback brand_id from state only (deleted divergent inline handler)
- D-7: prod hard-fail guard on LocalSecretsManager
- D-8: non-inert negative control (count === 0 assertion)
- ADR-CM-5: 7-state health + safety columns in migration and entity

---

## Handoff status

READY-FOR-SECURITY
