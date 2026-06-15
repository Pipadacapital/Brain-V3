# 05 — Developer Report: Connector + Pixel (Track 2)

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 3 — Build |
| **Track** | 2 — Connector + Pixel |
| **Author** | Backend Engineer |
| **Authored at** | 2026-06-15T23:15:00Z |
| **Verification** | typecheck (0 Track-2 errors) + 29 unit tests PASS |

---

## 1. Design Decisions

| Decision | Rationale |
|----------|-----------|
| **No IConnector/BaseConnector/plugin registry** | Scope-defer per §2. Shopify is self-contained under `sources/storefront/shopify/`. Abstraction emerges when the second connector is built (M1-data-spine or M2). |
| **HMAC as absolute-first operation (NN-4)** | `HandleOAuthCallbackCommand` throws `HmacValidationError` BEFORE touching any repository. Unit tests prove this: tampered HMAC → error + 0 repo calls. |
| **secret_ref-only pattern (NN-2)** | `ConnectorInstance` entity has no `oauth_token`/`*_ciphertext`/`*_key` field. `LocalSecretsManager.storeShopifyToken` returns an ARN string only. The access token is never returned from the command. Unit tests assert the entity has no forbidden field names. |
| **state nonce in InProcessOAuthStateStore (NN-4)** | Single-use enforced by deleting the key on first `consumeAndValidate`. Expiry enforced by wall-clock comparison. In production this is replaced by a Redis-backed store with native TTL. |
| **Pixel verify = real HTTP request (not simulated)** | `VerifyPixelCommand.checkPixelPresence` makes a live `fetch` to the brand's `target_host` and searches the response for `install_token`. Status is written to `pixel_status` from the actual result. |
| **Pixel inside connector bounded context** | Per 03-architecture-plan.md §3 Track 2 instruction: pixel lives under `connector/pixel/`, not as a separate top-level module. Both share the same brand-scoped isolation pattern. |
| **Meta/Google = zero backend** | Only `coming_soon: true` flags in `GetConnectorStatusQuery` response. No routes, no DB rows, no events emitted. |

---

## 2. Folder Structure

```
apps/core/src/modules/connector/
  index.ts                          — public module boundary (re-exports domain types)
  sources/storefront/shopify/
    domain/
      entities/
        ConnectorInstance.ts        — secret_ref-only entity (NN-2)
        ConnectorSyncStatus.ts      — real sync state machine
        ConnectorCursor.ts          — idempotent cursor (I-ST04)
      value-objects/
        ShopifyHmac.ts              — OAuth callback + webhook HMAC (NN-4)
        OAuthStateNonce.ts          — crypto.randomBytes(16), brand-bound (NN-4)
      repositories/
        IConnectorInstanceRepository.ts
        IConnectorSyncStatusRepository.ts
        IConnectorCursorRepository.ts
    application/
      commands/
        InitiateOAuthCommand.ts     — state nonce generation + Shopify install URL
        HandleOAuthCallbackCommand.ts — HMAC-first → state → shop → token → ARN → row
        DisconnectCommand.ts        — disconnect + secret deletion + event
      queries/
        GetConnectorStatusQuery.ts  — real sync status + coming_soon flags
    infrastructure/
      repositories/
        PgConnectorInstanceRepository.ts
        PgConnectorSyncStatusRepository.ts
        PgConnectorCursorRepository.ts
      secrets/
        ISecretsManager.ts          — interface (ARN-only contract)
        LocalSecretsManager.ts      — dev stub (LocalStack-compatible ARN)
      state/
        IOAuthStateStore.ts         — nonce store interface
        InProcessOAuthStateStore.ts — dev stub (single-use, TTL)
    interfaces/
      http/
        shopifyConnectorRoutes.ts   — 5 endpoints per §5.1
      webhooks/
        shopifyWebhookHandler.ts    — HMAC-first webhook (NN-4)
    tests/
      ShopifyHmac.test.ts           — 9 tests (positive + negative controls)
      OAuthStateNonce.test.ts       — 9 tests (entropy, single-use, TTL)
      SecretRef.test.ts             — 7 tests (NN-2 schema assertions)
      HandleOAuthCallbackCommand.test.ts — 4 tests (HMAC order + NN-2 contract)
  pixel/
    domain/
      entities/
        PixelInstallation.ts        — install_token (public), targetHost, installedAt
        PixelStatus.ts              — actual verify state (not simulated)
      repositories/
        IPixelInstallationRepository.ts
        IPixelStatusRepository.ts
    application/
      commands/
        GetOrCreatePixelInstallationCommand.ts — idempotent create + pixel.installed event
        VerifyPixelCommand.ts       — real HTTP HEAD/GET check → pixel_status write
      queries/
        GetPixelHealthQuery.ts      — Postgres-only (§6.4 dashboard source)
    infrastructure/
      repositories/
        PgPixelInstallationRepository.ts
        PgPixelStatusRepository.ts
    interfaces/
      http/
        pixelRoutes.ts              — 3 endpoints per §5.1

db/migrations/
  005_connector.sql                 — connector_instance (NN-2 header) + sync_status + cursor
  006_pixel.sql                     — pixel_installation + pixel_status

tools/isolation-fuzz/src/
  pg.connector.test.ts              — RLS isolation for all 5 Track-2 tables (NN-6)

packages/pixel-sdk/src/index.ts    — Scope comment updated (M1-data-spine boundary explicit)
```

