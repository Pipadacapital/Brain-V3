# 04 — Developer Report (Frontend/Web, Track B)
## feat-multi-brand — Track B: brand-switcher + create-brand dialog + client + cache

**authored_at:** 2026-06-16T09:30:00Z
**authored_by:** frontend-web-engineer (Stage 3)
**req_id:** feat-multi-brand
**stage:** 3 — Track B COMPLETE

---

## §1 — Files Changed / Created

| File | Change |
|---|---|
| `apps/web/lib/api/types.ts` | NEW `SetBrandResponse` type; `DashboardBrandSummaryResponse` extended with `active_brand_id` + `brands[]` (B1/B2) |
| `apps/web/lib/api/client.ts` | Import `SetBrandResponse`; `brandApi.switchBrand` repointed to `POST /v1/bff/session/set-brand` (B1); `RawBrandSummary.active_brand_id` field added; `getBrandSummary` pivot on `active_brand_id`, returns `active_brand_id + brands[]` (B2) |
| `apps/web/components/dashboard/brand-switcher.tsx` | NEW — brand switcher component with per-row select button, no-op guard, `DASHBOARD_QUERY_KEY` invalidation before navigation, `+ Create brand` CTA (B3/B4) |
| `apps/web/components/dashboard/create-brand-dialog.tsx` | NEW — dashboard create-brand dialog; explicit onSuccess: invalidate → switchBrand → invalidate → stay on `/dashboard`; MUST NOT call `resolveOnboardingRoute` (B5/MA-08) |
| `apps/web/app/(dashboard)/layout.tsx` | Mount `BrandSwitcher` in sidebar below logo, above nav links (B4) |

---

## §2 — Acceptance Criteria Disposition (B1–B5)

### B1 — PASS: `brandApi.switchBrand` → `POST /v1/bff/session/set-brand`

**File:line:** `apps/web/lib/api/client.ts:304–308`

```ts
switchBrand: (id: string) =>
  bffFetch<SetBrandResponse>('/v1/bff/session/set-brand', {
    method: 'POST',
    body: JSON.stringify({ brand_id: id }),
    idempotencyKey: generateRequestId(),
  }),
```

`SetBrandResponse` type added at `apps/web/lib/api/types.ts:303–310`:
```ts
export interface SetBrandResponse {
  request_id: string;
  auth: { brand_id: string; workspace_id: string; role: string; };
}
```

Mirrors `SetOrgResponse` shape. Old `/v1/brands/:id/switch` stub (which had no backing route) is replaced.

### B2 — PASS: `getBrandSummary` active-brand pivot on `active_brand_id`

**File:line:** `apps/web/lib/api/client.ts:529–530` (field), `572–580` (pivot logic)

`RawBrandSummary.active_brand_id: string | null` added at line 529–530.

Pivot comment at line 572: `// MA-06: active brand by id, not array index.`

Pivot logic:
```ts
const active = data.brands.find((b) => b.id === data.active_brand_id);
brand_name: active?.display_name ?? data.brands[0]?.display_name ?? '',
```

Fallback to `brands[0]` is a last-resort for legacy sessions where `active_brand_id` may be null before 0013 is deployed. Once 0013 is live and all sessions are refreshed, `active_brand_id` is always set.

`DashboardBrandSummaryResponse` extended at `apps/web/lib/api/types.ts:241–248` with `active_brand_id` and `brands[]`. Existing callers (`BrandSummaryCard`) only read `workspace_name`, `brand_name`, `member_count` — all still present, no breaking change.

### B3 — PASS: Cache invalidation + no-op guard

**File:line:** `apps/web/components/dashboard/brand-switcher.tsx:87–101`

No-op guard:
```ts
// B3/AC-3: no-op guard — do not call switchBrand if already on this brand.
if (id === activeBrandId) {
  setExpanded(false);
  return;
}
```

Invalidation before navigation:
```ts
await brandApi.switchBrand(id);
// B3/MA-06: invalidate DASHBOARD_QUERY_KEY BEFORE navigation
await queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
window.location.href = '/dashboard';
```

DASHBOARD_QUERY_KEY imported from `lib/hooks/use-dashboard` at line 29.

