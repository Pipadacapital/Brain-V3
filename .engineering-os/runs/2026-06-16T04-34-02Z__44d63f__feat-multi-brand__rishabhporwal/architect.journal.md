# Architect Journal — feat-multi-brand

## 2026-06-16T06:10:00Z — Architect — feat-multi-brand
**Stage:** 2 · **Paradigm:** Tier-0 deterministic (membership read + JWT sign + audit row; zero model calls — model would be a paradigm violation) · **Tracks:** backend-developer, frontend-web-developer
**Single-Primitive:** clean — extends mintSessionToken / findByUserAndOrg(3-arg) / sessionPreHandler / DbAuditWriter / BrandRepository; created nothing structural (one new AuthService method, one route, one migration, minimal UI). Rejected a 2nd brand-list endpoint.

**Load-bearing decision:** switch logic → new `AuthService.switchBrandContext()` (DDD: route stays thin; the BFF doesn't receive auditWriter — verified main.ts:312; the service already holds this.audit/this.pool/mintSessionToken). Rejected inline-in-route (DDD violation + threads auditWriter into registerBffRoutes) and rejected refreshSession-with-brand-param (that IS the MA-01 findActiveByUser substitution defect).

**Closed:** CRITICAL 2/2 (MA-01 direct mint, MA-02 workspaceId-from-JWT) · HIGH 6/6 (MA-03 brand-row role, MA-04 0013 workspace-GUC+soft-delete+NN-1, MA-05 sessionPreHandler, MA-06 brand-summary filter+cache, MA-07 M1-invariant doc, MA-08 create-brand routing) · MED 4/4 (MA-09 audit from/to, MA-10 archived 400, MA-11 ctx no brandId, MA-12 primary-node note) · LOW 3/3 (MA-13/14/15 as notes).

**Key facts grepped:** findByUserAndOrg sig = (userId, orgId, brandId, ctx) repositories.ts:800; mintSessionToken auth.service.ts:545 (reuses jti, preserves revocation); refreshSession→resolveActiveContext→findActiveByUser fallback auth.service.ts:560-572 (the defect to avoid); brand.status CHECK active|archived 0004:22; brand.service.create already enforces owner|brand_admin + creates brand-level owner row (brand.service.ts:68-96) — AC-4 authority confirmed; brandApi.switchBrand currently points at /v1/brands/:id/switch which has NO backing BFF route → repoint to set-brand; brand-summary member count is org-level today (bff.routes.ts:524) → make brand-scoped; client.ts:568 uses brands[0] → pivot on active_brand_id. Migrations via node-pg-migrate in db/migrations (next=0013). Deploy = GH Actions→ECR→Helm→ArgoCD→EKS, canary Phase-4-deferred so gate = health-probe auto-rollback (not canary).

**Deploy order:** migrate(0013) → core → web. 0013 is a hard dependency of the brand list under brain_app (fixes the latent zero-rows defect).

**Next:** backend-developer + frontend-web-developer — Stage 3 (parallel after 0013 deploys + set-brand live).

---

## 2026-06-16T07:45:00Z — Backend Engineer — feat-multi-brand
**Stage:** 3 · **Service:** core + db · **Verification:** typecheck PASS / isolation-fuzz 48 passed / curl all-pass
**Self-review vs gates:** PASS (MA-01 through MA-13, AC-7 all covered) · **Next:** READY-FOR-SECURITY

### Track A — Implemented
- A1: `db/migrations/0013_brand_self_read.sql` — workspace-GUC-scoped SELECT-only PERMISSIVE policy on brand for brain_app; soft-delete regression note; NN-1 two-GUC DO-block. Applied to dev DB. Proven under SET ROLE brain_app.
- A2: `AuthService.switchBrandContext()` — 3-arg membership check (NO brandId in ctx, MA-11); archived guard with brand-scoped ctx; mintSessionToken directly (MA-01 CRITICAL); brand.switch audit (MA-09); role from brand-level row (MA-03).
- A3: `POST /api/v1/bff/session/set-brand` — sessionPreHandler (MA-05); workspaceId from JWT only (MA-02); null workspaceId → 400 before DB call; AuthError mapping.
- A4: brand-summary `active_brand_id` + brand-scoped `member_count` (MA-06).
- A5: isolation-fuzz AC-7 describe block in `tools/isolation-fuzz/src/pg.test.ts` — seeds real brands + memberships; proves connector_instance cross-brand = 0 under NOBYPASSRLS isofuzz_brand_app role.
- A6: M1 invariant comment at `BrandService.list()` (MA-07); MA-13 doc in `switchBrandContext()` JSDoc.

### Pre-existing issue noted
`critical-paths.test.ts:143` `expect(expiresIn).toBe(900)` vs actual 3600 — pre-existing since `fix/token-1h-expiry-logout` commit. Not caused by Track A. Confirmed by git stash proof.

### Contract for frontend (Track B)
Pointer: `04-developer-report-backend.md §3` — set-brand shape, brand-list source (brand-summary `brands[]` + `active_brand_id`), active-brand fields.