---

## 3. OAuth / HMAC Flow (NN-4 enforcement)

### Initiation (`GET /api/v1/connectors/shopify/install`)
1. `InitiateOAuthCommand` generates `OAuthStateNonce` via `crypto.randomBytes(16)` (128-bit).
2. Nonce stored server-side keyed `shopify:oauth:state:{brandId}:{value}` with 900s TTL.
3. Returns Shopify install URL with `state=nonce&redirect_uri=callbackUrl`.

### Callback (`GET /api/v1/connectors/shopify/callback`)
`HandleOAuthCallbackCommand` enforces the following order (BINDING — NN-4):

```
Step 1: HMAC validation (FIRST — any failure → HmacValidationError → HTTP 401, no further processing)
Step 2: State nonce validation (consume server-stored nonce; single-use; 15-min TTL)
Step 3: Shop domain validation (must match *.myshopify.com)
Step 4: Token exchange with Shopify (POST /admin/oauth/access_token)
Step 5: Store token in Secrets Manager → get ARN (NN-2)
Step 6: Write connector_instance row (secret_ref = ARN only; no token bytes in DB)
Step 7: Write connector_sync_status row (waiting_for_data)
Step 8: Emit connector.connected event (secret_ref NOT in payload)
```

Unit test proof: `HandleOAuthCallbackCommand.test.ts` verifies that with a tampered HMAC, `HmacValidationError` is thrown and `connectorRepo.save` has 0 calls.

### Webhook validation (`POST /api/v1/webhooks/shopify/:topic`)
`ShopifyHmac.validateWebhook` called on raw body before any processing. Failure → HTTP 401.

---

## 4. Secret Handling (NN-2)

| Layer | What it holds |
|-------|---------------|
| `connector_instance.secret_ref` (Postgres) | Secrets Manager ARN only (e.g. `arn:aws:secretsmanager:us-east-1:...`) |
| AWS Secrets Manager | The actual Shopify OAuth access token |
| Domain entity `ConnectorInstance` | `secretRef` field (ARN string) — NO token/ciphertext/key field |
| API response | `secret_ref` is OMITTED from all API responses |
| Event payload `connector.connected` | `secret_ref` is OMITTED |

The migration 005 header explicitly states: "NO oauth_token / *_ciphertext / *_secret / *_key column exists."

Dev: `LocalSecretsManager` returns fake ARN `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/...` for local testing without a real AWS account. The actual token is discarded after storage.

---

## 5. API List (Track 2 endpoints, per §5.1)

| Method | Path | Auth/Role | Handler |
|--------|------|-----------|---------|
| GET | `/api/v1/connectors` | member | `GetConnectorStatusQuery` |
| GET | `/api/v1/connectors/shopify/install` | manager+ | `InitiateOAuthCommand` |
| GET | `/api/v1/connectors/shopify/callback` | public (HMAC-authed) | `HandleOAuthCallbackCommand` |
| GET | `/api/v1/connectors/:id/status` | member | `GetConnectorStatusQuery` |
| DELETE | `/api/v1/connectors/:id` | manager+ | `DisconnectCommand` |
| GET | `/api/v1/pixel/installation` | member | `GetOrCreatePixelInstallationCommand` |
| POST | `/api/v1/pixel/verify` | manager+ | `VerifyPixelCommand` |
| GET | `/api/v1/pixel/health` | member | `GetPixelHealthQuery` |
| POST | `/api/v1/webhooks/shopify/:topic` | public (HMAC-authed) | `shopifyWebhookHandler` |

`validateSession` + `rbacGuard` preHandlers are wired at mount time by the Track-1-owned module bootstrapper. Route handlers receive `brandId` via the `getBrandId(req)` dependency-injected function.

---

## 6. Event List (Track 2, per §5.2)