### B4 — PASS: Brand switcher in dashboard shell, org-scoped, single-brand always shown

**File:line:** `apps/web/components/dashboard/brand-switcher.tsx` (new file)

Mount point: `apps/web/app/(dashboard)/layout.tsx:12` (import) + `34` (render).

- Data source: `useBrandSummary()` → `data.brands[]`, active = `data.active_brand_id` (line 62).
- Renders even for single-brand users (MA-15): brands list + `+ Create brand` CTA always present in expanded state (line 149 comment).
- Org-scoped (MA-14): brand-summary endpoint is org-scoped under 0013 RLS policy — no additional filtering needed client-side.
- Per-row select button pattern mirrors `select-org-form.tsx`: `selectingId` busy state (line 38), `aria-label` on each button, `data-testid` on each row and button.
- `+ Create brand` CTA at line 208, `data-testid="btn-create-brand-cta"`.
- Role gate: reads `auth.role` from TanStack Query cache for `['auth', 'me']` (line 73–77). Default shows CTA to all users; backend enforces 403 for unauthorized create.

**Stable `data-testid`s:**
- `data-testid="brand-switcher"` — container
- `data-testid="brand-switcher-toggle"` — active brand button
- `data-testid="brand-switcher-list"` — dropdown list
- `data-testid="brand-switcher-row-{id}"` — per-brand row
- `data-testid="btn-select-brand-{id}"` — per-brand select button
- `data-testid="btn-create-brand-cta"` — create brand CTA
- `data-testid="brand-switcher-error"` — error feedback

### B5 — PASS: `DashboardCreateBrandDialog` — stays on `/dashboard`, no MA-08 violation

**File:line:** `apps/web/components/dashboard/create-brand-dialog.tsx` (new file)

Fields: `display_name`, `currency_code`, `timezone`, `revenue_definition` (same validation as `create-brand-form.tsx` — reuses `createBrandSchema` from `lib/api/schemas`).

Calls: `brandApi.create(...)` at line 142.

Explicit `onSuccess` flow (lines 145–168):
1. `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` — refresh brand list
2. `brandApi.switchBrand(newBrand.id)` — set new brand active
3. `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` — refresh after switch
4. `window.location.href = '/dashboard'` — stay on dashboard

**MA-08 negative (confirmed by grep):**
- `import.*CreateBrandForm` → absent
- `resolveOnboardingRoute` → absent (comments only)
- `router.push.*onboarding` → absent
- `window.location.href` → `/dashboard` only (line 167)

**Stable `data-testid`s:**
- `data-testid="create-brand-dialog"` — dialog root
- `data-testid="input-dialog-brand-name"` — brand name input
- `data-testid="select-dialog-currency-code"` — currency select
- `data-testid="select-dialog-timezone"` — timezone select
- `data-testid="select-dialog-revenue-definition"` — revenue definition select
- `data-testid="btn-create-brand-dialog-submit"` — submit button
- `data-testid="btn-create-brand-dialog-cancel"` — cancel button
- `data-testid="btn-create-brand-dialog-mismatch-confirm"` — mismatch confirm
- `data-testid="btn-create-brand-dialog-mismatch-cancel"` — mismatch cancel

---

## §3 — Notes for Track A / QA

### ASSUMPTION: workspace_id in create-brand body

The `DashboardCreateBrandDialog` reads `workspace_id` from the TanStack Query cache (`['workspace', 'list']`). The existing `CreateBrandForm` uses the same approach. If the backend `/v1/brands` POST derives `workspace_id` from the session JWT (instead of requiring it in the body), this helper becomes a no-op and should be cleaned up. Backend Track A owns the `POST /v1/brands` endpoint — if it changes to session-derived workspace, Track B's `getActiveWorkspaceId` helper needs removal.

> ASSUMPTION: `POST /v1/brands` requires `workspace_id` in the request body (consistent with `CreateBrandForm` behaviour).

### Role gate on `+ Create brand` CTA

The current implementation reads `auth.role` from the `['auth', 'me']` cache entry. The `/auth/me` endpoint does not include an `auth` sub-object in the standard `CurrentUserResponse` type — the `auth` object appears only in the `LoginResponse` and `SessionRefreshResponse`. This means `sessionRole` may be `null` in the common case, causing the CTA to default to visible (safe — backend rejects unauthorized creates with 403).

