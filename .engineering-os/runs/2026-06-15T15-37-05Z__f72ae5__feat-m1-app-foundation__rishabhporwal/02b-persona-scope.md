# Dynamic Persona Review — Scope & Over-Build Skeptic

> Filled by a single persona spawned in Stage 1.
> Lens: pragmatic Staff Engineer guarding the M1 vertical slice against premature abstraction,
> doc-08 schema creep, fake-data temptation, and enterprise-IAM creep.

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Persona** | `scope-over-build-skeptic` |
| **Timestamp** | 2026-06-15T16:20:00Z |

---

## What this lens sees

As the person whose job is to ensure every line built is the **smallest real thing that makes the demo
work**, I notice five surfaces where the M1-app-foundation requirement and the existing Sprint-0
codebase are primed to over-build. The requirement explicitly guards against simulation and future-phase
creep, and the CTO Advisor's intake review confirms the key boundaries — but the actual artifacts in the
repo and the canon documents reveal concrete drift vectors that need named rulings before the Architect's
plan becomes a build contract.

The central observation: three of the six concerns below are already partially materialised in the
Sprint-0 codebase (the `packages/pixel-sdk` comment, the connector `sources/` category sub-folders,
and the `notification` module table schema in doc-08 §5.5), and they will be pulled into M1-app-foundation
scope by builders who read doc-10 §7 or doc-08 §5.5 without the vertical-slice filter the intake review
established. The Architect must name these as explicit out-of-scope items in the build contract, not
leave them as implied non-goals.

---

## Concerns

### Concern 1 — CRITICAL: Role-name collision between the requirement and the canon will produce a schema
that cannot be reconciled with the frozen doc-08 `role` table CHECK constraint

- **Severity:** critical
- **Concern:** The M1 requirement specifies exactly four roles as `Owner/Admin/Analyst/Viewer`. The
  canonical data model (doc-08 §5.1 `role` table) defines the CHECK constraint as
  `role_code CHECK in('owner','brand_admin','manager','analyst')`. STACK.md ADR-006 (the locked seam
  binding) names the four roles as `Owner/Brand Admin/Manager/Analyst`. The BRD (doc-01 §13.3) is
  the authoritative product spec and explicitly names them as `Owner, Brand Admin, Manager, Analyst`.
  The requirement's `Admin/Viewer` names for the second and fourth roles do not exist anywhere in the
  frozen canon. If the builder implements migrations 001–006 with `role_code CHECK in
  ('owner','admin','analyst','viewer')` — matching what the requirement text says — the resulting
  schema contradicts the locked doc-08 §5.1 DDL, the STACK.md ADR-006 seam binding, and the BRD
  product spec simultaneously. Fixing this after data exists in production is a breaking migration.
- **Rationale:** The BRD (doc-01 §13.3) is the source of truth for product-visible role names and
  maps directly to the `role_code` CHECK constraint in doc-08 §5.1. The M1 requirement's role names
  (`Admin` instead of `Brand Admin`, `Viewer` instead of `Manager`) appear to be an informal
  shorthand that was not reconciled against the frozen canon before the requirement was written.
  This is a schema-level conflict that must be resolved before migration 001 is written, because
  the `role_code` constraint is a Postgres CHECK — changing it later is an ALTER TABLE that must
  be a new numbered migration, and any seed data or JWT claims written with the wrong codes will
  require a data migration. The Architect must confirm with the Stakeholder: are `Admin/Viewer`
  intentional renames of `Brand Admin/Manager` (in which case the BRD, doc-08, and STACK.md must
  be amended), or is `Owner/Admin/Analyst/Viewer` an error in the requirement text (in which case
  the builder must use `owner/brand_admin/manager/analyst` from the canon)?
  **This is the one item that cannot be resolved by the Architect alone — it requires a Stakeholder
  confirmation before migration 001 is written.**

---

### Concern 2 — HIGH: `packages/pixel-sdk` is already declared as a full brain.js production SDK
build in M1 (doc-10 §7 + the Sprint-0 stub comment), which contradicts the intake review's
pixel-scope ruling (wizard + verify endpoint only)