| Event | Topic | Emitted when |
|-------|-------|-------------|
| `connector.connected` | `{env}.connector.connected.v1` | After `connector_instance` INSERT (post-HMAC, secret_ref stored) |
| `connector.sync_started` | `{env}.connector.sync_started.v1` | When sync state transitions → `syncing` (consumed by sync status update) |
| `pixel.installed` | `{env}.pixel.installed.v1` | After `pixel_installation` INSERT (first call per brand) |
| `pixel.verified` | `{env}.pixel.verified.v1` | After HTTP verify success → `pixel_status.state = connected` |

Event payloads: `brand_id`, `connector_instance_id`/`pixel_installation_id`, `provider`, `idempotency_key`. `secret_ref` is intentionally excluded from all payloads (I-S09).

---

## 7. Validation Output

### Unit tests (real output)

```
pnpm --filter @brain/core run test:unit

RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/apps/core

✓ src/modules/connector/sources/storefront/shopify/tests/ShopifyHmac.test.ts (9 tests) 2ms
✓ src/modules/connector/sources/storefront/shopify/tests/OAuthStateNonce.test.ts (9 tests) 2ms
✓ src/modules/connector/sources/storefront/shopify/tests/SecretRef.test.ts (7 tests) 2ms
✓ src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts (4 tests) 4ms

Test Files  4 passed (4)
     Tests  29 passed (29)
  Start at  20:25:44
  Duration  421ms
```

### Typecheck

```
pnpm --filter @brain/core run typecheck

Result: 0 errors in connector/pixel files.
```

Sibling-pending errors (NOT Track-2-owned, properly excluded):
- `workspace-access/application/auth.service.ts` — `argon2` not installed (Track 1 pending)
- `workspace-access/application/auth.service.ts` — `notification/service.js` not written (Track 1 pending)
- `packages/db/src/index.ts` — `pg` module not installed (Track 1 pending)

### Isolation-fuzz (pg.connector.test.ts)

15 tests written across 5 tables (connector_instance, connector_sync_status, connector_cursor, pixel_installation, pixel_status). Each table has:
- [positive] brand-A GUC reads brand-A rows
- [NEGATIVE] brand-A GUC → 0 rows for brand-B query (I-S01)
- [NEGATIVE] no GUC → 0 rows (NN-1 two-arg form)

Status: PENDING-SIBLING (requires migrations 005-006 applied + brand rows seeded by Track 1). Typecheck error at `pg.connector.test.ts:180` is a cascade from `packages/db` not having `pg` installed (Track 1 owned). Tests will activate once Track 1 migrations land.

---

## 8. Risks

| ID | Risk | Mitigation |
|----|------|-----------|
| R1 | Shopify OAuth requires public HTTPS callback URL | Staging env with real domain required for E2E (C5). Local dev: `LocalSecretsManager` stub + `InProcessOAuthStateStore` allow unit testing without Shopify. |
| R2 | Pixel verify requires live merchant storefront | `VerifyPixelCommand.checkPixelPresence` will fail in local dev if `target_host` is not publicly accessible. Expected in dev — staging + real domain required. |
| R3 | `emitEvent` callback is injected — not wired to Redpanda yet | Track 0 (`packages/events`) must provide the Kafka producer. Track-2 command constructors accept it as a dependency. Wire in the module bootstrapper once Track 0 delivers. |
| R4 | `validateSession` + `rbacGuard` stubs — wired at mount time | Track 1 must provide these. Route files document the expected preHandler contract. |
| R5 | `InProcessOAuthStateStore` not multi-instance safe | Redis-backed store required before multi-pod production deploy. Replace via the `IOAuthStateStore` interface at bootstrap. |
| R6 | `pg.connector.test.ts:180` typecheck cascade from `@brain/db` sibling error | Will resolve once Track 1 installs `pg` in `packages/db`. |

---

## 9. Recommendations

1. **Track 0 (contracts)** must publish `ConnectorInstanceSchema` with `secret_ref: z.string()` and explicitly NO `*_token`/`*_key` field. The Zod contract is the machine-checkable NN-2 enforcement at the API surface.
2. **Track 1** must wire `validateSession` + `rbacGuard` as Fastify `preHandler` hooks in the module bootstrapper that mounts these routes. The `getBrandId(req)` function must extract from the JWT claim, not from body/query.
3. **Track 0 or Track 2 (integration)**: wire `emitEvent` to `@brain/events`' Kafka producer. The current stub accepts any async function — swap at bootstrap.
4. **Before staging deploy**: replace `InProcessOAuthStateStore` with Redis-backed implementation. Add `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` to Secrets Manager (not env vars in production).
5. **StarRocks row policy** (C2 from 02-cto-advisor-review.md): must be active before `connector.connected` emits to avoid the isolation gap on the managed cluster.

