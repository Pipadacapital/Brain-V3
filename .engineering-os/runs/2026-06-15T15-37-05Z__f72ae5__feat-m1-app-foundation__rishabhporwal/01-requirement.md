# Requirement: Brain M1 Application Foundation

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Title** | Brain M1 Application Foundation (Register → Login → Workspace → Brand → Invite → Dashboard → Connect Shopify → Install Pixel) |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-15T15:37:05Z |
| **Tier impact** | n/a (foundational app flow; not a packaging tier) |
| **Region impact** | India `ap-south-1` only (Phase 1); region/currency/tax model fields carried per doc 08 §36, GCC GTM deferred |

---

## Lane *(set by the Engineering Advisor at Stage 1)*

| Field | Value |
|-------|-------|
| **feature_class** | high-stakes |
| **feature_class_rationale** | Deterministic lane scan: `auth`, `connectors`, `multi_tenancy`, `schema_proto` (≥1 surface ⇒ high_stakes). Auth + RLS tenant isolation + audit + connector OAuth are the core VETO surfaces. |
| **trigger_surfaces_touched** | auth, connectors, multi_tenancy, schema_proto (contracts/events), system_of_record_audit, secrets_auth_iam |

---

## Raw text (from the Stakeholder)

> **M1 Application Foundation** — deliver the first fully usable Brain application flow. A user can: **Register → Login → Create Workspace → Create Brand → Invite Users → Land on Dashboard → Connect Shopify → Install Brain Pixel → View Connection Status → View Initial Data Status.** Production-grade; **no mocked backend, no fake analytics, no fake data** — if data is unavailable show **"No Data Yet"**, never simulate. Brain's moat = First-Party Data Collection + Integrations + Identity + Lakehouse; everything in M1 supports that. Do NOT build enterprise-SaaS or future-phase features. **Vertical-slice** throughout.
>
> **Part 1 — Flows:** (1) Registration: Register + Verify Email; email+password+verification; NO SSO/OAuth/social/magic-link. (2) Authentication: Login, Forgot/Reset Password; JWT/session, secure password storage, audit logging. (3) Workspace creation (e.g. "Sugandh Lok"): ownership, audit trail, tenant isolation. (4) Brand creation (e.g. "Sugandh Lok Store"): workspace relationship, brand isolation, future multi-brand. (5) User management: roles **Owner/Admin/Analyst/Viewer ONLY** — no custom roles/advanced RBAC/groups/teams/enterprise IAM. (6) Dashboard shell: Brand Summary, Connection Status, Data Status, Onboarding Progress — NO fake metrics/charts. (7) Connector setup: view integrations, Connect Shopify, connection health; Meta/Google = disabled "Coming Soon" (not implemented). (8) Pixel setup: Brain Pixel Installation Wizard — instructions, verify, status. (9) Initial Data Status: Connected / Syncing / Waiting For Data / Error — only ACTUAL backend state.
>
> **Part 2 — Database (VERTICAL-SLICE; only M1 tables, not the full doc-08 schema):** PostgreSQL + RLS (two-arg fail-closed) + audit + tenant isolation + node-pg-migrate. Domains: Auth (users, user_sessions, password_resets, email_verifications); Workspace (workspaces, workspace_members); Brand (brands, brand_members); Invitations (invitations); Connector Foundation (connector_instances, connector_sync_status, connector_cursors); Pixel Foundation (pixel_installations, pixel_status); Audit (M1 additions). For every table: columns, types, constraints, FKs, indexes, unique constraints, RLS policies, audit requirements. Migrations 001 Auth → 002 Workspace → 003 Brand → 004 Invitation → 005 Connector → 006 Pixel; reversible, idempotent where appropriate, tenant-isolated, Brain standards.
>
> **Part 3 — APIs:** Auth (Register, Verify Email, Login, Logout, Forgot, Reset, Current User); Workspace (Create/Get/Update/List); Brand (Create/Get/Update/List/Switch); User (Invite/Accept/List Members/Update Role/Remove); Connector (List/Connect Shopify/Status/Disconnect); Pixel (Installation Status/Verify/Health).
>
> **Part 4 — Events** (existing Brain event/contract standards): user_registered, user_logged_in, workspace_created, brand_created, user_invited, connector_connected, connector_sync_started, pixel_installed, pixel_verified (+ others M1 needs).
>
> **Part 5 — Frontend** (Next.js, current Brain arch): screen inventory, navigation, routes, component hierarchy, state management, API integration layer.
>
> **Part 6 — Backend** (modular monolith): modules, services, repositories, controllers, contracts, validation, error handling.
>
> **Part 7 — Testing:** unit, integration, API, RLS, isolation, E2E, acceptance.
>
> **Part 8 — Execution plan:** Epic → Feature → Story → Task → Subtask; each task: owner, dependencies, estimate, acceptance criteria.
>
> **Part 9 — Demo readiness:** Demo 1 Registration; Demo 2 Workspace+Brand; Demo 3 Invitations; Demo 4 Shopify Connection; Demo 5 Pixel Installation; Demo 6 Dashboard Shell.
>
> **Success:** a new user can Register → Login → Workspace → Brand → Invite → Connect Shopify → Install Pixel → Dashboard; all actions persist to DB; all APIs functional; all migrations production-ready; all tables enforce RLS; no mocked backend / no fake analytics / no future-phase. A real, demoable app aligned with the long-term architecture + data model.