- **Severity:** high
- **Concern:** The Sprint-0 scaffold created `packages/pixel-sdk/src/index.ts` with a comment
  explicitly scoping it as: *"Public surface (built in M1, per doc 10 §7): anon-id + 30-min
  session management, click-ID/UTM capture, `_fbc`/`_fbp` handling, event queue + offline retry,
  consent-at-capture, and the cart-attribute stitch writer (brain_anon_id + first-touch click IDs
  + UTMs → cart.attributes)."* Doc-10 §7 confirms: *"Brain Pixel: SDK first (anon-id + 30-min
  session, click-ID/UTM capture, `_fbc`/`_fbp`, event queue + offline retry, consent-at-capture,
  cart-attribute stitch writer), versioned, size-budgeted, non-blocking. Deploy as a static
  first-party asset over the per-tenant CNAME... Build in M1."* This is a full production pixel
  SDK — not the pixel installation wizard described in the M1-app-foundation requirement. The
  intake review (02-cto-advisor-review.md, Finding F3) correctly scoped M1-app-foundation pixel
  as: `pixel_installations` table + `pixel_status` table + a verify endpoint (HTTP HEAD check) +
  a status page. These two scopes are not the same deliverable. Any builder who reads
  `packages/pixel-sdk/src/index.ts` or doc-10 §7 without the intake review's clarification will
  build the full `brain.js` SDK as part of M1-app-foundation.
- **Rationale:** The full `brain.js` SDK (session management, UTM capture, click-ID handling,
  event queue, offline retry, CNAME deployment, server-side cookie setter) is a significant
  deliverable. It belongs to the M1-data-spine requirement (the separate parallel M1 slice for
  the collector + pixel ingestion path), not to M1-app-foundation. The confusion is already
  baked into the Sprint-0 scaffold comment and doc-10 §7. The Architect must resolve this split
  explicitly in the build plan: M1-app-foundation pixel deliverable = (a) `pixel_installations`
  table + `pixel_status` table in migration 006; (b) a pixel verify endpoint (HTTP HEAD to the
  brand's domain); (c) a status page showing actual state. `packages/pixel-sdk` is a stub
  placeholder — no implementation is part of this requirement. Implementation of the actual
  `brain.js` SDK belongs to the M1-data-spine run. The Architect must put a comment or README
  in `packages/pixel-sdk` making this split explicit, or builders will fill it as part of this
  requirement.

---

### Concern 3 — HIGH: The connector module's `sources/` category sub-folders
(`advertising/`, `logistics/`, `marketplace/`, `messaging/`, `payment/`, `storefront/`) and
doc-10's "connector SDK" framing will pull a generic connector abstraction layer into M1

- **Severity:** high
- **Concern:** The Sprint-0 scaffold created six category sub-folders under
  `apps/core/src/modules/connector/sources/` — `advertising/`, `logistics/`, `marketplace/`,
  `messaging/`, `payment/`, `storefront/` — each containing only a `.gitkeep`. Doc-10 §7 describes:
  *"Connector platform: the connector SDK (OAuth → idempotent UPSERT → canonical events → Bronze
  archive → cursors → late-repull) + the 'new source = a folder under sources/' rule. M1."* Doc-12
  §6 states a connector's Definition of Done includes: *"a folder under `sources/` (no engine
  edit)."* The M1-app-foundation requirement calls for Shopify-only. But the folder structure and
  the "connector SDK" framing in the referenced docs will create pressure on the builder to implement
  a `BaseConnector` abstract class / `IConnector` interface / shared OAuth utility / connector
  registry that supports plugging in Meta and Google later — before any of those connectors are
  in scope. A builder reading doc-10's "connector SDK (OAuth → idempotent UPSERT → canonical
  events → Bronze archive → cursors → late-repull)" will interpret that SDK as an M1 deliverable.
- **Rationale:** For M1-app-foundation (Shopify-only, design partner onboarding), a direct,
  concrete Shopify OAuth implementation is sufficient. The "new source = a folder under `sources/`"
  pattern is correct architecture — but it does not require building a generic connector SDK now.
  The correct M1 deliverable is: one concrete Shopify implementation under
  `sources/storefront/shopify/` (OAuth flow, `connector_instances` write, `secret_ref` pattern,
  connection health endpoint, `connector_sync_status` write, disconnect). No abstract base class,
  no shared connector registry, no plugin interface. The `advertising/`, `logistics/`, etc. folders
  exist as placeholders for future connectors — they must not acquire any interface code in M1.
  When Meta ships (M1-data-spine per doc-10), a shared OAuth utility may emerge — but that
  refactoring happens when the second connector is built, not before. The Architect must explicitly
  state: "no connector SDK / abstract base class / IConnector interface ships in M1-app-foundation;
  the Shopify connector is a concrete, self-contained implementation."

