# Shopify BYO-App Required — Design

**Date**: 2026-07-02
**Branch**: `feat/shopify-byo-app-required`
**Scope**: Shopify OAuth only. Meta / Google Ads / WooCommerce are unchanged.

## 1. Problem

The Shopify OAuth client credentials (`SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`) are baked into the environment. A Shopify **Custom App** is scoped to a single store, so a single env-registered app can only ingest from the one store on which it was installed. Every additional workspace/brand that connects Shopify silently authenticates against the same env app and cannot install it — connects fail or return tokens the app is not permitted to use.

The workspace user must supply the Client ID and Client Secret of the Shopify Custom App they created for **their own store**.

## 2. Prior state (what already exists)

The end-to-end per-brand "bring-your-own-OAuth-app" infrastructure is already implemented and wired:

- **Catalog** (`apps/core/src/modules/connector/catalog/registry.ts:127-146`) — Shopify declares `authFields: OAUTH_APP_FIELDS` (Client ID + Client Secret, both `optional: true`).
- **Storage** (`apps/core/src/modules/connector/oauth-app-creds.ts`) — `storeBrandOAuthAppCreds` writes to Secrets Manager under deterministic name `brain/connector/shopify_app/<brandId>`; `resolveBrandOAuthClientId` / `resolveBrandOAuthAppCreds` prefer the per-brand bundle and fall back to env.
- **Write route** (`apps/core/src/bootstrap/connectors/writeRoutes.ts:85-129`) — `POST /api/v1/connectors { type:'shopify', shop_domain, credentials:{client_id, client_secret} }` stores the pair and then initiates OAuth.
- **Initiate** (`apps/core/src/modules/connector/sources/storefront/shopify/application/commands/InitiateOAuthCommand.ts:53`) — uses per-brand `client_id`, falls back to `SHOPIFY_CLIENT_ID`.
- **Callback** (`apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts:134`) — resolves per-brand app creds (with env fallback) and uses them for HMAC and token exchange.
- **UI** (`apps/web/components/connectors/marketplace-view.tsx:704-717`) — renders the Client ID / Client Secret fields behind a "Use your own OAuth app (optional)" disclosure.

The workspace user must click the disclosure and fill in the fields; if they don't, the env fallback runs and only one store (the env app's install) works.

## 3. Change

For **Shopify only**:
- Remove the env fallback — `SHOPIFY_CLIENT_ID/SECRET` are no longer read on the Shopify connect / callback paths.
- Make Client ID and Client Secret **required** in the connect UI, rendered inline (no disclosure).
- Show an inline setup panel (redirect URL, scopes, step-by-step) with copy buttons so merchants can configure their Shopify Custom App correctly.
- Existing Shopify installs (which used the env app) are flipped to `health_state='TokenExpired'` with `last_error='BYO_APP_REQUIRED'` on deploy — the tile prompts them to reconnect with their own app.

Meta / Google Ads keep the current optional-with-env-fallback behavior. WooCommerce is a `credential` connector, entirely separate, and is untouched.

## 4. Architecture

```
Merchant creates Shopify Custom App
   │  (UI shows redirect URL + scopes to paste in)
   ▼
UI: enters shop_domain + client_id + client_secret (all required)
   │
   ▼
POST /api/v1/connectors
   { type:'shopify', shop_domain, credentials:{client_id, client_secret} }
   │
   ▼
writeRoutes.ts
  ├─ if def.byoAppRequired && missing creds → 400 MISSING_APP_CREDENTIALS
  ├─ storeBrandOAuthAppCreds(shopify, brandId, {client_id, client_secret})
  ├─ resolveBrandOAuthClientId(shopify, brandId, { requireBrandCreds: true })
  │    // returns undefined (not env) if brand has no stored client_id
  └─ initiateOAuth → Shopify authorize URL
   │
   ▼
Shopify callback → HandleOAuthCallbackCommand
  ├─ resolveBrandOAuthAppCreds(shopify, brandId, envFallback=null,
  │                            { requireBrandCreds: true })
  ├─ HMAC-verify with brand's client_secret
  ├─ Token exchange with brand's client_id + client_secret
  └─ Persist token in Secrets Manager → connector_instance.secret_ref
```