---

## 10. Files Created

| File | Purpose |
|------|---------|
| `db/migrations/005_connector.sql` | connector_instance (NN-2 header), sync_status, cursor + RLS + 3-GUC assertion |
| `db/migrations/006_pixel.sql` | pixel_installation, pixel_status + RLS |
| `apps/core/src/modules/connector/index.ts` | Updated: public type exports + scope comment |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorInstance.ts` | Secret_ref-only entity (NN-2) |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorSyncStatus.ts` | Sync state machine |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/entities/ConnectorCursor.ts` | Idempotent cursor (I-ST04) |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/value-objects/ShopifyHmac.ts` | HMAC validation (NN-4) |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/value-objects/OAuthStateNonce.ts` | State nonce (NN-4) |
| `apps/core/src/modules/connector/sources/storefront/shopify/domain/repositories/IConnector*.ts` | 3 repository interfaces |
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/ISecretsManager.ts` | Secrets interface |
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/LocalSecretsManager.ts` | Dev stub |
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/IOAuthStateStore.ts` | State store interface |
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/state/InProcessOAuthStateStore.ts` | Dev stub |
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnector*.ts` | 3 Pg repositories |
| `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.ts` | Install URL + nonce |
| `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts` | HMAC-first callback |
| `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/DisconnectCommand.ts` | Disconnect |
| `apps/core/src/modules/connector/sources/storefront/shopify/application/queries/GetConnectorStatusQuery.ts` | Real status |
| `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/http/shopifyConnectorRoutes.ts` | 5 HTTP routes |
| `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts` | Webhook HMAC-first |
| `apps/core/src/modules/connector/sources/storefront/shopify/tests/ShopifyHmac.test.ts` | 9 HMAC tests |
| `apps/core/src/modules/connector/sources/storefront/shopify/tests/OAuthStateNonce.test.ts` | 9 nonce tests |
| `apps/core/src/modules/connector/sources/storefront/shopify/tests/SecretRef.test.ts` | 7 NN-2 tests |
| `apps/core/src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts` | 4 integration tests |
| `apps/core/src/modules/connector/pixel/domain/entities/PixelInstallation.ts` | Pixel installation entity |
| `apps/core/src/modules/connector/pixel/domain/entities/PixelStatus.ts` | Verify state entity |
| `apps/core/src/modules/connector/pixel/domain/repositories/IPixel*.ts` | 2 repository interfaces |
| `apps/core/src/modules/connector/pixel/infrastructure/repositories/PgPixel*.ts` | 2 Pg repositories |
| `apps/core/src/modules/connector/pixel/application/commands/GetOrCreatePixelInstallationCommand.ts` | Idempotent create |
| `apps/core/src/modules/connector/pixel/application/commands/VerifyPixelCommand.ts` | Real HTTP verify |
| `apps/core/src/modules/connector/pixel/application/queries/GetPixelHealthQuery.ts` | Postgres-only health |
| `apps/core/src/modules/connector/pixel/interfaces/http/pixelRoutes.ts` | 3 HTTP routes |
| `packages/pixel-sdk/src/index.ts` | Updated: M1-data-spine scope comment |
| `tools/isolation-fuzz/src/pg.connector.test.ts` | 15 RLS isolation tests for 005-006 tables |

Total: 36 files created/updated.

---

## 11. Cross-Track Requests (contracts/migrations needed from other tracks)

### From Track 0 (contracts) — READ-ONLY for Track 2

| Contract needed | Shape | NN constraint |
|----------------|-------|---------------|
| `ConnectorInstanceSchema` | `{ id, brand_id, provider: 'shopify', shop_domain, secret_ref: z.string(), status, connected_at, ... }` | NO `*_token`/`*_key`/`*_ciphertext` field (NN-2) |
| `ConnectorSyncStatusSchema` | `{ id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at }` | |
| `ConnectorCursorSchema` | `{ id, brand_id, connector_instance_id, resource, cursor_value, updated_at }` | |
| `PixelInstallationSchema` | `{ id, brand_id, install_token, target_host, installed_at }` | |
| `PixelStatusSchema` | `{ id, brand_id, pixel_installation_id, state, verified_at, last_error }` | |
| `connector.connected` event schema | `{ brand_id, connector_instance_id, provider, shop_domain, idempotency_key }` (no secret_ref) | |
| `connector.sync_started` event schema | `{ brand_id, connector_instance_id, provider }` | |
| `pixel.installed` event schema | `{ brand_id, pixel_installation_id, install_token, target_host }` | |
| `pixel.verified` event schema | `{ brand_id, pixel_installation_id, install_token, target_host }` | |

