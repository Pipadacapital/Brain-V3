# 03 — Architecture Plan (BINDING)
## feat-multi-brand — Create additional brands + active-brand switcher

**req_id:** feat-multi-brand
**authored_at:** 2026-06-16T06:10:00Z
**authored_by:** architect (Stage 2)
**lane:** high_stakes · **trigger_surfaces:** auth, multi_tenancy
**decision:** ADVANCE → Stage 3 (backend-developer + frontend-web-developer, parallel after 0013 deploys)
**paradigm:** Tier-0 deterministic — zero model calls. Brand switch = one indexed DB read (`findByUserAndOrg` 3-arg) + one status read + one JWT sign + one append-only audit row. No statistical/ML/model path is even a candidate. **Cost: 0 tokens/day, $0/mo incremental** (DB + sign are already-paid control-plane ops). Justification: the entire feature is membership lookup → re-sign; any model involvement would be a paradigm violation.

**Canon verification:** No amendment. No new STACK layer, no new ADR, no new infra (confirmed in 02c Part 4). `I-S01` (brand isolation absolute) is *strengthened*, not relaxed: `brand_self_read` is SELECT-only, membership-predicated, AND workspace-GUC-scoped. `I-S06` audit append on every isolation-boundary event (brand.switch). `I-S07` n/a (no money). `I-ST04` idempotency: switch is naturally idempotent (re-mint to same brand = same context); create-brand already idempotent via existing `idempotencyKey`.

---

## §1 — Cost paradigm & over-engineering self-check

| Check | Result |
|---|---|
| Cheapest sufficient effort | Tier-0 deterministic. PASS — no model, no statistical layer, no cache primitive added. |
| Single-Primitive sweep | **CLEAN — extends, creates nothing structural.** Reuses: `mintSessionToken` (the ONE re-mint primitive), `MembershipRepository.findByUserAndOrg` (the ONE membership lookup, 3-arg form), `sessionPreHandler` (the ONE revocation gate), `DbAuditWriter` (the ONE audit log, `I-S06`), `BrandRepository.findById` (the ONE brand read), the `set-org` route as structural template. NO per-brand fork, NO new service, NO new notification/cache/audit primitive. |
| New endpoint justified? | YES — `POST /api/v1/bff/session/set-brand`. Stakeholder SD-1 mandates a distinct route + distinct `brand.switch` audit event. It is NOT a fork of set-org: set-org re-resolves context via `refreshSession`; set-brand MUST bypass that path (MA-01) — different security contract, distinct route is correct. |
| Over-engineering | PASS. No abstraction added beyond one new service method + one route + one migration + the minimal UI. The audit + archived guard live in the service method (DDD), not sprinkled in the route. |
| Reversibility | Migration 0013 is a `CREATE POLICY` (additive, SELECT-only) — reverse = `DROP POLICY brand_self_read ON brand`. Endpoint + UI removable without schema change. No destructive migration (`I-E02` honored). |

---

## §2 — Architectural decision: where the switch logic lives (the load-bearing call)

**Decision:** the brand-switch business logic lives in a **new `AuthService.switchBrandContext()` method** (workspace-access module, `application/auth.service.ts`), NOT inline in the BFF route.

