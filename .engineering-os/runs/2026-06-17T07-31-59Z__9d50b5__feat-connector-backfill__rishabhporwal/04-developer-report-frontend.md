# 04 — Developer Report: Frontend/Web (Track C)
## feat-connector-backfill

| Field | Value |
|-------|-------|
| **req_id** | `feat-connector-backfill` |
| **Stage** | 3 — Build (Track C) |
| **Track** | C — @frontend-web-developer |
| **Branch** | `feat/connector-backfill` |
| **Typecheck** | EXIT 0 (`pnpm --filter @brain/web typecheck`) |
| **Completed at** | 2026-06-17 |

---

## Commits (all on `feat/connector-backfill`, apps/web paths only)

| Hash | Slice | One-line description |
|------|-------|---------------------|
| `a436006` | C0 | feat(web/C0): add backfill API client + useBackfillProgress hook |
| `33e9301` | C1 | feat(web/C1): backfill progress UX on connected Shopify tile |
| `6d21f74` | C2 | feat(web/C2): label realized-revenue-card as 'Gross Revenue (ex-fees)' (D-11/ADR-BF-12) |
| `1f01940` | C3 | feat(web/C3): Playwright e2e backfill.spec.ts |

---

## C0 — Client + Hook

**Files modified:**
- `apps/web/lib/api/client.ts` — added `backfillApi.triggerBackfill()` + `backfillApi.getBackfillProgress()`. Both call `/api/v1/connectors/:id/backfill` and `/api/v1/connectors/:id/jobs` directly (not BFF-wrapped). `.data` envelope unwrapped at call site. `BackfillTriggerResponse` and `BackfillJobProgress` imported from `@brain/contracts` (A0 freeze). `BffApiError` thrown with `.code` set for `RECONNECT_REQUIRED` (D-7) and `BACKFILL_ALREADY_RUNNING` (D-9).
- `apps/web/lib/hooks/use-backfill.ts` (new) — `useBackfillProgress()`: TanStack Query hook polling every 3s while status ∈ {queued,running}; stops on terminal; 404 treated as "no job yet" (no error). `useTriggerBackfill()`: mutation that invalidates the progress query on success to begin polling immediately.
- `apps/web/next.config.js` — added `/api/v1/:path*` rewrite to `CORE_API_URL` (default `http://localhost:3001`) so the web app can proxy the backfill routes which are not BFF-wrapped.

**D-8 compliance:** `estimated_total=null` is never coerced to 0. The `getBackfillProgress` function returns the raw `BackfillJobProgress` interface from contracts; `percent=null` is preserved exactly.

---

## C1 — Progress UX

**Files modified:**
- `apps/web/components/connectors/backfill-control.tsx` (new) — `BackfillControl` component with:
  - Trigger button: visible/enabled for `owner`/`brand_admin` only (reads `useSessionRole()`). Hidden for `manager`/`analyst` — mirrors server 403 (D-15).
  - `ActiveProgress`: determinate progress bar (with `percent`) or indeterminate pulsing bar (when `percent=null`). When `estimated_total===null`, shows "Collecting your data…" text, never "0%". `role="progressbar"` + `aria-valuenow`/`aria-valuemin`/`aria-valuemax` (a11y).
  - `TerminalState`: completed (count + achieved_depth_label), partial/failed (reason + retry button).
  - `BackfillStatusBadge`: icon + label, never colour-only (WCAG 1.4.1). `role="status"` + `aria-label`.
  - RECONNECT_REQUIRED alert: `data-testid="backfill-reconnect-required"` with `AlertTriangle` icon + message.
  - BACKFILL_ALREADY_RUNNING alert: separate state with spinner icon.
  - All required `data-testid`s: `backfill-trigger`, `backfill-progress`, `backfill-records`, `backfill-estimated`, `backfill-depth-label`, `backfill-status`, `backfill-reconnect-required`.
  - Reuses: `Button`, `Skeleton`, `ErrorCard`, `Badge` (Single-Primitive).
- `apps/web/components/connectors/connectors-list.tsx` — wired `BackfillControl` into `ConnectorCard` for connected Shopify tiles, after the disconnect button. Visible to all roles; trigger gated internally by `useSessionRole()`.

---

## C2 — Dashboard Label (D-11/ADR-BF-12)

**Files modified:**
- `apps/web/components/dashboard/realized-revenue-card.tsx`:
  - `CardTitle` now shows `"Gross Revenue (ex-fees)"` in a `<span data-testid="realized-revenue-gross-label">`.
  - `GrossRevenueTooltip` component (inline before the card): keyboard-accessible `<button>` with `aria-label="What does ex-fees mean?"`, toggles a `role="tooltip"` span. Tooltip text: "Settlement fees not yet applied. This figure represents gross revenue from Shopify orders. Net revenue will be shown once the Razorpay settlement data is connected."
  - Label applied in both `no_data` and `has_data` states — always present.
  - No number changed; reuses the existing `realized_gmv_as_of` engine value.
  - Provisional block unchanged: still shown separately, never blended (D-4).

---

## C3 — Playwright E2E

