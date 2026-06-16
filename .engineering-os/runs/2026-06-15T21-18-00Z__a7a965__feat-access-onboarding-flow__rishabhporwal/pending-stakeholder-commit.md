# Pending Stakeholder Commit — `feat-access-onboarding-flow`

**Final review:** PASS / GO (Stage 6, independent re-run). Awaiting Stakeholder gate (Stage 7) approval to commit.

Mechanical commit command — **explicit product-code paths only** (no `git add -A`; `.engineering-os/` run-state is intentionally excluded). The deleted ghost route is included as a staged deletion.

```sh
git add \
  apps/core/package.json \
  apps/core/src/main.ts \
  apps/core/src/modules/frontend-api/internal/bff.routes.ts \
  apps/core/src/modules/workspace-access/internal/application/auth.service.ts \
  apps/core/src/modules/workspace-access/internal/application/brand.service.ts \
  apps/core/src/modules/workspace-access/internal/application/invite.service.ts \
  apps/core/src/modules/workspace-access/internal/application/workspace.service.ts \
  apps/core/src/modules/workspace-access/internal/domain/auth/entities.ts \
  apps/core/src/modules/workspace-access/internal/domain/brand/entities.ts \
  apps/core/src/modules/workspace-access/internal/domain/organization/entities.ts \
  apps/core/src/modules/workspace-access/internal/infrastructure/rate-limiter.ts \
  apps/core/src/modules/workspace-access/internal/infrastructure/repositories.ts \
  apps/core/src/modules/workspace-access/internal/interfaces/rest/auth.routes.ts \
  apps/core/src/modules/workspace-access/internal/interfaces/rest/brand.routes.ts \
  apps/core/src/modules/workspace-access/internal/interfaces/rest/member.routes.ts \
  apps/core/src/modules/workspace-access/tests/critical-paths.test.ts \
  apps/core/src/modules/workspace-access/tests/family-wipe.live.test.ts \
  "apps/web/app/(onboarding)/brand/new/page.tsx" \
  "apps/web/app/(onboarding)/invite/page.tsx" \
  "apps/web/app/(onboarding)/layout.tsx" \
  "apps/web/app/(onboarding)/onboarding/done/page.tsx" \
  "apps/web/app/(onboarding)/onboarding/integrations/page.tsx" \
  "apps/web/app/(onboarding)/select-org/page.tsx" \
  "apps/web/app/(onboarding)/workspace/new/page.tsx" \
  apps/web/components/auth/login-form.tsx \
  apps/web/components/auth/register-form.tsx \
  apps/web/components/members/accept-invite-view.tsx \
  apps/web/components/onboarding/create-brand-form.tsx \
  apps/web/components/onboarding/onboarding-done-step.tsx \
  apps/web/components/onboarding/onboarding-integrations-step.tsx \
  apps/web/components/onboarding/select-org-form.tsx \
  apps/web/e2e/smoke.spec.ts \
  apps/web/lib/api/client.ts \
  apps/web/lib/api/schemas.ts \
  apps/web/lib/api/types.ts \
  apps/web/middleware.ts \
  apps/web/vitest.config.ts \
  db/migrations/0010_brand_locale.sql \
  db/migrations/0011_onboarding_state.sql \
  db/migrations/0012_session_rotation_lineage.sql \
  packages/contracts/src/api/brand.api.v1.ts

git commit -m "feat(access): rotating refresh tokens, revoke-on-all, 4-step onboarding wizard, multi-org set-org, rate limiting

- AC-1 rotating refresh tokens + /auth/token/refresh (FOR UPDATE rotation, replay family-wipe → 401 SESSION_REVOKED, set_config GUC under brain_app)
- AC-2 revoke-on-all (removeMember/updateMemberRole/suspend/scope=all) in-txn
- AC-3 rate limiting (login/bff-session/forgot/register/refresh, fail-open, single-count)
- AC-4 brand currency_code/timezone/revenue_definition (CHECK excludes placed)
- AC-5/AC-9 onboarding_status enum replaces needs_onboarding; resume routing; CSRF consolidated
- AC-6 4-step wizard (currency/timezone/revenue, Step 3 integrations + Skip, ghost /invite removed)
- AC-7 acceptInvite email-match/verified guards; AC-8 set-org membership-verified + member-route org scoping
- migrations 0010-0012 (additive, rollback-documented)"
```

**Deploy order (BINDING, MA-08):** `pnpm migrate up (0010→0011→0012)` → deploy `core` → deploy `web`. Migration `down` is window-gated (before any non-default brand value / any org advanced past `pending`).

**Pre-commit note:** the Stakeholder also has uncommitted `.engineering-os/` run-state + journals in the working tree; those are OS bookkeeping and are NOT part of this product commit.
</content>