---

### Concern 4 — HIGH: The `notification` module M1 scope is ambiguous; doc-08 §5.5 defines a full
notification + consent schema that will be built prematurely if the Architect does not bound it

- **Severity:** high
- **Concern:** The M1-app-foundation requirement needs transactional email for three triggers:
  email verification, password reset, user invitation. The intake review (C3) correctly identifies
  the minimal M1 `notification` module as: `send_log` table + SES email channel adapter +
  transactional-email path. However, doc-08 §5.5 defines a full notification + consent schema
  including: `notification(notification_id, brand_id, recipient_user_id, tier CHECK
  in('critical','important','digest'), ...)`, `notification_pref(brand_id, user_id, prefs jsonb,
  quiet_hours jsonb)`, `consent_record(brand_id, brain_id, category CHECK
  in('analytics','marketing','personalization','ai_processing'), state, source, ...)`,
  `consent_tombstone(brand_id, brain_id, category, tombstoned_at)`. These are the Phase-3
  marketing/WhatsApp consent tables. The INVARIANTS.md I-ST05 requires all outbound to pass
  through the `notification` module, which will be interpreted as requiring the full
  `can_contact()` consent gate — including `consent_record` and `consent_tombstone` — even in M1.
  Building these tables in M1 is schema creep: `consent_record` and `consent_tombstone` are only
  meaningful when marketing outbound exists, which is Phase 3.
- **Rationale:** Transactional emails (verify, reset, invite) are legally consent-exempt in India
  under TCCCPR and do not require a `consent_record` lookup or a `consent_tombstone` check. The
  notification chokepoint (I-ST05) is a code-path constraint — all sends pass through one module —
  not a schema constraint requiring the full consent table set. The minimal M1 `notification`
  module schema is: `send_log(id, brand_id, recipient_email, template_id, status, sent_at,
  idempotency_key)` only. `notification_pref`, `consent_record`, `consent_tombstone`, and the
  `can_contact()` gate are M2+/Phase-3 additions, added when marketing outbound (WhatsApp,
  promotional email) is introduced. The Architect must explicitly state: M1 `notification` module
  = `send_log` table + SES adapter + transactional-only send path. The consent gate in
  `can_contact()` is a pass-through stub for M1 (transactional always passes); the full consent
  schema is deferred until marketing outbound is in scope.

---

### Concern 5 — MEDIUM: The M1 schema proposes `workspaces`/`workspace_members` tables but the
canonical doc-08 model uses `organization`/`membership` — the naming divergence will create a
migration sequence that drifts from the frozen data model

