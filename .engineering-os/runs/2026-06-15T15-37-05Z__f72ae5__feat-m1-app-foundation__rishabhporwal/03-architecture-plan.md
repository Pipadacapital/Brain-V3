# 03 — Architecture Plan (BINDING) — Brain M1 Application Foundation

| Field | Value |
|-------|-------|
| **req_id** | `feat-m1-app-foundation` |
| **Stage** | 2 — Architect |
| **Author** | Architect (Opus tier) |
| **Authored at** | 2026-06-15T20:10:00Z |
| **Decision** | ADVANCE → Stage 3 (parallel build) |
| **Lane** | high_stakes (7 trigger surfaces) |
| **Cost paradigm** | **Tier 1 — deterministic logic only.** Zero model calls. Auth, RBAC, OAuth, CRUD, RLS, pixel-verify, dashboard reads are all deterministic. No statistical/ML/small/large-model path is permitted in M1-app-foundation. Justification: every operation has a closed deterministic answer; a model call here would be a paradigm-bypass (cost-routing-paradigms gate ⇒ block at review). Estimated model spend: **0 tokens/day, $0/mo.** |

> **This document is the build contract.** Stages 3–8 implement it verbatim. Any required deviation routes back to the Architect (amendment loop) — never freelanced. The 7 NON-NEGOTIABLES (NN-1..NN-7) and every persona must-fix are folded into per-track **acceptance contracts** below as REQUIRED pass-1 items.

---

## 0. Binding decisions inherited (do NOT re-open)

| # | Decision | Source | Binding form in this plan |
|---|---|---|---|
| D0.1 | **Auth = app-native** email/password/JWT in `workspace-access`; Authentik fronts later via OIDC token-issuer swap. | 02-review §5 ruling (Option B) | §3 Track 1; JWT claims ADR-006-shaped so the later swap is a non-migration. |
| D0.2 | **Role codes** = `owner / brand_admin / manager / analyst` (Canon, doc-08 §5.1 CHECK). UI labels Admin/Viewer map to canon codes. | Stakeholder-resolved (task header) + 02-review Decision 1 Option A | §1 role map; migration 002 CHECK uses these 4. |
| D0.3 | **Table names** = doc-08 §5.1 canonical: `organization`, `membership` (single table, `brand_id NULL`=org-level), `brand`, `app_user`, `invite`. Other M1 tables keep functional names. | Stakeholder-resolved (task header) + 02-review Decision 2 Option A | §1 product-term→table map; migrations 001–006. |
| D0.4 | **Vertical slice** — only the ~14 M1 tables (migrations 001–006). No doc-08 OLAP/ledger/identity-graph/billing/consent tables. | 01-req Part 2 + 02-review §6 + persona §B defers | §2 + §7 scope-violation list. |

---

## 1. Product-term → database-name map (publish to all builders; pin at top of the migration plan)

| Product term (requirement / UI) | Database object (canon doc-08 §5.1) | Notes |
|---|---|---|
| Workspace | `organization` | top-level tenant root |
| Workspace Member | `membership` WHERE `brand_id IS NULL` | org-level membership |
| Brand Member | `membership` WHERE `brand_id IS NOT NULL` | brand-level membership |
| Brand | `brand` | child of organization (two-level hierarchy; "brand = workspace" product equivalence — NOT a 3rd level) |
| User | `app_user` | user-global; login identity; NO brand RLS |
| Invitation | `invite` | nullable `brand_id` → compound RLS (NN-7) |

**UI-label ↔ role_code map (explicit, binding):**

| UI label (frontend display) | `role_code` (DB / JWT / RLS) | Capability summary (M1) |
|---|---|---|
| Owner | `owner` | full control; exactly one per organization; sole Owner cannot be removed/demoted while last |
| Admin | `brand_admin` | manage brand, members (except Owner), connectors, pixel, invites |
| Manager *(label: "Manager")* | `manager` | operate brand; connect/disconnect connectors; install/verify pixel; no member management |
| Analyst *(label: "Analyst")* | `analyst` | read-only on brand state, dashboard, connection/data status |

> The requirement's "Viewer" maps to `manager` per 02-review Decision-1 Option A annotation; frontend displays the canon labels (Owner/Admin/Manager/Analyst). The four `role_code` values are the only values the migration-002 CHECK constraint accepts. No custom roles, groups, teams, or SCIM (scope-defer §2).

---

## 2. Scope fence (any PR adding these to M1 is a scope-violation BLOCKER)

**NOT in M1-app-foundation** (binding defers — persona §B + 02-review §6):
- OLAP/lakehouse: `silver.*`, `gold.*`, `realized_revenue_ledger`, `attribution_credit_ledger`, any StarRocks/Iceberg table or query. Dashboard reads **Postgres control-plane only** (§6.4 names the exact columns).
- Measurement/billing/identity-graph/AI: `metric_registry`, `metric_definition`, `decision_log`, `ai_provenance`, `identity_link`, `brain_id_alias`, `contact_pii`, `gmv_meter_snapshot`, `invoice`, `entitlement`.
- Consent/marketing: `consent_record`, `consent_tombstone`, `notification_pref`. `notification` M1 = `send_log` + SES transactional adapter + `can_contact()` **pass-through stub** only.
- Connector abstraction: **NO** `IConnector` interface, **NO** `BaseConnector`, **NO** plugin registry, **NO** shared OAuth utility. Shopify is a concrete self-contained impl under `connector/sources/storefront/shopify/`. `advertising/ logistics/ messaging/ payment/ marketplace/` stay `.gitkeep`.
- Pixel SDK: the production `brain.js` (`packages/pixel-sdk`) is the **M1-data-spine** deliverable, NOT this run. M1-app-foundation pixel = migration 006 + verify endpoint (HTTP HEAD/GET presence check) + status page. **Track 2 must add a clarifying comment to `packages/pixel-sdk/src/index.ts`** noting the requirement split before any pixel work.
- Meta/Google connectors: **frontend UI stub only** (disabled card + tooltip). Zero backend routes/rows/events.
- Settlement reconciliation (Razorpay), `connector/settlement/` — M2.
- Execution plan as a build deliverable — the 6 named demos (§8) are acceptance criteria, not a track.

