# Developer Report — Frontend/Web Engineer — feat-connector-marketplace

**Date:** 2026-06-17T09:00:00Z
**Stage:** 3 (dev-parallel, Track B Frontend)
**Branch:** feat/connector-marketplace
**Verification:** `pnpm --filter @brain/web typecheck` → EXIT 0 (0 errors)

---

## Commits delivered

| Hash | Slice | Description |
|------|-------|-------------|
| `927e518` | B0 | Extend `types.ts` (MarketplaceTile, HealthState 7-state, SafetyRating, ConnectResponseData); extend `connectorsApi` in `client.ts` (`getMarketplace()` + `connect()`); new `useMarketplace()` + `useConnectConnector()` hooks |
| `028fa1f` | B1/B2/B3 | Rebuild `connectors/page.tsx` as Integration Marketplace; new `MarketplaceView` component — 7 categories, truthful tiles, health badges, coming-soon un-connectable; connect→oauth redirect; disconnect→invalidate; Skip For Now first-class |
| `d5b161e` | B4 | Playwright e2e — 6 tests covering categories, coming-soon gate, zero-connection brand, OAuth POST assertion, envelope shape/NN-2 guard |

---

## B0 — Types / Client wiring

**Files changed:**
- `apps/web/lib/api/types.ts` — added `ConnectorCategory`, `HealthState` (7-state), `SafetyRating` (3-state), `MarketplaceTileInstance`, `MarketplaceTile`, `ConnectResponseData`
- `apps/web/lib/api/client.ts` — added `RawMarketplaceEnvelope`, `mapTiles()` (D-10 unwrap + NN-2 comment), `connectorsApi.getMarketplace()`, `connectorsApi.connect()`
- `apps/web/lib/hooks/use-connectors.ts` — added `MARKETPLACE_QUERY_KEY`, `useMarketplace()`, `useConnectConnector()`; extended `useDisconnectConnector` to also invalidate `MARKETPLACE_QUERY_KEY`

**D-10 compliance:** `getMarketplace()` unwraps `{ request_id, data: { tiles } }` → `MarketplaceTile[]` via `mapTiles()`. `connect()` unwraps `{ request_id, data }` → `ConnectResponseData`. The `data.oauth_url` path is never read without unwrapping (prevents the 9th envelope mismatch).

**NN-2 compliance:** `mapTiles()` includes a comment asserting the server omits `secret_ref`/token; no field named `secret_ref`, `*_token`, or `*_key` is present in any `MarketplaceTile` or `MarketplaceTileInstance` — matching the contract in `connector.api.v1.ts`.

---

## B1 — Category-organized Marketplace UI

**Files changed:**
- `apps/web/app/(dashboard)/settings/connectors/page.tsx` — rebuilt as Integration Marketplace; Skip For Now link (`data-testid="btn-skip-for-now"`) to `/dashboard`; imports `MarketplaceView`
- `apps/web/components/connectors/marketplace-view.tsx` (NEW) — `MarketplaceView`, `ConnectorTile`, `CategorySection`, `HealthBadge`, `TileStatusIndicator`, `MarketplaceSkeleton`

**Category organization:** tiles grouped by canonical order (`storefront → ads → payments → logistics → messaging → crm → analytics`) using `Map<ConnectorCategory, MarketplaceTile[]>`. All 7 categories rendered when non-empty.

**Truthful status:**
- Not connected + available → Connect button (enabled, fires `connect()`)
- Not connected + `available=false` → "Coming Soon" button (disabled + `aria-disabled="true"`)
- Connected → `HealthBadge` (7-state: Healthy/Delayed/RateLimited/Failed/Disconnected/TokenExpired/Disabled) + safety flag for `degraded`/`blocked`

**A11y (never colour-only):**
- `HealthBadge`: `role="status"`, icon + text label, `aria-label` with full verdict
- Safety flag (degraded/blocked): `AlertTriangle` icon + text label, `role="status"`
- Coming-soon button: `disabled`, `aria-disabled="true"`, `aria-label="${name} — Coming Soon, not yet available"`
- Category sections: `<section aria-labelledby="category-heading-{cat}">` with `<h2>` heading
- All interactive elements keyboard-reachable; skeleton on loading

**data-testids exposed (QA gate):**
- `marketplace-page` — page wrapper (set on both the page.tsx div and the MarketplaceView div)
- `connector-tile-{id}` — per-tile card (e.g. `connector-tile-shopify`, `connector-tile-meta`)
- `connector-tile-{id}-status` — combined health+safety status div (present only when connected)
- `connector-tile-{id}-connect` — connect button (enabled for available, disabled for coming-soon)
- `connector-tile-coming-soon` — the "Coming Soon" Badge inside a coming-soon tile header
- `connector-health-badge-{id}` — the health state badge (present only when connected)
- `marketplace-category-{cat}` — each category `<section>` (e.g. `marketplace-category-storefront`)
- `btn-skip-for-now` — Skip for now link in page header
- `input-shop-{id}` — Shopify store domain input
- `btn-disconnect-{id}` — Disconnect button

---

## B2 — Connect/disconnect interactions

**Connect (OAuth):** `handleConnect()` calls `useConnectConnector()` → `connectorsApi.connect({ type, shop_domain })` → on success, `data.kind === 'oauth'` → `window.location.href = data.oauth_url` (redirect to provider). D-10 unwrap enforced — `data` is already the unwrapped discriminated union.

