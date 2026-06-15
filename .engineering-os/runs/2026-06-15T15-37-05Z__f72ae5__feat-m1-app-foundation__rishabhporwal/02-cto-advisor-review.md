# Engineering Advisor — Stage 1 Intake Review

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 1 — Intake |
| **Reviewer** | Engineering Advisor (cto-advisor, Sonnet tier) |
| **Reviewed at** | 2026-06-15T15:55:00Z |
| **Decision** | ADVANCE |
| **Lane** | high_stakes |

---

## 1. Dependency Pre-flight

Linked prior run: `chore-platform-foundations-sprint0` — shipped (commit sha `5331641`, Stage 8 complete, `2026-06-15T14:16:30Z`). No open CRITICAL/HIGH obligations in that run's residuals that block M1 start.

One tech-debt obligation from Sprint-0 is a **M1 gate** (not a blocker on beginning the build, but a gate before the first production audit write):

| Residual | ID | Owner | Must close by |
|---|---|---|---|
| `packages/audit` sha256 hash (djb2 stub) | L-02-audit-sha256 | Security Reviewer | Before first production audit write under any live tenant — i.e., before M1 goes live |

**Action for the Architect:** encode L-02-audit-sha256 as an explicit pre-launch gate in the M1 acceptance criteria, not a follow-up. The Architect must confirm with the Security Reviewer that sha256 is live and the hourly S3 Object Lock checkpoint job is deployed before any M1 demo writes to the audit log under a real tenant session.

**Pre-flight: CLEAR.** No blocking dependency is unshipped. M1 may begin.

---

## 2. Lane Validation — Surfaces

The orchestrator's deterministic scan returned `[auth, connectors, multi_tenancy, schema_proto]`. The requirement itself flags `system_of_record_audit` and `secrets_auth_iam` as additions. I validate all six and add one more below.

| Surface | Scan / Req | My validation | Basis |
|---|---|---|---|
| `auth` | flagged | CONFIRMED — this is the primary surface. App-native email/password/JWT/session vs. Authentik-backed is the key tension (see §5). Every auth-surface item in TRIGGER-SURFACES.md fires: JWT mint/validate path, revocation denylist, the 4 permission templates in JWT claims + RLS + MCP scopes, the httpOnly-cookie exchange, token lifetime. | TRIGGER-SURFACES.md §Authentication/authorization |
| `connectors` | flagged | CONFIRMED — Shopify OAuth flow (`connector_instances`, `connector_sync_status`, `connector_cursors`) is in scope. `connector_instance.secret_ref` → Secrets Manager (I-S09). `connector.connected` / `connector.sync_started` events must publish to Redpanda. The connector SDK, idempotent upsert, and cursor-based sync are in scope. | TRIGGER-SURFACES.md §Multi-tenancy + INVARIANTS.md I-S09 |
| `multi_tenancy` | flagged | CONFIRMED — every M1 table carries `brand_id`; RLS two-arg fail-closed (NN-1 from Sprint-0 is the binding form); isolation negative-tests are a P0 gate per INVARIANTS.md I-S01. The Sprint-0 RLS framework is the substrate; M1 migrations 001–006 must use the same pattern. | TRIGGER-SURFACES.md §Multi-tenancy; Sprint-0 NN-1 |
| `schema_proto` | flagged (as schema + contracts) | CONFIRMED — `packages/contracts` Zod as source of truth for all M1 APIs + events (I-E01). The 9 events + all API request/response shapes must have Zod schemas committed in contracts before any implementation begins. Migrations 001–006 are schema changes gated by TRIGGER-SURFACES.md §Schema changes. | INVARIANTS.md I-E01; TRIGGER-SURFACES.md §Schema changes |
| `system_of_record_audit` | added by req | CONFIRMED AND ADDED — every auth action (register, login, logout, password reset, email verify) + every consequential workspace/brand/invite/connector/pixel action must write to the hash-chained audit log. This is the first production audit-log use (Sprint-0 only scaffolded it). L-02-audit-sha256 must be closed before M1 goes live. | INVARIANTS.md I-S06; THE-MOAT.md; lessons-learned.md L-02 |
| `secrets_auth_iam` | added by req | CONFIRMED AND ADDED — Shopify OAuth tokens must live in Secrets Manager (`connector_instance.secret_ref`); email provider credentials (for verification/reset emails) must also be in Secrets Manager; JWT signing key must be KMS-backed or Secrets Manager — never in env vars or code. | INVARIANTS.md I-S09; STACK.md ADR-007 |
| `outbound_side_effects` | NOT in scan | ADDED — M1 sends transactional emails (verify email, password reset invite email, invitation acceptance). These must pass through the `notification` module's single outbound chokepoint (ADR-012, INVARIANTS.md I-ST05). Even though M1 email is transactional (not marketing), the chokepoint must be the only egress door from day one. A direct SMTP send bypassing `notification` is a hard invariant violation. | INVARIANTS.md I-ST05; TRIGGER-SURFACES.md §Outbound side-effects |

**Final trigger surfaces (validated + added):**
`[auth, connectors, multi_tenancy, schema_proto, system_of_record_audit, secrets_auth_iam, outbound_side_effects]`

**Lane confirmed: high_stakes.** Seven surfaces. The scan's call is correct; I added one surface (`outbound_side_effects`) not caught by the scan.

---

## 3. Sharpened Requirement Fields

### Problem statement (sharpened)
Sprint-0 shipped the executable platform substrate (RLS framework, CI gates, contracts pipeline, data-platform scaffold, IaC). There is no usable application — no user can register, no workspace exists, no data connection can be made. M1 must deliver the first end-to-end user journey on the frozen architecture: account → workspace → brand → team → Shopify connection → Brain Pixel → dashboard shell. Without this, the design partner (Sugandh Lok) cannot onboard, and there is nothing to demonstrate that the data spine works at a real product level.

### Target user (confirmed and scoped)
Primary: the brand operator (design-partner persona, Owner role) completing first-time onboarding. Secondary: invited team members (Admin/Analyst/Viewer). Developer-facing surfaces (migrations, APIs, events, modules) are the build substrate, not a separate product surface.

### Success metric (binary, confirmed)
A new user completes the full chain `Register → Login → Create Workspace → Create Brand → Invite Team → Connect Shopify → Install Pixel → Reach Dashboard` with every action: (a) persisted to Postgres with RLS; (b) emitting its audit-log entry; (c) emitting its domain event to Redpanda; (d) reflected in actual connection/sync status on the frontend. All six named demos must be demoable. Zero mocked backend behavior; zero fake data.

### Constraints (confirmed and sharpened)
- Architecture frozen: modular monolith + 4 deployables; 13 locked ADRs; no new services/DBs/ledgers/platforms. All M1 code lands in `apps/core/src/modules/` (workspace-access, connector, notification) and `apps/web`.
- Vertical-slice DB: ONLY the 6 migration groups (001–006). No reach into full doc-08 schema (metrics, attribution, billing, decision-log, Customer-360, identity-graph). This is the app shell + connector foundation, not the data spine.
- Auth scope: email + password + JWT/session ONLY. No SSO/OAuth/social/magic-link for user auth. Shopify OAuth is in scope as connector auth (separate, correct).
- RBAC scope: exactly Owner/Admin/Analyst/Viewer. No custom roles, groups, teams, or enterprise IAM.
- No simulation: "No Data Yet" honest empty states only. Connection/sync status reflects actual backend state.
- Multi-tenant by construction: `brand_id` on every row/key/log/event. RLS two-arg fail-closed (NN-1). Isolation negative-tests are a P0 gate.
- Security by default: bcrypt/argon2 password hashing; JWT signing key in Secrets Manager; connector OAuth token stored by `secret_ref` only; audit logging on all auth + consequential actions.
- Transactional emails (verify, reset, invite) via `notification` module only — no direct SMTP bypassing the chokepoint.
- L-02-audit-sha256: sha256 hash must replace the djb2 stub before the first production audit write.