- **Severity:** medium
- **Concern:** The M1 requirement proposes migration groupings as: 001 Auth (`users`,
  `user_sessions`, `password_resets`, `email_verifications`), 002 Workspace (`workspaces`,
  `workspace_members`), 003 Brand (`brands`, `brand_members`). The canonical doc-08 §5.1 schema
  defines: `organization(org_id PK, legal_name, billing_country, region, ...)`,
  `membership(membership_id, org_id, brand_id, user_id, role_id, ...)`,
  `app_user(user_id PK, org_id FK, email, ...)`, and `invite(invite_id, org_id, brand_id, ...)`.
  The BRD (doc-01 §13.1) clarifies: *"A brand (also called a workspace) is the atomic unit of
  isolation. An organization owns one or more brands."* So "workspace" = brand, and "organization"
  is the correct table name for the top-level tenant root — not "workspaces". The requirement's
  proposed `workspaces` table is likely an alias for what doc-08 calls `organization`, but the
  table name divergence will produce migrations that either: (a) use different table names from
  the canonical DDL spec, requiring a reconciliation migration later; or (b) silently re-define
  the semantic model (treating workspace as something between org and brand, adding a layer that
  doesn't exist in the canon).
- **Rationale:** The BRD §13.1 is explicit: a brand is also called a workspace. Organization is the
  top-level entity. The canonical doc-08 §5.1 table is `organization`. If the M1 migrations use
  `workspaces` as a separate table from `brands`, the Architect is introducing a three-level
  hierarchy (organization → workspace → brand) that does not exist in any canon document. If
  `workspaces` is intended as a rename of `organization`, the migrations will diverge from the
  doc-08 DDL and must be reconciled. The Architect must confirm the mapping and use the canonical
  table names from doc-08 §5.1: `organization` (not `workspaces`), `app_user` (not `users`),
  `membership` (not `workspace_members` or `brand_members`), `invite` (not `invitations`). The
  requirement's table names are informal; the canon table names are the authoritative DDL.

---

### Concern 6 — MEDIUM: The Dashboard "Data Status" widget must be bounded to actual Postgres
control-plane reads; any build team tempted by even a single StarRocks query in the dashboard
shell creates an unreachable code path in M1 and a dependency on the M1-data-spine requirement

- **Severity:** medium
- **Concern:** The dashboard shell requirement asks for: Brand Summary, Connection Status, Data
  Status, Onboarding Progress. The intake review (Finding F4) correctly rules all four as pure
  Postgres reads. However, the "Data Status" phrasing — `Connected / Syncing / Waiting For Data
  / Error` — is close to the language used for the analytics pipeline status in the M1-data-spine
  slice (Bronze freshness, Silver/Gold lag, DQ grades). A builder who opens doc-08 or the STACK.md
  and sees the AnalyticsAdapter seam may wire a StarRocks freshness query into the "Data Status"
  widget, either because the field name sounds like an analytics concept or because they want to
  give the dashboard more useful content. This would create: (a) a StarRocks dependency in the
  app-foundation requirement; (b) an I-ST01 violation (Analytics API is the sole StarRocks read
  path, and the dashboard shell must not become a direct StarRocks client); (c) dead code in M1
  because no data has flowed through the pipeline yet.
- **Rationale:** The "Data Status" widget reads exactly two fields from Postgres: `pixel_status`
  (from the `pixel_status` table in migration 006) and `connector_sync_status` (from the
  `connector_sync_status` table in migration 005). Both are Postgres control-plane tables. There
  is no StarRocks query, no Analytics API call, no DQ grade lookup, no Bronze freshness check.
  The Architect must name the specific table + column that each dashboard widget reads, leaving
  no ambiguity for the builder:
  - Brand Summary: `brands.display_name`, `workspace.name` (from control-plane),
    `membership` count for this brand.
  - Connection Status: `connector_instances.status` + `connector_sync_status.last_sync_at` +
    `connector_sync_status.status`.
  - Data Status: `pixel_status.status` + `pixel_installations.installed_at`.
  - Onboarding Progress: deterministic completion flags computed from the above tables.

---

## Defer list

| Item | Reason to defer |
|------|-----------------|
| Full `brain.js` pixel SDK (anon-id, session, click-ID, UTM, offline queue, CNAME deployment) | M1-data-spine requirement; not this one. `packages/pixel-sdk` is a stub placeholder. The installation wizard is instructions + a verify endpoint only. |
| Connector SDK / abstract base class / `IConnector` interface / shared OAuth utility | No second connector in M1-app-foundation. One concrete Shopify implementation is sufficient; abstraction emerges when the second connector (Meta, in M1-data-spine) is built. |
| `consent_record`, `consent_tombstone`, `notification_pref`, `can_contact()` gate | Marketing/WhatsApp outbound is Phase 3. Transactional email (verify, reset, invite) is consent-exempt under TCCCPR. M1 notification schema = `send_log` only. |
| `role_code` values `admin` and `viewer` (as proposed in the requirement) | Canon uses `brand_admin` and `manager`. Must be confirmed with Stakeholder before migration 001 is written. If the canon names hold, `Admin` and `Viewer` are UI display names only, not `role_code` values. |
| `workspaces` and `workspace_members` as new table names | Canon table names from doc-08 §5.1 are `organization` and `membership`. No `workspaces` table exists in the canonical DDL. Architect must use doc-08 §5.1 names or the schemas will diverge. |
| Multi-brand member table (`brand_members`) as a separate table | In doc-08, brand membership is the `membership` table with a `brand_id FK NULL` (nullable = org-level membership for Owner). No separate `brand_members` table. |
| StarRocks queries in dashboard shell | I-ST01 invariant. All dashboard reads in M1 are Postgres control-plane. No OLAP dependency. |
| Meta/Google connector backend code, routes, or events | UI stub (disabled button + tooltip) only. Zero backend. |
| Execution plan (Epic → Story → Task → Subtask with owner/estimate/AC) | Doc-12 §4 finding F2: this is a PM artifact. The Architect produces the build contract; the OS runs builders. Delivering a JIRA-style breakdown wastes build time. |
| Settlement connector data in migration 005 | Settlement reconciliation is M2 (Razorpay). Migration 005 should contain only what the Shopify connection health UI needs: `connector_instances`, `connector_sync_status`, `connector_cursors`. Settlement tables are M2. |

---

## Recommendations

1. **Role-name collision: require Stakeholder confirmation before migration 001 is written.** The
   Architect must not assume `Admin = brand_admin` and `Viewer = manager` are safe substitutions.
   The doc-01 BRD, doc-08 §5.1 `role` CHECK constraint, and STACK.md ADR-006 all name the four
   roles as `Owner/Brand Admin/Manager/Analyst`. If the requirement's `Admin/Viewer` are the
   intended names, three canon documents must be amended. If `Admin/Viewer` is a shorthand
   error, the builder must use `owner/brand_admin/manager/analyst` throughout. There is no
   middle path — `role_code` is a CHECK constraint in a migration; it sets in stone at migration 001.

2. **Pixel split: add a one-line comment to `packages/pixel-sdk/src/index.ts` + the Architect
   plan stating which requirement owns the implementation.** The existing comment says "built in M1"
   and references doc-10 §7. The Architect plan must clarify: implementation of `packages/pixel-sdk`
   is assigned to M1-data-spine, not M1-app-foundation. M1-app-foundation's pixel deliverable
   is migration 006 (`pixel_installations`, `pixel_status`) + a verify endpoint + a status page.

3. **Connector abstraction: the build contract must state "no IConnector interface, no BaseConnector
   class" in M1-app-foundation.** The Shopify connector is a concrete, self-contained implementation
   under `sources/storefront/shopify/`. Abstraction emerges when the second connector is built.
   The `advertising/`, `logistics/`, `messaging/`, `payment/` folders remain `.gitkeep` stubs
   with no interface code until their first concrete connector is assigned.

4. **Table names: the Architect must reconcile the requirement's informal table names against
   doc-08 §5.1 before migration 001 is written.** The canonical names are:
   `organization` (not `workspaces`), `app_user` (not `users`), `membership` (not
   `workspace_members` or `brand_members`), `invite` (not `invitations`). If the Stakeholder
   prefers the requirement's names, a doc-08 amendment is required first.

5. **Notification module: the Architect plan must bound M1 `notification` schema to `send_log`
   only.** The build contract must name the deferred tables (`notification_pref`, `consent_record`,
   `consent_tombstone`) as not-M1 with a specific trigger (when marketing outbound is introduced).

6. **Dashboard data sources: the Architect must name the exact Postgres table + column for each
   dashboard widget** in the build contract, so no builder introduces a StarRocks query or an
   Analytics API call into the dashboard shell.

---

## Skills consulted

- `dynamic-persona-spawning` (count rule, inhabiting discipline, concern threshold)
- `auth-and-access` (RBAC scope, role-name canon, JWT claims shape)

---

## One line for the CTO Advisor synthesis

**The top risk is the role-name collision (`Owner/Admin/Analyst/Viewer` vs canon `owner/brand_admin/manager/analyst`) — it is a breaking schema conflict that must be resolved by the Stakeholder before migration 001 is written; the secondary risks are the pixel-sdk/data-spine boundary confusion and the connector-SDK abstraction pressure, both of which are already primed in the Sprint-0 scaffold and will pull M2 scope into this requirement if not named explicitly in the Architect's build contract.**

---

## Journal stub

```markdown
## 2026-06-15T16:20:00Z — Persona:scope-over-build-skeptic — feat-m1-app-foundation
**Angle:** M1 vertical-slice guard — schema naming, pixel split, connector abstraction, notification scope, role-name collision · **Top concern:** role_code CHECK constraint collision between requirement (Admin/Viewer) and canon BRD/doc-08/STACK.md (brand_admin/manager) — breaking schema conflict · **Severity:** H
```