---

## 3. Build-track decomposition (parallel fan-out)

Sequencing (critical path): **Track 0 (contracts) → {Track 1 + Track 3 parallel} → Track 2 (after migrations 001–004 land).** Track 3 codes against Track-0-generated types immediately; does not need a running backend.

```
        ┌──────────── Track 0 — Contracts & Events (backend-developer) ─────────────┐
        │  packages/contracts (Zod, all M1 APIs) + packages/events (9 events) — SEQ-FIRST
        └───────────────────────────────┬───────────────────────────────────────────┘
                          ┌─────────────┴──────────────┐
            ┌─────────────▼─────────────┐   ┌───────────▼──────────────┐
            │ Track 1 — Control plane   │   │ Track 3 — Frontend       │
            │ (backend-developer)       │   │ (frontend-web-developer) │
            │ migrations 001–004 + auth │   │ apps/web 9 flows + shell │
            │ + workspace/brand/invite  │   │ (parallel w/ Track 1)    │
            │ + notification + BFF      │   └──────────────────────────┘
            │ + packages/db 3-GUC + audit sha256 (L-02)
            └─────────────┬─────────────┘
                          │ (migrations 001–004 landed, brand/org FKs available)
            ┌─────────────▼─────────────┐
            │ Track 2 — Connector+Pixel │
            │ (backend-developer)       │
            │ migrations 005–006 +      │
            │ Shopify OAuth + pixel     │
            └───────────────────────────┘
```

**Shared-file owners (write-race prevention):**
- `packages/contracts/src/**` + `packages/events/src/**` → **Track 0 owns**; Tracks 1/2/3 consume only.
- `packages/db/src/index.ts` (3-GUC middleware) → **Track 1 owns**; Track 2 consumes the published `QueryContext`.
- `packages/audit/src/index.ts` (sha256 swap, L-02) → **Track 1 owns**.
- `db/migrations/*` → Track 1 owns `001–004`; Track 2 owns `005–006`. **Strict numeric apply order; Track 2 cannot merge before Track 1's migrations land** (FK to `organization`/`brand`).
- `apps/core/src/modules/frontend-api/**` (BFF) → **Track 1 owns**; Track 3 consumes its tRPC surface (defined in Track 0).
- `tools/isolation-fuzz/src/**` → Track 1 extends for 001–004 tables; Track 2 extends for 005–006 tables (separate files: `pg.workspace.test.ts`, `pg.connector.test.ts`) — no shared-file edit.

### Track 0 — Contracts & Events — `@backend-developer` — SEQUENCE-FIRST
**Owns:** `packages/contracts/src/api/*`, `packages/contracts/src/events/*`, `packages/events` wiring.
**Why first:** I-E01 — no behaviour code before its Zod contract exists + codegen committed.
**Deliverables:** all M1 API Zod schemas (§5.1), the 9 event schemas with the doc-07 envelope (§5.2), codegen (types/OpenAPI/Avro), `buf-breaking` green, CODEOWNERS on `packages/contracts`.
**Pins:** `zod@^3.25.76` (match existing repo pin — do NOT bump to zod 4; that is a breaking surface drift requiring api-discipline).

### Track 1 — Backend control plane — `@backend-developer`
**Owns:** `apps/core/src/modules/workspace-access/internal/**` (auth, org, brand, membership, invite, RBAC), `apps/core/src/modules/notification/internal/**` (send_log + SES transactional), `apps/core/src/modules/frontend-api/internal/**` (BFF), migrations `001–004`, `packages/db/src/index.ts` (3-GUC middleware), `packages/audit/src/index.ts` (sha256 + DB-backed writer, L-02).
**Depends on:** Track 0.
**DDD layout** (per domain-driven-design skill — bounded context, never technical layer):
```
workspace-access/internal/
  domain/auth/        (entities: AppUser, Session; value-objects: PasswordHash, Token; policies: PasswordPolicy, EnumerationSafePolicy)
  domain/organization/ domain/brand/ domain/membership/ domain/invite/
  application/        (commands: RegisterUser, VerifyEmail, Login, ResetPassword, CreateOrganization, CreateBrand, InviteMember, AcceptInvite, …; queries: GetCurrentUser, ListMembers, …)
  infrastructure/     (PgAppUserRepository, PgSessionRepository, … — implement domain repo interfaces; SesEmailAdapter via notification)
  interfaces/         (rest/trpc route adapters — THIN; producers for the 5 control-plane events)
  security/           (3-GUC setter, validateSession preHandler, rbacGuard)
```

### Track 2 — Connector & Pixel — `@backend-developer`
**Owns:** `apps/core/src/modules/connector/sources/storefront/shopify/**`, `connector/connection/**`, a `pixel` area under `connector/` (installation + verify + status — keep inside the `connector` bounded context; no new top-level module), migrations `005–006`, the 4 connector/pixel events.
**Depends on:** Track 0 + Track 1 migrations 001–004 (FK to `organization`/`brand`).
**Owner choice rationale:** assigned **backend-developer** (not data-engineer): M1 connector scope is OAuth + `secret_ref` storage + status rows + idempotent cursor upsert + 4 event emits — control-plane logic, no StarRocks/dbt/lakehouse math. The data-spine sync consumer is the complementary M1-data-spine run.

### Track 3 — Frontend — `@frontend-web-developer`
**Owns:** `apps/web/app/**` (9 flows), component hierarchy, TanStack Query integration via the BFF, dashboard shell with honest "No Data Yet".
**Depends on:** Track 0 (generated types). Parallel with Track 1.