**File:** `apps/web/e2e/backfill.spec.ts`

Tests follow the `marketplace.spec.ts` pattern with the `onboardToDashboard` helper and `global-setup.ts` rate-limit key clearing.

| Test | Coverage | Approach |
|------|----------|----------|
| 1 | Dashboard "Gross Revenue (ex-fees)" label (D-11) | Live nav to /dashboard; asserts `realized-revenue-gross-label` testid + exact text |
| 2 | brand_admin sees connectors page | Live nav to /settings/connectors; asserts marketplace page loads |
| 3 | Manager sees no enabled trigger (D-15 UI gating) | Registers manager, invites via UI, logs in as manager; asserts `backfill-trigger` not visible |
| 4 | D-8: estimated_total=null → "Collecting your data…" not "0%" | Route interception with `estimated_total:null`; asserts progress text does not contain "0%" |
| 5 | achieved_depth_label renders on completed (HP-3) | Route interception with `status:'completed'`, `achieved_depth_label:'24 months'` |
| 6 | POST → 202 {job_id,status} for brand_admin | Live API call; guarded by `SHOPIFY_CONNECTED_CONNECTOR_ID` env var |
| 7 | Manager POST → 403 (D-15 non-inert) | Live API call as manager; guarded by `SHOPIFY_CONNECTED_CONNECTOR_ID` env var |
| 8 | RECONNECT_REQUIRED 409 → reconnect alert (D-7) | Route interception; clicks trigger; asserts `backfill-reconnect-required` visible |
| 9 | backfill-status badge a11y | Route interception; asserts `role="status"` and `aria-label` on badge |

**E2E result note:** Tests that require a live connected Shopify connector (tests 6, 7) are guarded by `SHOPIFY_CONNECTED_CONNECTOR_ID` env var and skip gracefully when absent. All other tests run unconditionally against both servers.

Tests 4, 5, 8, 9 use Playwright route interception (`page.route('**/api/v1/connectors/*/jobs'...)`) to simulate backfill states without requiring a real Shopify connection.

---

## Typecheck Result

```
> @brain/web@0.0.0 typecheck /Users/.../apps/web
> tsc --noEmit
[exit 0 — no output]
```

---

## D-8 Honesty Verification

When `estimated_total===null`:
- `ProgressBar` renders with `aria-valuetext="Collecting your data…"` and `aria-valuenow=undefined` (no fabricated number).
- Width is `w-full` with `animate-pulse` (indeterminate, not 0%).
- `ActiveProgress` shows `<span data-testid="backfill-records">Collecting your data…</span>` not `0/0 orders` or `0%`.
- `percent` is `null` per the contract (`null when estimated_total null` — ADR-BF-4) and is never rendered as a number.

## D-11 (Gross Revenue) Verification

`data-testid="realized-revenue-gross-label"` is present in the DOM with text `"Gross Revenue (ex-fees)"` in both the `no_data` and `has_data` states. The tooltip "Settlement fees not yet applied" is accessible via keyboard (Info button). Provisional block is unchanged and never blended.

## D-15 (Manager Auth) Verification

`useSessionRole()` is called in `BackfillControl`. For `role === 'manager'` or `role === 'analyst'`, the trigger button is not rendered (`canTrigger = false`). The component only shows the read-only progress/status display if a job exists. The server is always the authoritative gate (403); the UI mirrors it for UX honesty.

## data-testids Exposed

| testid | Component | State |
|--------|-----------|-------|
| `backfill-trigger` | BackfillControl | idle (brand_admin) or retry (partial/failed) |
| `backfill-progress` | BackfillControl | active or terminal state |
| `backfill-records` | BackfillControl | running (records count or "Collecting…") |
| `backfill-estimated` | BackfillControl | running (when estimated_total present) |
| `backfill-depth-label` | BackfillControl | completed/partial |
| `backfill-status` | BackfillStatusBadge | any job state |
| `backfill-reconnect-required` | BackfillControl | after RECONNECT_REQUIRED 409 |
| `realized-revenue-gross-label` | RealizedRevenueCard | always (D-11) |

---

## Deviations from Plan

None. All ADRs honored:
- ADR-BF-3/4: routes `/api/v1/connectors/:id/backfill` (POST) + `/api/v1/connectors/:id/jobs` (GET) confirmed in `apps/core/src/main.ts:734,801`.
- ADR-BF-8/11/D-11: "Gross Revenue (ex-fees)" label implemented exactly per plan.
- D-8: estimated_total=null → indeterminate state, never 0%.
- D-15: manager trigger hidden (not disabled) — mirrors server 403.
- Single-Primitive: reuses Button, Skeleton, ErrorCard, Badge, EmptyState, Card family. No new primitive.

## BOUNCE-worthy issues

None identified. All contracts verified against committed Track A/B code:
- Contract types from `@brain/contracts` (A0 freeze) — confirmed exported in `packages/contracts/src/index.ts:254-263`.
- Backend routes confirmed in `apps/core/src/main.ts:734` (POST) and `801` (GET).
- `.data` envelope unwrap pattern matches existing `connectorsApi` pattern in `client.ts`.