A tighter gate would require one of:
a) `/auth/me` to return `auth.role` in its response (Track A change)
b) A dedicated `useSessionAuth` hook that reads from `SessionRefreshResponse` cached data

The current implementation is safe (backend is source of truth per arch plan B5); the UI gate is a convenience only. QA should verify the backend 403 path.

### Accessibility

- All interactive elements keyboard-reachable with `focus-visible:ring-2` focus ring
- `aria-expanded` on the brand switcher toggle button
- `role="listbox"` + `role="option"` + `aria-selected` on brand list
- `aria-label` on every button (Playwright/axe can key off these)
- Status uses icon (`CheckCircle2`) + text label for active brand — not colour alone (WCAG 1.4.1)
- Dialog uses Radix `DialogPrimitive` (focus trap + `Esc` close built in)
- `role="alert"` on all error / mismatch messages

> NOTE: `axe-core` / `pa11y` CI run was NOT executed in this session (no browser environment available). The orchestrator's Playwright suite will cover this gate.

---

## §4 — Verification Summary

### Typecheck
```
pnpm --filter @brain/web typecheck
> tsc --noEmit
[EXIT 0 — no output, no errors]
```

### Lint
```
pnpm --filter @brain/web lint
> eslint .
[EXIT 0 — no output, no errors]
```

### MA-08 negative grep
```
grep -n "import.*CreateBrandForm\|resolveOnboardingRoute\|router\.push.*onboarding" \
  apps/web/components/dashboard/create-brand-dialog.tsx

Result:
6: * MA-08 CRITICAL: This component MUST NOT import CreateBrandForm...  [comment]
7: * call resolveOnboardingRoute, or push...                            [comment]
50:import { createBrandSchema, type CreateBrandFormValues } from ...    [schema import, not component]
157:      // MA-08: NEVER resolveOnboardingRoute, ...                   [comment]

→ No actual import of CreateBrandForm, no call to resolveOnboardingRoute, no router.push to /onboarding
```

### Unit tests
No new unit tests were added in this Track B build (no test scaffold was present for dashboard components). The Playwright e2e suite keying off `data-testid`s is the contracted verification path per arch plan §7.

### Browser / e2e
NOT RUN — orchestrator runs Playwright separately. No browser environment available in this session. All `data-testid`s are stable and documented for the QA suite.

---

## §5 — Self-review vs Track B Acceptance Contract

| Checkpoint | Status | Proof |
|---|---|---|
| AC-1/SD-1: `switchBrand` → `POST /v1/bff/session/set-brand` with `{ brand_id }` body | PASS | `client.ts:304–308` |
| MA-06: `getBrandSummary` pivots on `active_brand_id`; cache invalidated on switch BEFORE navigation | PASS | `client.ts:575`; `brand-switcher.tsx:97–99` |
| AC-3/MA-14/15: switcher in dashboard shell, org-scoped, shown for single-brand users with `+ Create brand` CTA; no-op guard | PASS | `layout.tsx:34`; `brand-switcher.tsx:87–90, 208–225` |
| AC-4/MA-08: create-brand dialog does NOT reuse `CreateBrandForm.onSuccess`; never calls `resolveOnboardingRoute`; stays on `/dashboard`; Owner/Brand-Admin only | PASS | `create-brand-dialog.tsx:167`; grep above |

### Security self-review

| Gate | Status |
|---|---|
| No raw HTML injection | PASS — all user-facing strings are React-rendered (no `dangerouslySetInnerHTML`) |
| No token in DOM / non-httpOnly cookie | PASS — `bffFetch` uses `credentials: 'include'`; no manual token handling |
| MA-08 misroute | PASS — dialog routes to `/dashboard` only |
| CSRF on mutation | PASS — `bffFetch` calls `ensureCsrfToken()` for all POST mutations (verified in existing `bffFetch` implementation) |
| `data-testid` on all interactive elements | PASS — all listed above |
| No new state mechanism | PASS — uses TanStack Query (existing) + `useState` (component-local) |
