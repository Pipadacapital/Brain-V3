# Stage-8 Deploy Report — feat-access-onboarding-flow

**Agent:** platform-devops  
**Stage:** 8  
**Req ID:** feat-access-onboarding-flow  
**Timestamp:** 2026-06-16T05:00:00Z  

---

## Branch & Commit

| Field | Value |
|---|---|
| Branch | `feat/access-onboarding-flow` |
| Commit SHA | `44fba58` |
| Files committed | 72 |
| Insertions / deletions | +7870 / -297 |

## Remote & PR

| Field | Value |
|---|---|
| Remote | `origin` — https://github.com/Rishabhporwal/Brain-V4.git |
| Push | SUCCEEDED — branch live on origin |
| PR via gh CLI | FAILED — gh CLI unauthenticated |
| Manual PR URL | https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/access-onboarding-flow |
| PR action required | Open manually; **do NOT merge without review** |

## Phase — Dev-Only (Phase 1)

This is a Phase-1 dev-only ship. There is NO production infrastructure.

- No canary configured (no prod target)
- No bake window (no live traffic)
- No auto-rollback against prod (no prod deployment)
- No staging smoke against live systems (no running staging cluster)
- No prod infra/EKS/ArgoCD apply in scope

All of the above are explicitly deferred until Phase 2 (infra graduation trigger fires).

## Gates Passed (prior stages)

| Gate | Result |
|---|---|
| Security Review (r1 + r3) | PASS |
| QA Review (r1 + r3) | PASS |
| Final Review — Opus | PASS / GO |
| Stakeholder gate | APPROVED |
| Deploy VETO (`gate_check.py --to deploy`) | EXIT 0 (PASS) |
| ACs | 11/11 MET |
| Open CRITICAL/HIGH | 0 |
| Bounce rounds | 2 (CRITICAL regression caught and resolved: `SET LOCAL $1` invalid Postgres) |

## 4 LOW Residuals (accepted, tracked — owners responsible for closure)

| # | Finding | Owner | Target |
|---|---|---|---|
| LOW-1 | `COMMIT_WAIT` CSRF hardening deferred — custom header check mitigation in place | Backend Engineer | M2 |
| LOW-2 | OTel trace instrumentation not yet wired on auth routes | Platform/SRE | M2 infra |
| LOW-3 | Integration-selection step persists to DB; downstream connectors not yet implemented | Backend Engineer | Next sprint |
| LOW-4 | E2E smoke covers happy path only; invite-expiry + replay-attack flows are unit-only | QA | M2 |

## Migration Deploy Order (when infra exists)

Run in this strict order to avoid schema/code mismatch:

1. `migrate` — apply all 3 migrations in sequence:
   - `0010_brand_locale.sql` — adds `currency`, `timezone`, `revenue_definition` to `brand`
   - `0011_onboarding_state.sql` — adds `onboarding_status` enum + column to `organization`
   - `0012_session_rotation_lineage.sql` — adds `family_id`, `rotated_at`, `revoked_at` to `session`
2. `core` service restart (picks up new schema)
3. `web` service restart (Next.js — picks up updated API client types)

## Reversibility Recipe

Phase-1 (dev-only) — no prod deployment to roll back.

To undo the commit on the feature branch:
```
git revert 44fba58 --no-edit
git push origin feat/access-onboarding-flow
```

To abandon entirely: close the PR without merging.

If migrations were applied to a dev DB and need reversal:
- `0012`: `DROP TABLE session_lineage; ALTER TABLE session DROP COLUMN family_id, DROP COLUMN rotated_at, DROP COLUMN revoked_at;`
- `0011`: `ALTER TABLE organization DROP COLUMN onboarding_status; DROP TYPE onboarding_status_enum;`
- `0010`: `ALTER TABLE brand DROP COLUMN currency, DROP COLUMN timezone, DROP COLUMN revenue_definition;`

(Always run in reverse order: 0012 → 0011 → 0010.)

## What Shipped (summary)

- Registration → login → 4-step onboarding wizard → dashboard redirect
- Wizard steps: Organization → Brand → Integration-selection → Done
- Brand fields: `currency`, `timezone`, `revenue_definition` (CHECK: `realized|delivered`)
- `onboarding_status` enum drives server-side resume (crash-safe; resumes to exact step)
- Rotating refresh tokens with `SELECT FOR UPDATE`, replay → family-wipe
- `revoke-on-all` on role/member changes (same-txn)
- Rate-limiting on login + BFF session endpoints
- `set-org` 403-on-non-member guard
- `acceptInvite` email-match + verified guard
- Member-route org scoping
- CSRF consolidated
- Live PG test: `family-wipe.live.test.ts`