---

## Problem statement

Sprint-0 shipped the platform substrate (CI/CD, contracts, RLS framework, isolation tests, Terraform, data-platform scaffolding) but there is **no usable application**. M1 must deliver the first real end-to-end user journey — account → workspace → brand → team → connect Shopify → install pixel → dashboard shell — on the frozen architecture, fully persisted and RLS-enforced, with honest empty states ("No Data Yet") rather than any simulation. This is the entry point that lets the design partner (Sugandh Lok) actually onboard.

## Target user

The brand operator onboarding to Brain (the design-partner persona) + their invited team (Owner/Admin/Analyst/Viewer). Developer-facing surfaces (APIs, migrations, modules) are the build substrate.

## Success metric

A new user completes the full chain **Register → Login → Create Workspace → Create Brand → Invite Team → Connect Shopify → Install Pixel → Reach Dashboard** with every action persisted, every API functional, all migrations production-ready, all tables RLS-enforced, zero mocked/fake behavior. Demoable via the 6 named demos.

## Constraints

- **Frozen architecture** — modular monolith + 4 deployables; no new services/deployables/DBs/ledgers/platforms; align to the Canon + doc-08 data model.
- **Vertical-slice DB** — ONLY the M1 tables; future domains in future migrations; do not implement the full doc-08 schema.
- **Auth scope** — email+password+verification + JWT/session ONLY. No SSO/OAuth/social/magic-link. (Connector OAuth for Shopify is separate and in-scope.)
- **RBAC scope** — exactly Owner/Admin/Analyst/Viewer; no custom roles/groups/teams/enterprise IAM.
- **No simulation** — no mocked backend, no fake analytics/charts/data; honest "No Data Yet" / actual backend state only.
- **Multi-tenant by construction** — `brand_id`/workspace isolation on every row/key/log; RLS two-arg fail-closed (NN-1); isolation negative-tests are a P0 gate.
- **Security by default** — secure password storage (hashing), secrets via Secrets Manager/KMS, audit logging on auth + consequential actions, least privilege.
- **Self-hosted Authentik** is the Canon IdP — reconcile: M1 wants app-native email/password auth. The Architect must resolve whether M1 auth is Authentik-backed or an app-native control-plane auth that Authentik fronts later (flag at intake).

## Non-goals

- No analytics/metrics/charts, no decision engine/recommendations, no attribution, no Customer 360, no billing.
- No Meta/Google connectors (Shopify only; others = disabled "Coming Soon").
- No enterprise SaaS (SSO, advanced RBAC, groups/teams, SCIM), no GCC/multi-region launch, no reserved data domains.
- No future-phase data marts beyond what the connection/pixel status requires.

---

## Linked prior runs

- `chore-platform-foundations-sprint0` (the foundation this builds on — shipped 2026-06-15).
- Planning input: `docs/plans/M1-database-and-migration-plan.md`.

## Notes

- The Stakeholder requested rich deliverables: per-table DDL detail, API list, event list, frontend inventory, backend module layout, test matrix, an Epic→Subtask execution plan, and 6 demo definitions. The Architect should decompose into parallel build tracks (backend control-plane + auth, frontend Next.js flows, data/connector+pixel foundation) and right-size to the M1 vertical slice.
- Canon anchors: STACK.md (Authentik IdP, Fastify/tRPC, Next.js, Postgres+RLS, node-pg-migrate), HLD.md (13 modules — workspace-access, connector, identity, notification, frontend-api), INVARIANTS.md (RLS, no-PII, money, contract-first), TRIGGER-SURFACES.md, auth-and-access skill, multi-tenancy-isolation skill.