### Non-goals (confirmed)
- No analytics/metrics/charts/decision engine/attribution/billing/Customer-360.
- No Meta/Google connectors (disabled "Coming Soon" stubs only).
- No enterprise IAM (SSO, SCIM, groups/teams, advanced RBAC).
- No GCC/multi-region launch.
- No realized-revenue-ledger, attribution-credit-ledger, metric registry, or any doc-08 Gold/Silver tables (these are the M1-data-spine slice, a separate parallel M1 requirement, not this one).
- No Brain Pixel production SDK with CNAME routing (pixel installation wizard shows instructions + verify endpoint; the production pixel SDK is a separate deliverable).

---

## 4. "Make It Less Dumb" Pass

### What can be deleted or simplified?

**Finding F1 — The requirement is correctly scoped; it must NOT be further split into separate requirements.**
The 9 flows are tightly coupled by data dependencies: you cannot demo Workspace without Auth; you cannot demo Brand without Workspace; you cannot demo Invite without Brand; you cannot demo Dashboard without all prior flows persisted. Splitting them into separate requirements would create a dependency chain of blocked requirements and slow the design-partner onboarding. The correct decomposition is **parallel build tracks within one requirement** (see §7). Do not split.

**Finding F2 — Remove "execution plan" deliverable from the Architect's plan scope.**
The requirement asks for "Epic → Feature → Story → Task → Subtask" with owner/dependencies/estimate/AC per task. This is a project-management artifact. The engineering OS already produces the architecture plan (Stage 2), developer reports (Stages 3), QA (Stage 5), and deployment (Stage 8). The Architect should produce the build-track decomposition (what to build in what order, with what dependencies) but should NOT produce a full JIRA-style task breakdown — that is over-specification that will be stale by the time the builder runs. The Architect produces the plan; the orchestrator runs the builders. **Defer the "execution plan" framing to a post-Architect project management step; the Architect's plan is the build contract.**

**Finding F3 — Brain Pixel installation wizard is instructions + verify endpoint, not a pixel SDK build.**
The requirement correctly scopes pixel as "installation wizard — instructions, verify, status." The production `brain.js` SDK with CNAME routing and first-party cookie handling is a separate M1 deliverable in the data spine track (not this requirement). The M1-app-foundation pixel scope is: (a) a `pixel_installations` table + `pixel_status` table; (b) a verify endpoint that confirms the pixel tag is present on the brand's domain (a simple HTTP HEAD check is sufficient); (c) a status page showing `Connected / Syncing / Waiting For Data / Error` from actual backend state. This is correct and does not need simplification; confirm it is not confused with building the pixel SDK itself.

**Finding F4 — Dashboard shell must NOT include any analytics computation path.**
The "Dashboard shell" deliverable is: Brand Summary (workspace/brand name, member count — from Postgres), Connection Status (from `connector_sync_status` — from Postgres), Data Status (from `pixel_status` — from Postgres), Onboarding Progress (completion steps — deterministic from Postgres state). None of these require the Analytics API, StarRocks, or the metric engine. They are pure Postgres reads. The Architect must explicitly bind the dashboard data sources to Postgres control-plane tables ONLY — not to the Analytics API or any OLAP layer. Any attempt to wire the dashboard to StarRocks in M1 is a scope violation.

**Finding F5 — Meta/Google "Coming Soon" connectors are UI stubs, not backend stubs.**
The connector list shows Meta/Google as disabled "Coming Soon." These should be purely frontend UI stubs (a disabled button with a tooltip) — no backend routes, no database rows, no event emissions for Meta/Google. Any backend code for Meta/Google in M1 is scope creep.

**Finding F6 — Invitation flow: confirm the email delivery path.**
User invitations require sending an email (the invitation link). This is the first real outbound email in the product. It must go through the `notification` module. The requirement does not explicitly name the email provider — confirm the email provider (AWS SES or similar) is configured in Secrets Manager before the builder implements the invitation flow. This is a pre-build dependency the Architect must call out explicitly.

### What is non-negotiable and stays?
- RLS + isolation negative-tests (P0 gate, I-S01).
- Audit logging on auth + consequential actions (I-S06, L-02-audit-sha256 closure gate).
- Contract-first: Zod schemas in `packages/contracts` before implementation (I-E01).
- Migrations 001–006 in the exact sequence specified, reversible, idempotent.
- Shopify OAuth via Secrets Manager `secret_ref` pattern (I-S09).
- JWT/session via the `workspace-access` module, not in app code (TRIGGER-SURFACES.md §Auth).
- All transactional emails via `notification` module (I-ST05).

---

## 5. The Authentik-vs-App-Auth Ruling (Decision for the Architect)

**This is the central tension of this requirement.** It must be called out explicitly and decided before any builder touches auth code.

### The tension
The Canon (STACK.md ADR-006) binds `Authentik (self-hosted on EKS)` as the IdentityAdapter — OIDC/SAML, MFA, JWT mint, revocation denylist. The Sprint-0 intake review ruled Authentik operational deployment deferred to "M1 Day 1." The M1-app-foundation requirement asks for email/password/verify/forgot/reset/JWT/session — with the explicit note: "The Architect must resolve whether M1 auth is Authentik-backed or an app-native control-plane auth."

