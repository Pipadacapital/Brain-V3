# Shopify BYO-App Required Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Shopify OAuth require the workspace user's own Custom App Client ID + Client Secret (removing the shared `SHOPIFY_CLIENT_ID/SECRET` env fallback for Shopify only). Show an inline setup panel with redirect URL + scopes. Flip existing Shopify installs to `RECONNECT_REQUIRED` on deploy.

**Architecture:** Catalog-driven — one `byoAppRequired: true` flag on Shopify's `ConnectorDefinition` gates every callsite (`resolveBrandOAuth*` resolvers, write route guard, OAuth callback, webhook HMAC resolver, marketplace tile API, frontend rendering). Existing per-brand credential storage in Secrets Manager (`brain/connector/shopify_app/<brandId>`) is unchanged. Meta / Google Ads / WooCommerce untouched.

**Tech Stack:** TypeScript (strict), Fastify, React (Next.js App Router), Vitest, Playwright, Postgres 16, LocalSecretsManager (dev) / AWS Secrets Manager (prod). Branch: `feat/shopify-byo-app-required`.

**Spec:** `docs/superpowers/specs/2026-07-02-shopify-byo-app-required-design.md` (commit `f2085b52`).

---

## File Structure

**Create:**
- `db/migrations/0031_migration_state.sql` — `ops.migration_state (key TEXT PK, applied_at TIMESTAMPTZ)`.
- `apps/core/src/bootstrap/reconnect-shopify-byo.ts` — one-shot idempotent boot task.
- `apps/core/src/bootstrap/reconnect-shopify-byo.test.ts` — unit test for the boot task.
- `apps/web/components/connectors/byo-app-setup-panel.tsx` — the Shopify setup instructions panel.

**Modify:**
- `apps/core/src/modules/connector/catalog/registry.ts` — extend types + Shopify entry.
- `apps/core/src/modules/connector/oauth-app-creds.ts` — new `requireBrandCreds` flag.
- `apps/core/src/modules/connector/oauth-app-creds.test.ts` — cover the flag.
- `apps/core/src/modules/connector/catalog/catalog.test.ts` — assert Shopify catalog shape.
- `apps/core/src/bootstrap/connectors/writeRoutes.ts` — enforce catalog flag.
- `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` — extend for BYO required.
- `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts` — pass `requireBrandCreds` through.
- `apps/core/src/modules/connector/webhooks/platform/registerWebhookRoutes.ts` — pass `requireBrandCreds` for Shopify.
- `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts` — align with BYO-first resolver.
- (Marketplace tile builder — path resolved in Task 7).
- `apps/core/src/main.ts` — wire the boot task + `SHOPIFY_CLIENT_SECRET` env may now be optional (kept required in this plan for deprecation window; see spec §8).
- `apps/web/lib/api/types.ts` — extend `MarketplaceTile`.
- `apps/web/components/connectors/marketplace-view.tsx` — required-inline rendering + reconnect banner.
- `apps/web/e2e/connector-lifecycle.spec.ts` — Shopify BYO E2E case.

---

### Task 1: Extend catalog types

**Files:**
- Modify: `apps/core/src/modules/connector/catalog/registry.ts:103-125` (extend `ConnectorDefinition`) and top-of-file (new `ByoAppSetup` + hoisted `SHOPIFY_SCOPES_LIST`).

- [ ] **Step 1: Read the existing catalog file to confirm insertion points**

Run: `sed -n '100,150p' apps/core/src/modules/connector/catalog/registry.ts`
Expected: shows the `ConnectorDefinition` interface ending at line 125 and `OAUTH_APP_HINT` / `OAUTH_APP_FIELDS` at 127-134.

- [ ] **Step 2: Add the `ByoAppSetup` type + `SHOPIFY_SCOPES_LIST` const, and extend `ConnectorDefinition`**

Insert after the existing `CredentialConnectSpec` interface (around line 101) and before `ConnectorDefinition`:

```ts
/**
 * ByoAppSetup — declarative setup instructions surfaced to the merchant when a connector
 * requires its own OAuth app. Rendered by the connect UI as a copy-buttoned panel.
 *
 * `redirectUrl` is emitted as '' from the catalog and filled at request time from
 * config.shopifyCallbackUrl (the public OAuth callback URL), because the catalog is
 * static-typed compile-time state.
 */
export interface ByoAppSetup {
  /** Public OAuth redirect URL the merchant must paste into their Custom App config. */
  redirectUrl: string;
  /** OAuth scope list the merchant must enable — must match the InitiateOAuthCommand scopes. */
  scopes: readonly string[];
  /** Optional external docs link. */
  docsUrl?: string;
}

/**
 * Shopify's required OAuth scopes — hoisted here so the catalog can hand them to the connect
 * UI's setup panel and InitiateOAuthCommand can consume the same list.
 */
export const SHOPIFY_SCOPES_LIST = [
  'read_orders',
  'read_products',
  'read_customers',
  'write_script_tags',
  'write_pixels',
  'read_customer_events',
] as const;
```

Then extend `ConnectorDefinition` (currently ends at line 125) — add these two optional fields BEFORE the closing brace:

```ts
  /**
   * OAuth connectors only. When true, the workspace user MUST supply per-brand Client ID /
   * Client Secret — env fallback (SHOPIFY_CLIENT_ID/SECRET etc.) is refused for this provider.
   * Requires `byoAppSetup` populated for the connect UI's setup panel.
   */
  byoAppRequired?: boolean;
  /** Declarative setup instructions rendered by the connect UI when `byoAppRequired`. */
  byoAppSetup?: ByoAppSetup;
```

- [ ] **Step 3: Verify types compile**

Run: `cd apps/core && npx tsc --noEmit`
Expected: no new errors introduced.

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/modules/connector/catalog/registry.ts
git commit -m "feat(catalog): add ByoAppSetup + byoAppRequired to ConnectorDefinition"
```

---

### Task 2: Update Shopify catalog entry (required fields + BYO setup)

**Files:**
- Modify: `apps/core/src/modules/connector/catalog/registry.ts:136-146` (Shopify entry).
- Test: `apps/core/src/modules/connector/catalog/catalog.test.ts`.

- [ ] **Step 1: Write the failing catalog test**

Append to `apps/core/src/modules/connector/catalog/catalog.test.ts` (create the describe block if the file already has one — merge in):

```ts
import { describe, it, expect } from 'vitest';
import { CONNECTOR_CATALOG, SHOPIFY_SCOPES_LIST } from './registry.js';

describe('Shopify catalog entry — BYO-app required', () => {
  const shopify = CONNECTOR_CATALOG.find((c) => c.id === 'shopify');

  it('declares byoAppRequired', () => {
    expect(shopify?.byoAppRequired).toBe(true);
  });

  it('declares byoAppSetup with scopes matching SHOPIFY_SCOPES_LIST', () => {
    expect(shopify?.byoAppSetup).toBeDefined();
    expect(shopify?.byoAppSetup?.scopes).toEqual(SHOPIFY_SCOPES_LIST);
  });

  it('marks client_id + client_secret as REQUIRED (not optional)', () => {
    const cid = shopify?.authFields?.find((f) => f.key === 'client_id');
    const csec = shopify?.authFields?.find((f) => f.key === 'client_secret');
    expect(cid).toBeDefined();
    expect(csec).toBeDefined();
    expect(cid?.optional).not.toBe(true);
    expect(csec?.optional).not.toBe(true);
  });
});

