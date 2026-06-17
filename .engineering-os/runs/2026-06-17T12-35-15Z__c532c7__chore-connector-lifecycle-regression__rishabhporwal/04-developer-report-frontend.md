# Developer Report — Track C (Frontend/Web)
## chore-connector-lifecycle-regression

| Field | Value |
|---|---|
| **req_id** | `chore-connector-lifecycle-regression` |
| **Track** | C — Frontend/Web Engineer |
| **Branch** | `chore/connector-lifecycle-regression` |
| **Commit (C1)** | `9e64c7f` — test(lifecycle): C1 disconnected-tile→Connect e2e + coming-soon invariant (defect #1 revert-RED) |
| **New file** | `apps/web/e2e/connector-lifecycle.spec.ts` |
| **Typecheck** | `pnpm --filter @brain/web typecheck` → EXIT 0 |
| **E2e result** | 9 passed (connector-lifecycle: 3 + marketplace no-regression: 6) |

---

## What the E2E Proves

### C1a — Disconnected instance → Connect tile (defect #1, revert-RED)

Seeds a `status='disconnected'` `connector_instance` row via the superuser connection
(`DATABASE_URL = postgres://brain:brain@localhost:5432/brain`) for a freshly onboarded
brand (from `onboardToDashboard`), then navigates to `/settings/connectors` and asserts:

1. `connector-tile-shopify` is visible.
2. `input-shop-shopify` is visible (Connect state — shop domain input only appears when `tile.instance === null`).
3. `connector-tile-shopify-connect` is visible and **enabled** after filling the domain.
4. `connector-health-badge-shopify` has count **0** (no health badge → no `TileStatusIndicator` rendered).
5. `btn-disconnect-shopify` has count **0** (no Disconnect button).

**Revert-RED mechanism:**

The fix lives at `main.ts:535`:
```
const instance = found && found.status !== 'disconnected' ? found : null;
```

If reverted to `const instance = found`:
- The BFF returns `instance ≠ null` for the seeded disconnected row.
- `TileStatusIndicator` renders a `HealthBadge` → `connector-health-badge-shopify` count goes from 0 to 1 → `toHaveCount(0)` **goes RED**.
- The tile renders the Disconnect branch (not the Connect branch) → `connector-tile-shopify-connect` disappears → enabled assertion **goes RED**.
- `input-shop-shopify` disappears → visibility assertion **goes RED**.

### C1b — Fresh brand baseline (connect-tile reference)

Zero `connector_instance` rows → BFF returns `instance=null` → Connect tile is the only rendered action. Confirms the no-instance happy path works end-to-end.

### C1c — Coming-soon invariant

Coming-soon tiles (Meta) are `disabled` + `aria-disabled="true"` and do not fire POST `/api/bff/v1/connectors`. This invariant holds regardless of lifecycle state.

---

## Honesty Boundary (D-1, architecture-plan.md §4 Track C)

| Surface | Layer | Test file |
|---|---|---|
| UI tile state transitions: disconnected→Connect | E2E (this file) | `connector-lifecycle.spec.ts` |
| Coming-soon tile un-connectable invariant | E2E (this file) | `connector-lifecycle.spec.ts` |
| Reconnect UPSERT no-23505 (same `id` returned) | Integration (Track B) | `connector-lifecycle.integration.test.ts` |
| Single sync row count after reconnect | Integration (Track B) | `connector-lifecycle.integration.test.ts` |
| OAuth callback 302/Location/HMAC contract | Integration (Track B) | `oauth-callback.integration.test.ts` |
| Pagination `since_id=0` 600-order walk | Integration (Track A) | `shopify-pagination.integration.test.ts` |
| Worker NIL-uuid GUC + cross-brand RLS | Integration (Track A) | `worker-guc.integration.test.ts` |
| Sync-status→connected + currency trigger | Integration (Track A) | `sync-status-currency.integration.test.ts` |
| `dev_secret` round-trip + prod hard-fail | Integration (Track A) | `dev-secret.integration.test.ts` |
| Provisional surfaced contract (defect #5) | Integration (existing) | `revenue-metrics.live.test.ts` (reference — not duplicated) |

**Full connect→disconnect→reconnect round-trip is NOT driven through the browser.** A real Shopify OAuth authorize requires a staging environment. The e2e proves the disconnected-tile RENDERING via a seeded DB state. The reconnect DB mechanics (UPSERT, no-23505, single-sync-row) are Track B integration territory.

---

## Seeded-State Approach

`seedDisconnectedInstance(brandId)` inserts a `connector_instance` row with:
- `status = 'disconnected'`
- `health_state = 'Disconnected'`
- `safety_rating = 'safe'`
- `secret_ref` = a fake ARN (no real credential stored)
- `ON CONFLICT (brand_id, provider) DO UPDATE` — idempotent if a prior test left a row

Cleanup in a `finally` block: deletes `connector_sync_status`, `connector_cursor`, then `connector_instance` for the seeded `instanceId`. No reference to the real Boddactive brand (`60d543dc-…`).

---

## E2E Pass Evidence

```
Running 9 tests using 1 worker

  ✓  1 [chromium] › e2e/connector-lifecycle.spec.ts:137:5 › disconnected connector_instance renders as Connect tile (not health badge) — defect #1 revert-RED (8.4s)
  ✓  2 [chromium] › e2e/connector-lifecycle.spec.ts:200:5 › freshly onboarded brand with no connector_instance renders Shopify Connect tile (6.1s)
  ✓  3 [chromium] › e2e/connector-lifecycle.spec.ts:238:5 › coming-soon tile is structurally un-connectable (aria-disabled) — lifecycle invariant (7.9s)
  ✓  4 [chromium] › e2e/marketplace.spec.ts:39:5 › marketplace renders all 7 categories with tiles (6.0s)
  ✓  5 [chromium] › e2e/marketplace.spec.ts:57:5 › shopify tile renders in storefront category with connect input (6.0s)
  ✓  6 [chromium] › e2e/marketplace.spec.ts:82:5 › coming-soon tile is present and is structurally un-connectable (7.9s)
  ✓  7 [chromium] › e2e/marketplace.spec.ts:120:5 › marketplace renders fully for a freshly onboarded brand with zero connections (6.0s)
  ✓  8 [chromium] › e2e/marketplace.spec.ts:143:5 › OAuth tile Connect button fires POST /api/bff/v1/connectors with type=shopify (5.9s)
  ✓  9 [chromium] › e2e/marketplace.spec.ts:183:5 › GET /api/bff/v1/connectors returns correct envelope with tiles (5.9s)

  9 passed (1.0m)
```

Typecheck: `pnpm --filter @brain/web typecheck` → EXIT 0 (0 errors).

---

## Data-Testids Asserted

| testid | Test | Assertion |
|---|---|---|
| `marketplace-page` | all 3 lifecycle tests | visible |
| `connector-tile-shopify` | C1a, C1b | visible |
| `input-shop-shopify` | C1a, C1b | visible (Connect state); filled with domain |
| `connector-tile-shopify-connect` | C1a | enabled after domain fill (revert-RED) |
| `connector-tile-shopify-connect` | C1b | visible; disabled before domain fill; enabled after |
| `connector-health-badge-shopify` | C1a | `toHaveCount(0)` (revert-RED) |
| `btn-disconnect-shopify` | C1a | `toHaveCount(0)` |
| `connector-tile-coming-soon` | C1c | first visible; count > 0 |
| `connector-tile-meta` | C1c | visible |
| `connector-tile-meta-connect` | C1c | disabled; `aria-disabled="true"` |

---

## No New Product Code (D-9)

Diff is confined exclusively to `apps/web/e2e/connector-lifecycle.spec.ts`. Zero product code changes.

---

## Discovered Product Bugs

None found during Track C work. The ADR-R3 worker prod-hard-fail gap (WorkerLocalSecretsManager has no NODE_ENV=production guard) was discovered and documented by Track A; surfaced via `it.skip` in `dev-secret.integration.test.ts`.

---

## Residuals / BOUNCE-worthy Issues

None for Track C. All 3 tests green; marketplace no-regression confirmed; typecheck EXIT 0.