### Files touched

| Layer | File | Change |
|---|---|---|
| Catalog | `apps/core/src/modules/connector/catalog/registry.ts` | Extend `ConnectorDefinition` with `byoAppRequired?: boolean` and `byoAppSetup?: ByoAppSetup`. Set both on Shopify. Override `optional: false` on Shopify's `authFields`. |
| Backend | `apps/core/src/modules/connector/oauth-app-creds.ts` | Add optional `{ requireBrandCreds?: boolean }` to `resolveBrandOAuthClientId` and `resolveBrandOAuthAppCreds`. When true, skip env fallback. |
| Backend | `apps/core/src/bootstrap/connectors/writeRoutes.ts` | Read `def.byoAppRequired`; guard for missing creds → 400; pass `requireBrandCreds: true`. |
| Backend | `apps/core/src/modules/connector/sources/storefront/shopify/application/commands/HandleOAuthCallbackCommand.ts` | For Shopify, resolve with `envFallback: null` (or `requireBrandCreds: true`); on missing creds → `HmacValidationError`. |
| Backend | Marketplace tile response builder (whichever file assembles `MarketplaceTile` in `apps/core/src/modules/connector/marketplace/`) | Include `byo_app_required` and `byo_app_setup` on the tile. `byo_app_setup.redirect_url` is filled from `config.shopifyCallbackUrl` at request time. |
| Frontend | `apps/web/lib/api/types.ts` | Extend `MarketplaceTile` with `byo_app_required?: boolean` and `byo_app_setup?: { redirect_url, scopes, docs_url? } | null`. |
| Frontend | `apps/web/components/connectors/marketplace-view.tsx` | When `tile.byo_app_required`, render inline required fields + a `ByoAppSetupPanel` above them; skip the "Use your own OAuth app (optional)" disclosure. Extend `handleConnect` disable logic. Add reconnect banner for connected instances with `last_error='BYO_APP_REQUIRED'`. |
| Migration | `apps/core/src/bootstrap/reconnect-shopify-byo.ts` (new) | One-shot idempotent boot task. Guarded by `ops.migration_state` row. Flips existing Shopify instances with no per-brand secret to `TokenExpired` + `BYO_APP_REQUIRED` and emits `connector.reconnect_required`. |
| Migration | `db/migrations/0031_migration_state.sql` (new) | `CREATE TABLE ops.migration_state (key TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`. |

## 5. Catalog schema

```ts
export interface ByoAppSetup {
  redirectUrl: string;         // canonical OAuth callback (filled from config at request time)
  scopes: readonly string[];   // must match InitiateOAuthCommand.SHOPIFY_SCOPES exactly
  docsUrl?: string;            // optional external help link
}

interface ConnectorDefinition {
  // ...existing fields...
  byoAppRequired?: boolean;
  byoAppSetup?: ByoAppSetup;
}

// Shared const, hoisted out of InitiateOAuthCommand
export const SHOPIFY_SCOPES_LIST = [
  'read_orders', 'read_products', 'read_customers',
  'write_script_tags', 'write_pixels', 'read_customer_events',
] as const;

// Shopify entry
{
  id: 'shopify',
  category: 'storefront',
  displayName: 'Shopify',
  connectMethod: 'oauth',
  availability: 'available',
  description: 'Sync orders, products, customers.',
  authFields: [
    { key: 'client_id',     label: 'Client ID',     type: 'text',     secret: false, optional: false, hint: 'From your Shopify Custom App API credentials.' },
    { key: 'client_secret', label: 'Client Secret', type: 'password', secret: true,  optional: false, hint: 'From your Shopify Custom App API credentials.' },
  ],
  byoAppRequired: true,
  byoAppSetup: {
    redirectUrl: '',                 // resolved at request-build time
    scopes: SHOPIFY_SCOPES_LIST,
    docsUrl: undefined,
  },
}
```