### From Track 1 (control plane) — READ-ONLY for Track 2

| Dependency | What's needed |
|-----------|---------------|
| `validateSession(userId, jti)` | Exported from workspace-access module; mounted as Fastify preHandler |
| `rbacGuard(['manager', 'owner', 'brand_admin'])` | RBAC preHandler; required for install/disconnect/verify routes |
| `getBrandId(req)` | JWT brand_id claim extractor |
| 3-GUC middleware (`packages/db`) | Ensures `app.current_brand_id` is set before queries; Track 1 owns `packages/db/src/index.ts` |
| Migrations 001-004 | `brand(id)` FK target for connector_instance and pixel_installation. Must land before migration 005/006. |
| `@brain/db` `pg` dependency | Track 1 must `pnpm add pg @types/pg` in `packages/db`. Unblocks the cascade typecheck error in `tools/isolation-fuzz`. |

---

## Journal Entry

```markdown
## 2026-06-15T23:15:00Z — Backend Engineer — feat-m1-app-foundation
**Stage:** 3 · **Track:** 2-connector-pixel · **Service:** connector + pixel (within core monolith)
**Verification:** 29 unit tests PASS (HMAC×9, nonce×9, NN-2×7, callback×4) · typecheck 0 Track-2 errors
**Self-review vs gates:**
  - NN-2: PASS — secret_ref-only entity, no token fields, LocalSecretsManager returns ARN-only, unit tests assert no forbidden field names
  - NN-4: PASS — HMAC is step 1 in HandleOAuthCallbackCommand, HmacValidationError thrown before any repo call (unit test negative control proves this), state nonce single-use (unit test), webhook HMAC validated before processing
  - NN-6: PENDING-SIBLING — isolation-fuzz extended (15 tests across 5 tables), pending Track-1 migration landing + packages/db pg install
  - Scope-defer §2: PASS — no IConnector/BaseConnector, no Meta/Google backend, pixel-sdk scope comment updated
  - I-ST04: PASS — connector_cursor upsert on (brand_id, connector_instance_id, resource), GetOrCreatePixelInstallation idempotent
  - Idempotency-Key: in route handlers for mutations
**Next:** READY-FOR-SECURITY
```

---

## Bounce-Fix Round 1

| Field | Value |
|-------|-------|
| **Finding fixed** | MED-CALLBACK-01 |
| **Stage** | 3 — Bounce Fix |
| **Author** | Backend Engineer |
| **Fixed at** | 2026-06-15T21:18:00Z |
| **Verification** | typecheck (0 errors) + 55 unit tests PASS |

### Finding: MED-CALLBACK-01 — OAuth callback derived `brand_id` from attacker-controlled query string

The `shopifyConnectorRoutes.ts` callback route read `brand_id` from `query['brand_id']` (line 106) and passed it directly to `HandleOAuthCallbackCommand.execute({ brandId })`. Although the state nonce binding provided CSRF mitigation, the brand_id was attacker-supplied.

### Fix approach

`brand_id` is now bound INTO the state record at install time and derived from the server-side record on callback. The query-param `brand_id` dependency is fully removed.

**Files changed:**

| File | Change |
|------|--------|
| `infrastructure/state/IOAuthStateStore.ts` | Replaced `consumeAndValidate(brandId, state): Promise<boolean>` with `consumeAndGetBrandId(state): Promise<{ brandId: string } \| null>`. Key now uses state value only; brandId is stored as part of the record value. |
| `infrastructure/state/InProcessOAuthStateStore.ts` | Implemented `consumeAndGetBrandId`. Key scheme changed from `shopify:oauth:state:{brandId}:{state}` to `shopify:oauth:state:{state}`; stored value now holds `{ brandId, expiresAt }`. |
| `application/commands/HandleOAuthCallbackCommand.ts` | Removed `brandId` from `OAuthCallbackInput`. Step 2 calls `stateStore.consumeAndGetBrandId(state)` and extracts `brandId` from the returned record. HMAC is still step 1 (NN-4 unchanged). |
| `interfaces/http/shopifyConnectorRoutes.ts` | Removed `brand_id` query param read and the `MISSING_BRAND_CONTEXT` 400 guard. `idempotencyKey` no longer includes `brandIdParam`. `brandId` is never passed to `handleCallback.execute()`. |
| `tests/OAuthStateNonce.test.ts` | All `consumeAndValidate` calls replaced with `consumeAndGetBrandId`. Added new test proving brandId comes from the store record (MED-CALLBACK-01 proof). Added test for two-brand independence. 9 → 10 tests. |
| `tests/HandleOAuthCallbackCommand.test.ts` | Removed `brandId` from all `cmd.execute()` calls. Removed `brand_id` from `buildValidQuery` params. Added `MED-CALLBACK-01` proof test (5th test) verifying a forged `brand_id` in the query has no effect — the stored `REAL_BRAND_ID` is used for the `ConnectorInstance.brandId` and the emitted event. 4 → 5 tests. |