### Deploy-pipeline track (REQUIRED — folded into the slice, not a follow-up)
M1 changes the `core` and `web` deployables (no new service is created — modular monolith, ADR-001/I-E05). Per the deploy invariant, each track that changes a deployable carries its pipeline step **in the same slice**:
- **Track 1 + Track 2** (core): GitHub Actions → ECR (affected-only build via `turbo --affected`) → Helm chart bump → ArgoCD app `core` sync → health-probe bake → **auto-rollback on K8s probe failure** (ADR-010; canary/percentage-rollout is Phase-4-deferred per STACK.md — M1 ships probe-based auto-rollback + the `packages/feature-flags` per-brand kill-switch, NOT LaunchDarkly targeting).
- **Track 3** (web): same pipeline for the `web` ArgoCD app.
- **Migration gate in the pipeline:** `pnpm migrate up` runs as a pre-deploy Argo job against the target env; a failed/irreversible migration blocks the deploy. **M1 task: wire `node-pg-migrate@^8.0.4` + `pnpm migrate` scripts** (`migrate:up`, `migrate:down`, `migrate:create`) in `packages/db` — currently absent (verified: no migrate script anywhere in the repo; only `db/migrations/0001_init.sql` exists, applied by a bespoke path). This wiring is a Track 1 pass-1 item.

---

## 4. The DB schema + migrations 001–006

**Conventions (all migrations):** `node-pg-migrate@^8.0.4`; each has `up` + `down` (reversible); `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` where safe; RLS + GRANT in the **same** migration as the table; ids `uuid DEFAULT gen_random_uuid()`; timestamps `TIMESTAMPTZ DEFAULT NOW()`; **no money columns in M1** (none of these tables hold currency). App role = `brain_app` (NOLOGIN, no BYPASSRLS — established in `0001_init.sql`). **RLS pattern = NN-1 two-arg fail-closed** extended to the 3 GUCs (NN-1):

```sql
-- brand-scoped:    USING (brand_id      = current_setting('app.current_brand_id', TRUE)::uuid)
-- workspace-scoped:USING (organization_id = current_setting('app.current_workspace_id', TRUE)::uuid)
-- user-self:       USING (app_user_id   = current_setting('app.current_user_id', TRUE)::uuid)
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON <t> AS PERMISSIVE FOR ALL TO brain_app USING (<predicate>);
```
Extend the `0001_init.sql` NN-1 assertion block to scan **all three** GUC names for the one-arg form (NN-1).

### NN-1 — three-GUC tenancy map (per-table — BINDING)

| Table | Migration | GUC(s) that gate it | RLS? | Rationale |
|---|---|---|---|---|
| `app_user` | 001 | none | **NO RLS** | user-global login identity; cross-tenant by nature; isolation at service layer (NN-1 explicit choice, not omission) |
| `user_session` | 001 | `app.current_user_id` | YES | self-read only; revocation denylist row |
| `password_reset` | 001 | `app.current_user_id` | YES | self-scoped token |
| `email_verification` | 001 | `app.current_user_id` | YES | self-scoped token |
| `organization` | 002 | `app.current_workspace_id` | YES | workspace tenant root |
| `membership` | 002 | `app.current_workspace_id` | YES | org+brand membership; `brand_id NULL`=org-level |
| `brand` | 003 | `app.current_brand_id` | YES | brand isolation within org |
| `invite` | 004 | **compound (NN-7)** `app.current_workspace_id` + `app.current_brand_id` | YES | nullable brand_id → two PERMISSIVE policies |
| `connector_instance` | 005 | `app.current_brand_id` | YES | per-brand connector |
| `connector_sync_status` | 005 | `app.current_brand_id` | YES | per-brand status |
| `connector_cursor` | 005 | `app.current_brand_id` | YES | per-brand cursor; idempotent upsert |
| `pixel_installation` | 006 | `app.current_brand_id` | YES | per-brand pixel |
| `pixel_status` | 006 | `app.current_brand_id` | YES | per-brand pixel status |

> The 3-GUC middleware in `packages/db` and the BFF set ALL applicable GUCs (via `SET LOCAL` inside a transaction) before any query. `app_user` reads are guarded by an explicit service-layer `WHERE` + the login path only.

### Migration 001 — Auth (`app_user`, `user_session`, `password_reset`, `email_verification`)

**`app_user`** — login identity (NO RLS; service-layer isolation).
Columns: `id uuid PK`, `email citext NOT NULL` (enable `citext` ext for case-insensitive uniqueness), `email_normalized text NOT NULL`, `password_hash text NOT NULL` (argon2id encoded string), `email_verified_at timestamptz NULL`, `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'))`, `created_at`, `updated_at`.
Constraints: `UNIQUE (email)`; index `app_user_email_normalized_idx` on `(email_normalized)`.
GRANT: `SELECT, INSERT, UPDATE` to `brain_app` (no DELETE). **No column named `*_token`/`*_secret`/`*_key`** (I-S09; `password_hash` is the argon2 digest, allowed — Semgrep allowlist note in the migration header).
Audit: `app_user.registered`, `app_user.email_verified`.

**`user_session`** — access/refresh + revocation denylist. RLS: `app.current_user_id`.
Columns: `id uuid PK`, `app_user_id uuid NOT NULL FK→app_user(id)`, `jti uuid NOT NULL UNIQUE` (JWT id; the denylist key), `refresh_token_hash text NOT NULL` (sha256 of the rotating refresh secret — never plaintext), `issued_at timestamptz NOT NULL DEFAULT NOW()`, `expires_at timestamptz NOT NULL`, `revoked_at timestamptz NULL`, `ip inet NULL`, `user_agent text NULL`, `created_at`.
Indexes: `(app_user_id)`, `(jti)`, partial `(app_user_id) WHERE revoked_at IS NULL`.
RLS predicate: `app_user_id = current_setting('app.current_user_id', TRUE)::uuid`.
GRANT: `SELECT, INSERT, UPDATE` (UPDATE only to set `revoked_at`; no DELETE).
Audit: `user.logged_in`, `session.revoked` (logout).

**`password_reset`** — RLS `app.current_user_id`.
Columns: `id uuid PK`, `app_user_id uuid NOT NULL FK→app_user(id)`, `token_hash text NOT NULL UNIQUE` (sha256 of `crypto.randomBytes(32)`), `expires_at timestamptz NOT NULL` (issued_at + 1h), `used_at timestamptz NULL`, `created_at`.
Index: `(token_hash)`. RLS: `app_user_id = …current_user_id`. GRANT `SELECT, INSERT, UPDATE`.
Audit: `password_reset.requested`, `password_reset.completed`.

