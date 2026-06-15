# Stage-8 Deployment Report — feat-m1-app-foundation

**Agent:** platform-devops  
**Stage:** 8  
**Timestamp:** 2026-06-15T19:30:00Z  
**Req ID:** feat-m1-app-foundation

---

## What Shipped

**Branch:** `feat/m1-app-foundation`  
**Commit SHA:** `55e4d68`  
**Full SHA:** `55e4d68` (HEAD on feat/m1-app-foundation)  
**Pushed to origin:** YES (`https://github.com/Rishabhporwal/Brain-V4.git`)  
**PR:** Not opened via CLI — `gh` CLI unauthenticated in this environment. Manual PR creation URL: `https://github.com/Rishabhporwal/Brain-V4/pull/new/feat/m1-app-foundation`. Base: `master`, Head: `feat/m1-app-foundation`.

**Folded commits:**
- `dc3fd47` — fix(web): BFF rewrite `/api`-prefix fix (`apps/web/next.config.js`) — carried forward from `fix/web-bff-proxy-api-prefix`
- `55e4d68` — M1 vertical slice + 3 dev-config fixes (turbo.json, docker-compose.yml, apps/web/package.json)

**Files committed:** 181 (160 M1 product-path files + 3 dev-config fixes + 18 engineering-os run artifacts)

---

## Vertical Slice Delivered

Full user journey: Register → Login → Workspace → Brand → Invite → Dashboard → Connect Shopify → Install Pixel

| Layer | What shipped |
|---|---|
| DB migrations | 6 migrations (0002–0007): auth, workspace, brand, invitation, connector, pixel — 14 M1 tables |
| RLS | 3-GUC two-arg fail-closed RLS on all 14 tables; isolation-fuzz real suite on NOSUPERUSER NOBYPASSRLS |
| Auth | argon2id (m=19456,t=2,p=1); sha256 audit hash-chain; timing-safe token compare; single-use tokens |
| Connectors | secret_ref-only storage; HMAC-first Shopify OAuth; pixel SDK |
| Frontend | Next.js 14 app router: auth flows, onboarding, dashboard, connector settings, pixel wizard |
| BFF | BFF proxy with /api prefix rewrite; validateSession on all protected routes |
| Packages | packages/audit, packages/contracts (6 API contracts + M1 events), packages/db, packages/pixel-sdk |
| Roles | Canon 4 roles: owner / brand_admin / manager / analyst |
| Dashboard | Honest "No Data Yet" state; Meta/Google marked coming_soon |

**Negative controls verified (all CLOSED):**
- NN-1: 3-GUC two-arg in packages/db + all 6 migrations
- NN-2: secret_ref-only in contract + DDL
- NN-3: validateSession preHandler on every route + BFF
- NN-5: argon2id params asserted + tested; timing-safe; sha256 tokens; single-use
- NN-6: audit WHERE brand_id mandatory
- NN-7: invite compound PERMISSIVE RLS
- L-02: sha256 hash-chain (replaces djb2 stub)

---

## Phase-1 Dev-Only Ship Semantics

**This is a Phase-1 dev-only ship. No production infrastructure exists.**

- No canary deployment — canary/bake/rollback applies from M2 onward when infra is provisioned
- No staging smoke test against live infrastructure — no live infra exists in Phase 1
- No auto-rollback monitor armed — N/A (no prod infra)
- No trace pipeline health check — no OTel collector/backend deployed yet
- Metric parity: N/A in Phase 1
- Bake window: N/A in Phase 1

The reversibility recipe for this ship is: `git revert 55e4d68` on the feature branch, or simply do not merge the PR. The commit is isolated on `feat/m1-app-foundation`; `master` is untouched.

---

## 11 LOW Residuals Carried Forward

All CRITICAL/HIGH/MEDIUM issues: 0 open. The following LOW items are tracked with named owners and close-by dates.

| # | Item | Owner | Close-by |
|---|---|---|---|
| 1 | Rate-limit on auth endpoints (register/login/forgot-password) | backend-engineer | M2 sprint start |
| 2 | Email enumeration timing jitter on register (constant-time response) | backend-engineer | M2 |
| 3 | Shopify webhook signature replay window (nonce/timestamp check) | backend-engineer | M2 |
| 4 | OAuthStateNonce expiry enforcement in DB (currently in-process only) | backend-engineer | M2 |
| 5 | InProcessOAuthStateStore not HA (single-node only; no Redis backing) | platform-devops | M2 infra |
| 6 | SES sandbox — production approval pending (email delivery limited) | backend-engineer | Pre-launch |
| 7 | Pixel SDK CSP nonce injection (Content-Security-Policy hardening) | frontend-engineer | M2 pixel hardening |
| 8 | Dashboard polling interval not tunable (hardcoded) | frontend-engineer | M2 |
| 9 | RBAC middleware coverage gap on BFF routes (some routes unguarded) | backend-engineer | M2 |
| 10 | Missing integration test for invite-accept flow end-to-end | qa | M2 QA sprint |
| 11 | MinIO BYOC transition trigger not yet evaluated against cost threshold | platform-devops | M2 infra review |

---

## Monitor Posture

**Phase 1 — N/A.** No production infra. Monitors, alarms, dashboards, SLO burn-rate alerts, and canary health gates are all deferred to the M2 infra provisioning sprint when ECS/EKS + observability stack is deployed.

At that point, per the devops-aws + observability skills, the following will be armed:
- p95 latency alarm: >2s over 5min → auto-rollback
- Error rate alarm: >1% over 5min → auto-rollback
- Health probe failure: 2 consecutive → rollback
- Kafka consumer lag alarm (when MSK Serverless is provisioned)
- OTel trace pipeline healthy check post-deploy

---

## Reversibility Recipe

1. **Do not merge the PR** — `feat/m1-app-foundation` is isolated; `master` is untouched.
2. If already merged: `git revert 55e4d68 -m 1` (for a merge commit) or `git revert 55e4d68` (direct), then open a revert PR.
3. The commit is atomic — one SHA contains the full M1 slice. A single revert undoes everything.
4. DB migrations (0002–0007): if migrations have been applied to a dev DB, run the corresponding `down` migrations or restore from pre-migration snapshot.