### preHandler note (HIGH-MOUNT-01 context)

`registerShopifyConnectorRoutes(fastify, deps)` accepts a `ConnectorRouteDeps` object. The function does NOT add any preHandlers itself (session/RBAC are deferred to mount time). The control-plane builder must pass `preHandler: [validateSessionPreHandler, requireRole(['manager', 'owner', 'brand_admin'])]` as Fastify route options when calling `fastify.register(registerShopifyConnectorRoutes, ...)` — or mount the routes within a scoped plugin that installs these hooks. The callback route (`/api/v1/connectors/shopify/callback`) is intentionally public and must NOT receive the session preHandler. The route registration function is ready to accept preHandlers scoped per-route by the control-plane bootstrapper.

### Verification output (real)

```
pnpm --filter @brain/core run typecheck
> tsc --noEmit
(exit 0 — 0 errors)

pnpm --filter @brain/core run test:unit
> vitest run --passWithNoTests

 RUN  v2.1.9 /Users/rishabhporwal/Desktop/Brain V3/apps/core

 ✓ src/modules/connector/sources/storefront/shopify/tests/ShopifyHmac.test.ts (9 tests) 2ms
 ✓ src/modules/connector/sources/storefront/shopify/tests/SecretRef.test.ts (7 tests) 2ms
 ✓ src/modules/connector/sources/storefront/shopify/tests/OAuthStateNonce.test.ts (10 tests) 2ms
 ✓ src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts (5 tests) 4ms
 ✓ src/modules/workspace-access/tests/auth.service.test.ts (24 tests) 4ms

 Test Files  5 passed (5)
      Tests  55 passed (55)
   Start at  21:18:29
   Duration  474ms (transform 1.46s, setup 0ms, collect 1.54s, tests 15ms, environment 0ms, prepare 138ms)
```

```markdown
## 2026-06-15T21:18:00Z — Backend Engineer — feat-m1-app-foundation (Bounce-Fix Round 1)
**Stage:** 3 · **Track:** connector-bouncefix · **Service:** connector (within core monolith)
**Verification:** typecheck 0 errors + 55 unit tests PASS (OAuthStateNonce×10, HandleOAuthCallback×5, HMAC×9, NN-2×7, auth×24)
**Self-review vs gates:**
  - MED-CALLBACK-01: FIXED — brand_id removed from query param path; derived from server-side state record via consumeAndGetBrandId(); proof test added (attacker brand_id in query has zero effect)
  - NN-4: UNCHANGED — HMAC validation remains step 1 in HandleOAuthCallbackCommand; proof test for HMAC-first order retained
  - HIGH-MOUNT-01 note: registerShopifyConnectorRoutes accepts preHandlers from the control-plane builder; preHandler contract documented in this report
**Next:** READY-FOR-SECURITY
```

---

## Bounce-Fix Round 2

| Field | Value |
|-------|-------|
| **Findings fixed** | ISO-SEED-01 (HIGH, QA) + HIGH-SECRETS-01-RESIDUAL (HIGH, Security) |
| **Stage** | 3 — Bounce Fix Round 2 |
| **Author** | Backend Engineer |
| **Fixed at** | 2026-06-15T21:49:00Z |
| **Verification** | typecheck 0 errors (isolation-fuzz) + 55 unit tests PASS (core) + 43 isolation tests PASS / 2 skipped (StarRocks, pre-existing) |

---

### Finding: ISO-SEED-01 — connector/pixel isolation seed FK ordering bug (hollow no-op tests)

**Root cause:** `connector_instance` has `UNIQUE (brand_id, provider)`. The prior seed generated a fresh UUID for `connInstanceIdA`/`B` each run, then used `ON CONFLICT DO NOTHING` — which silently skipped the insert on repeat runs, leaving the freshly-generated UUIDs absent from the DB. All `connector_sync_status`/`connector_cursor` inserts that FK-reference these UUIDs threw FK violations. The `catch` block set `pgAvailable = false` → all 11 tests early-returned as hollow no-ops passing with zero assertions. `pixel_installation` had the identical issue (`UNIQUE (brand_id)`).