**`email_verification`** — RLS `app.current_user_id`.
Columns: `id uuid PK`, `app_user_id uuid NOT NULL FK→app_user(id)`, `token_hash text NOT NULL UNIQUE`, `expires_at timestamptz NOT NULL` (24h), `used_at timestamptz NULL`, `created_at`.
Index `(token_hash)`. RLS as above. GRANT `SELECT, INSERT, UPDATE`.

### Migration 002 — Workspace (`organization`, `membership`)

**`organization`** — RLS `app.current_workspace_id`.
Columns: `id uuid PK`, `name text NOT NULL`, `slug text NOT NULL UNIQUE`, `owner_user_id uuid NOT NULL FK→app_user(id)`, `region_code text NOT NULL DEFAULT 'IN'` (RegionAdapter seam — India binding only; field carried per doc-08 §36), `created_at`, `updated_at`.
RLS predicate: `id = current_setting('app.current_workspace_id', TRUE)::uuid`.
Constraint: exactly-one-Owner invariant enforced at the service layer + `owner_user_id NOT NULL`. GRANT `SELECT, INSERT, UPDATE`.
Audit: `organization.created`.

**`membership`** — single table; `brand_id NULL`=org-level, `brand_id NOT NULL`=brand-level. RLS `app.current_workspace_id`.
Columns: `id uuid PK`, `organization_id uuid NOT NULL FK→organization(id)`, `brand_id uuid NULL FK→brand(id)` (FK added in 003 via deferred constraint or in 003's up), `app_user_id uuid NOT NULL FK→app_user(id)`, `role_code text NOT NULL CHECK (role_code IN ('owner','brand_admin','manager','analyst'))`, `created_at`, `updated_at`.
Constraints: `UNIQUE (organization_id, brand_id, app_user_id)` (a user has one role per scope; NULL brand_id participates via a partial unique index for the org-level row: `CREATE UNIQUE INDEX membership_org_user_uniq ON membership(organization_id, app_user_id) WHERE brand_id IS NULL`).
Indexes: `(organization_id)`, `(brand_id)`, `(app_user_id)`.
RLS predicate: `organization_id = current_setting('app.current_workspace_id', TRUE)::uuid`.
GRANT `SELECT, INSERT, UPDATE, DELETE` (member removal is a DELETE; sole-Owner guard at service layer).
Audit: `membership.created`, `membership.role_changed`, `membership.removed`.

### Migration 003 — Brand (`brand`) + brand-level membership rule

**`brand`** — RLS `app.current_brand_id`.
Columns: `id uuid PK`, `organization_id uuid NOT NULL FK→organization(id)`, `display_name text NOT NULL`, `domain text NULL` (pixel-verify target host), `status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived'))`, `region_code text NOT NULL DEFAULT 'IN'`, `created_at`, `updated_at`.
Indexes: `(organization_id)`. RLS predicate: `id = current_setting('app.current_brand_id', TRUE)::uuid`.
GRANT `SELECT, INSERT, UPDATE`.
003 also adds the `membership.brand_id → brand(id)` FK (deferred from 002) and the brand-level membership rule note. Audit: `brand.created`.

### Migration 004 — Invitation (`invite`) — compound RLS (NN-7)

**`invite`** — `brand_id` nullable. **TWO PERMISSIVE policies (OR-combine)** — NN-7.
Columns: `id uuid PK`, `organization_id uuid NOT NULL FK→organization(id)`, `brand_id uuid NULL FK→brand(id)`, `email citext NOT NULL`, `role_code text NOT NULL CHECK (role_code IN ('owner','brand_admin','manager','analyst'))`, `token_hash text NOT NULL UNIQUE` (sha256 of `crypto.randomBytes(32)`), `invited_by_user_id uuid NOT NULL FK→app_user(id)`, `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked'))`, `expires_at timestamptz NOT NULL` (7d), `accepted_at timestamptz NULL`, `created_at`.
Index `(token_hash)`, `(organization_id)`, `(brand_id)`.
RLS (NN-7):
```sql
CREATE POLICY invite_org_level ON invite AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id IS NULL AND organization_id = current_setting('app.current_workspace_id', TRUE)::uuid);
CREATE POLICY invite_brand_level ON invite AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id IS NOT NULL AND brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
```
GRANT `SELECT, INSERT, UPDATE`. Audit: `invite.created`, `invite.accepted`.

### Migration 005 — Connector (`connector_instance`, `connector_sync_status`, `connector_cursor`)

**`connector_instance`** — **NN-2: `secret_ref` ARN ONLY; NO token/ciphertext column.** RLS `app.current_brand_id`.
Columns: `id uuid PK`, `brand_id uuid NOT NULL FK→brand(id)`, `provider text NOT NULL CHECK (provider IN ('shopify'))` (M1 only Shopify), `shop_domain text NOT NULL` (`*.myshopify.com`), `secret_ref text NOT NULL` (AWS Secrets Manager ARN — **the only credential reference; zero token bytes in Postgres**), `status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','disconnected','error'))`, `connected_at timestamptz NOT NULL DEFAULT NOW()`, `disconnected_at timestamptz NULL`, `created_at`, `updated_at`.
**Migration header MUST state:** no `oauth_token`, `*_token`, `*_ciphertext`, `*_secret`, `*_key` column exists (I-S09 / NN-2). Semgrep DDL scan covers this file.
Constraint: `UNIQUE (brand_id, provider)` (one Shopify connection per brand in M1). Index `(brand_id)`. RLS `brand_id = …current_brand_id`. GRANT `SELECT, INSERT, UPDATE`.
Audit: `connector.connected`, `connector.disconnected`.

**`connector_sync_status`** — RLS `app.current_brand_id`.
Columns: `id uuid PK`, `brand_id uuid NOT NULL FK→brand(id)`, `connector_instance_id uuid NOT NULL FK→connector_instance(id)`, `state text NOT NULL DEFAULT 'waiting_for_data' CHECK (state IN ('connected','syncing','waiting_for_data','error'))`, `last_sync_at timestamptz NULL`, `last_error text NULL`, `updated_at`.
Index `(brand_id, connector_instance_id)`. GRANT `SELECT, INSERT, UPDATE`.

**`connector_cursor`** — idempotent on the cursor (I-ST04). RLS `app.current_brand_id`.
Columns: `id uuid PK`, `brand_id uuid NOT NULL FK→brand(id)`, `connector_instance_id uuid NOT NULL FK→connector_instance(id)`, `resource text NOT NULL` (e.g. `orders`), `cursor_value text NULL`, `updated_at`.
Constraint `UNIQUE (brand_id, connector_instance_id, resource)` (the upsert key — replay-safe). GRANT `SELECT, INSERT, UPDATE`.

### Migration 006 — Pixel (`pixel_installation`, `pixel_status`)

**`pixel_installation`** — RLS `app.current_brand_id`.
Columns: `id uuid PK`, `brand_id uuid NOT NULL FK→brand(id)`, `install_token uuid NOT NULL DEFAULT gen_random_uuid()` (the per-brand pixel tag identifier embedded in the snippet — not a secret), `target_host text NOT NULL` (host to verify), `installed_at timestamptz NULL`, `created_at`, `updated_at`.
Constraint `UNIQUE (brand_id)`. RLS `brand_id = …current_brand_id`. GRANT `SELECT, INSERT, UPDATE`.
Audit: `pixel.installed`.

**`pixel_status`** — RLS `app.current_brand_id`.
Columns: `id uuid PK`, `brand_id uuid NOT NULL FK→brand(id)`, `pixel_installation_id uuid NOT NULL FK→pixel_installation(id)`, `state text NOT NULL DEFAULT 'waiting_for_data' CHECK (state IN ('connected','syncing','waiting_for_data','error'))`, `verified_at timestamptz NULL`, `last_error text NULL`, `updated_at`.
Index `(brand_id)`. GRANT `SELECT, INSERT, UPDATE`. Audit: `pixel.verified`.

**Down migrations:** each `down` drops policies, GRANTs, indexes, then the table, in reverse order. No `down` ever touches `audit_log`/`brand_keyring` (Sprint-0). I-E02: these M1 tables are control-plane (not ledger/Bronze) so reversible DROP is permitted — but the **`audit_log` rows they wrote are never deleted** (append-only).

---

## 5. API + event specs

### 5.1 Endpoints (every M1 endpoint — no extras)

All mutations require `Idempotency-Key` header (I-ST04, 24h replay cache). All lists use **keyset/cursor pagination** (no OFFSET — anti-pattern). Error envelope = `{ request_id, error: { code, message, fields? } }` (matches `sample.api.v1.ts`). All protected routes run `validateSession` (NN-3) + `rbacGuard` in a Fastify `preHandler`. `role` column = required minimum `role_code`.

**Auth** (`workspace-access`; public except where noted):
| Method | Path | Auth/Role | Req/Resp Zod | Notes |
|---|---|---|---|---|
| POST | `/api/v1/auth/register` | public | `RegisterRequest`/`RegisterResponse` | argon2id hash; no user-enumeration |
| POST | `/api/v1/auth/verify-email` | public (token) | `VerifyEmailRequest`/`OkResponse` | single-use token |
| POST | `/api/v1/auth/login` | public | `LoginRequest`/`LoginResponse` | mints access JWT + refresh; writes `user_session` |
| POST | `/api/v1/auth/logout` | session | `LogoutRequest`/`OkResponse` | sets `revoked_at` on jti |
| POST | `/api/v1/auth/forgot-password` | public | `ForgotPasswordRequest`/`OkResponse` | **always 200, content-identical** (NN-5) |
| POST | `/api/v1/auth/reset-password` | public (token) | `ResetPasswordRequest`/`OkResponse` | single-use, 1h expiry |
| GET | `/api/v1/auth/me` | session | —/`CurrentUserResponse` | validates session every call (NN-3) |

**Workspace** (`organization`): POST `/api/v1/workspaces` (auth), GET `/api/v1/workspaces/:id` (member), PATCH `/api/v1/workspaces/:id` (owner/brand_admin), GET `/api/v1/workspaces` (auth; keyset).
**Brand**: POST `/api/v1/brands` (owner/brand_admin), GET `/api/v1/brands/:id` (member), PATCH `/api/v1/brands/:id` (owner/brand_admin), GET `/api/v1/brands` (member; keyset), POST `/api/v1/brands/:id/switch` (member → re-mints token with new `brand_id` claim).
**User/Members**: POST `/api/v1/invites` (owner/brand_admin), POST `/api/v1/invites/accept` (public token), GET `/api/v1/members` (member; keyset), PATCH `/api/v1/members/:id/role` (owner/brand_admin; sole-Owner guard), DELETE `/api/v1/members/:id` (owner/brand_admin; sole-Owner guard).
**Connector** (`connector`): GET `/api/v1/connectors` (member; returns shopify + Meta/Google **as `coming_soon` flags only**), GET `/api/v1/connectors/shopify/install` (manager+; returns Shopify install URL + sets state nonce), GET `/api/v1/connectors/shopify/callback` (public — **HMAC-first**, NN-4), GET `/api/v1/connectors/:id/status` (member), DELETE `/api/v1/connectors/:id` (manager+; disconnect).
**Pixel** (`connector`/pixel): GET `/api/v1/pixel/installation` (member; returns snippet + install_token), POST `/api/v1/pixel/verify` (manager+; HTTP HEAD/GET presence check → writes status), GET `/api/v1/pixel/health` (member; returns `pixel_status`).
**BFF** (`frontend-api`): all `apps/web` calls route through the BFF (httpOnly cookie → short token → in-proc fan-out); the BFF asserts `X-Brand-Id` non-null + runs `validateSession` on arrival (NN-3) + forwards correlation id.

### 5.2 Events (9 — doc-07 envelope; producer; emitted-when)

Envelope = the `sample.collector.event.v1` shape (`schema_version, event_id, brand_id, correlation_id, event_name, occurred_at, …`); topic `{env}.{domain}.{event}.v1`; partition key `brand_id:event_id`; idempotency `(brand_id, event_id)`. For user/workspace events with no brand yet, `brand_id` carries the `organization_id` as the tenant key (documented in each schema). No raw PII in any payload (I-S02).

| Event | Topic | Producer | Emitted when |
|---|---|---|---|
| `user.registered` | `{env}.user.registered.v1` | workspace-access | after `app_user` insert + verification token issued |
| `user.logged_in` | `{env}.user.logged_in.v1` | workspace-access | after `user_session` insert |
| `workspace.created` | `{env}.workspace.created.v1` | workspace-access | after `organization` insert |
| `brand.created` | `{env}.brand.created.v1` | workspace-access | after `brand` insert |
| `user.invited` | `{env}.user.invited.v1` | workspace-access | after `invite` insert (before email send) |
| `connector.connected` | `{env}.connector.connected.v1` | connector | after `connector_instance` insert (post-HMAC, secret_ref stored) |
| `connector.sync_started` | `{env}.connector.sync_started.v1` | connector | when sync state → `syncing` |
| `pixel.installed` | `{env}.pixel.installed.v1` | connector/pixel | after `pixel_installation` insert |
| `pixel.verified` | `{env}.pixel.verified.v1` | connector/pixel | after verify success → `pixel_status` write |

---

## 6. Design decisions (per Stakeholder output format)

**6.1 Design Decisions.** (a) App-native auth (D0.1); JWT claims `{ sub, brand_id, workspace_id, role, iat, exp, jti }` — ADR-006-shaped so Authentik fronting later is a token-issuer swap, not a migration. (b) Three-GUC RLS (NN-1) is the kernel isolation; service-layer guard on `app_user` only. (c) `secret_ref`-only for connector creds (NN-2). (d) Single `membership` table (canon) over two member tables — simpler compound logic. (e) Pixel = verify-endpoint, not SDK (scope-defer). (f) Dashboard = Postgres-only reads (§6.4). **Alternative considered + rejected:** Authentik-backed auth from M1 day-1 — rejected (02-review §5: not operationally deployed, adds blocking infra to the critical path, M1 needs no OIDC/SAML/MFA; app-native is the canonical M1 choice with a clean Phase-2 seam).

**6.2 Folder Structure.** Per DDD skill (bounded-context, never technical-layer) — see Track 1/2 layouts in §3. `apps/web` by route group (`(auth)/ (onboarding)/ (dashboard)/ (settings)/`).

**6.3 Configuration.** Secrets via AWS Secrets Manager + KMS (I-S09): JWT signing key (rotatable), SES credentials, Shopify client secret, per-connector `secret_ref`. Argon2id params (m=19456, t=2, p=1) asserted at startup (NN-5). `region_code='IN'` (RegionAdapter India binding). No secret in env/code/logs.

**6.4 Dashboard data sources (BINDING — Postgres columns only; persona §B):**
| Widget | Exact source |
|---|---|
| Brand Summary | `organization.name`, `brand.display_name`, COUNT over `membership` |
| Connection Status | `connector_instance.status`, `connector_sync_status.state` + `.last_sync_at` |
| Data Status | `pixel_status.state`, `pixel_installation.installed_at` |
| Onboarding Progress | deterministic from existence of the above rows |
No StarRocks/Analytics-API/OLAP/DQ-grade call. "No Data Yet" rendered when a source row is absent.

**6.5 Risks.** (R1) Shopify OAuth needs a public callback URL — local dev cannot test the full flow; **staging with real domain+SSL required before Shopify E2E** (02-review C5). (R2) L-02 audit-sha256 debt is a launch gate (§7). (R3) StarRocks row policies pending from Sprint-0 — must activate before any connector data flows (02-review C2; tracked as a Track 2 deploy task). (R4) zod-3 vs zod-4: pin to existing `^3.25.76`; do not bump.

**6.6 Recommendations.** Build Track 0 → {1‖3} → 2. Land migrations 001–004 before Track 2 starts. Run isolation-fuzz extension before Track 1 ships (P0 gate).

---

## 7. Pre-launch gates (BINDING acceptance — must pass before any M1 demo under a live tenant)

| Gate | Owner | Criterion |
|---|---|---|
| **L-02 audit sha256** | Track 1 + Security Reviewer | `packages/audit` djb2 stub (`stubHash`, `index.ts:73`) replaced with `crypto.createHash('sha256')`; DB-backed `AuditWriter` (replacing `NoopAuditWriter`) INSERTs into `audit_log` with real hash-chain; hourly S3 Object Lock checkpoint job deployed. **No live-tenant audit write before this is confirmed by the Security Reviewer.** |
| **NN-6 isolation-fuzz (P0)** | Track 1 + Track 2 | Harness extended from the demo table to ALL ~14 M1 tables across the 3 GUC dimensions, on the real non-superuser `brain_app` role, asserting 0 rows cross-tenant (not an error). Audit-log read path: every `packages/audit` SELECT carries `WHERE brand_id = $1` (code-path coverage test). Move from `skip` to PASS. |
| **StarRocks row policies** | Track 2 / deploy | Active on the managed cluster before `connector.connected` emits; Sprint-0 `skip` → PASS. |
| **`pnpm migrate` wiring** | Track 1 | `node-pg-migrate@^8.0.4` + scripts present; migrations 001–006 apply + reverse cleanly in CI. |

---

## 8. Demo readiness (the 6 named demos = acceptance criteria)

| Demo | Pass criterion (all persisted, real backend, RLS-enforced, audit + event emitted) |
|---|---|
| 1 — Registration | Register → verification email via `notification`/SES → verify → `app_user.email_verified_at` set; `user.registered` emitted; audit row written with **real sha256** chain |
| 2 — Workspace + Brand | Create `organization` (Owner set) → create `brand`; both RLS-isolated; `workspace.created` + `brand.created` emitted |
| 3 — Invitations | Invite (org- or brand-level) → email link → accept → `membership` row at correct scope; compound RLS (NN-7) verified; `user.invited` emitted |
| 4 — Shopify Connection | Install URL → callback **HMAC-first** (NN-4) → `secret_ref` stored (no token in DB, NN-2) → `connector_instance` + status rows; `connector.connected` emitted; status reflects real state |
| 5 — Pixel Installation | Wizard shows snippet → verify endpoint HTTP-checks `target_host` → `pixel_status.state` from real result; `pixel.installed` + `pixel.verified` emitted |
| 6 — Dashboard Shell | All 4 widgets render from the §6.4 Postgres columns; "No Data Yet" where no row; zero OLAP/StarRocks call |

---

## 9. Per-track acceptance contracts (REQUIRED pass-1 — every persona must-fix folded in)

> Every item below is a pass-1 acceptance criterion (kills the rework bounce). NN-x and persona IAH/scope findings are inlined.

**Track 0 (Contracts & Events):**
- [ ] All §5.1 API + §5.2 event Zod schemas committed; codegen (types/OpenAPI/Avro) generated + committed (I-E01); `buf-breaking` green; CODEOWNERS on `packages/contracts`.
- [ ] **NN-2 at the contract level:** `ConnectorInstance` schema has `secret_ref: z.string()` and **NO** field named `*_token`/`*_secret`/`*_key` typed as string (persona IAH-05). Semgrep scans contracts + migration DDL.
- [ ] `zod@^3.25.76` pin (no zod-4 bump). Idempotency-Key header in every mutation schema (I-ST04). Error envelope matches `sample.api.v1.ts`.

**Track 1 (Control plane):**
- [ ] **NN-1:** migrations 001–004 use the per-table GUC map (§4); two-arg fail-closed; `0001_init.sql` assertion extended to all 3 GUC names; 3-GUC middleware in `packages/db` sets all applicable GUCs + resets at checkout.
- [ ] **NN-3:** `validateSession(userId, jti)` queries `user_session.revoked_at IS NULL`; called in a `preHandler` on EVERY protected route **and** every BFF fan-out route; short fan-out token carries the original `jti` (persona IAH-03).
- [ ] **NN-5:** argon2id (m=19456,t=2,p=1) with a startup cost assertion; forgot-password **always 200, content-identical** (no enumeration, IAH-02); reset+invite tokens `crypto.randomBytes(32)` → sha256, single-use (`used_at`), expiry-enforced (reset 1h, invite 7d), timing-safe lookup (IAH-07).
- [ ] **NN-6 + NN-7:** isolation-fuzz extended to 001–004 tables incl. both `invite` variants (org-level + brand-level); audit SELECT `WHERE brand_id` coverage test (IAH-08).
- [ ] **L-02:** sha256 swap + DB-backed audit writer + hourly S3 checkpoint (pre-launch gate §7).
- [ ] `notification` minimal: `send_log` + SES adapter + `can_contact()` pass-through stub; verify/reset/invite emails via this chokepoint ONLY — no direct SES from workspace-access (I-ST05). No `consent_record`/`consent_tombstone`/`notification_pref` (scope-defer).
- [ ] Exactly-one-Owner + sole-Owner-removal guard (service layer). RBAC = 4 canon codes only; no groups/teams/custom roles (scope-defer).
- [ ] `pnpm migrate` wiring (node-pg-migrate@^8.0.4). Deploy step: ECR build (turbo --affected) → Helm → ArgoCD `core` → probe bake → auto-rollback.

**Track 2 (Connector & Pixel):**
- [ ] **NN-2:** migration 005 `connector_instance` has `secret_ref text NOT NULL` and NO token/ciphertext column; header states it; Shopify token → Secrets Manager only.
- [ ] **NN-4:** callback handler validates Shopify **HMAC first** (401 on failure, no further processing); client secret from Secrets Manager (never env); `state` nonce `crypto.randomBytes(16)`+ stored server-side keyed `(brand_id,state)`, 15-min TTL, single-use; `shop` validated `*.myshopify.com`; webhook callbacks also HMAC-validated (IAH-04).
- [ ] Shopify is concrete under `sources/storefront/shopify/` — **no IConnector/BaseConnector/plugin registry/shared OAuth util** (scope-defer); Meta/Google = zero backend.
- [ ] `connector_cursor` idempotent upsert on `(brand_id, connector_instance_id, resource)` (I-ST04). Pixel verify = HTTP HEAD/GET presence check; comment added to `packages/pixel-sdk/src/index.ts` re: requirement split (scope-defer).
- [ ] NN-6 isolation-fuzz extended to 005–006 tables. StarRocks row policy gate (§7). 4 events emitted on the correct topics. Deploy step folded in (core pipeline).

**Track 3 (Frontend):**
- [ ] 9 flows + dashboard shell; all API calls via the BFF (httpOnly cookie → short token); React Hook Form + Zod from contracts; TanStack Query; Shadcn UI.
- [ ] Dashboard reads ONLY the §6.4 Postgres columns via BFF; honest "No Data Yet"; **zero ECharts/OLAP/StarRocks** (scope-defer). Meta/Google = disabled card + tooltip, no backend call.
- [ ] UI labels per §1 role map (Owner/Admin/Manager/Analyst); Shopify connect + pixel wizard + invite-accept flows wired. Deploy step folded in (web pipeline).

---

## 10. In-lane DoD (self-check)

- [x] All sections filled (no `{{TBD}}`); cost paradigm declared + justified (Tier-1 deterministic, $0).
- [x] Single-Primitive sweep: clean — audit log (ONE, `packages/audit`), notification chokepoint (ONE, `notification` module), no per-channel forks, no connector SDK fork. Extended existing primitives (`packages/db` 3-GUC, isolation-fuzz harness, module stubs) rather than creating new ones.
- [x] Tenant isolation at every layer (3-GUC RLS + service guard + BFF assert) + observability (correlation id, audit) + real-network smoke (Shopify callback, SES, pixel HTTP verify, Testcontainers Postgres) in the test strategy.
- [x] ≥1 alternative + rejection (Authentik-backed, §6.1). Reversible migrations (up/down each). Cost estimate (0 tokens/day, $0/mo).
- [x] Every track has concrete file/dir ownership; deploy-pipeline track present for the core+web deployable changes (no new service).
- [x] All persona must-fix (NN-1..NN-7, IAH-01..08, scope defers) folded into §9 acceptance contracts as pass-1 items.
- [x] Every pinned version real (verified): `fastify@^4.29.1`, `pg@^8.21.0`, `zod@^3.25.76` (existing); `argon2@^0.44.0`, `node-pg-migrate@^8.0.4`, `jose@^6.2.3` or `jsonwebtoken@^9.0.3`, `@fastify/cookie@^9.4.0` (resolved latest-stable / fastify-4-compatible).

---

## Journal Entry

```markdown
## 2026-06-15T20:10:00Z — Architect — feat-m1-app-foundation
**Stage:** 2 · **Paradigm:** Tier-1 deterministic ($0; zero model calls — paradigm-bypass blocked) · **Tracks:** 0 contracts → {1 control-plane ‖ 3 frontend} → 2 connector+pixel
**Single-Primitive:** clean (extended packages/db 3-GUC, isolation-fuzz harness, audit sha256-swap, module stubs; no connector SDK / per-channel fork) · **Decisions encoded:** app-native auth (D0.1), canon roles owner/brand_admin/manager/analyst (D0.2), canon tables organization/membership/brand/app_user/invite (D0.3), 3-GUC RLS map (NN-1), secret_ref-only (NN-2), BFF revocation every route (NN-3), Shopify HMAC-first (NN-4), argon2id+no-enum (NN-5), isolation-fuzz all 14 tables (NN-6), compound invite RLS (NN-7); L-02 sha256 = pre-launch gate · **Next:** backend-developer (Track 0, then 1 & 2), frontend-web-developer (Track 3) — Stage 3
```

---HANDOFF---
stage: 2
decision: ADVANCE
build_tracks:
  - {track: 0, owner: backend-developer, summary: "packages/contracts Zod for all M1 APIs + packages/events 9 events (doc-07 envelope); codegen+buf-breaking; NN-2 secret_ref-only at contract level; zod@^3.25.76"}
  - {track: 1, owner: backend-developer, summary: "control plane: migrations 001-004 (app_user/user_session/password_reset/email_verification, organization/membership, brand, invite); workspace-access auth(argon2id,JWT,3-GUC RLS,revocation), org/brand/membership/invite, RBAC(4 canon roles); notification SES transactional; frontend-api BFF; packages/db 3-GUC middleware; packages/audit sha256+DB writer (L-02); pnpm migrate wiring"}
  - {track: 2, owner: backend-developer, summary: "connector+pixel: migrations 005-006 (connector_instance secret_ref-only/sync_status/cursor, pixel_installation/status); Shopify concrete OAuth HMAC-first + state nonce; pixel verify endpoint+status; 4 connector/pixel events; isolation-fuzz 005-006; StarRocks row policy gate"}
  - {track: 3, owner: frontend-web-developer, summary: "apps/web 9 flows + dashboard shell (Postgres-only, No-Data-Yet); BFF integration; role labels; Shopify connect + pixel wizard + invite-accept; Meta/Google coming-soon stubs"}
parallel_groups:
  - "SEQ-FIRST: Track 0 (contracts) blocks all"
  - "PARALLEL after Track 0: Track 1 (control plane) ‖ Track 3 (frontend against generated types)"
  - "AFTER Track 1 migrations 001-004 land: Track 2 (connector+pixel; FK to organization/brand)"
  - "shared-file owners: contracts/events=T0; packages/db 3-GUC + packages/audit + migrations 001-004=T1; migrations 005-006=T2; frontend-api BFF=T1 (T3 consumes); isolation-fuzz extended in separate files per track"
m1_tables: [app_user, user_session, password_reset, email_verification, organization, membership, brand, invite, connector_instance, connector_sync_status, connector_cursor, pixel_installation, pixel_status]
migrations:
  - "001 Auth — app_user (no RLS, service-layer), user_session/password_reset/email_verification (RLS app.current_user_id)"
  - "002 Workspace — organization + membership (RLS app.current_workspace_id; role_code CHECK 4 canon codes)"
  - "003 Brand — brand (RLS app.current_brand_id) + membership.brand_id FK + brand-level membership rule"
  - "004 Invitation — invite (compound NN-7: two PERMISSIVE policies, nullable brand_id)"
  - "005 Connector — connector_instance (secret_ref ARN only, NN-2), connector_sync_status, connector_cursor (idempotent upsert)"
  - "006 Pixel — pixel_installation, pixel_status (RLS app.current_brand_id)"
state: {status: in-development, stage: 3, owner: "backend-developer (tracks 0,1,2) + frontend-web-developer (track 3)"}
summary: |
  Binding M1 plan written: app-native auth in workspace-access (D0.1), canon roles owner/brand_admin/manager/analyst
  with UI labels (D0.2), canon tables organization/membership/brand/app_user/invite (D0.3), vertical slice migrations
  001-006 only (D0.4). All 7 NON-NEGOTIABLES encoded as per-table/per-route acceptance criteria: 3-GUC fail-closed
  RLS (NN-1), secret_ref-only connectors (NN-2), revocation on every route incl BFF (NN-3), Shopify HMAC-first +
  state nonce (NN-4), argon2id + no-enumeration + randomBytes(32) single-use tokens (NN-5), isolation-fuzz over all
  14 tables (NN-6, P0), compound invite RLS (NN-7). L-02 audit sha256 is a pre-launch gate. 4 parallel tracks
  sequenced contracts-first; deploy pipeline (core+web, no new service) + pnpm migrate wiring folded in. Tier-1
  deterministic, $0 model spend. 6 demos = acceptance. Stage 3 builders ADVANCE.
---END HANDOFF---
</content>
</invoke>