**Why (DDD iron law + Single-Primitive):**
- The route handler must stay THIN (parse body, call use-case, set cookie, map result) — `domain-driven-design` skeleton; business rules in routes are a Single-Primitive violation (can't be reused by a future RPC/job).
- The audit append (`I-S06`, MA-09) needs an `AuditWriter`. `registerBffRoutes(app, authService, pool, cookieSecret, rateLimiter)` does **not** receive `auditWriter` (verified `main.ts:312`). `AuthService` already holds `this.audit`, `this.pool`, `mintSessionToken`, and imports `MembershipRepository` + would import `BrandRepository`. Putting the logic there reuses the existing wiring with **zero new constructor params threaded into the BFF**.
- The membership check, archived guard, direct mint, and audit are ONE atomic security operation — they belong together in one domain method, not split across a route.

**Rejected alternative — inline in `bff.routes.ts` (mirror set-org's structure):** would require threading `auditWriter` into `registerBffRoutes` (new param, touches `main.ts`) AND would place the 3-arg membership rule + archived rule + direct-mint discipline in a route handler — exactly the anti-pattern `domain-driven-design` blocks. Rejected: more surface, weaker boundary, harder to unit-test the security path.

**Rejected alternative — reuse `refreshSession` with a new `preferredBrandId` param:** this is the **MA-01 CRITICAL defect itself**. `refreshSession → resolveActiveContext → findActiveByUser` fallback substitutes the most-recently-created brand for the requested one. Adding a brand param to that chain risks future callers hitting the fallback. Rejected hard: set-brand must call `mintSessionToken` **directly** with a context built from the *verified* membership row — never through the resolve/refresh path.

The BFF route (`POST /api/v1/bff/session/set-brand`) is a thin adapter: validate `auth.workspaceId` non-null + body `brand_id` present → call `authService.switchBrandContext(...)` → set cookie → return the `{ auth: {...} }` shape. All `SEC:` invariants enforced inside the service method.

---

## §3 — The contract (§6 binding — builders implement EXACTLY this)

### 3.1 `POST /api/v1/bff/session/set-brand`

**PreHandler:** `[sessionPreHandler]` — DB revocation check, identical registration to `set-org` at `bff.routes.ts:280-282` (MA-05). CSRF enforced by the app-wide `onRequest` hook (NOT exempt). Comment required:
`// SEC: session revocation DB check required — do NOT use JWT-only verification (MA-05)`

**Request body:**
```jsonc
{ "brand_id": "uuid" }   // brand_id ONLY. NO workspace_id / organization_id in body.
```

**Response 200** (same shape family as set-org, `bff.routes.ts:344-352`):
```jsonc
{
  "request_id": "uuid",
  "auth": { "brand_id": "uuid", "workspace_id": "uuid", "role": "owner|brand_admin|analyst|..." }
}
```
Sets httpOnly cookie `COOKIE_NAME` (secure in prod, sameSite=strict, path=/, maxAge=expiresIn) — copy the set-org cookie block verbatim.

**Error matrix (exact codes — builders must not rename):**
| Condition | HTTP | code |
|---|---|---|
| `auth.workspaceId` is null (no active org in session) | 400 | `MISSING_WORKSPACE` |
| body `brand_id` missing/empty | 400 | `MISSING_BRAND_ID` |
| `pool` unavailable | 503 | `SERVICE_UNAVAILABLE` |
| no brand-level membership row for `(userId, workspaceId, brand_id)` | 403 | `FORBIDDEN` |
| brand resolved but `status === 'archived'` | 400 | `BRAND_ARCHIVED` |

**Service method signature (new, `auth.service.ts`):**
```ts
async switchBrandContext(
  userId: string,
  jti: string,
  fromBrandId: string | null,   // auth.brandId (outgoing), audit only
  workspaceId: string,          // auth.workspaceId from JWT — NEVER body (MA-02)
  requestedBrandId: string,     // body.brand_id
  correlationId: string,
): Promise<{ accessToken: string; expiresIn: number; context: ActiveContext }>
```
Throws `AuthError(code, message, statusCode)` for the 403 / 400 BRAND_ARCHIVED cases (route maps to the matrix above).

### 3.2 Brand-list source (switcher data)

The switcher reads brands from the **existing** `GET /api/v1/dashboard/brand-summary` `data.brands[]` array (already returns `{ id, display_name, domain, status }` per brand the user can see). Under 0013, `brain_app` will see exactly the user's member-brands within the active org. **No new list endpoint** — Single-Primitive: do not add `GET /api/v1/bff/brands`. The active brand is identified by `data.active_brand_id` (new field, §3.3), not array index (MA-06).

> Note: `brandApi.list()` (`client.ts:296`) hits `/v1/brands` — leave it; the switcher uses brand-summary's `brands[]` so the active-brand pivot and the list come from one response (avoids a second round-trip + a second cache key to invalidate).

### 3.3 Dashboard brand-summary — active-brand fields (AC-5)

BFF `data` payload gains `active_brand_id`; existing fields stay:
```jsonc
{
  "org_name": "string|null",
  "active_brand_id": "uuid|null",   // NEW — = auth.brandId
  "brand_count": 0,
  "member_count": 0,                // NOW per-active-brand (MA-06)
  "brands": [ { "id", "display_name", "domain", "status" } ]
}
```
`client.ts:getBrandSummary` resolves the active brand by `data.brands.find(b => b.id === data.active_brand_id)` (NOT `brands[0]`), returns its `display_name` (MA-06).

---

## §4 — Migration 0013 (deploys FIRST: migrate → core → web)

`db/migrations/0013_brand_self_read.sql`. Template = `0009_organization_self_read.sql` (read it verbatim for the header + NN-1 DO-block style). PERMISSIVE, SELECT-only, `TO brain_app`, workspace-GUC-scoped (MA-04).

```sql
-- ============================================================================
-- 0013_brand_self_read.sql — Self-read RLS policy on brand
-- ============================================================================
-- Companion to 0008 (membership) / 0009 (organization). `brand` is RLS-scoped to
-- app.current_brand_id (0004 brand_isolation), so under the production brain_app
-- role a brand-summary / switcher query (SELECT ... FROM brand WHERE organization_id
-- = $1) returns ZERO rows — the active-brand GUC matches only ONE brand. This is a
-- latent prod defect in the existing brand-summary handler, exposed the moment a
-- second brand exists. Dev connects as superuser `brain` (bypasses RLS) and masks it.
--
-- Fix: a PERMISSIVE, SELECT-only policy letting a user read the brands in which they
-- hold a brand-level membership, scoped to the ACTIVE org via the workspace GUC.
-- Writes remain governed solely by brand_isolation (0004). Not a cross-tenant read.
--
-- Fail-closed (NN-1): two-arg current_setting(..., TRUE). Missing/NULL user OR
-- workspace GUC → subquery returns 0 rows → id IN (empty) is false → 0 brands.
--
-- SOFT-DELETE / ARCHIVED REGRESSION NOTE (MA-04b): the subquery predicates on
-- m.brand_id IS NOT NULL only. If `membership` ever gains a soft-delete column
-- (deleted_at / status), a revoked-then-soft-deleted member would re-appear in the
-- brand list. On any such migration you MUST add `AND m.deleted_at IS NULL` (or the
-- status equivalent) here, or removed users silently regain brand visibility.
-- (Archived BRANDS are intentionally still listable — the set-brand handler rejects
--  switching INTO an archived brand at the application layer, MA-10; an archived-brand
--  RLS join would add a cross-table check to a hot policy — avoided by design.)
-- ============================================================================

CREATE POLICY brand_self_read ON brand
  FOR SELECT
  TO brain_app
  USING (
    id IN (
      SELECT m.brand_id
      FROM membership m
      WHERE m.app_user_id = current_setting('app.current_user_id', TRUE)::uuid
        AND m.brand_id IS NOT NULL
        -- Scope to the ACTIVE org only; the workspace GUC is always set by
        -- sessionPreHandler before any protected BFF query runs (MA-04a).
        AND m.organization_id = current_setting('app.current_workspace_id', TRUE)::uuid
    )
  );

-- Negative-control sanity (NN-1): two-arg fail-closed form, BOTH GUCs.
DO $$
DECLARE
  bad_count int;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_policies
  WHERE tablename = 'brand'
    AND policyname = 'brand_self_read'
    AND (
      (qual LIKE '%current_setting(''app.current_user_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%'
        AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%')
      OR
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%'
        AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%')
    );
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'brand_self_read uses one-arg current_setting (not fail-closed) — NN-1 violation';
  END IF;
END $$;
```

**Recursion check:** `brand_self_read` reads `membership`; `membership` policies (0008) do not read `brand` → no policy recursion. `brand_isolation` (0004, FOR ALL) co-exists: PERMISSIVE policies OR together, so a SELECT passes if EITHER the active-brand match OR the self-read membership match holds — correct (the switcher needs the broader self-read; brand-scoped queries still work via brand_isolation).

---

## §5 — Tracks

### TRACK A — `@backend-developer` (set-brand, 0013, brand-summary, fuzz, docs)

> **Sequencing:** A1 (migration) → A2/A3/A4 (endpoint+summary, parallelizable) → A5 (fuzz, after A2 live) → A6 (docs, anytime). Deploy A1 to migrate BEFORE core ships A2.

**A1 — Migration `db/migrations/0013_brand_self_read.sql` (AC-2, MA-04).** 2–5 min.
- Create the file with the exact SQL in §4 (workspace-GUC filter + soft-delete note + NN-1 two-GUC DO-block). Template: `db/migrations/0009_organization_self_read.sql`.
- Acceptance: `node-pg-migrate up` applies clean; the DO-block does NOT raise; `psql` as a NOBYPASSRLS role with both GUCs set lists only member-brands-in-org; with workspace GUC unset → 0 rows.

**A2 — `AuthService.switchBrandContext()` (AC-1, MA-01/02/03/09/10/11/12).** New method in `apps/core/src/modules/workspace-access/internal/application/auth.service.ts` (after `refreshSession`, ~line 609). 2–5 min each sub-step:
- A2.1 Add `BrandRepository` to the existing repositories import (`auth.service.ts:31-38`).
- A2.2 Build the membership-check ctx **without brandId** (MA-11):
  `const ctx = { correlationId, userId, workspaceId };` + comment:
  `// MA-11: NO brandId in ctx — setting app.current_brand_id before authorizing the target brand would bleed into the pooled connection (mirror set-org ctx at bff.routes.ts:313)`
- A2.3 `const row = await memberRepo.findByUserAndOrg(userId, workspaceId, requestedBrandId, ctx);` — **3-arg, non-null third arg** (MA-01/MA-03). `if (!row) throw new AuthError('FORBIDDEN', 'Not a member of the requested brand.', 403);`
  Comment: `// SEC MA-02: workspaceId comes from the JWT (caller passes auth.workspaceId), NEVER the request body — prevents cross-org membership spoofing`
- A2.4 Archived guard (MA-10): with a **brand-scoped** ctx (`{ correlationId, workspaceId, brandId: requestedBrandId }` — now authorized), read `const brand = await brandRepo.findById(requestedBrandId, brandCtx);` `if (!brand) throw 403 FORBIDDEN; if (brand.status === 'archived') throw new AuthError('BRAND_ARCHIVED', 'Cannot switch to an archived brand.', 400);`
  Comment: `// MA-10: app-layer archived guard (NOT in RLS — a cross-table status join in a hot policy is a perf risk)`
  Comment: `// MA-12: this read must target the primary Postgres node — a create-then-switch on a read replica could 403 under replica lag. M1 is single-node; mandatory revisit before any read replica.`
- A2.5 Build context from THE BRAND ROW (MA-03): `const context: ActiveContext = { brandId: row.brandId, workspaceId: row.organizationId, role: row.roleCode, onboardingStatus: null };`
  Comment: `// MA-03: role comes from the BRAND-LEVEL membership row (row.roleCode) — NEVER the org-level (null-brand) row, or an org-owner is minted into a brand-analyst session.`
- A2.6 `const accessToken = this.mintSessionToken(userId, jti, context);` — **direct mint, reusing jti** (MA-01, preserves revocation). Comment: `// MA-01 CRITICAL: mintSessionToken DIRECTLY. NEVER refreshSession/resolveActiveContext — their findActiveByUser fallback substitutes the wrong brand.`
- A2.7 Audit (MA-09) — mirror `auth.service.ts:195` append shape:
  ```ts
  await this.audit.append({
    brand_id: requestedBrandId,           // context col = NEW brand (effect)
    actor_id: userId,
    actor_role: row.roleCode,
    action: 'brand.switch',
    entity_type: 'brand',
    entity_id: requestedBrandId,
    payload: { from_brand_id: fromBrandId, to_brand_id: requestedBrandId, workspace_id: workspaceId, role_granted: row.roleCode },
    idempotency_key: randomUUID(),
  });
  ```
  Comment: `// MA-09: audit written after a successful membership+archived check. If mintSessionToken throws after this append, the audit row stands (append-only, I-S06) — acceptable, matches existing pattern.`
- A2.8 `return { accessToken, expiresIn: ACCESS_TOKEN_EXPIRY_SECS, context };`

**A3 — `POST /api/v1/bff/session/set-brand` route (AC-1).** New handler in `bff.routes.ts` immediately after the set-org handler (~line 354). 2–5 min:
- Register `{ preHandler: [sessionPreHandler] }` (MA-05) with the `// SEC: session revocation DB check required` comment.
- `const auth = (request as AuthenticatedRequest).auth;` `const body = request.body as { brand_id?: string };`
- `if (!auth.workspaceId) return reply.code(400).send({ request_id, error: { code: 'MISSING_WORKSPACE', ... } });` (MA-02) + comment `// SEC: workspaceId must come from JWT, not body`.
- `if (!body?.brand_id) → 400 MISSING_BRAND_ID;` `if (!pool) → 503 SERVICE_UNAVAILABLE;`
- `try { const result = await authService.switchBrandContext(auth.userId, auth.jti, auth.brandId, auth.workspaceId, body.brand_id, correlationId); }` — set cookie (copy set-org block at `bff.routes.ts:335-341`), return `{ request_id, auth: { brand_id: result.context.brandId, workspace_id: result.context.workspaceId, role: result.context.role } }`.
- `catch (err) { if (err instanceof AuthError) return reply.code(err.statusCode).send({ request_id, error: { code: err.code, message: err.message } }); throw err; }`
- Import `AuthError` from auth.service (already exported, `auth.service.ts:30` referenced).

**A4 — brand-summary active-brand filter (AC-5, SD-2, MA-06).** `bff.routes.ts:506-543`. 2–5 min:
- Pass `auth.brandId` into the brand query: add `AND id = $2` and param `[auth.workspaceId, auth.brandId]` (so it returns the active brand row; `brands[]` still drives the switcher list — keep the existing 20-row org query for the list, but add a SEPARATE single active-brand lookup OR include `active_brand_id` and let the client pivot). **Binding choice:** keep `brands[]` as the org-member-brand list (needed by the switcher), ADD `active_brand_id: auth.brandId` to the response, and make `member_count` brand-scoped.
- Member count → brand-scoped (MA-06): `SELECT COUNT(DISTINCT app_user_id)::text AS count FROM membership WHERE organization_id = $1 AND brand_id = $2` with `[auth.workspaceId, auth.brandId]`. Comment: `// MA-06/SD-2: member count is per-active-brand, not org-level`.
- Add `active_brand_id: auth.brandId` to the `data` object.
- Guard: if `auth.brandId` is null (onboarded org, no active brand), keep `member_count: 0` and `active_brand_id: null` — honest empty, do not 500.

**A5 — Isolation-fuzz brand-switch test (AC-7).** Add a case to `tools/isolation-fuzz/src/pg.test.ts` (follow its NOSUPERUSER `isofuzz_app` + `buildSetGucSql` pattern, lines 1-60). 2–5 min:
- Seed brand A + brand B (both with a `brand_self_read`-eligible membership for the same test user, same org). Under `isofuzz_app`: SET the GUCs to brand B's context (user GUC + workspace GUC + `app.current_brand_id = B`). Assert a `SELECT * FROM brand WHERE id = '<A>'` AND a `SELECT * FROM connector_instance WHERE brand_id = '<A>'` return **0 rows** (brand B session cannot read brand A). Positive control: same session reads brand B rows > 0.
- Assert: do NOT `.skip()`. Comment ties to AC-7.

**A6 — Docs (AC-6, MA-07, MA-13).** 2–5 min, comments only:
- `brand.service.ts:170` (the `list()` guard) — add the MA-07 M1-invariant comment verbatim from 02c (every brand-member holds an org-level membership row; brand-invite post-M1 must create an org-level row or update this guard).
- `auth.service.ts` near `findActiveByUser` usage / the new method — add the MA-13 note: fresh login auto-resolves most-recently-created brand membership; switch via set-brand; "remember last active brand" deferred.

**TRACK A acceptance contract (REQUIRED pass-1 — every persona must-fix folded in):**
- [ ] MA-01: set-brand path calls `mintSessionToken` directly; `refreshSession`/`resolveActiveContext`/`findActiveByUser` NOT referenced in `switchBrandContext`.
- [ ] MA-02: `workspaceId` sourced from `auth.workspaceId`; null → 400 MISSING_WORKSPACE before any DB call; `brand_id` is the ONLY body field read.
- [ ] MA-03: `context.role = row.roleCode` from the 3-arg (non-null brand) membership row.
- [ ] MA-04: 0013 has workspace-GUC filter + soft-delete note + NN-1 two-GUC DO-block; migrates clean.
- [ ] MA-05: route uses `sessionPreHandler`; SEC comment present.
- [ ] MA-06: brand-summary filters member count by `auth.brandId`; `active_brand_id` in payload.
- [ ] MA-07: M1-invariant comment at `brand.service.ts:170`.
- [ ] MA-09: `brand.switch` audit with `from_brand_id`/`to_brand_id`/`workspace_id`/`role_granted`.
- [ ] MA-10: archived brand → 400 BRAND_ARCHIVED.
- [ ] MA-11: membership-check ctx has NO brandId; archived read uses a separate brand-scoped ctx post-auth.
- [ ] MA-12: primary-node comment on the membership/archived read.
- [ ] MA-13: findActiveByUser doc note.
- [ ] AC-7: brand-switch isolation-fuzz case present, not skipped, passes under `isofuzz_app`.

### TRACK B — `@frontend-web-developer` (switcher, create-brand dialog, client + cache)

> Starts once A3 (endpoint) is live on a deploy env; B1/B2 can be drafted against the §3 contract in parallel.

**B1 — `brandApi.switchBrand` repoint + `setBrand` client (AC-1, SD-1).** `apps/web/lib/api/client.ts:301`. 2–5 min:
- Replace the body of `switchBrand(id)` to call the new endpoint:
  ```ts
  switchBrand: (id: string) =>
    bffFetch<SetBrandResponse>('/v1/bff/session/set-brand', {
      method: 'POST', body: JSON.stringify({ brand_id: id }), idempotencyKey: generateRequestId(),
    }),
  ```
- Add `SetBrandResponse` type (`{ request_id, auth: { brand_id, workspace_id, role } }`) — mirror `SetOrgResponse`. Remove/leave the old `/v1/brands/:id/switch` reference (it had no backing route; this is the correct target now).

**B2 — `getBrandSummary` active-brand pivot (AC-5, MA-06).** `client.ts:563-571`. 2–5 min:
- Add `active_brand_id: string | null` to `RawBrandSummary` (`client.ts:523-528`).
- Resolve: `const active = data.brands.find(b => b.id === data.active_brand_id); brand_name: active?.display_name ?? data.brands[0]?.display_name ?? ''` (prefer active; array-index only as last-resort fallback). Comment: `// MA-06: active brand by id, not array index`.

**B3 — Cache invalidation on switch (AC-3, AC-5, MA-06).** Wherever `switchBrand` succeeds (the switcher handler, B4). 2–5 min:
- After `brandApi.switchBrand(id)` resolves: `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` (import `DASHBOARD_QUERY_KEY` from `lib/hooks/use-dashboard.ts`) **before** any soft-navigation, then reload/redirect into the new brand context. Comment ties to MA-06 (staleTime=60s would otherwise show the prior brand for up to 60s).
- No-op guard (AC-3): if the selected id === current active brand id, do NOT call switchBrand.

**B4 — Brand switcher UI in dashboard shell (AC-3, MA-14/15).** New `apps/web/components/dashboard/brand-switcher.tsx`, mounted in `apps/web/app/(dashboard)/layout.tsx`. 2–5 min:
- Pattern: reuse `select-org-form.tsx` interaction model (list rows, per-row select button, `selectingId` busy state, `aria-label`, `data-testid`). Data source: `useBrandSummary()` → `data.brands[]`; active = `data.active_brand_id`.
- Always render the switcher even for single-brand users (MA-15), with the active brand shown + a "+ Create brand" CTA (Owner/Brand-Admin only — gate on `auth.role` from session; backend is source of truth).
- Selecting a non-active brand → B3 flow. Scope: brands within current org only (MA-14 — brand-summary is already org-scoped under 0013).

**B5 — `DashboardCreateBrandDialog` (AC-4, MA-08).** New `apps/web/components/dashboard/create-brand-dialog.tsx`. 2–5 min:
- Fields: `display_name`, `currency_code`, `timezone`, `revenue_definition` (same validation as `create-brand-form.tsx`). Call `brandApi.create(...)`.
- **MUST NOT** import `CreateBrandForm` / its `onSuccess` (which calls `resolveOnboardingRoute` → misroutes a 2nd brand, MA-08). Explicit `onSuccess`:
  `queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY })` → optionally `await brandApi.switchBrand(newBrand.id)` (then B3 invalidation) → **stay on `/dashboard`**. NEVER `resolveOnboardingRoute`, NEVER `router.push('/onboarding/*')`.
- Visibility: Owner/Brand-Admin only.

**TRACK B acceptance contract (REQUIRED pass-1):**
- [ ] AC-1/SD-1: `brandApi.switchBrand` → `POST /v1/bff/session/set-brand` with `{ brand_id }` body.
- [ ] MA-06: `getBrandSummary` pivots on `active_brand_id`; dashboard cache invalidated on every successful switch BEFORE navigation.
- [ ] AC-3/MA-14/15: switcher in dashboard shell, org-scoped, shown for single-brand users with "+ Create brand" CTA; no-op guard when selecting the active brand.
- [ ] AC-4/MA-08: create-brand dialog does NOT reuse `CreateBrandForm.onSuccess`; never calls `resolveOnboardingRoute`; stays on `/dashboard`; Owner/Brand-Admin only.

---

## §6 — Deploy pipeline track (service change → mandatory, same slice)

This slice changes the `core` service (new route + service method + migration) and `web`. Per `STACK.md` ADR-010 (GitHub Actions → ECR → Helm → ArgoCD → EKS; **canary/percentage-rollout is Phase-4-deferred — NOT built**, so the gate here is health-probe auto-rollback, not canary; inventing canary would violate STACK).

**Ordered deploy (migrate → core → web) — MA-12 / hard dependency of the brand list:**
1. **migrate:** apply `0013_brand_self_read.sql` via `node-pg-migrate up` (the `migrate` job/Argo Workflow). MUST land before core ships — the brand-summary + switcher return 0 brands under `brain_app` without it. Affected-only: migration job runs because `db/migrations/**` changed.
2. **core:** affected-only build (Turbo/Nx detects `apps/core` change) → ECR image (digest-pinned) → ArgoCD syncs the `core` Helm release → **K8s health-probe + ArgoCD auto-rollback** on readiness failure. Per-service deploy app (`deployments/core`), not deploy-all.
3. **web:** affected-only build (`apps/web` change) → image → ArgoCD `web` release → health-probe auto-rollback.

Rollback: `DROP POLICY brand_self_read ON brand` (additive policy, safe) + ArgoCD rollback to prior `core`/`web` revision. No data migration to reverse (`I-E02` honored — no destructive op).

---

## §7 — Observability & test strategy

- **Audit (`I-S06`):** every switch emits `brand.switch` (from/to/workspace/role_granted) — the brand-timeline reconstruction source. Verified by an integration test asserting one append per successful switch.
- **Real-network smoke (high_stakes mandatory):** an integration test against a live `brain_app`-role Postgres (docker-compose `--profile core`) that: registers a 2-brand user → calls `set-brand` to brand B → asserts the returned JWT carries `brand_id = B`, `role = brand-B-row role` → calls brand-summary → asserts `active_brand_id = B` and brand-B member count. This is the end-to-end proof MA-01/03/06 hold on the wire, not just in unit mocks.
- **Isolation-fuzz (A5, `I-S01`):** post-switch cross-brand read returns 0 rows under NOSUPERUSER role (AC-7).
- **Negative-path tests:** archived brand → 400 BRAND_ARCHIVED; non-member brand → 403; null workspace → 400; revoked session (sessionPreHandler) → 401.
- **Tenant-isolation at every layer:** RLS (0013 + brand_isolation), GUC-in-ctx discipline (MA-11), audit brand_id, JWT brand_id re-mint — each independently asserted.

---

## §8 — Alternatives considered & rejected

1. **Reuse `refreshSession(preferredBrandId)`** — REJECTED: this IS the MA-01 context-substitution defect (findActiveByUser fallback). Direct mint is mandatory. (§2)
2. **Inline switch logic in the BFF route** — REJECTED: business rules in a route handler (DDD violation) + forces threading `auditWriter` into `registerBffRoutes`. Service method is smaller net surface. (§2)
3. **New `GET /api/v1/bff/brands` list endpoint** — REJECTED: brand-summary already returns the member-brand list under 0013; a second endpoint = second cache key + extra round-trip (Single-Primitive). (§3.2)
4. **Archived-brand guard inside the RLS policy** — REJECTED: a cross-table status join in a hot SELECT policy is a perf risk; app-layer guard (MA-10) is correct. (§4)
5. **Hard-reload-only for cache freshness** — REJECTED: fragile; explicit `invalidateQueries` before navigation is required (MA-06). (B3)

---

## §9 — Handoff depth note

Per `role-empowerment-model`, this is high_stakes/auth+multi_tenancy → **deep handoff**: every SEC-critical step has an exact comment string, file:line anchor, and the §3 contract is binding (no builder reinterpretation of the security path). The UI track gets pattern references (select-org-form) + the contract, with normal latitude on presentation.