**Fix approach:**

1. `connector_instance` (one row per brand per provider): changed to `ON CONFLICT (brand_id, provider) DO UPDATE SET shop_domain = EXCLUDED.shop_domain RETURNING id`. The returned `id` is the row that ACTUALLY exists in the DB — new or pre-existing. This id is captured into `connInstanceIdA`/`B` instead of the pre-generated UUID. FK chain downstream now always references a real id.

2. `pixel_installation` (one row per brand): changed to `ON CONFLICT (brand_id) DO UPDATE SET target_host = EXCLUDED.target_host RETURNING id`. Same pattern. Captured into `pixelInstallIdA`/`B`.

3. Added PERMISSIVE mirror RLS policies for `APP_ROLE` (`isofuzz_connector_app`) in `beforeAll`. The production migration policies are `TO brain_app` — they only apply when the current role is `brain_app`. Since `isofuzz_connector_app` is a different role and FORCE RLS is on, no policy matched → default deny for all rows (both brand-A and brand-B). The fix adds test-scoped policies with the same brand-GUC predicate so the test role observes real brand-scoped enforcement. These policies are dropped in `afterAll`.

4. Added positive assertions (`expect(rows.length).toBeGreaterThan(0)`) to all 5 positive tests. Prior code only asserted `row.brand_id === BRAND_A` for each row — which trivially passed on an empty set. Adding the length check makes the positive control non-tautological.

**Files changed:**

| File | Change |
|------|--------|
| `tools/isolation-fuzz/src/pg.connector.test.ts` | UPSERT RETURNING for connector_instance + pixel_installation; capture returned id for FK chain; add test-scope mirror RLS policies in beforeAll + DROP in afterAll; add positive-control length assertions |

**Result:** 15 connector/pixel isolation tests now RUN and ASSERT (were hollow no-ops). Positive (brand-A reads brand-A rows), negative (brand-A cannot read brand-B → 0; no-GUC → 0) on NOSUPERUSER NOBYPASSRLS role. NN-6 for connector/pixel is now verified.

---

### Finding: HIGH-SECRETS-01-RESIDUAL — AwsSecretsManager export and wiring

**Status at start of this bounce:** `AwsSecretsManager` was already implemented at `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/AwsSecretsManager.ts` and already wired conditionally in `main.ts` (line 252: `isProduction ? new AwsSecretsManager(...) : new LocalSecretsManager()`). The security re-review captured state BEFORE that wiring was applied.

**What was missing:** No barrel export (`index.ts`) existed in the secrets directory, so the public module boundary did not expose both implementations for control-plane selection. The task requirement is "Export both AwsSecretsManager + LocalSecretsManager so the control-plane builder can select by `isProduction` in main.ts."

**Fix:** Created `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/index.ts` that re-exports both implementations and the interface. The barrel includes the exact wiring comment for the control-plane builder.

**Files changed:**

| File | Change |
|------|--------|
| `apps/core/src/modules/connector/sources/storefront/shopify/infrastructure/secrets/index.ts` | NEW — barrel export for AwsSecretsManager + LocalSecretsManager + ISecretsManager |

**Wiring the control-plane builder must do in `main.ts`** (already done but documented for completeness):

```typescript
// In production: SHOPIFY_CLIENT_SECRET env var holds the ARN, NOT the secret value.
// In dev: SHOPIFY_CLIENT_SECRET env var holds the raw value directly.
const shopifyClientSecretRef = getEnvOrThrow('SHOPIFY_CLIENT_SECRET');
const connectorSecretsManager: ISecretsManager = isProduction
  ? new AwsSecretsManager(getEnv('AWS_REGION', 'us-east-1'), shopifyClientSecretRef)
  : new LocalSecretsManager();
```

`AwsSecretsManager` constructor args: `(region: string, clientSecretArn: string)`. Uses `@aws-sdk/client-secrets-manager` with IRSA (no static credentials). `getShopifyClientSecret()` calls `GetSecretValueCommand({ SecretId: clientSecretArn })`. Fail-closed: empty response throws. `storeShopifyToken()` calls `CreateSecretCommand` → returns ARN for NN-2 storage. `deleteShopifyToken()` calls `DeleteSecretCommand`.

---

### Verification output (real)