describe('Meta + Google Ads catalog entries — BYO-app remains OPTIONAL', () => {
  it('meta.authFields client_id + client_secret stay optional', () => {
    const meta = CONNECTOR_CATALOG.find((c) => c.id === 'meta');
    expect(meta?.byoAppRequired).not.toBe(true);
    expect(meta?.authFields?.find((f) => f.key === 'client_id')?.optional).toBe(true);
    expect(meta?.authFields?.find((f) => f.key === 'client_secret')?.optional).toBe(true);
  });

  it('google_ads.authFields client_id + client_secret stay optional', () => {
    const ga = CONNECTOR_CATALOG.find((c) => c.id === 'google_ads');
    expect(ga?.byoAppRequired).not.toBe(true);
    expect(ga?.authFields?.find((f) => f.key === 'client_id')?.optional).toBe(true);
    expect(ga?.authFields?.find((f) => f.key === 'client_secret')?.optional).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

Run: `cd apps/core && npx vitest run src/modules/connector/catalog/catalog.test.ts`
Expected: FAIL on `byoAppRequired`, `byoAppSetup`, and the required-flag assertions.

- [ ] **Step 3: Update the Shopify catalog entry**

Replace the current Shopify entry (`registry.ts:138-146`) with:

```ts
  {
    id: 'shopify',
    category: 'storefront',
    displayName: 'Shopify',
    connectMethod: 'oauth',
    availability: 'available',
    description: 'Sync orders, products, customers.',
    // Shopify Custom Apps are single-store: the workspace user MUST bring their own app's
    // Client ID / Client Secret. No env fallback (byoAppRequired), so both fields are REQUIRED.
    authFields: [
      { key: 'client_id',     label: 'Client ID',     type: 'text',     secret: false, optional: false, hint: 'From your Shopify Custom App API credentials.' },
      { key: 'client_secret', label: 'Client Secret', type: 'password', secret: true,  optional: false, hint: 'From your Shopify Custom App API credentials.' },
    ],
    byoAppRequired: true,
    byoAppSetup: {
      // Filled at request-build time from config.shopifyCallbackUrl — see marketplace tile builder.
      redirectUrl: '',
      scopes: SHOPIFY_SCOPES_LIST,
    },
  },
```

- [ ] **Step 4: Run the test — expect pass**

Run: `cd apps/core && npx vitest run src/modules/connector/catalog/catalog.test.ts`
Expected: all Shopify + Meta + Google Ads assertions pass.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/modules/connector/catalog/registry.ts apps/core/src/modules/connector/catalog/catalog.test.ts
git commit -m "feat(catalog): Shopify requires per-brand Client ID + Client Secret"
```

---

### Task 3: Add `requireBrandCreds` flag to oauth-app-creds resolvers

**Files:**
- Modify: `apps/core/src/modules/connector/oauth-app-creds.ts:59-71` (`resolveBrandOAuthClientId`) and `109-125` (`resolveBrandOAuthAppCreds`).
- Test: `apps/core/src/modules/connector/oauth-app-creds.test.ts` — append new cases.

- [ ] **Step 1: Write the failing tests**

Append to `apps/core/src/modules/connector/oauth-app-creds.test.ts` inside the file (top-level `describe` blocks):

```ts
describe('resolveBrandOAuthClientId — requireBrandCreds', () => {
  beforeEach(() => {
    process.env['DATABASE_URL'] ??= 'postgres://brain:brain@localhost:5432/brain';
    resetAllConfigCaches();
  });

  it('returns undefined when no brand bundle and requireBrandCreds: true — env is NOT consulted', async () => {
    const prev = process.env['SHOPIFY_CLIENT_ID'];
    process.env['SHOPIFY_CLIENT_ID'] = 'env-fallback-id';
    try {
      const sm = mockSecrets(null);
      const r = await resolveBrandOAuthClientId(sm, 'shopify', BRAND, { requireBrandCreds: true });
      expect(r).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env['SHOPIFY_CLIENT_ID'];
      else process.env['SHOPIFY_CLIENT_ID'] = prev;
    }
  });

  it('still returns the brand client_id when present, even with requireBrandCreds: true', async () => {
    const sm = mockSecrets({ client_id: 'brand-id', client_secret: 's' });
    const r = await resolveBrandOAuthClientId(sm, 'shopify', BRAND, { requireBrandCreds: true });
    expect(r).toBe('brand-id');
  });
});

describe('resolveBrandOAuthAppCreds — requireBrandCreds', () => {
  it('returns null when no brand bundle and requireBrandCreds: true — envFallback is ignored', async () => {
    const sm = mockSecrets(null);
    const r = await resolveBrandOAuthAppCreds(
      sm,
      'shopify',
      BRAND,
      { clientId: 'env-id', clientSecret: 'env-secret' },
      { requireBrandCreds: true },
    );
    expect(r).toBeNull();
  });

  it('returns brand bundle when present, even with requireBrandCreds: true', async () => {
    const sm = mockSecrets({ client_id: 'brand-id', client_secret: 'brand-secret' });
    const r = await resolveBrandOAuthAppCreds(
      sm,
      'shopify',
      BRAND,
      { clientId: 'env-id', clientSecret: 'env-secret' },
      { requireBrandCreds: true },
    );
    expect(r).toEqual({ clientId: 'brand-id', clientSecret: 'brand-secret' });
  });

  it('returns null on a partial brand bundle with requireBrandCreds: true (no env fallback)', async () => {
    const sm = mockSecrets({ client_id: 'brand-id' });
    const r = await resolveBrandOAuthAppCreds(
      sm,
      'shopify',
      BRAND,
      { clientId: 'env-id', clientSecret: 'env-secret' },
      { requireBrandCreds: true },
    );
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd apps/core && npx vitest run src/modules/connector/oauth-app-creds.test.ts`
Expected: new cases FAIL because `resolveBrandOAuthClientId` and `resolveBrandOAuthAppCreds` don't accept the new opts arg yet.

- [ ] **Step 3: Add the flag to both resolvers**

Replace `resolveBrandOAuthClientId` (`oauth-app-creds.ts:59-71`):

```ts
export async function resolveBrandOAuthClientId(
  secretsManager: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  opts?: { requireBrandCreds?: boolean },
): Promise<string | undefined> {
  try {
    const bundle = await secretsManager.getSecret(appSecretName(provider, brandId));
    if (bundle?.['client_id']) return bundle['client_id'];
  } catch {
    // fall through to env (unless required)
  }
  if (opts?.requireBrandCreds) return undefined;
  return envClientId(provider);
}
```

Replace `resolveBrandOAuthAppCreds` (`oauth-app-creds.ts:109-125`):

```ts
export async function resolveBrandOAuthAppCreds(
  secretsManager: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  envFallback: OAuthAppCreds | null,
  opts?: { requireBrandCreds?: boolean },
): Promise<OAuthAppCreds | null> {
  try {
    const bundle = await secretsManager.getSecret(appSecretName(provider, brandId));
    const clientId = bundle?.['client_id'];
    const clientSecret = bundle?.['client_secret'];
    if (clientId && clientSecret) return { clientId, clientSecret };
  } catch {
    // fall through to env fallback (unless required)
  }
  if (opts?.requireBrandCreds) return null;
  if (envFallback?.clientId && envFallback?.clientSecret) return envFallback;
  return null;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd apps/core && npx vitest run src/modules/connector/oauth-app-creds.test.ts`
Expected: all tests pass (including the pre-existing 8 cases — signature is additive).

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/modules/connector/oauth-app-creds.ts apps/core/src/modules/connector/oauth-app-creds.test.ts
git commit -m "feat(oauth-app-creds): add requireBrandCreds flag to refuse env fallback"
```

---

### Task 4: Enforce catalog flag in write route

**Files:**
- Modify: `apps/core/src/bootstrap/connectors/writeRoutes.ts:85-129` (OAuth branch).
- Test: extend the write-route integration test — likely `apps/core/src/bootstrap/connectors/writeRoutes.test.ts` or the closest integration file. Search first (Step 1).

- [ ] **Step 1: Locate the write-route test file**

Run: `cd apps/core && grep -rln "POST.*connectors\b" src/bootstrap/connectors 2>/dev/null | grep -i test`
Expected: one test file (either `writeRoutes.test.ts` or an integration file). Note the exact path — the assertions below go there.

If no test file exists, create `apps/core/src/bootstrap/connectors/writeRoutes.test.ts` with a fresh vitest scaffold using the pattern from `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` (Fastify + registerConnectorWriteRoutes + mock deps).

- [ ] **Step 2: Write the failing test**

Add to the located test file:

```ts
it('POST /api/v1/connectors { type:"shopify" } without credentials → 400 MISSING_APP_CREDENTIALS', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/connectors',
    headers: { 'x-brand-id': BRAND, ...authHeaders },
    payload: { type: 'shopify', shop_domain: 'demo.myshopify.com' },
  });
  expect(res.statusCode).toBe(400);
  const body = JSON.parse(res.body);
  expect(body.error?.code).toBe('MISSING_APP_CREDENTIALS');
});

it('POST /api/v1/connectors { type:"shopify" } with client_id + client_secret → 200 oauth_url', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/connectors',
    headers: { 'x-brand-id': BRAND, ...authHeaders },
    payload: {
      type: 'shopify',
      shop_domain: 'demo.myshopify.com',
      credentials: { client_id: 'brand-app-id', client_secret: 'brand-app-secret' },
    },
  });
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body);
  expect(body.data?.oauth_url).toMatch(/^https:\/\/demo\.myshopify\.com\/admin\/oauth\/authorize/);
  expect(body.data?.oauth_url).toContain('client_id=brand-app-id');
});

it('POST /api/v1/connectors { type:"meta" } without credentials still initiates (env fallback allowed)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/connectors',
    headers: { 'x-brand-id': BRAND, ...authHeaders },
    payload: { type: 'meta' },
  });
  // Regression guard: Meta keeps the optional-with-fallback behavior.
  expect([200, 503]).toContain(res.statusCode); // 503 only if env unset; 200 with env
});
```

(Use whatever brand + auth harness the existing writeRoutes tests use; `BRAND` and `authHeaders` will already be defined at the top of that file.)

- [ ] **Step 3: Run tests — expect failure**

Run: `cd apps/core && npx vitest run <located-file-path>`
Expected: the Shopify-without-creds case fails (currently returns 200 via env fallback).

- [ ] **Step 4: Enforce the catalog flag in the write route**

Modify `writeRoutes.ts` inside the `if (def.connectMethod === 'oauth') { ... }` block (starting at line 85). After `const dispatch = getOAuthDispatch(connectorType);` and its `!dispatch` guard, insert BEFORE the existing `try { ... }`:

```ts
        // BYO-required (Shopify): reject up front if the workspace user did not supply Custom App
        // credentials. Prevents an initiate against the env app that only works for one store.
        if (def.byoAppRequired) {
          const cid = body.credentials?.['client_id']?.trim();
          const csec = body.credentials?.['client_secret']?.trim();
          if (!cid || !csec) {
            return reply.code(400).send({
              request_id: requestId,
              error: {
                code: 'MISSING_APP_CREDENTIALS',
                message: `${def.displayName} requires your Custom App's Client ID and Client Secret.`,
              },
            });
          }
        }
```

Then, inside the existing `try { ... }` block, update the `resolveBrandOAuthClientId` call (currently `writeRoutes.ts:103`) to pass the flag:

```ts
          const clientId = await resolveBrandOAuthClientId(
            connectorSecretsManager,
            provider,
            brandId,
            { requireBrandCreds: def.byoAppRequired ?? false },
          );
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd apps/core && npx vitest run <located-file-path>`
Expected: all three cases pass.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/bootstrap/connectors/writeRoutes.ts <located-test-file-path>
git commit -m "feat(connectors): reject Shopify OAuth connect without BYO Client ID/Secret"
```

---

### Task 5: Pass `requireBrandCreds` to HandleOAuthCallbackCommand

**Files:**
- Modify: `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts:94-140`.
- Test: `apps/core/src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts` — locate and extend.

- [ ] **Step 1: Locate the callback command's construction site**

Run: `cd apps/core && grep -rn "new HandleOAuthCallbackCommand(" src 2>/dev/null`
Expected: 1-2 construction sites — the bootstrap wiring plus test files.

- [ ] **Step 2: Write the failing test**

Add to `apps/core/src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts`:

```ts
it('when requireBrandCreds=true and brand has no stored app creds → HmacValidationError (env NOT consulted)', async () => {
  const secretsManager = makeMockSecretsManager({ brandBundle: null, envClientSecret: 'env-secret' });
  const cmd = new HandleOAuthCallbackCommand(
    secretsManager,
    stateStore,
    connectorRepo,
    syncStatusRepo,
    emitEvent,
    'production',   // appEnv
    'https://brain.example',  // webhookCallbackBaseUrl
    true,           // requireBrandCreds ← NEW
  );
  // Prime state store with a valid nonce for BRAND
  await stateStore.set(BRAND, 'valid-state', 900);
  await expect(
    cmd.execute({
      query: { state: 'valid-state', shop: 'demo.myshopify.com', code: 'c', hmac: 'anything' },
      idempotencyKey: 'idem-1',
    }),
  ).rejects.toBeInstanceOf(HmacValidationError);
  // The env secret was NEVER fetched.
  expect(secretsManager.getShopifyClientSecret).not.toHaveBeenCalled();
});
```

Match `makeMockSecretsManager`, `stateStore`, and `HmacValidationError` import to the pattern already used in this file. If the file constructs the command with 5-7 args, extend to 8.

- [ ] **Step 3: Run the test — expect failure**

Run: `cd apps/core && npx vitest run src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts`
Expected: FAIL — constructor doesn't accept the 8th arg.

- [ ] **Step 4: Add `requireBrandCreds` to the constructor and thread it through**

In `HandleOAuthCallbackCommand.ts`, extend the constructor (currently ends at line 110):

```ts
    private readonly webhookCallbackBaseUrl: string = defaultWebhookCallbackBaseUrl(),
    /**
     * When true, resolve the brand's Shopify app creds WITHOUT the env fallback (BYO-required).
     * Driven by catalog: getDefinition('shopify').byoAppRequired. Defaults to false to keep the
     * existing 5-7 arg construction (and unit tests) compiling unchanged.
     */
    private readonly requireBrandCreds: boolean = false,
  ) {}
```

Then in `execute()` (around line 134), replace the `resolveBrandOAuthAppCreds` call:

```ts
    const appCreds = await resolveBrandOAuthAppCreds(
      this.secretsManager,
      'shopify',
      peeked.brandId,
      this.requireBrandCreds
        ? null
        : {
            clientId: process.env['SHOPIFY_CLIENT_ID'] ?? '',
            clientSecret: await this.secretsManager.getShopifyClientSecret(),
          },
      { requireBrandCreds: this.requireBrandCreds },
    );
    if (!appCreds?.clientSecret) {
      throw new HmacValidationError();
    }
```

Note: the ternary skips the `getShopifyClientSecret()` fetch when `requireBrandCreds` is true — required for the test assertion above.

- [ ] **Step 5: Update the bootstrap wiring to pass the flag from the catalog**

Locate where `HandleOAuthCallbackCommand` is constructed in bootstrap (from Step 1). Add a `getDefinition` import if not present, and pass the flag:

```ts
import { getDefinition } from '../modules/connector/catalog/index.js'; // adjust relative path

const shopifyDef = getDefinition('shopify');
const handleCallback = new HandleOAuthCallbackCommand(
  connectorSecretsManager,
  stateStore,
  connectorRepo,
  syncStatusRepo,
  emitEvent,
  process.env['APP_ENV'] ?? process.env['NODE_ENV'] ?? 'development',
  defaultWebhookCallbackBaseUrl(),
  shopifyDef?.byoAppRequired ?? false, // ← NEW
);
```

- [ ] **Step 6: Run tests — expect pass**

Run:
```
cd apps/core && npx vitest run src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts
cd apps/core && npx vitest run src/modules/connector/tests/oauth-callback.integration.test.ts
```
Expected: both pass. Any existing 5-7 arg constructions still compile (default keeps behavior).

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts \
        apps/core/src/modules/connector/sources/storefront/shopify/tests/HandleOAuthCallbackCommand.test.ts \
        apps/core/src/bootstrap/**  # the wiring site from Step 5
git commit -m "feat(shopify-oauth): callback rejects when no per-brand app creds (BYO required)"
```

---

### Task 6: Skip env fallback in webhook HMAC resolver for Shopify

**Files:**
- Modify: `apps/core/src/modules/connector/webhooks/platform/registerWebhookRoutes.ts:65-96` (the `shopifyHmacSecretResolver` default).
- Modify: `apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts:107-117` (legacy handler — see Step 4).
- Test: `apps/core/src/modules/connector/webhooks/tests/ShopifyWebhookStrategy.pipeline.integration.test.ts` — extend.

- [ ] **Step 1: Write the failing test**

Add to `ShopifyWebhookStrategy.pipeline.integration.test.ts` inside its top-level describe:

```ts
it('when Shopify has byoAppRequired and the brand has no stored app secret, HMAC verify fails (env is NOT used)', async () => {
  // Arrange: a connected Shopify instance for BRAND, but NO per-brand app secret bundle.
  await seedConnectedShopifyInstance({ brandId: BRAND, shopDomain: 'byo.myshopify.com' });
  secretsManager.getSecret = vi.fn(async () => null); // no per-brand bundle
  secretsManager.getShopifyClientSecret = vi.fn(async () => 'env-secret'); // env fallback exists

  // A webhook signed with the env secret (which the receiver must REFUSE for byoAppRequired).
  const body = Buffer.from('{"id":1}');
  const hmac = sign(body, 'env-secret');

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/shopify/orders_create',
    headers: {
      'x-shopify-shop-domain': 'byo.myshopify.com',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-topic': 'orders/create',
      'content-type': 'application/json',
    },
    payload: body,
  });

  expect(res.statusCode).toBe(401);
  expect(secretsManager.getShopifyClientSecret).not.toHaveBeenCalled();
});
```

(`sign` = base64 HMAC-SHA256, mirroring `SHOPIFY_HMAC_CONFIG`. Reuse the helper the file already imports.)

- [ ] **Step 2: Run the test — expect failure**

Run: `cd apps/core && npx vitest run src/modules/connector/webhooks/tests/ShopifyWebhookStrategy.pipeline.integration.test.ts`
Expected: FAIL — env fallback is currently used, so the env-signed HMAC currently verifies.

- [ ] **Step 3: Refactor the default `shopifyHmacSecretResolver` to pass `requireBrandCreds`**

Replace lines 68-96 in `registerWebhookRoutes.ts`:

```ts
  const shopifyDef = getDefinition('shopify');
  const shopifyRequiresBrandCreds = shopifyDef?.byoAppRequired ?? false;

  const shopifyHmacSecretResolver =
    deps.shopifyHmacSecretResolver ??
    (async (shopDomain: string): Promise<string> => {
      const sd = shopDomain.trim();
      if (!sd) return '';
      let brandId = '';
      try {
        const r = await deps.rawPgPool.query<{ brand_id: string }>(
          `SELECT brand_id FROM resolve_connector_by_shop_domain($1)`,
          [sd],
        );
        brandId = r.rows[0]?.brand_id ?? '';
      } catch {
        return '';
      }
      if (!brandId) return '';

      // BYO-required (Shopify): env fallback is FORBIDDEN. If the brand has no stored app secret,
      // return '' → HMAC_INVALID (existing installs on the env app are handled by the boot-time
      // reconnect migration; see Task 10). Fail-closed.
      const envFallback = shopifyRequiresBrandCreds
        ? null
        : {
            clientId: process.env['SHOPIFY_CLIENT_ID'] ?? '',
            clientSecret: await deps.secretsManager.getShopifyClientSecret().catch(() => ''),
          };

      const creds = await resolveBrandOAuthAppCreds(
        deps.secretsManager,
        'shopify',
        brandId,
        envFallback,
        { requireBrandCreds: shopifyRequiresBrandCreds },
      );
      return creds?.clientSecret ?? '';
    });
```

Add the `getDefinition` import at the top of the file:

```ts
import { getDefinition } from '../../catalog/index.js'; // adjust relative to file path
```

- [ ] **Step 4: Audit `shopifyWebhookHandler.ts:109` — the legacy env-only path**

Run: `cd apps/core && grep -rn "shopifyWebhookHandler" src 2>/dev/null | grep -v ".test"`
Expected: one or more registration sites. Determine whether this handler is still wired into the Fastify server:
- If it IS wired: replace the `const clientSecret = await secretsManager.getShopifyClientSecret();` at line 109 with the same BYO-first resolution used in `registerWebhookRoutes.ts` (extract into a shared helper `resolveShopifyWebhookSecret(shopDomain, brandId)` and call it from both places).
- If it is NOT wired (dead code): delete the file and its test.

Commit the decision.

- [ ] **Step 5: Run tests — expect pass**

Run:
```
cd apps/core && npx vitest run src/modules/connector/webhooks/tests/ShopifyWebhookStrategy.pipeline.integration.test.ts
cd apps/core && npx vitest run src/modules/connector/webhooks
```
Expected: pass — including the new BYO-required rejection case, and existing Meta / non-Shopify webhook tests untouched.

- [ ] **Step 6: Commit**

```bash
git add apps/core/src/modules/connector/webhooks/platform/registerWebhookRoutes.ts \
        apps/core/src/modules/connector/sources/storefront/shopify/interfaces/webhooks/shopifyWebhookHandler.ts \
        apps/core/src/modules/connector/webhooks/tests/ShopifyWebhookStrategy.pipeline.integration.test.ts
git commit -m "feat(shopify-webhook): reject env-signed HMAC when byoAppRequired"
```

---

### Task 7: Extend marketplace tile API with `byo_app_required` + `byo_app_setup`

**Files:**
- Locate first (Step 1) — the file that assembles `MarketplaceTile` from `CONNECTOR_CATALOG`.
- Test: the file's existing marketplace test (or `apps/core/src/modules/connector/tests/connector-marketplace.live.test.ts`).

- [ ] **Step 1: Locate the marketplace tile builder**

Run: `cd apps/core && grep -rln "byo_app_\|byoAppRequired\|byoAppSetup\|display_name" src/modules/connector 2>/dev/null | grep -v test | grep -v catalog`
Then: `cd apps/core && grep -rln "display_name.*category.*connect_method\|MarketplaceTile" src 2>/dev/null | grep -v test | grep -v node_modules`
Expected: one file that maps `ConnectorDefinition` → the wire-format `MarketplaceTile`. Note its path.

- [ ] **Step 2: Write the failing test**

Extend `apps/core/src/modules/connector/tests/connector-marketplace.live.test.ts` (or the located file's test):

```ts
it('shopify tile carries byo_app_required=true + byo_app_setup with redirect_url + scopes', async () => {
  const tiles = await getMarketplaceTiles({ brandId: BRAND, shopifyCallbackUrl: 'https://brain.example/api/v1/connectors/shopify/callback' });
  const shopify = tiles.find((t) => t.id === 'shopify')!;
  expect(shopify.byo_app_required).toBe(true);
  expect(shopify.byo_app_setup).toBeDefined();
  expect(shopify.byo_app_setup!.redirect_url).toBe('https://brain.example/api/v1/connectors/shopify/callback');
  expect(shopify.byo_app_setup!.scopes).toContain('read_orders');
  expect(shopify.byo_app_setup!.scopes).toContain('write_pixels');
});

it('meta + google_ads tiles have byo_app_required falsy', async () => {
  const tiles = await getMarketplaceTiles({ brandId: BRAND, shopifyCallbackUrl: 'https://brain.example/cb' });
  expect(tiles.find((t) => t.id === 'meta')!.byo_app_required).not.toBe(true);
  expect(tiles.find((t) => t.id === 'google_ads')!.byo_app_required).not.toBe(true);
});
```

- [ ] **Step 3: Run the test — expect failure**

Run: `cd apps/core && npx vitest run src/modules/connector/tests/connector-marketplace.live.test.ts`
Expected: FAIL — the wire type doesn't carry these fields yet.

- [ ] **Step 4: Extend the tile builder**

In the file located in Step 1:
1. Add `byo_app_required?: boolean` and `byo_app_setup?: { redirect_url: string; scopes: string[]; docs_url?: string | null } | null` to the tile TypeScript type.
2. Populate from `def.byoAppRequired` and `def.byoAppSetup` when assembling the tile — fill `redirect_url` from the request-time `shopifyCallbackUrl` config (dependency-inject or read from the request context, matching how other request-time config is threaded there).

Example (adapt to the located file's actual shape):

```ts
const byo_app_required = def.byoAppRequired ?? false;
const byo_app_setup = def.byoAppSetup
  ? {
      redirect_url: def.id === 'shopify' ? shopifyCallbackUrl : def.byoAppSetup.redirectUrl,
      scopes: [...def.byoAppSetup.scopes],
      docs_url: def.byoAppSetup.docsUrl ?? null,
    }
  : null;

return {
  // ...existing fields...
  byo_app_required,
  byo_app_setup,
};
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd apps/core && npx vitest run src/modules/connector/tests/connector-marketplace.live.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add <marketplace-tile-builder-file> apps/core/src/modules/connector/tests/connector-marketplace.live.test.ts
git commit -m "feat(marketplace-api): expose byo_app_required + byo_app_setup on tiles"
```

---

### Task 8: Frontend — required inline fields + setup panel + reconnect banner

**Files:**
- Modify: `apps/web/lib/api/types.ts` (`MarketplaceTile` type).
- Create: `apps/web/components/connectors/byo-app-setup-panel.tsx` (new component).
- Modify: `apps/web/components/connectors/marketplace-view.tsx` (Shopify tile branch).

- [ ] **Step 1: Extend the wire type**

In `apps/web/lib/api/types.ts`, find `MarketplaceTile` and add:

```ts
export interface ByoAppSetup {
  redirect_url: string;
  scopes: string[];
  docs_url?: string | null;
}

export interface MarketplaceTile {
  // ...existing fields...
  byo_app_required?: boolean;
  byo_app_setup?: ByoAppSetup | null;
}
```

- [ ] **Step 2: Create the setup panel component**

Create `apps/web/components/connectors/byo-app-setup-panel.tsx`:

```tsx
'use client';

/**
 * ByoAppSetupPanel — rendered on the Shopify connect tile above the required Client ID / Secret
 * fields. Numbered instructions with copy-buttoned Redirect URL and scope list, so the merchant
 * can configure their Shopify Custom App correctly BEFORE pasting credentials.
 *
 * Copy semantics mirror the existing WebhookSetupPanel (see marketplace-view.tsx CopyRow).
 */

import { useState } from 'react';
import { Copy, Check, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import type { ByoAppSetup } from '@/lib/api/types';

function CopyRow({ tileId, fieldKey, label, value }: { tileId: string; fieldKey: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the value and copy it manually.', variant: 'destructive' });
    }
  };
  return (
    <div className="space-y-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
          data-testid={`byo-${tileId}-${fieldKey}-value`}
          title={value}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
          data-testid={`byo-${tileId}-${fieldKey}-copy`}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

export function ByoAppSetupPanel({ tileId, displayName, setup }: { tileId: string; displayName: string; setup: ByoAppSetup }) {
  return (
    <div
      className="mb-4 space-y-3 rounded-md border border-primary/30 bg-primary/5 p-4"
      role="region"
      aria-label={`Set up your ${displayName} Custom App`}
      data-testid={`byo-setup-${tileId}`}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Set up your {displayName} Custom App</p>
          <p className="text-xs text-muted-foreground">
            Shopify Custom Apps are per-store — create one on your store, then paste its credentials below.
          </p>
        </div>
      </div>
      <ol className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li>In Shopify admin, go to <strong>Settings → Apps and sales channels → Develop apps → Create an app</strong>.</li>
        <li>In the app&apos;s <strong>Configuration</strong> tab, set <strong>Allowed redirection URL(s)</strong> to:</li>
      </ol>
      <CopyRow tileId={tileId} fieldKey="redirect" label="Redirect URL" value={setup.redirect_url} />
      <ol start={3} className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li>In <strong>API access scopes</strong>, enable these scopes:</li>
      </ol>
      <CopyRow tileId={tileId} fieldKey="scopes" label="Scopes" value={setup.scopes.join(',')} />
      <ol start={4} className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li><strong>Install</strong> the app on your store, then copy the API credentials from the <strong>API credentials</strong> tab into the fields below.</li>
      </ol>
      {setup.docs_url && (
        <p className="text-xs">
          <a href={setup.docs_url} target="_blank" rel="noreferrer" className="text-primary underline">
            Full setup guide →
          </a>
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the panel + required inline fields into marketplace-view.tsx**

In `apps/web/components/connectors/marketplace-view.tsx`:

1. Import at top: `import { ByoAppSetupPanel } from './byo-app-setup-panel';`
2. Inside `ConnectorTile`, after the existing `hasOauthAppFields` computation (around line 308), add:

```tsx
  const byoRequired = Boolean(tile.byo_app_required && tile.byo_app_setup);
```

3. In the disconnected-state render block (around line 660, the `else` branch that renders form fields + Connect button), replace the existing OAuth disclosure block so:
   - When `byoRequired`: render `<ByoAppSetupPanel>` and the OAuth fields INLINE as required (using `oauthAppFields` which now come from the catalog with `optional: false`).
   - When NOT `byoRequired`: keep the existing disclosure branch untouched.

Replace the block starting at "OAuth BYO-app: optional Client ID/Secret tucked behind a disclosure" (line 703-717) with:

```tsx
            {/* Shopify (or any byoAppRequired OAuth tile): setup panel + REQUIRED inline fields. */}
            {isOauth && byoRequired && tile.byo_app_setup && (
              <>
                <ByoAppSetupPanel tileId={tile.id} displayName={tile.display_name} setup={tile.byo_app_setup} />
                {renderFields(oauthAppFields)}
              </>
            )}

            {/* Non-required (Meta / Google Ads): keep the existing optional disclosure. */}
            {isOauth && !byoRequired && hasOauthAppFields && (
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                  aria-expanded={showAdvanced}
                  data-testid={`oauth-advanced-toggle-${tile.id}`}
                >
                  {showAdvanced ? 'Use Brain’s app instead' : 'Use your own OAuth app (optional)'}
                </button>
                {showAdvanced && renderFields(oauthAppFields)}
              </div>
            )}
```

4. Extend the Connect button `disabled` prop (around line 691) to require BYO fields when `byoRequired`:

```tsx
              disabled={
                isConnecting ||
                !emailVerified ||
                (tile.id === 'shopify' && isOauth && !shopDomain.trim()) ||
                (isCredential && !credsComplete) ||
                (byoRequired && (!(creds['client_id'] ?? '').trim() || !(creds['client_secret'] ?? '').trim()))
              }
```

- [ ] **Step 4: Add the reconnect banner for `BYO_APP_REQUIRED` last_error**

Add a banner branch in the CONNECTED render block (around line 532). Assumes `firstInstance.last_error` is surfaced on `MarketplaceTileInstance` (extend the type in `types.ts` if it isn't):

```tsx
            {/* Reconnect banner: match the last_error tag chosen in Task 10 Step 0. Use `includes` so
                both 'BYO_APP_REQUIRED' and 'RECONNECT_REQUIRED:BYO_APP_REQUIRED' (colon-suffixed
                variant) trigger the banner. Adjust to `startsWith('BYO_APP_REQUIRED')` or
                `=== 'BYO_APP_REQUIRED'` if Task 10 chose the strict-equality path (separate
                sub-reason column). */}
            {tile.id === 'shopify' && firstInstance?.last_error?.includes('BYO_APP_REQUIRED') && (
              <div
                role="alert"
                className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-foreground"
                data-testid={`connector-tile-${tile.id}-reconnect-required`}
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <strong>Reconnect required.</strong> Brain&apos;s shared Shopify app was retired.
                  Create your own Shopify Custom App and reconnect using its credentials.
                </span>
              </div>
            )}
```

If `MarketplaceTileInstance` does not currently expose `last_error`, add it in `apps/web/lib/api/types.ts`:

```ts
export interface MarketplaceTileInstance {
  // ...existing fields...
  last_error?: string | null;
}
```

And extend the marketplace tile builder from Task 7 to include it (from `connector_sync_status.last_error`, joined by `connector_instance_id`).

- [ ] **Step 5: Type-check + lint**

Run: `cd apps/web && npx tsc --noEmit && npx next lint`
Expected: no new errors.

- [ ] **Step 6: Manually test in dev**

Run: `cd tools/dev && ./dev-up.sh` (or the project's start command).

In a browser, log in with a verified email, navigate to Settings → Connectors, click into the Shopify tile:
- Verify the setup panel renders with a copy-buttoned redirect URL and scopes.
- Verify Client ID + Client Secret fields are inline (no disclosure).
- Verify the Connect button is disabled until shop_domain + client_id + client_secret are all filled.
- Verify Meta / Google Ads tiles STILL render the "Use your own OAuth app (optional)" disclosure and stay optional.

Note any UX issues in a comment on the commit (do not block on cosmetic fixes).

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/api/types.ts \
        apps/web/components/connectors/byo-app-setup-panel.tsx \
        apps/web/components/connectors/marketplace-view.tsx
git commit -m "feat(web): Shopify tile requires BYO Client ID/Secret + shows setup panel"
```

---

### Task 9: Migration — `ops.migration_state` table

**Files:**
- Create: `db/migrations/0031_migration_state.sql`.

- [ ] **Step 1: Confirm next migration number**

Run: `ls db/migrations/ | tail -5`
Expected: highest existing is 0030 (or `0119_reap_stale_syncing_lease.sql` was mentioned earlier — pick the next unused sequential number). If there are gaps or a higher number, use `<next-integer>_migration_state.sql`. Adjust filename in Step 2 accordingly.

- [ ] **Step 2: Write the migration**

Create `db/migrations/0031_migration_state.sql` (replace `0031` with the number confirmed in Step 1):

```sql
-- ============================================================================
-- 0031_migration_state.sql — Additive: ops.migration_state
--
-- One-shot idempotency guard for boot-time data migrations that must run
-- exactly once per deployment (e.g. bootstrap/reconnect-shopify-byo.ts).
--
-- Why not a DDL migration table? DDL migrations are handled by the migrator
-- runner. This is for DATA migrations that run at Core API bootstrap and need
-- a persistent "already applied" marker. Small, ops-only, no RLS (superuser).
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.migration_state (
  key         TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE ops.migration_state IS
  'Boot-time data migration idempotency markers. See apps/core/src/bootstrap/*.ts.';
```

- [ ] **Step 3: Run migrations against a dev Postgres**

Run: `docker exec brain-v4-postgres-1 psql -U brain -d brain -f - < db/migrations/0031_migration_state.sql`
Expected: `CREATE SCHEMA` + `CREATE TABLE` + `COMMENT` (or `NOTICE: schema "ops" already exists, skipping` — either is fine).

Verify:
```
docker exec brain-v4-postgres-1 psql -U brain -d brain -c "\d ops.migration_state"
```
Expected: table with `key TEXT PK` and `applied_at TIMESTAMPTZ NOT NULL`.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0031_migration_state.sql
git commit -m "feat(db): ops.migration_state table for boot-time data migrations"
```

---

### Task 10: Boot-time task — flip existing Shopify installs to `RECONNECT_REQUIRED`

**Files:**
- Create: `apps/core/src/bootstrap/reconnect-shopify-byo.ts`.
- Create: `apps/core/src/bootstrap/reconnect-shopify-byo.test.ts`.
- Modify: `apps/core/src/main.ts` — call the boot task after DB + secrets are ready.

- [ ] **Step 0: Determine the exact `last_error` string that satisfies migration 0112's back-off**

Migration `0112_reconnect_required_repull_backoff.sql` parks the ingest scheduler on connectors whose `connector_sync_status.state='error' AND last_error` "names RECONNECT_REQUIRED". A bare `'BYO_APP_REQUIRED'` string will not match its NOT EXISTS predicate, causing a 45s retry loop for every migrated instance (exactly the defect 0112 closes).

Run: `cat db/migrations/0112_reconnect_required_repull_backoff.sql | grep -n -A 2 -i "last_error\|RECONNECT_REQUIRED"`
Read the exact SQL predicate (LIKE, `=`, `~*`, etc.).

Pick the last_error string to write in Steps 3, 4 based on the predicate:
- If the predicate is `last_error LIKE 'RECONNECT_REQUIRED%'` (or `~ '^RECONNECT_REQUIRED'`) → write `'RECONNECT_REQUIRED:BYO_APP_REQUIRED'`. The colon-suffix disambiguates the specific sub-reason for the UI while satisfying the LIKE.
- If the predicate is `last_error = 'RECONNECT_REQUIRED'` (strict equality) → write `'RECONNECT_REQUIRED'` and pass the sub-reason in the event payload (`reason: 'byo_app_required'`) + a new `connector_sync_status.error_detail` column OR reuse an existing structured error column. Do NOT add a new column here — this is one-shot ops state; the event payload is enough.

Record the chosen string as the `LAST_ERROR_TAG` constant used everywhere below. In this plan the placeholder `<LAST_ERROR_TAG>` refers to that chosen string; substitute it in Steps 3-6.

- [ ] **Step 1: Write the failing unit test**

Create `apps/core/src/bootstrap/reconnect-shopify-byo.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type pg from 'pg';
import type { ISecretsManager } from '@brain/connector-secrets';
import { runReconnectShopifyByoMigration, MIGRATION_KEY } from './reconnect-shopify-byo.js';

function mockPool(rows: Array<{ id: string; brand_id: string }>, alreadyApplied = false) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM ops.migration_state')) {
      return { rows: alreadyApplied ? [{ key: MIGRATION_KEY }] : [] };
    }
    if (sql.startsWith('SELECT id, brand_id FROM connector_instance')) {
      return { rows };
    }
    if (sql.startsWith('UPDATE connector_sync_status')) return { rowCount: 1 };
    if (sql.startsWith('INSERT INTO ops.migration_state')) return { rowCount: 1 };
    return { rows: [] };
  });
  return { query } as unknown as pg.Pool;
}

// The last_error tag chosen in Step 0. Replace before running the test.
const LAST_ERROR_TAG = '<LAST_ERROR_TAG>';
function mockSecrets(bundlesByBrand: Record<string, Record<string, string> | null>): ISecretsManager {
  return {
    getSecret: vi.fn(async (name: string) => {
      const m = /shopify_app\/(.+)$/.exec(name);
      return m ? (bundlesByBrand[m[1]!] ?? null) : null;
    }),
  } as unknown as ISecretsManager;
}

describe('reconnect-shopify-byo boot task', () => {
  let emit: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    emit = vi.fn(async () => undefined);
  });

  it('flips instances with no per-brand secret to RECONNECT_REQUIRED and emits event', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }]);
    const secrets = mockSecrets({ 'brand-1': null });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    // UPDATE connector_sync_status ran once with BYO_APP_REQUIRED.
    const updates = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([sql]: [string]) => sql.startsWith('UPDATE connector_sync_status'),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toContain(LAST_ERROR_TAG);
    expect(emit).toHaveBeenCalledWith(
      'connector.reconnect_required',
      expect.objectContaining({
        brand_id: 'brand-1',
        connector_instance_id: 'inst-1',
        provider: 'shopify',
        reason: 'byo_app_required',
      }),
    );
  });

  it('leaves instances with a per-brand secret UNTOUCHED', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }]);
    const secrets = mockSecrets({ 'brand-1': { client_id: 'x', client_secret: 'y' } });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    const updates = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([sql]: [string]) => sql.startsWith('UPDATE connector_sync_status'),
    );
    expect(updates).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('is idempotent — second run is a no-op when marker present', async () => {
    const pool = mockPool([{ id: 'inst-1', brand_id: 'brand-1' }], /*alreadyApplied=*/ true);
    const secrets = mockSecrets({ 'brand-1': null });

    await runReconnectShopifyByoMigration({ pool, secrets, emit });

    // Only the marker SELECT should have run; no SELECT of instances, no UPDATE.
    const selects = (pool.query as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([sql]: [string]) => sql.startsWith('SELECT id, brand_id FROM connector_instance'),
    );
    expect(selects).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `cd apps/core && npx vitest run src/bootstrap/reconnect-shopify-byo.test.ts`
Expected: FAIL — file `reconnect-shopify-byo.ts` doesn't exist.

- [ ] **Step 3: Implement the boot task**

Create `apps/core/src/bootstrap/reconnect-shopify-byo.ts`:

```ts
/**
 * reconnect-shopify-byo.ts — one-shot idempotent boot task.
 *
 * Purpose: After the "Shopify BYO-app required" ship, existing Shopify installs authenticated
 * against the env-baked app are broken (webhook HMAC verifies against the env secret, which is
 * no longer accepted). This task flips those installs to RECONNECT_REQUIRED so the connect UI
 * prompts the merchant to reconnect with their own Custom App credentials.
 *
 * Idempotency: guarded by ops.migration_state (migration 0031) — the marker row is inserted
 * LAST, so a mid-run crash re-runs safely on next boot (per-row UPDATE is idempotent).
 *
 * Scope: reads across brands (superuser txn — ops layer). Emits the same event lane the OAuth
 * callback already uses, so the medallion audit trail catches the reconnect prompts.
 */
import type pg from 'pg';
import type { ISecretsManager } from '@brain/connector-secrets';
import { hasBrandOAuthAppCreds } from '../modules/connector/oauth-app-creds.js';

export const MIGRATION_KEY = 'shopify_byo_required_2026_07';

export interface RunReconnectShopifyByoDeps {
  pool: pg.Pool;
  secrets: ISecretsManager;
  emit: (eventName: string, payload: Record<string, unknown>) => Promise<void>;
}

export async function runReconnectShopifyByoMigration(deps: RunReconnectShopifyByoDeps): Promise<void> {
  const { pool, secrets, emit } = deps;

  // 1. Idempotency check.
  const marker = await pool.query<{ key: string }>(
    `SELECT key FROM ops.migration_state WHERE key = $1`,
    [MIGRATION_KEY],
  );
  if (marker.rows.length > 0) return;

  // 2. Enumerate all connected Shopify instances.
  const instances = await pool.query<{ id: string; brand_id: string }>(
    `SELECT id, brand_id FROM connector_instance WHERE provider = 'shopify' AND status = 'connected'`,
  );

  // 3. For each, flip when no per-brand app secret exists.
  for (const row of instances.rows) {
    const hasCreds = await hasBrandOAuthAppCreds(secrets, 'shopify', row.brand_id);
    if (hasCreds) continue;

    // LAST_ERROR_TAG chosen in Step 0 above (aligns with migration 0112's back-off predicate).
    await pool.query(
      `UPDATE connector_sync_status
         SET state = 'error',
             last_error = $2,
             updated_at = NOW()
       WHERE connector_instance_id = $1`,
      [row.id, '<LAST_ERROR_TAG>'],
    );
    await emit('connector.reconnect_required', {
      brand_id: row.brand_id,
      connector_instance_id: row.id,
      provider: 'shopify',
      reason: 'byo_app_required',
    });
  }

  // 4. Insert the marker LAST so a crash re-runs the migration safely.
  await pool.query(
    `INSERT INTO ops.migration_state (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
    [MIGRATION_KEY],
  );
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd apps/core && npx vitest run src/bootstrap/reconnect-shopify-byo.test.ts`
Expected: all 3 cases pass.

- [ ] **Step 5: Wire into `main.ts`**

In `apps/core/src/main.ts`, after the DB pool and secrets manager are initialized (search for `connectorSecretsManager` construction — around line 700+), and BEFORE the Fastify server starts listening, add:

```ts
import { runReconnectShopifyByoMigration } from './bootstrap/reconnect-shopify-byo.js';

// One-shot idempotent data migration: flip existing Shopify installs (env-app) to
// RECONNECT_REQUIRED so the connect UI prompts the merchant. Safe to re-run — guarded by
// ops.migration_state. Failure is logged but does not block boot (belt-and-braces).
try {
  await runReconnectShopifyByoMigration({
    pool: rawPgPool,
    secrets: connectorSecretsManager,
    emit: (name, payload) => emitEvent(name, payload),
  });
} catch (err) {
  log.warn(
    `[main] reconnect-shopify-byo boot task failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
  );
}
```

(Use the exact `emitEvent` / `rawPgPool` / `log` names main.ts already uses at that point — verify by reading the surrounding block.)

- [ ] **Step 6: Smoke-test the boot task locally**

Run:
```
cd tools/dev && ./dev-up.sh
docker exec brain-v4-postgres-1 psql -U brain -d brain -c \
  "SELECT * FROM ops.migration_state WHERE key='shopify_byo_required_2026_07';"
```
Expected: one row present after Core API boots. If a Shopify instance existed pre-boot without BYO creds, its `connector_sync_status.last_error` is now `'BYO_APP_REQUIRED'`.

Restart Core API and verify the marker prevents re-running (no second event emit — check logs).

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/bootstrap/reconnect-shopify-byo.ts \
        apps/core/src/bootstrap/reconnect-shopify-byo.test.ts \
        apps/core/src/main.ts
git commit -m "feat(bootstrap): flip legacy Shopify installs to RECONNECT_REQUIRED on boot"
```

---

### Task 11: E2E — Shopify BYO connect happy path + blocked path

**Files:**
- Modify: `apps/web/e2e/connector-lifecycle.spec.ts`.

- [ ] **Step 1: Read the existing spec file to match its test-harness patterns (login, seed, network mocks)**

Run: `sed -n '1,60p' apps/web/e2e/connector-lifecycle.spec.ts`
Note the login helpers and any Playwright fixtures the file uses.

- [ ] **Step 2: Add the new E2E cases**

Append to `apps/web/e2e/connector-lifecycle.spec.ts`:

```ts
test('Shopify tile shows setup panel + REQUIRED Client ID/Secret fields', async ({ page }) => {
  await loginAsVerifiedManager(page); // reuse the file's existing helper name
  await page.goto('/settings/connectors');

  const tile = page.getByTestId('connector-tile-shopify');
  await expect(tile).toBeVisible();

  // Setup panel is visible (not hidden behind a disclosure)
  await expect(tile.getByTestId('byo-setup-shopify')).toBeVisible();

  // Copy button for redirect URL is present + copyable
  await expect(tile.getByTestId('byo-shopify-redirect-copy')).toBeVisible();
  await expect(tile.getByTestId('byo-shopify-scopes-copy')).toBeVisible();

  // The required Client ID + Client Secret fields are visible inline
  await expect(tile.getByTestId('input-shopify-client_id')).toBeVisible();
  await expect(tile.getByTestId('input-shopify-client_secret')).toBeVisible();

  // Connect button is disabled until shop domain + Client ID + Client Secret are all filled
  const connectBtn = tile.getByTestId('connector-tile-shopify-connect');
  await expect(connectBtn).toBeDisabled();

  await tile.getByTestId('input-shop-shopify').fill('demo-store.myshopify.com');
  await expect(connectBtn).toBeDisabled(); // still missing client_id + client_secret

  await tile.getByTestId('input-shopify-client_id').fill('brand-app-id');
  await expect(connectBtn).toBeDisabled(); // still missing client_secret

  await tile.getByTestId('input-shopify-client_secret').fill('brand-app-secret');
  await expect(connectBtn).toBeEnabled();
});

test('Meta tile keeps the OPTIONAL disclosure (regression guard for byoAppRequired=false)', async ({ page }) => {
  await loginAsVerifiedManager(page);
  await page.goto('/settings/connectors');

  const tile = page.getByTestId('connector-tile-meta');
  await expect(tile).toBeVisible();

  // Meta uses the collapsible disclosure — the BYO setup panel is NOT rendered.
  await expect(tile.getByTestId('byo-setup-meta')).toHaveCount(0);
  await expect(tile.getByTestId('oauth-advanced-toggle-meta')).toBeVisible();
});
```

- [ ] **Step 3: Run the E2E suite**

Run: `cd apps/web && npx playwright test e2e/connector-lifecycle.spec.ts --reporter=line`
Expected: new cases PASS. If Playwright reports selector misses, verify the `data-testid` values match those added in Task 8.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/connector-lifecycle.spec.ts
git commit -m "test(e2e): Shopify BYO required fields + Meta optional-disclosure regression"
```

---

### Task 12: Final verification — naming guard, typecheck, full test suites

- [ ] **Step 1: Run the v4-naming-guard**

Run: `bash tools/lint/v4-naming-guard.sh`
Expected: exit 0 — no new violations (no new `*_secret` columns, no dbt, no StarRocks, no retired-DB refs).

- [ ] **Step 2: TypeScript strict typecheck across affected packages**

Run:
```
cd apps/core && npx tsc --noEmit
cd apps/web && npx tsc --noEmit
```
Expected: no errors in either.

- [ ] **Step 3: Full unit + integration suites**

Run:
```
cd apps/core && npx vitest run
cd apps/web && npx vitest run
```
Expected: all pre-existing tests still pass; new tests from Tasks 2-7 and 10 pass.

- [ ] **Step 4: E2E**

Run: `cd apps/web && npx playwright test e2e/connector-lifecycle.spec.ts --reporter=line`
Expected: pass.

- [ ] **Step 5: Final commit + PR draft**

If any post-fix commits are needed (e.g., a typecheck fix), commit them individually with `fix(...)` messages. Then:

```bash
git push -u origin feat/shopify-byo-app-required
```

Draft a PR against `master` with the spec document linked in the description.

- [ ] **Step 6: Manual walkthrough**

Follow the "Rollout" checklist in the spec (`docs/superpowers/specs/2026-07-02-shopify-byo-app-required-design.md` §13) against a staging environment: create a Shopify Custom App, paste redirect URL + scopes from the setup panel, connect, verify HMAC + one backfill.

---

## Spec Coverage Self-Review

| Spec section | Task(s) |
|---|---|
| §4 Architecture (data flow) | 3, 4, 5, 6 |
| §5 Catalog schema | 1, 2 |
| §6 Backend contract (resolvers) | 3 |
| §6 Backend contract (write route) | 4 |
| §6 Backend contract (callback) | 5 |
| §6 Backend contract (marketplace API) | 7 |
| §6 Backend contract (webhook resolver) — implicit in HMAC path | 6 |
| §7 Frontend | 8 |
| §7 Reconnect banner | 8 (Step 4) |
| §8 Migration for existing installs | 9, 10 |
| §9 Medallion alignment (event emission) | 10 (Step 3 — emit connector.reconnect_required) |
| §10 Error handling (MISSING_APP_CREDENTIALS) | 4 |
| §10 Error handling (BYO_APP_REQUIRED) | 8, 10 |
| §11 Testing (unit + integration + E2E + migration) | 2, 3, 4, 5, 6, 7, 10, 11 |
| §12 Out of scope | (not implemented — verified in review) |
| §13 Rollout | 12 |

No spec section without a task. Task 6 covers a callsite (webhook resolver) that was clarified as "implementation-time" in §6 — added explicitly here.