### Option A: Authentik-backed from M1 Day 1
Authentik handles: user registration (via Authentik's API or its own UI embedded via OIDC flow), email verification, password reset, JWT mint (Authentik issues tokens), session management, revocation denylist. Brain's `workspace-access` module calls Authentik for auth operations; Postgres stores workspace/brand/member/invite data only.

**Pros:**
- Aligned with the long-term Canon (ADR-006 is a locked decision).
- MFA, OIDC, SAML seams built in from day one.
- No auth logic to migrate later.

**Cons:**
- Authentik on EKS is not yet deployed (Sprint-0 scoped it as "Helm chart + namespace declaration only, not operational"). It must be deployed and operational before any auth feature can be built or tested.
- Authentik's self-hosted setup has non-trivial operational complexity: EKS deployment, Helm values, SMTP configuration for email delivery, bootstrap admin flow, OIDC client configuration per environment (dev/staging/prod).
- Authentik's API for programmatic user creation/management (used for registration + email verification flows) requires careful mapping to Brain's domain model. This adds an integration layer the builder must own.
- Developer iteration speed for auth flows is slower (local dev requires a running Authentik instance or Docker Compose service).
- Sprint-0 Docker Compose already has an Authentik service stub — but it was not exercised or validated.
- Risk: if Authentik setup has issues (EKS ingress, cert-manager, SMTP relay, bootstrap), it blocks ALL auth work and therefore ALL M1 flows. Single-point-of-failure on the critical path.

**Option B: App-native control-plane auth in `workspace-access` now; Authentik fronting later**
Brain's `workspace-access` module owns user registration, email/password hashing (bcrypt/argon2), JWT mint/validate (using a KMS-backed signing key or a Secrets Manager-stored signing secret), session management (short-lived access JWT + rotating refresh in `user_sessions` table), revocation denylist (checked via `user_sessions.revoked_at`), password reset token (hashed in `password_resets` table), and email verification token (in `email_verifications` table). Authentik is deployed in parallel but not on the auth critical path for M1.

**Pros:**
- No external dependency on Authentik operational readiness. Auth flows can be built and tested immediately using Postgres + Secrets Manager (which Sprint-0 already set up).
- Full control over the auth flow UX and domain model — no impedance mismatch between Authentik's user model and Brain's `brand_id`-scoped tenant model.
- Faster iteration: local dev uses Docker Compose Postgres + a static JWT signing secret; no Authentik service required to run the app.
- The M1 auth tables (users, user_sessions, password_resets, email_verifications) are exactly the tables the requirement specifies — and they map cleanly to the `workspace-access` module that already owns this domain in HLD.md.
- Authentik can be deployed in parallel (as a Phase-2 extraction seam) and front the app-native auth via OIDC at that point, with zero user disruption (Brain issues OIDC tokens from day one, Authentik just becomes the IdP that issues them).

**Cons:**
- Defers the locked ADR-006 IdentityAdapter binding. Auth is "in app code" longer than the Canon intends.
- Must ensure the JWT format, claims structure, and revocation denylist are compatible with what Authentik would issue later (so migration is transparent).
- Must not introduce auth patterns that would require a breaking user-facing migration when Authentik fronts it.

### The Engineering Advisor's Ruling

**Recommendation: Option B — app-native control-plane auth in `workspace-access` for M1.**

**Reasoning (canonical, not preference):**

1. **Sprint-0 reality:** Authentik is not operationally deployed. The Sprint-0 Architect plan scoped it as Helm chart + namespace declaration only. Making Authentik the M1 auth dependency adds an unplanned blocking infrastructure task to the M1 critical path.

2. **Authentik's Phase-1 role per STACK.md:** ADR-006 binds Authentik as the IdentityAdapter for "OIDC/SAML, MFA day one." M1's auth scope explicitly excludes SSO, SAML, and MFA (these are enterprise-phase features, per the non-goals). The Authentik binding's unique value (OIDC/SAML/MFA) is not needed in M1. Using Authentik for email/password-only in M1 adds operational cost with no functional gain over app-native auth.

3. **Modular monolith model:** HLD.md is explicit — "Phase 2: extract Identity to its own gRPC service." The `workspace-access` module already owns orgs/brands/users/roles/sessions/invites in the 13-module decomposition. Auth logic belongs in this module. Moving it to Authentik now is premature extraction — the opposite of the "simplicity-first" principle (I-E05).

4. **Migration path exists:** If the `workspace-access` module issues JWT claims using the same shape that Authentik would issue (sub = user UUID, brand_id claim, role claim, standard iat/exp/jti), then fronting with Authentik later is a token-issuer swap, not a schema migration. The revocation denylist in `user_sessions` can be queried regardless of who minted the token. This is a clean seam.

5. **Authentik on EKS is not a zero-cost operational choice:** It requires cert-manager, an ingress, SMTP relay config, bootstrap admin credentials in Secrets Manager, and at least one EKS pod running at all times. For a design-partner phase with one tenant, this is operational overhead that adds cost and failure modes without user-visible benefit.

**Decision for the Architect:** Implement auth as app-native in `workspace-access` for M1. The `users` table, JWT signing via Secrets Manager-stored key (rotatable), bcrypt/argon2 password hashing, `user_sessions` table (access JWT + refresh), `password_resets` table, `email_verifications` table are the canonical tables. The revocation denylist is a query against `user_sessions.revoked_at`. JWT claims MUST use the same claim names that ADR-006 specifies (so Authentik can front it transparently later). Deploy Authentik on EKS in parallel as an M1 operational task (it must be ready before MFA or SSO is needed), but do NOT put it on the auth critical path.

**Does this need the Stakeholder?** No. This ruling is resolvable from the Canon. ADR-006 binds Authentik as the IdentityAdapter but does not specify "Authentik must handle email/password registration in M1 specifically." The Sprint-0 outcome (Authentik not operationally deployed) and the M1 non-goals (no MFA, no SSO, no SAML) make app-native auth the correct M1 implementation without violating the ADR. The ADR is honored as a Phase-2 extraction target. If the Stakeholder wants to override this (i.e., insists on Authentik-backed from M1 Day 1), an `/escalate` is warranted — but the Engineering Advisor's reading is that this does not require escalation.

---

## 6. Vertical-Slice DB Discipline — Confirmation

### M1 table set vs. the requirement

The requirement specifies 6 migration groups:

| Migration | Domain | Tables |
|---|---|---|
| 001 | Auth | `users`, `user_sessions`, `password_resets`, `email_verifications` |
| 002 | Workspace | `workspaces`, `workspace_members` |
| 003 | Brand | `brands`, `brand_members` |
| 004 | Invitation | `invitations` |
| 005 | Connector Foundation | `connector_instances`, `connector_sync_status`, `connector_cursors` |
| 006 | Pixel Foundation | `pixel_installations`, `pixel_status` |

**Vertical-slice check — what is NOT in M1 (must not drift in):**

The following doc-08 tables are explicitly NOT M1 scope. The Architect must include an explicit statement in the plan that any PR adding these tables to M1 migrations is a scope-violation blocker:

- `realized_revenue_ledger`, `attribution_credit_ledger` (Gold — M1-data-spine, not this requirement)
- `metric_registry`, `metric_definition`, `metric_dependency`, `metric_audit` (measurement module)
- `identity_link`, `brain_id_alias`, `contact_pii`, `pii_vault_reference` (identity module — async writer, M2+)
- `gmv_meter_snapshot`, `invoice`, `invoice_line`, `entitlement` (billing module)
- `decision_log`, `ai_provenance`, `recommendation_outcome` (AI/recommendation modules)
- `consent_record`, `consent_tombstone` (notification module — M2+ when outbound marketing begins)
- `silver.*`, `gold.*` tables (StarRocks — not Postgres at all)
- `audit_action` companion event table beyond what the audit log already provides

**What M1 audit additions look like:** The `audit_log` table (already scaffolded in Sprint-0 migration #0001) gets entries written for M1 actions. No new audit table is needed — the existing hash-chained audit log is the SoR. The requirement's phrase "Audit (M1 additions)" means writing audit entries for M1 events, not adding new audit tables.

### Relationship to M1-data-spine (the complementary M1 requirement)
This requirement is the **App Shell + Connection Foundation** slice of M1. The complementary **M1-data-spine** requirement (a separate future pipeline run) covers: realized-revenue-ledger, Bronze Iceberg table builds, Silver/Gold dbt materializations, metric engine, Analytics API first endpoints. Both are M1 but distinct vertical slices that can be built in parallel. The Architect and Delivery Coordinator must ensure no cross-dependency is introduced between the two slices (the app-foundation slice must not depend on any OLAP table; the data-spine slice must not depend on M1 app tables beyond `connector_instances` / `connector_cursors` for the Shopify sync consumer).

### M1-database-and-migration-plan.md
The task references `docs/plans/M1-database-and-migration-plan.md` but this file does not exist (confirmed: `find` returns only `db/migrations/0001_init.sql`). The Architect must author this plan as a Stage 2 deliverable. The table set above is the correct starting scope; the Architect fills in column lists, types, constraints, FKs, indexes, unique constraints, RLS policies, and migration DDL per table.

---

## 7. Recommended Build Tracks — Decomposition and Sequencing

M1-app-foundation is one requirement but must be built in parallel tracks with explicit sequencing to avoid builders blocking on each other. The Architect validates and owns the binding plan; these are the recommended tracks.

### Track 0 — Contracts + Events (SEQUENCE-FIRST, blocks all other tracks)
**Owner agent:** `backend-developer`
**Estimated effort:** 1–2 days; must land before any other track begins implementation.
**Contents:**
- Zod contracts in `packages/contracts` for ALL M1 APIs (Auth, Workspace, Brand, User, Connector, Pixel) — request/response shapes, error envelopes.
- Event schemas in `packages/events` for ALL 9+ M1 events: `user.registered`, `user.logged_in`, `workspace.created`, `brand.created`, `user.invited`, `connector.connected`, `connector.sync_started`, `pixel.installed`, `pixel.verified`.
- Codegen artifacts (types, OpenAPI, Avro stubs for events).
- `buf-breaking` gate must pass for all event schemas.
- `packages/contracts` CODEOWNERS enforcement.
**Why first:** I-E01 (contract-first is an INVARIANT — no code may be written for a behavior until its Zod contract exists). Builders in Tracks 1–3 are blocked on this.

### Track 1 — Backend Control Plane (auth/workspace/brand/invite/RBAC + migrations 001–004)
**Owner agent:** `backend-developer`
**Depends on:** Track 0 (contracts).
**Contents:**
- Migrations 001 (Auth), 002 (Workspace), 003 (Brand), 004 (Invitation) — with RLS (NN-1 two-arg form), FKs, indexes, unique constraints, audit-log triggers or explicit audit writes.
- L-02-audit-sha256 closure: sha256 hash function in `packages/audit`, hourly S3 Object Lock checkpoint job.
- `workspace-access` module: user registration service (bcrypt/argon2 hashing), email verification service (token generation + `email_verifications` table), login/logout service (JWT mint with KMS-backed signing key, `user_sessions` write), forgot/reset service (`password_resets` table), RBAC enforcement middleware.
- JWT shape: claims `{ sub, brand_id, workspace_id, role, iat, exp, jti }` — ADR-006-compatible for future Authentik fronting.
- Revocation denylist: query `user_sessions` on every protected action (the "denylist checked on every protected action" per TRIGGER-SURFACES.md §Auth — this is a Postgres lookup, not Redis, at M1 scale).
- `notification` module wiring for transactional emails: verify-email, password-reset, invitation email — all via the notification chokepoint (I-ST05). AWS SES credentials in Secrets Manager.
- Workspace CRUD services + workspace-member services.
- Brand CRUD services + brand-member services.
- Invitation CRUD services (create, accept, expire).
- All Fastify/tRPC routes for the Auth, Workspace, Brand, User API groups.
- Idempotency: every mutating endpoint requires `Idempotency-Key` (I-ST04).
- Audit-log entries for: register, login, logout, password_reset_requested, password_reset_completed, email_verified, workspace_created, brand_created, user_invited, user_role_changed, user_removed.
- Isolation negative-tests for migrations 001–004 (cross-brand queries return 0 rows).

**Shared-file note:** `packages/db` migrations must be merged in numeric order. Track 1 owns migrations 001–004; Track 2 owns 005–006. Track 1 migrations must land first (Track 2 depends on `workspaces` and `brands` FKs). The builder must not apply migrations out of order.

### Track 2 — Connector + Pixel Foundation (migrations 005–006 + Shopify flow + pixel verify)
**Owner agent:** `backend-developer` (or `data-engineer` for the sync cursor / event emission logic)
**Depends on:** Track 0 (contracts), Track 1 (migrations 001–004 landed, `brands` FK available).
**Contents:**
- Migrations 005 (Connector: `connector_instances`, `connector_sync_status`, `connector_cursors`) and 006 (Pixel: `pixel_installations`, `pixel_status`) — RLS (NN-1 form), all FKs, indexes.
- `connector` module: connector list endpoint (returns available connectors with status); Shopify OAuth flow (redirect to Shopify install URL → callback → store `secret_ref` in Secrets Manager → write `connector_instances` row); connection health/status endpoint; disconnect endpoint. Meta/Google = UI-stub only (no backend).
- Shopify OAuth token: store as `connector_instance.secret_ref` → Secrets Manager key. Never store plaintext token in DB. I-S09.
- Connector events: `connector.connected`, `connector.sync_started` published to Redpanda on the correct topic (`{env}.connector.connected.v1`).
- `pixel_installations` write on install + `pixel_status` write on verify.
- Pixel verify endpoint: HTTP HEAD/GET check against the brand's domain for the Brain pixel tag (no production pixel SDK required in M1 — the wizard shows embed instructions and verifies presence via a simple endpoint check).
- Pixel events: `pixel.installed`, `pixel.verified` published to Redpanda.
- `connector_cursors` idempotent upsert pattern (I-ST04 — cursor-based sync is idempotent on the cursor).
- Isolation negative-tests for migrations 005–006.

### Track 3 — Frontend (Next.js 9 flows + dashboard shell + API integration)
**Owner agent:** `frontend-web-developer`
**Depends on:** Track 0 (contracts — types generated from Zod schemas). Can begin against OpenAPI-generated TypeScript types immediately; does not need backend running.
**Contents:**
- Route and page structure: `/auth/register`, `/auth/verify-email`, `/auth/login`, `/auth/forgot-password`, `/auth/reset-password`, `/onboarding/workspace`, `/onboarding/brand`, `/onboarding/invite`, `/dashboard`, `/settings/connectors`, `/settings/connectors/shopify`, `/settings/pixel`.
- Component hierarchy: AuthLayout, OnboardingLayout, DashboardLayout; per-route form components (React Hook Form + Zod validation from contracts); TanStack Query hooks for all API calls via the `frontend-api` BFF.
- State management: TanStack Query for server state; no client-side global store for auth state (httpOnly cookie → BFF → short token exchange per the `frontend-api` pattern per HLD.md).
- httpOnly cookie pattern: the BFF (`frontend-api` module) handles the cookie → short token exchange. The browser never holds a long-lived token.
- Dashboard shell: Brand Summary (workspace name, brand name, member count — Postgres reads); Connection Status (from `connector_sync_status`); Data Status (from `pixel_status`); Onboarding Progress (step completion from Postgres state). All honest — "No Data Yet" when no data exists. No charts, no metrics, no OLAP queries.
- Shopify connect flow: redirect to Shopify install → callback → update connector status → show "Connected" state.
- Pixel wizard: embed code display (copy-paste instructions) + verify button (calls pixel verify endpoint) + status display.
- Invitation accept flow: token-based URL → accept endpoint → redirect to login or onboarding.
- "Coming Soon" stubs: Meta and Google connector cards — disabled button, tooltip, no backend call.
- Accessibility: Shadcn UI components; no custom ARIA hacks needed if Shadcn defaults are honored.
- No ECharts usage in M1 (no metrics/analytics — defer to M1-data-spine dashboard).

**Shared-file note:** the `frontend-api` BFF module in `apps/core` owns the httpOnly-cookie ↔ short-token exchange. The frontend-web-developer and backend-developer must coordinate on the BFF interface (covered by Track 0 contracts).

---

## 8. Key Challenge Findings

### C1 — Audit sha256 debt (L-02) is a blocking pre-launch gate, not a follow-up
The Sprint-0 Stakeholder waiver approved deferring sha256 to M1 "before the first production audit write." M1's first auth action (any user registration or login) writes to the audit log under a live tenant. If L-02 is not closed before M1 goes live — even for a design-partner demo — the audit log contains non-cryptographic hash rows that violate I-S06. This is not a future concern; it is a launch gate. The Architect must make sha256 implementation + hourly S3 checkpoint job an M1 pre-launch acceptance criterion with Security Reviewer sign-off. **Do not allow M1 demos under a live tenant until L-02 is closed.**

### C2 — StarRocks row policy residual from Sprint-0
Sprint-0's isolation-fuzz left StarRocks row policies as "pending" (the OSS allin1 container does not support `CREATE ROW POLICY`; the test skips with `ctx.skip()`). M1 introduces real Shopify connector data flowing through the pipeline. By the time M1's Shopify connector emits `connector.connected` and sync begins, StarRocks row policies must be active on the managed StarRocks cluster. The Architect must include StarRocks row policy provisioning as an explicit M1 deliverable in Track 2, and the isolation-fuzz must move from `skip` to `PASS` before M1 is marked shipped.

### C3 — The `notification` module is a dependency, not a detail
M1 has three outbound email triggers: email verification, password reset, user invitation. All three must pass through `notification` (I-ST05). The `notification` module must be minimally functional for M1: a `send_log` table, an email channel adapter (AWS SES), and the consent gate (transactional emails are consent-exempt in India under TCCCPR but must still pass through the chokepoint). The Architect must scope the minimal `notification` module for M1 — not the full Phase-1 notification stack (which includes WhatsApp, DLT, consent categories for marketing), but at minimum: transactional email path via SES. This is a shared dependency between Tracks 1 and 3 (Track 1 triggers emails; Track 3 shows status).

### C4 — The `frontend-api` BFF module is a shared dependency
The `frontend-api` BFF (httpOnly-cookie ↔ short-token exchange + CSRF + view-model fan-out) is referenced in HLD.md as a distinct module. For M1, this module must: (a) exchange the httpOnly cookie for a short-lived access token on every protected frontend request; (b) assert `X-Brand-Id` non-null before any query (TRIGGER-SURFACES.md §Multi-tenancy); (c) forward correlation IDs. The Architect must scope the M1 `frontend-api` module explicitly — it is not "just proxy routing." The backend-developer who builds the auth APIs and the frontend-web-developer who builds the pages both depend on this module's interface.

### C5 — Connector OAuth requires a public callback URL in development
Shopify OAuth requires a publicly accessible callback URL for the install flow. In local development, this means using a tunnel (ngrok or similar) or a dev environment with a public URL. The Architect must note this as a dev-environment constraint: Shopify connector testing cannot be done purely locally without an accessible callback URL. Staging environment must be up (with a real domain and SSL) before Shopify OAuth can be tested end-to-end.

### C6 — Scope risk: 9 flows + 6 migrations + all APIs + events + frontend + tests is a large M1
The requirement is correctly scoped (it is the minimum viable app shell) but it is the largest single requirement in the pipeline so far. The parallel build tracks mitigate the timeline risk. The key sequencing constraint is: Track 0 (contracts) must land in day 1–2; Track 1 (auth migrations + backend) and Track 3 (frontend) can then run in parallel for the first sprint; Track 2 (connector + pixel) can begin once Track 1's brand tables are migrated. The Architect must produce an explicit sequencing diagram and identify the critical path: Track 0 → Track 1 migration landing → Track 2 start; Track 0 → Track 3 start. Total expected build time: 2–3 weeks with parallel tracks.

---

## 9. Domain Check Against Product Canon

| Canon anchor | Check | Finding |
|---|---|---|
| I-S01 Brand isolation | Every M1 table must have RLS (NN-1 two-arg form); brand_id on every row; isolation-fuzz covers all 4 layers. | REQUIRED — Architect must explicitly require NN-1 in migration DDL for all 6 migration groups. |
| I-S06 Audit log | Auth actions + consequential workspace/brand/invite/connector/pixel actions must write audit entries. L-02 sha256 must close before first production write. | REQUIRED — L-02 closure is a pre-launch gate, not a follow-up. |
| I-S09 Secrets | Shopify OAuth token as `secret_ref` only; JWT signing key in Secrets Manager; email provider credentials in Secrets Manager. No plaintext in DB. | REQUIRED — connector_instance must use the `secret_ref` pattern from day one. |
| I-E01 Contract-first | Track 0 delivers ALL contracts before Track 1/2/3 begin implementation. | REQUIRED — enforced by track sequencing. |
| I-E05 Simplicity-first | No new deployables, DBs, or services. All M1 code lands in `apps/core/modules/` + `apps/web`. | CONFIRMED — requirement is correctly scoped. |
| I-ST04 Idempotency | Every mutating API requires `Idempotency-Key` (24h cache). Connector cursors idempotent on cursor write. | REQUIRED — Architect must include idempotency-key pattern in all mutation API contracts. |
| I-ST05 One outbound chokepoint | Verify-email, password-reset, invitation emails MUST go through `notification` module. | REQUIRED — no direct SES calls from workspace-access module. |
| THE-MOAT | M1-app-foundation does not touch the moat components (no revenue ledger, no attribution, no Decision Log, no billing meter, no parity oracle). | CONFIRMED — scope is clean. No moat risk. |
| COMPLIANCE | Email/password auth is not a DPDP concern at M1 (transactional, no marketing). Connector OAuth: Shopify credentials in per-brand Secrets Manager key (I-S09 + per-brand KMS path). | CONFIRMED — no compliance escalation needed for M1-app-foundation. |
| Money | No money operations in M1-app-foundation. Money-lint gate (float-money columns) from Sprint-0 remains active and will catch any accidental money column. | CONFIRMED — no money concern. |
| Cost-routing | No model calls in M1-app-foundation. All auth/workspace/brand/invite/connector/pixel operations are deterministic (Tier 1). | CONFIRMED — no cost-routing concern. |

---

## 10. Stress-Test Personas

Two personas are required for high_stakes lane. Each must surface at minimum one concrete concern.

### Persona 1 — "The Tenant Isolation + Auth Hardness Skeptic" (`:sonnet`)
**Angle:** This persona carries forward the isolation-hardness pressure from Sprint-0's Persona 2 but now focuses on the M1-specific auth and tenancy surfaces. They challenge: (a) whether the app-native auth ruling creates a JWT/session isolation gap (can a user's session bleed across brands/workspaces in the `user_sessions` table?); (b) whether the `workspace_members` and `brand_members` tables have RLS policies that correctly scope to `brand_id` AND `workspace_id` (a user in Workspace A must not see any data from Workspace B, even if they exist in the `users` table); (c) whether the invitation token flow is resistant to timing attacks and token enumeration; (d) whether the Shopify OAuth callback correctly validates the HMAC signature before writing the `connector_instances` row (a malicious callback without HMAC validation is an injection vector); (e) whether the connector `secret_ref` pattern is enforced at the Zod contract level (a contract that allows `oauth_token` as a string field is a schema-level I-S09 violation); (f) whether the `revocation_denylist` check (the `user_sessions.revoked_at` query) is performed on every protected route — including the BFF fan-out routes — not just on login.

**Required to surface:** at minimum one concrete gap in the isolation or auth hardening that the builder must address before M1 goes live, with the specific INVARIANT at risk.

### Persona 2 — "The Scope and Over-Build Skeptic" (`:sonnet`)
**Angle:** This persona pressure-tests whether M1-app-foundation is building only what the design partner needs to onboard, and nothing more. They challenge: (a) whether the dashboard shell is pulling any OLAP data (even a single StarRocks query in the dashboard shell is a scope violation and an unreachable code path in M1 since no data has flowed yet); (b) whether the connector module is building a generic connector SDK (a single hardcoded Shopify integration is sufficient — abstraction for "100+ connectors" is premature and not needed until M2); (c) whether the `notification` module for M1 is scoped to the minimal transactional email path only (building consent categories, DLT registration, suppression lists, and WhatsApp stubs in M1 is pure over-build); (d) whether the RBAC implementation is introducing any group/team/custom-role concepts "for later" (the constraint is exactly Owner/Admin/Analyst/Viewer, nothing more); (e) whether the pixel installation wizard is inadvertently triggering a full `brain.js` SDK build (the wizard is instructions + a verify endpoint; the SDK is a separate requirement); (f) whether the execution plan deliverable (Epic → Story → Task) is consuming build time that should go to actual code.

**Required to surface:** at minimum one concrete item they believe is over-built or scope-creeping in M1, with the rationale that the design-partner can onboard without it.

---

## 11. Decision

**ADVANCE** to Architect (after persona synthesis).

This requirement is sound and correctly scoped. The problem statement is real (no usable application), the target users are clear (design-partner persona + invited team), the success metric is binary and demoable, and the constraints are fully aligned with the Product Canon and frozen ADRs.

The Authentik-vs-app-auth tension is resolved (app-native in `workspace-access` for M1; Authentik deployment runs in parallel but not on the auth critical path; no Stakeholder escalation needed).

The vertical-slice DB discipline is confirmed (migrations 001–006 only; no OLAP or measurement tables; the M1-data-spine requirement is the complementary parallel slice).

The build track decomposition (Track 0 contracts-first → Track 1 backend control plane + Track 3 frontend in parallel → Track 2 connector+pixel after Track 1 migrations land) is the correct sequencing.

The 6 challenge findings (L-02 sha256 gate, StarRocks row policy residual, notification module scope, frontend-api BFF as shared dependency, Shopify OAuth public callback requirement, overall scope size) are directional clarifications for the Architect, not blockers at intake.

No escalation trigger is met. No moat component is weakened. No frozen ADR is re-opened (the Authentik ruling defers Authentik to parallel operational work, not to a swap or new ADR).

The 2 personas will stress-test tenant isolation/auth hardness and scope/over-build. ADVANCE is the correct decision.

---

## 12. Intake DoD Checklist

- [x] Review filled (no TBD).
- [x] Lane confirmed: high_stakes; 7 trigger surfaces validated and expanded (`outbound_side_effects` added).
- [x] Dependency pre-flight: Sprint-0 shipped; L-02 tech-debt acknowledged as M1 pre-launch gate.
- [x] Sharpened requirement fields: problem, user, success metric, constraints, non-goals.
- [x] "Make it less dumb" pass: 6 findings (no split warranted; execution-plan deliverable deferred; pixel scope confirmed; dashboard OLAP scope bounded; Meta/Google = UI stubs only; email provider as pre-build dependency).
- [x] Authentik-vs-app-auth ruling: app-native in `workspace-access` for M1; Authentik parallel; no Stakeholder escalation needed.
- [x] Vertical-slice DB confirmation: migrations 001–006 only; excluded tables named; M1-database-and-migration-plan.md to be authored by Architect; relationship to M1-data-spine noted.
- [x] Recommended build-track decomposition: 4 tracks with owner agents and sequencing (Track 0 first; Track 1 + Track 3 parallel; Track 2 after Track 1 migrations).
- [x] Domain check vs Product Canon: 12 anchors checked.
- [x] Challenge findings: 6 findings (C1 L-02 gate, C2 StarRocks row policy, C3 notification module scope, C4 frontend-api BFF, C5 Shopify callback URL, C6 overall scope size).
- [x] 2 personas named with angles: Tenant Isolation + Auth Hardness Skeptic (auth/tenancy gaps); Scope and Over-Build Skeptic (OLAP drift, connector abstraction, notification over-build).
- [x] Decision: ADVANCE.
- [x] Journal and audit-log entries: written below.
- [x] State declared in HANDOFF (orchestrator writes active.json).

---

## Journal Entry

```markdown
## 2026-06-15T15:55:00Z — Engineering Advisor (cto-advisor) — feat-m1-app-foundation
**Stage:** 1 · **Action:** Intake + surfaces validation + Authentik ruling · **Personas:** tenant-isolation-auth-hardness-skeptic:sonnet + scope-over-build-skeptic:sonnet · **Decision:** ADVANCE
**Rationale:** App-native auth in workspace-access for M1 (Authentik not on critical path; no Stakeholder escalation); vertical-slice DB confirmed (migrations 001-006 only); outbound_side_effects surface added (notification chokepoint is M1 day-one dependency); L-02 sha256 is a pre-launch gate; 4 build tracks sequenced (contracts-first → backend+frontend parallel → connector+pixel after migration landing); 6 challenge findings directional for Architect. No moat, compliance, or invariant violation. · **Next:** Architect Stage 2 — binding plan with auth ruling, track sequencing, and NN-1 + I-ST05 as explicit acceptance criteria
```

---

## Persona Synthesis & Architect Brief

**Synthesized by:** Engineering Advisor (cto-advisor, Sonnet tier) — Stage 1 synthesis pass
**Synthesized at:** 2026-06-15T16:35:00Z
**Sources:** 02a-persona-isolation-auth.md (tenant-isolation-auth-hardness-skeptic) + 02b-persona-scope.md (scope-over-build-skeptic)

---

### A. Isolation / Auth Non-Negotiables (binding Architect + builder directives)

These are elevated from persona findings to binding directives. They are expensive or structurally impossible to retrofit once migrations are written and data exists. Every item below is a PRE-BUILD gate, not a review comment.

**NN-1 — Three-GUC RLS model (IAH-01, HIGH)**

The Sprint-0 single-GUC model (`app.current_brand_id` only) is structurally insufficient for the M1 workspace/user layer. Three GUCs are required, all in the NN-1 two-arg fail-closed form (`current_setting('...', TRUE)` — missing GUC returns NULL, predicate returns false, 0 rows, never another tenant's data):

- `app.current_brand_id` — brand-scoped tables: `brands`, `brand_members`, `connector_instances`, `connector_sync_status`, `connector_cursors`, `pixel_installations`, `pixel_status`.
- `app.current_workspace_id` — workspace-scoped tables: `workspaces` (or canon equivalent), `workspace_members` (or canon equivalent).
- `app.current_user_id` — user-self-read tables: `user_sessions`, `password_resets`, `email_verifications`.

The `users` / `app_user` table carries NO isolating RLS predicate — it is cross-tenant by nature; isolation is enforced at the service layer. This is an explicit architectural choice, not an omission.

The middleware in `workspace-access` and the `frontend-api` BFF must set ALL applicable GUCs before any query. The existing NN-1 assertion in `0001_init.sql` must be extended to scan all three GUC names.

The isolation-fuzz harness must be extended before Track 1 ships to cover all 15+ M1 tables across all three tenancy dimensions, using the real `brain_app` role. This is a P0 launch gate (I-S01).

**NN-2 — `connector_instances.secret_ref` = Secrets Manager ARN only; NO ciphertext column (IAH-05, HIGH)**

Migration 005 DDL must NOT include `oauth_token_ciphertext bytea` or any `*_token`/`*_ciphertext` column. The column is `secret_ref text NOT NULL` — the Secrets Manager ARN only. Zero token bytes in Postgres. The Zod contract for `ConnectorInstance` in `packages/contracts` must include `secret_ref: z.string()` and must not include any field typed as string named `*_token`, `*_secret`, `*_key`. The Shopify OAuth token storage path writes the ARN to `connector_instance.secret_ref`; the token never touches Postgres. The Semgrep rule must scan migration DDL files in addition to TypeScript. This is an explicit Track 0 (contracts) gate and a Track 2 (connector) acceptance criterion. (I-S09)

**NN-3 — Session revocation denylist checked on EVERY protected route including all BFF fan-out (IAH-03, HIGH)**

The `workspace-access` module must expose a `validateSession(userId, jti)` function that queries `user_sessions.revoked_at IS NULL`. Every protected route — including all downstream routes called via the `frontend-api` BFF fan-out (workspace, brand, connector, pixel modules) — must call `validateSession` in a Fastify `preHandler` before any business logic. The BFF validates on arrival; each module route validates independently. The short-lived token the BFF mints for module fan-out must include the original session `jti` so downstream routes can locate the correct `user_sessions` row. Revocation denylist check must appear in the acceptance criteria for every API story in Tracks 1 and 2.

**NN-4 — Shopify OAuth: HMAC validation is the absolute first operation in the callback handler (IAH-04, HIGH)**

The callback handler must: (1) validate the Shopify HMAC signature first — any failure returns HTTP 401 with no further processing; (2) validate the Shopify client secret fetched from Secrets Manager (never from env vars). After HMAC, the `state` parameter must be verified: generated with `crypto.randomBytes(16)` minimum, stored server-side keyed to `(brand_id, state)` with TTL of 15 minutes, single-use (consumed on callback). The `shop` parameter must be validated against `*.myshopify.com` format. Shopify webhook callbacks must ALSO validate HMAC — this is a separate acceptance criterion from the OAuth callback. HMAC validation order is an explicit acceptance criterion in the Track 2 connector story, not a review comment.

**NN-5 — Password hashing: argon2id (OWASP 2025 params) or bcrypt cost >= 12; forgot-password is timing-safe + content-identical; tokens are crypto.randomBytes(32), single-use, expiry-enforced (IAH-02 + IAH-07, HIGH + MEDIUM)**

The Architect must specify exactly ONE algorithm. Recommended: argon2id with OWASP 2025 minimum parameters (m=19456, t=2, p=1). If argon2id is rejected for dependency reasons, bcrypt with cost >= 12 (never the default of 10). A startup-time assertion must validate the cost factor meets the minimum. The forgot-password response must be timing-safe and content-identical regardless of whether the email exists (always HTTP 200, same body; never 404 or a different message for "email not found"). Password-reset and invitation tokens must be `crypto.randomBytes(32)` (256 bits) before SHA-256 hashing for storage. Both token types must be single-use (`used_at` column, checked before use) and expiry-enforced (password-reset = 1 hour; invitation = 7 days). Token lookup must use timing-safe comparison. These are explicit acceptance criteria in the Track 1 auth story.

**NN-6 — Isolation-fuzz extended to ALL M1 tables (15+) across 3 tenancy dimensions under the non-owner role; audit_log read path enforces WHERE brand_id on every packages/audit SELECT (IAH-CX + IAH-08, HIGH + MEDIUM)**

The Sprint-0 isolation-fuzz proves the pattern on a demo table only. It must be extended before Track 1 ships to cover every real M1 table in every tenancy dimension. Specifically: `workspaces` isolation (workspace_id GUC); `workspace_members` isolation; `brands` isolation (brand_id GUC within workspace); `brand_members` isolation; `invitations` isolation (compound policy tested for both workspace-level and brand-level variants); `connector_instances` isolation; `user_sessions` self-isolation. All tests use the real `brain_app` role and assert 0 rows (not an error) on cross-tenant queries.

For the audit log: because `audit_log` has RLS intentionally disabled (cross-brand SoR), every function in `packages/audit` that executes a SELECT must be reviewed for the mandatory `WHERE brand_id = $1` predicate before M1 ships. The isolation-fuzz harness must include a code-path coverage test confirming the audit query function always appends the brand_id filter. This is a P0 launch gate.

**NN-7 — Compound RLS for nullable-brand_id rows: invitations table requires two PERMISSIVE policies (IAH-06, MEDIUM)**

The `invitations` table (or canon equivalent `invite`) has `brand_id FK NULL` — brand_id is nullable for workspace-level invitations. A single RLS policy using only `brand_id = current_setting('app.current_brand_id', TRUE)::uuid` would make workspace-level invitations (brand_id IS NULL) invisible to all queries (NULL = uuid is always false) and would leave no isolation on them. The correct implementation is two Postgres PERMISSIVE policies (which OR-combine):
- Policy 1 (workspace-level invites): `WHERE brand_id IS NULL AND workspace_id = current_setting('app.current_workspace_id', TRUE)::uuid`
- Policy 2 (brand-level invites): `WHERE brand_id IS NOT NULL AND brand_id = current_setting('app.current_brand_id', TRUE)::uuid`

The isolation-fuzz must test both variants. This is a migration 004 DDL acceptance criterion.

---

### B. Scope Defer Rulings (binding — builders must not drift into these)

These are explicit defers from the scope-over-build-skeptic persona. They are binding in the Architect's plan: any PR that ships code touching a deferred item is a scope-violation blocker.

| Defer item | Reason | Owner of the defer ruling |
|---|---|---|
| Full `brain.js` pixel SDK (anon-id, 30-min session, UTM/click-ID capture, offline queue, CNAME deployment) | M1-data-spine requirement, not this one. `packages/pixel-sdk` is a stub placeholder. The `packages/pixel-sdk/src/index.ts` comment and doc-10 §7 say "built in M1" — the Architect plan must make explicit that this means M1-data-spine, not M1-app-foundation. M1-app-foundation pixel = migration 006 + verify endpoint + status page only. | Architect must add a comment to `packages/pixel-sdk/src/index.ts` clarifying the requirement split before builders begin. |
| Connector SDK / abstract base class / IConnector interface / shared OAuth utility | No second connector in M1-app-foundation. The `sources/` category sub-folders exist as placeholders. The Shopify connector is a concrete, self-contained implementation under `sources/storefront/shopify/`. No BaseConnector, no plugin registry, no shared OAuth adapter. Abstraction emerges when the second connector is built (M1-data-spine or M2). The `advertising/`, `logistics/`, `messaging/`, `payment/` folders remain `.gitkeep` stubs. | Explicit statement required in Architect build contract: "no IConnector interface, no BaseConnector class ships in M1-app-foundation." |
| `consent_record`, `consent_tombstone`, `notification_pref`, `can_contact()` gate | Marketing and WhatsApp outbound is Phase 3. Transactional emails (verify, reset, invite) are consent-exempt under TCCCPR. M1 `notification` module schema = `send_log` table + SES adapter + transactional-only send path. The `can_contact()` gate is a pass-through stub for M1. `notification_pref`, `consent_record`, `consent_tombstone` are deferred until marketing outbound is introduced. | Architect must name these tables explicitly as not-M1 in the build contract. |
| Dashboard Data Status via StarRocks / Analytics API / OLAP | Dashboard shell reads exactly: `brands.display_name` + `workspaces.name` + membership count (Postgres), `connector_instances.status` + `connector_sync_status.last_sync_at` + `connector_sync_status.status` (Postgres), `pixel_status.status` + `pixel_installations.installed_at` (Postgres), onboarding completion flags (deterministic from above). No StarRocks query, no Analytics API call, no DQ grade lookup, no Bronze freshness check. | Architect must name the exact Postgres table + column for each dashboard widget in the build contract. |
| Meta / Google connector backend code, routes, events | UI stub only — a disabled button with a tooltip in the frontend. Zero backend routes, zero DB rows, zero event emissions for Meta/Google in M1. | Already stated in intake. Binding here for builder reference. |
| Settlement connector data in migration 005 | Settlement reconciliation is M2 (Razorpay). Migration 005 = `connector_instances` + `connector_sync_status` + `connector_cursors` only. | Already stated in intake. Confirmed by persona. |
| Execution plan deliverable (Epic -> Story -> Task -> Subtask with estimates) | PM artifact, not a build deliverable. The Architect produces the build contract; the orchestrator runs builders. The 6 named demos are acceptance criteria, not a separate deliverable track. | Already stated in intake finding F2. Binding here. |

---

### C. Two Stakeholder Decisions (cannot be resolved by the Architect — isolated for the orchestrator)

Both decisions are schema-level conflicts between the M1 requirement's explicit wording and the frozen Canon (doc-08 §5.1, doc-01 §13, STACK.md ADR-006). Both must be resolved before migration 001 is written. They are not preference questions — they determine the CHECK constraints and table names in a migration that cannot be changed without a breaking DDL migration on live data.

---

#### Stakeholder Decision 1 — Role Names

**The conflict:**

| Source | Four role names |
|---|---|
| M1 requirement (explicit) | Owner / Admin / Analyst / Viewer |
| Canon: STACK.md ADR-006 (locked) | Owner / Brand Admin / Manager / Analyst |
| Canon: doc-08 §5.1 CHECK constraint (frozen DDL) | `owner` / `brand_admin` / `manager` / `analyst` |
| Canon: doc-01 §13 BRD (product spec) | Owner / Brand Admin / Manager / Analyst |

The requirement's `Admin` does not map to any canon `role_code`. The requirement's `Viewer` does not map to any canon `role_code`. `analyst` exists in both. The three canon sources agree with each other; the requirement disagrees with all three.

**Option A — Honor the Canon's 4 names (`owner / brand_admin / manager / analyst`)**

Migration 001 `role_code CHECK in ('owner','brand_admin','manager','analyst')`. JWT claims use these codes. RLS policies key on these codes. The requirement's `Admin` is a UI display name for `brand_admin`; `Viewer` is a UI display name for `manager`. No canon document is amended.

Pros: zero migration risk; JWT/RLS contract unchanged from the frozen spec; all three canon sources remain internally consistent.

Cons: the M1 requirement must be annotated to clarify that `Admin` = `brand_admin` in code and `Viewer` = `manager` in code. Any external documentation or demo scripts using `Admin`/`Viewer` are informal labels.

**Option B — Honor the requirement's 4 names (`owner / admin / analyst / viewer`)**

Migration 001 `role_code CHECK in ('owner','admin','analyst','viewer')`. The BRD (doc-01 §13), doc-08 §5.1 DDL, and STACK.md ADR-006 must all be amended to reflect the new names before migration 001 is written. JWT claims and RLS policies use the new codes.

Pros: the migration matches the requirement's explicit wording; no ambiguity for builders reading the requirement.

Cons: three canon documents require amendments (doc-01, doc-08, STACK.md ADR-006 — a locked ADR); the amendment itself requires Engineering Advisor review. If any Sprint-0 code, tests, or seed data already references the old `role_code` values (e.g., in `0001_init.sql` check constraint patterns or test fixtures), those require updates. The `manager` role name disappears entirely — if any stakeholder communication has used "Manager," this is a product-visible rename.

**Engineering Advisor recommendation: Option A.**

The three canon sources are already internally consistent and form the locked RLS/JWT-claim contract. The requirement's `Admin`/`Viewer` read as informal shorthand — the BRD was the founding product spec and used `Brand Admin`/`Manager`; the requirement appears to have simplified these informally. Amending three canon documents (including a locked ADR) to match an informal shorthand in a single requirement introduces unnecessary churn and migration risk. The correct fix is annotating the requirement and UI display names, not the schema. Builders should use `brand_admin` and `manager` as `role_code` values; the frontend displays them as `Admin` and `Viewer` if the Stakeholder prefers those product labels.

If the Stakeholder's intent is a genuine product rename (the four roles will be called `Admin` and `Viewer` in all user-facing surfaces, documentation, and future requirements going forward), then Option B is appropriate — but it requires explicit Stakeholder confirmation and canon amendments before migration 001, not after.

---

#### Stakeholder Decision 2 — Table Names

**The conflict:**

| Source | Top-level entity table | Membership table | User table | Invitation table |
|---|---|---|---|---|
| M1 requirement (explicit) | `workspaces` | `workspace_members` / `brand_members` (separate) | `users` | `invitations` |
| Canon: doc-08 §5.1 (frozen DDL) | `organization` | `membership` (single table, brand_id nullable) | `app_user` | `invite` |
| Canon: doc-01 §13.1 (BRD) | organization owns brands; "brand = workspace" (product terminology) | single membership relation | `app_user` | invite |

The requirement's `workspaces` table appears to map to doc-08's `organization` (the top-level tenant root). The requirement's separate `brand_members` table does not exist in the canon — doc-08 uses a single `membership` table with `brand_id FK NULL` (null = org-level membership, non-null = brand-level). The requirement's `users` table maps to doc-08's `app_user`. The requirement's `invitations` maps to doc-08's `invite`.

The requirement also implies a three-level hierarchy: workspace > brand (since both `workspace_members` and `brand_members` exist as separate tables). The canon (doc-01 §13.1) defines a two-level hierarchy: organization > brand (where "brand" is also called "workspace" as a product term). No three-level hierarchy exists in the canon.

**Option A — Keep doc-08 canonical names (`organization`, `membership`, `app_user`, `invite`)**

Migration table names match doc-08 §5.1 exactly. "Workspace" is the product-facing label for what the database calls `organization`. The single `membership` table covers both org-level and brand-level membership (brand_id nullable). No separate `brand_members` table. `users` in the requirement = `app_user` in code; `invitations` = `invite` in code; `workspaces` = `organization` in code.

Pros: migrations match the frozen DDL spec; no canon document requires amendment; the two-level hierarchy is preserved.

Cons: the requirement's table names are informal; builders reading the requirement must maintain a mental mapping (workspace = organization, etc.). The Architect's plan must state the canonical-to-product-term mapping explicitly.

**Option B — Adopt the requirement's names as M1 canonical (`workspaces`, `workspace_members`, `brands`, `brand_members`, `users`, `invitations`)**

Migration table names match the requirement. Doc-08 §5.1 must be amended to reflect these names before migration 001 is written.

Pros: migrations match the requirement's explicit wording; no builder mapping required.

Cons: doc-08 requires amendment; the introduction of a separate `brand_members` table alongside `workspace_members` adds a layer not in the canon; the `membership` table's elegant single-table design (org vs brand membership handled by nullable `brand_id`) is replaced by two tables, which complicates the compound RLS policy for invitations and duplicates membership logic. The two-level hierarchy risk: if `workspaces` and `brands` are both explicitly named tables, builders may treat them as two separate levels (workspace > brand), adding a three-level hierarchy that contradicts the BRD's "brand = workspace" equivalence.

**Engineering Advisor recommendation: Option A.**

The doc-08 §5.1 DDL is the frozen data model and the canonical authority. The requirement's table names are informal product terminology — "workspace" is the product-facing name for what the engineers call `organization`. The single `membership` table design is cleaner and avoids the compound-RLS complexity that two separate tables would introduce. "Brand = workspace" (doc-01 §13.1) means the `organization` → `brand` hierarchy is the correct two-level model; a separate `workspaces` table would be an incorrect third level.

The Architect's build contract should include an explicit canonical-to-product-term mapping table (visible to all builders) as the first item in the migration plan:

| Product term (requirement) | Database name (canon doc-08 §5.1) |
|---|---|
| Workspace | `organization` |
| Workspace Member | `membership` (with `brand_id IS NULL` = org-level) |
| Brand Member | `membership` (with `brand_id IS NOT NULL` = brand-level) |
| User | `app_user` |
| Invitation | `invite` |

If the Stakeholder prefers to amend the canon to use the product terms as table names (i.e., Option B), that amendment must happen before migration 001 and must be confirmed explicitly — it is not an Architect-level decision.

---

### D. Synthesis Summary and Advance Rationale

Both personas surfaced substantive concerns. Neither persona produced a "looks good" response. All concerns are accounted for:

- The IAH persona (isolation/auth) produced 9 findings: 5 HIGH, 3 MEDIUM, 1 HIGH cross-cutting. All are elevated to binding NN directives (NN-1 through NN-7) above or are captured in the two Stakeholder decisions. None require a KILL or CHALLENGE-BACK — all are pre-build specification gaps, not architectural contradictions.

- The scope persona produced 6 findings: 1 CRITICAL (role-name collision), 3 HIGH (pixel split, connector abstraction, notification scope), 2 MEDIUM (table names, dashboard data sources). The CRITICAL item is isolated as Stakeholder Decision 1. The 3 HIGH items are resolved as binding scope defer rulings in Section B. The 2 MEDIUM items are resolved: dashboard data sources are named explicitly in Section B; table names are isolated as Stakeholder Decision 2.

Neither persona finding adds a new trigger surface beyond the 7 confirmed in intake. Lane stays `high_stakes`.

The two Stakeholder decisions (role names, table names) are schema-level conflicts between the requirement and the Canon. They cannot be resolved by the Engineering Advisor or the Architect because the Canon (including locked ADR-006) would need to be amended for Option B in either case. Both are framed for a clean pick. Both must be resolved before migration 001 is written.

Everything else is ADVANCE to Architect.

---

### Synthesis Journal Entry

```markdown
## 2026-06-15T16:35:00Z — Engineering Advisor (cto-advisor) — feat-m1-app-foundation
**Stage:** 1 · **Action:** Persona synthesis · **Personas synthesized:** tenant-isolation-auth-hardness-skeptic:sonnet (9 findings, 5H+3M+1H-CX) + scope-over-build-skeptic:sonnet (6 findings, 1C+3H+2M) · **Decision:** ADVANCE
**Rationale:** All persona findings resolved — 7 binding NNs elevated (NN-1 three-GUC RLS, NN-2 secret_ref-only, NN-3 BFF revocation on every route, NN-4 Shopify HMAC first, NN-5 argon2id+timing-safe, NN-6 isolation-fuzz all 15+ tables, NN-7 compound RLS nullable brand_id); binding scope defers named (pixel-sdk, connector-SDK, consent-tables, dashboard OLAP, Meta/Google backend, settlement, execution-plan); 2 Stakeholder decisions isolated (role names: req Owner/Admin/Analyst/Viewer vs canon owner/brand_admin/manager/analyst — rec Option A; table names: req workspaces/workspace_members vs canon organization/membership — rec Option A). No new surfaces. Lane stays high_stakes (7 surfaces). · **Next:** Stakeholder confirmation on 2 decisions, then Architect Stage 2.
```