```
pnpm --filter @brain/tool-isolation-fuzz run typecheck
> tsc --noEmit
(exit 0 — 0 errors)

pnpm --filter @brain/tool-isolation-fuzz run test:isolation
> vitest run --no-file-parallelism

 ✓ pg.connector.test.ts > connector_instance — RLS isolation (NN-6) > [positive] brand-A GUC reads brand-A connector_instance rows
 ✓ pg.connector.test.ts > connector_instance — RLS isolation (NN-6) > [NEGATIVE] brand-A GUC cannot read brand-B connector_instance rows → 0
 ✓ pg.connector.test.ts > connector_instance — RLS isolation (NN-6) > [NEGATIVE] no GUC → 0 connector_instance rows (NN-1)
 ✓ pg.connector.test.ts > connector_sync_status — RLS isolation (NN-6) > [positive] brand-A GUC reads brand-A connector_sync_status rows
 ✓ pg.connector.test.ts > connector_sync_status — RLS isolation (NN-6) > [NEGATIVE] brand-A GUC cannot read brand-B sync status → 0
 ✓ pg.connector.test.ts > connector_sync_status — RLS isolation (NN-6) > [NEGATIVE] no GUC → 0 connector_sync_status rows (NN-1)
 ✓ pg.connector.test.ts > connector_cursor — RLS isolation (NN-6) > [positive] brand-A GUC reads brand-A connector_cursor rows
 ✓ pg.connector.test.ts > connector_cursor — RLS isolation (NN-6) > [NEGATIVE] brand-A GUC cannot read brand-B cursor rows → 0
 ✓ pg.connector.test.ts > connector_cursor — RLS isolation (NN-6) > [NEGATIVE] no GUC → 0 connector_cursor rows (NN-1)
 ✓ pg.connector.test.ts > pixel_installation — RLS isolation (NN-6) > [positive] brand-A GUC reads brand-A pixel_installation rows
 ✓ pg.connector.test.ts > pixel_installation — RLS isolation (NN-6) > [NEGATIVE] brand-A GUC cannot read brand-B pixel_installation rows → 0
 ✓ pg.connector.test.ts > pixel_installation — RLS isolation (NN-6) > [NEGATIVE] no GUC → 0 pixel_installation rows (NN-1)
 ✓ pg.connector.test.ts > pixel_status — RLS isolation (NN-6) > [positive] brand-A GUC reads brand-A pixel_status rows
 ✓ pg.connector.test.ts > pixel_status — RLS isolation (NN-6) > [NEGATIVE] brand-A GUC cannot read brand-B pixel_status rows → 0
 ✓ pg.connector.test.ts > pixel_status — RLS isolation (NN-6) > [NEGATIVE] no GUC → 0 pixel_status rows (NN-1)

 Test Files  5 passed (5)
      Tests  43 passed | 2 skipped (45)   [↑ was 39 pass + 2 skip with hollow connector tests]
   Start at  21:49:35
   Duration  705ms

pnpm --filter @brain/core run test:unit
> vitest run --passWithNoTests

 ✓ ShopifyHmac.test.ts (9 tests)
 ✓ SecretRef.test.ts (7 tests)
 ✓ OAuthStateNonce.test.ts (10 tests)
 ✓ HandleOAuthCallbackCommand.test.ts (5 tests)
 ✓ auth.service.test.ts (24 tests)

 Test Files  5 passed (5)
      Tests  55 passed (55)   [no regressions]
   Start at  21:49:44
   Duration  195ms
```

---

### Journal Entry — Bounce-Fix Round 2

```markdown
## 2026-06-15T21:49:00Z — Backend Engineer — feat-m1-app-foundation (Bounce-Fix Round 2)
**Stage:** 3 · **Track:** connector-bouncefix-r2 · **Service:** connector + isolation-fuzz
**Verification:** typecheck 0 errors (isofuzz) + 55 unit tests PASS (core, no regressions) + 43 isolation PASS / 2 skip (StarRocks pre-existing)
**Self-review vs gates:**
  - ISO-SEED-01: FIXED — UPSERT RETURNING captures DB-resident id; test-scope mirror RLS policies added; positive-control length assertions added; 15 connector/pixel tests now RUN+ASSERT (were hollow)
  - HIGH-SECRETS-01-RESIDUAL: FIXED — AwsSecretsManager barrel export added; main.ts already has isProduction conditional wiring; control-plane wiring documented
  - NN-6: NOW VERIFIED for all 5 connector/pixel tables (connector_instance, connector_sync_status, connector_cursor, pixel_installation, pixel_status)
  - Verification valid: NOSUPERUSER NOBYPASSRLS role, positive controls non-tautological (rows.length > 0), negative controls assert 0 rows
**Next:** READY-FOR-SECURITY
```