`OAUTH_APP_FIELDS` remains the shared optional pair used by Meta and Google Ads; Shopify no longer references it (it declares its own required pair).

## 6. Backend contract

### `oauth-app-creds.ts` — signature change (additive)

```ts
resolveBrandOAuthClientId(
  sm: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  opts?: { requireBrandCreds?: boolean },
): Promise<string | undefined>;

resolveBrandOAuthAppCreds(
  sm: ISecretsManager,
  provider: OAuthProvider,
  brandId: string,
  envFallback: OAuthAppCreds | null,
  opts?: { requireBrandCreds?: boolean },
): Promise<OAuthAppCreds | null>;
```

When `requireBrandCreds === true`:
- `resolveBrandOAuthClientId` returns `undefined` if the brand's Secrets Manager bundle is missing or has no `client_id`. Env is never consulted.
- `resolveBrandOAuthAppCreds` returns `null` if the brand's bundle is missing/incomplete. `envFallback` is ignored.

`storeBrandOAuthAppCreds` and `hasBrandOAuthAppCreds` are unchanged. `envClientId` is retained for Meta / Google Ads.

### Write route (`writeRoutes.ts`)

```ts
if (def.connectMethod === 'oauth') {
  // ...existing dispatch lookup...
  const provider = connectorType as OAuthProvider;
  const appCreds = body.credentials;

  if (def.byoAppRequired) {
    if (!appCreds?.['client_id']?.trim() || !appCreds?.['client_secret']?.trim()) {
      return reply.code(400).send({
        request_id: requestId,
        error: {
          code: 'MISSING_APP_CREDENTIALS',
          message: `${def.displayName} requires your Custom App's Client ID and Client Secret.`,
        },
      });
    }
  }

  if (appCreds?.['client_id'] && appCreds?.['client_secret']) {
    await storeBrandOAuthAppCreds(connectorSecretsManager, provider, brandId, {
      clientId: appCreds['client_id'],
      clientSecret: appCreds['client_secret'],
    });
  }

  const clientId = await resolveBrandOAuthClientId(
    connectorSecretsManager,
    provider,
    brandId,
    { requireBrandCreds: def.byoAppRequired ?? false },
  );
  // ... rest unchanged ...
}
```

### Callback (`HandleOAuthCallbackCommand.ts`)

Constructor accepts an optional `requireBrandCreds` flag (defaulting to false to preserve existing 5-arg/6-arg construction in tests). The bootstrap wiring reads `getDefinition('shopify').byoAppRequired` and passes it. Inside `execute`:

```ts
const appCreds = await resolveBrandOAuthAppCreds(
  this.secretsManager,
  'shopify',
  peeked.brandId,
  this.requireBrandCreds
    ? null
    : { clientId: process.env['SHOPIFY_CLIENT_ID'] ?? '',
        clientSecret: await this.secretsManager.getShopifyClientSecret() },
  { requireBrandCreds: this.requireBrandCreds },
);
if (!appCreds?.clientSecret) {
  throw new HmacValidationError();
}
```

The existing `HmacValidationError` on missing `clientSecret` becomes the enforcement point. No new error type.

### Marketplace tile response

Add `byo_app_required: boolean` and `byo_app_setup: { redirect_url: string; scopes: string[]; docs_url?: string } | null` to the tile shape. Populate from `def.byoAppRequired` and `def.byoAppSetup`; fill `redirect_url` at request time from `config.shopifyCallbackUrl`.

## 7. Frontend

### Types

```ts
// apps/web/lib/api/types.ts
export interface ByoAppSetup {
  redirect_url: string;
  scopes: string[];
  docs_url?: string | null;
}
export interface MarketplaceTile {
  // ...existing...
  byo_app_required?: boolean;
  byo_app_setup?: ByoAppSetup | null;
}
```

### Component (`marketplace-view.tsx`)

New helper component `ByoAppSetupPanel({ tile, setup })` that:
- Renders a `SectionCard`-style panel above the credential fields with a "Set up your Shopify Custom App" heading.
- Uses the existing `CopyRow` component (lines 179-214) for the redirect URL and scopes list.
- Numbered steps:
  1. Go to Shopify admin → Settings → Apps and sales channels → Develop apps → **Create an app**.
  2. In the app's **Configuration** tab, set **Allowed redirection URL(s)** to `[CopyRow: redirect_url]`.
  3. In **API access scopes**, enable: `[CopyRow: scopes.join(',')]`.
  4. **Install** the app on your store, then copy the API credentials from the **API credentials** tab into the fields below.

`ConnectorTile` rendering rules (Shopify tile, disconnected state):
1. Store domain input — unchanged.
2. `<ByoAppSetupPanel>` when `tile.byo_app_required && tile.byo_app_setup`.
3. Client ID input (required, inline) — driven by `authFields` (now `optional: false`).
4. Client Secret input (required, inline, `type=password`).
5. Connect button — disabled when `tile.byo_app_required && (!creds.client_id?.trim() || !creds.client_secret?.trim())`.

The existing "Use your own OAuth app (optional)" disclosure branch (`{isOauth && hasOauthAppFields && ...}` at line 704) runs only when `!tile.byo_app_required`, so Meta / Google Ads render unchanged.

### Reconnect banner (connected state)

When a connected instance has `last_error === 'BYO_APP_REQUIRED'`, prepend a warning banner inside the connected-state block: "Reconnect required — Brain's shared Shopify app is retired. Create your own Custom App and reconnect." with a "Reconnect" button that calls `disconnect` + refocuses the disconnected-form state. (Two clicks; matches existing disconnect UX.)

## 8. Migration for existing installs

### `db/migrations/0031_migration_state.sql`

```sql
CREATE SCHEMA IF NOT EXISTS ops;
CREATE TABLE IF NOT EXISTS ops.migration_state (
  key         TEXT        PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

(Fits the CLAUDE.md invariant: `ops` schema on Postgres for operational state.)

### `apps/core/src/bootstrap/reconnect-shopify-byo.ts` (new)

Boot-time task, called from `apps/core/src/main.ts` after secrets manager + DB pool are ready:

```
1. BEGIN txn (superuser role — ops schema, cross-brand read).
2. SELECT 1 FROM ops.migration_state WHERE key='shopify_byo_required_2026_07';
   If found → COMMIT + return (idempotent no-op).
3. SELECT id, brand_id FROM connector_instance
   WHERE provider='shopify' AND status='connected';
4. For each row:
     if !(await hasBrandOAuthAppCreds(sm, 'shopify', brand_id)):
       UPDATE connector_instance
         SET health_state='TokenExpired',
             safety_rating='blocked',
             last_error='BYO_APP_REQUIRED',
             updated_at=NOW()
         WHERE id=$1;
       emit('connector.reconnect_required', {
         brand_id, connector_instance_id, provider:'shopify',
         reason:'byo_app_required'
       });
5. INSERT INTO ops.migration_state (key) VALUES ('shopify_byo_required_2026_07');
6. COMMIT.
```

Order matters: the marker is inserted last so a mid-run crash re-runs on next boot (safe — idempotent per row).

`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` env vars remain in `.env.production.example` for a deprecation window (nothing reads them for Shopify after this ships). Cleanup ticket: delete env vars once `count(connector_instance WHERE provider='shopify' AND last_error='BYO_APP_REQUIRED') == 0` in prod.

## 9. Medallion alignment

- **Bronze events**: existing `connector.connected` (unchanged) + new `connector.reconnect_required` event emitted through the same M1 event publisher → Bronze events lane. No new bronze tables.
- **Silver / Gold**: no data-model change. Auth config is not a medallion mart concern.
- **Ops (Postgres)**: `connector_instance` is the operational state; brand_id-first isolation preserved. `ops.migration_state` (new) is operational-only. Both live under Brain's existing RLS surface.
- **Secrets**: per-brand app creds continue to live in Secrets Manager (NN-2 forbids `*_secret` columns on `connector_instance`); deterministic name `brain/connector/shopify_app/<brandId>` is brand-isolated by key.
- **Money / currency / tenant isolation invariants**: not touched by this change.

## 10. Error handling

| Code | Layer | Where | User message |
|---|---|---|---|
| `MISSING_APP_CREDENTIALS` | 400 | `writeRoutes.ts` connect handler | "Shopify requires your Custom App's Client ID and Client Secret." |
| `BYO_APP_REQUIRED` | internal | `connector_instance.last_error` | Tile-rendered: "Reconnect required — create your own Custom App and reconnect." |
| `OAUTH_NOT_CONFIGURED` | 503 | `writeRoutes.ts` (existing) | Kept as belt-and-braces for the resolve-returns-undefined race. |
| `HmacValidationError` | callback rejection | `HandleOAuthCallbackCommand` (existing) | Existing rejection copy. |

Logging: never log client_secret or the Secrets Manager bundle values (I-S09 invariant). Redact the credentials block from any request-body log emitter.

## 11. Testing

| Layer | File | Case |
|---|---|---|
| Unit | `apps/core/src/modules/connector/oauth-app-creds.test.ts` | `requireBrandCreds: true` in `resolveBrandOAuthClientId` returns `undefined` when no per-brand bundle (does not fall back to env). |
| Unit | same | `requireBrandCreds: true` in `resolveBrandOAuthAppCreds` returns `null` even when `envFallback` is supplied. |
| Unit | `apps/core/src/modules/connector/catalog/catalog.test.ts` | Shopify tile: `byoAppRequired === true`, `byoAppSetup.scopes` matches `SHOPIFY_SCOPES_LIST`, `authFields` are `optional: false`. Meta / Google Ads: `byoAppRequired` is falsy, `authFields` remain optional. |
| Integration | `apps/core/src/modules/connector/tests/oauth-callback.integration.test.ts` | Shopify callback with no per-brand secret → `HmacValidationError` (previously accepted via env fallback). Meta callback with no per-brand secret → still passes via env (regression guard). |
| Integration | new test in `writeRoutes` integration suite | `POST /api/v1/connectors { type:'shopify', shop_domain, credentials:{} }` → 400 `MISSING_APP_CREDENTIALS`. With credentials → 200 + `oauth_url`. |
| E2E | `apps/web/e2e/connector-lifecycle.spec.ts` | Shopify tile renders the setup panel, all three fields are visible (store domain, client_id, client_secret), Connect is disabled until all three are filled, copy buttons work. |
| Migration | new `reconnect-shopify-byo.test.ts` | Stub Shopify instance with no per-brand secret → flipped to `TokenExpired` + `BYO_APP_REQUIRED` + event emitted. Second run → no-op (marker row present). Stub Shopify instance WITH per-brand secret → unchanged. |

CI: `tools/lint/v4-naming-guard.sh` runs unchanged; no new StarRocks / dbt / feature-precompute / `*_secret`-column violations.

## 12. Out of scope

- Meta / Google Ads BYO-app requirement (their env fallback stays; they can opt in later by flipping the same catalog flag).
- Env var deletion (`SHOPIFY_CLIENT_ID/SECRET`) — deprecation window, follow-up ticket.
- Public docs page for Custom App setup (`docsUrl` is nullable; setup panel is self-contained).
- WooCommerce (`credential` connector, entirely separate credential fields).

## 13. Rollout

1. Merge to master; deploy to staging.
2. Staging: run through connect with a real staging Shopify Custom App; verify HMAC, token exchange, one full backfill.
3. Staging: verify the boot task marks the pre-existing staging install as `BYO_APP_REQUIRED` on first boot after deploy; verify second boot is a no-op.
4. Production: deploy during a low-traffic window; monitor `connector.reconnect_required` event volume vs. `connector_instance WHERE provider='shopify' AND status='connected'` count.
5. Notify existing merchants (out-of-band email) with a link to the setup panel and expected reconnect UX.
6. Follow-up (2 weeks after 100% reconnect): delete `SHOPIFY_CLIENT_ID/SECRET` from `.env.production.example` and any remaining callsites.