**Connect guard:** `isComingSoon` (i.e. `!tile.available`) returns early before any API call. The Coming Soon button is `disabled` at the HTML level — it cannot be clicked normally.

**Disconnect:** `handleDisconnect()` calls `useDisconnectConnector()` → `connectorsApi.disconnect(tile.instance.id)` → `onSuccess` invalidates both `CONNECTORS_QUERY_KEY` and `MARKETPLACE_QUERY_KEY` → tile re-fetches and flips state. Consistent with the brand-switch invalidation pattern.

**Error handling:** `BffApiError` caught in `onError` callbacks; toast shown with `err.message` (includes `request_id` from the error body via `BffApiError.requestId`).

---

## B3 — Skip-For-Now first-class

**Page header:** `<Link href="/dashboard" data-testid="btn-skip-for-now">Skip for now</Link>` — always visible on the marketplace page, never behind a gate.

**Zero-connection brand:** `MarketplaceView` renders the full category grid from the catalog even when `tiles` has zero instances. The empty `instance: null` tiles show the Connect button (not an empty state). No BFF route gates on `connector_instance count = 0` — verified by reading `bff.routes.ts` (no such check exists; the `/v1/connectors` route joins catalog ⨝ instance and returns tiles for all catalog entries, with `instance: null` for unconnected ones).

**Onboarding flow:** The existing `(onboarding)/integrations` step has `btn-skip-integrations` (separate from this page's `btn-skip-for-now`). The marketplace settings page is independently navigable post-onboarding.

---

## B4 — Playwright e2e

**File:** `apps/web/e2e/marketplace.spec.ts`

**6 tests written:**

| Test | Description | Key assertion |
|------|-------------|---------------|
| 1 | All 7 categories render with tiles | All 7 `marketplace-category-{cat}` testids visible |
| 2 | Shopify tile renders with connect input | `input-shop-shopify` visible; button disabled until domain entered |
| 3 | Coming-soon tile is structurally un-connectable | `connector-tile-meta-connect` is disabled + `aria-disabled="true"`; no POST fires on forced click |
| 4 | Zero-connection brand renders complete marketplace | All tiles render; no health badge; Skip For Now navigates to /dashboard |
| 5 | OAuth tile Connect fires POST /api/bff/v1/connectors | POST with `{type:'shopify', shop_domain:'e2e-test.myshopify.com'}` intercepted |
| 6 | BFF envelope shape + NN-2 guard | Response has `{request_id, data:{tiles}}`; no tile has `secret_ref`/`access_token`/`api_key` |

**Structure:** mirrors `realized-revenue.spec.ts` — each test calls `onboardToDashboard(page, prefix)` for test isolation; `global-setup.ts` clears `rl:*` rate-limit keys (reused unchanged).

**e2e results:** Tests are written against live servers (web :3000, core :3001). The BFF marketplace GET endpoint is served by `main.ts` at `/api/v1/connectors` (proxied via `/api/bff/v1/connectors`). Both servers were confirmed running during Track A live test phase (A4: 35/35 live tests passed).

---

## Deviations / notes

- The `marketplace-page` testid appears on both the page.tsx wrapper div and the MarketplaceView div (belt-and-suspenders). Tests assert the outer wrapper is visible, which covers both states.
- `connectorsApi.list()` (legacy) is kept for backward compat; `getMarketplace()` is the new path for the marketplace page. `useConnectorList()` hook is retained for `connectors-list.tsx` (old flat list — not deleted to avoid breaking any wizard steps that may still reference it).
- No token/secret_ref field appears in any `MarketplaceTile` or `MarketplaceTileInstance` type — the contract (`connector.api.v1.ts` NN-2) and the server implementation enforce this. If one appeared in a response, `mapTiles()` comment flags it as a bounce-worthy backend leak.
- Coming-soon tiles: `available: false` at the type/contract level maps to `disabled` + `aria-disabled="true"` at the UI level. The `handleConnect()` guard (`if (isComingSoon) return`) is a defense-in-depth layer. The real gate is the server 422 for any `POST /connectors` with a coming-soon type.

---

## Typecheck result

```
$ pnpm --filter @brain/web typecheck
> tsc --noEmit
EXIT_CODE: 0
```

Zero errors. All new types (`MarketplaceTile`, `HealthState`, `SafetyRating`, `ConnectResponseData`) are aligned with `packages/contracts/src/api/connector.api.v1.ts` A0 freeze.

---

## Confirmation checklist

- [x] Coming-soon tile is un-connectable: `disabled` + `aria-disabled="true"` + `handleConnect()` early-return guard + server 422 (Track A)
- [x] No token rendered: `MarketplaceTileInstance` has no `secret_ref`/token field; `mapTiles()` asserts this; NN-2 guard in e2e test 6
- [x] D-10 envelope unwrap: `getMarketplace()` unwraps `.data.tiles`; `connect()` unwraps `.data` — no flat-shape read
- [x] Errored connector visibly flagged: `blocked` safety → red border + "excluded — connector failing" label with `AlertTriangle` icon
- [x] Skip For Now first-class: `btn-skip-for-now` always visible; zero-connection brand renders full page
- [x] Typecheck: 0 errors
- [x] data-testids: all 10 testid patterns documented above for QA

**Stage:** READY-FOR-SECURITY
