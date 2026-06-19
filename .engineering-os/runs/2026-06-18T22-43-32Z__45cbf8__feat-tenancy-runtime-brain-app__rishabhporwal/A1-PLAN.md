# A1 (runtime brain_app cutover) — validated plan + the primitive

A1 = run the app process as the non-superuser `brain_app` so even the non-`@brain/db` paths enforce
RLS. This doc is the **validated** plan (analysis confirmed against the live DB + a proof run), plus
the reusable primitive this branch adds.

## What this branch adds (safe, no behavior change)
- **`beginRlsTxn(rawClient, ctx, appRole='brain_app')`** in `@brain/db` — the rawPgPool analogue of
  `executeInRlsTxn`: runs `BEGIN; SET LOCAL ROLE brain_app; SET LOCAL <gucs>` so a hand-rolled
  multi-statement transaction enforces RLS under the app role with the request's brand/workspace/user
  GUCs. 3 unit tests. This is the tool every control-plane site below will use. Unused until wired, so
  it changes nothing on its own.

## The GUC map (verified against pg_policies)
| RLS table (FORCE) | policy → GUC needed |
|---|---|
| `organization` | isolation → `app.current_workspace_id`; self_read → `app.current_user_id` |
| `membership` | isolation (ALL) → `app.current_workspace_id`; self_read (SELECT) → `app.current_user_id` |
| `brand` | isolation (ALL) → `app.current_brand_id`; self_read (SELECT) → user+workspace via membership |
| `invite` | org-level → `app.current_workspace_id`; brand-level → `app.current_brand_id` |
| `connector_instance` | isolation → `app.current_brand_id` |

Non-RLS (safe under brain_app with existing grants): `app_user`, `app_session`, `audit_log`, `dev_secret`.
`brain_app` already exists with `rolsuper=f, rolbypassrls=f, rolcanlogin=t` and the needed table grants.

## rawPgPool sites to wrap (apps/core)
- `onboarding.service.ts` — ALREADY GUC-wrapped (`txnClientAdapter` + `buildContextGucSql`); just needs
  `SET LOCAL ROLE brain_app` added to its BEGIN, then verify.
- `auth.service.ts` — `suspendUser`, `reactivateUser` (context upfront: workspaceId=organizationId) →
  `beginRlsTxn`. **`rotateRefreshToken`** is the DELICATE one: the session is found by token FIRST and
  the userId is only known AFTER that SELECT, so the GUC must be set MID-transaction (after identity
  is resolved), NOT at BEGIN. The acceptInvite-style txn (~line 613) already sets `app.current_user_id`
  mid-txn at 572 — same shape.
- `invite.service.ts` — create/accept invite txns → workspace (org-level) or brand (brand-level) GUC.
- `main.ts` connector blocks (Razorpay/Shopflo/Gokwik, ~1105/1183/1258) — `connector_instance` writes →
  `app.current_brand_id`.
- Vault (`ContactPiiVaultRepository`, `KmsVaultKeyProvider`) + `LocalSecretsManager` — check whether their
  tables are RLS-scoped; if not, no GUC needed (grants suffice).

## Sequencing (DSN flip is LAST — atomic)
1. Wrap every rawPgPool RLS site with `beginRlsTxn` / mid-txn `set_config`. This activates RLS on these
   paths via `SET LOCAL ROLE` **even on today's superuser connection**, so it is verifiable BEFORE any DSN
   change.
2. Verify with the live suites (the harness): `member-lifecycle` (24), `onboarding-ux` (18),
   `member-wire-smoke`, `switch-brand`, `family-wipe`. PROVEN this run: wrapped `suspendUser`/`reactivateUser`
   pass under the brain_app role for real-UUID cases (6/6).
3. Only then flip the runtime DSN to `brain_app`: core `main.ts` connects via `BRAIN_APP_DATABASE_URL`;
   `pnpm migrate` keeps the superuser `DATABASE_URL` (a separate `MIGRATION_DATABASE_URL`); update
   `.env`/compose/Terraform. Re-run the suites + a live login→brand-scoped-read smoke under brain_app.

## Gotchas found (so the PR doesn't trip on them)
- **Mock unit tests use placeholder non-UUID ids** (e.g. `'org-001'` in member-lifecycle authority tests).
  `beginRlsTxn`/`buildContextGucSql` validate UUIDs, so those fixtures must move to real UUIDs (the mock
  returns canned rows regardless of value; the cross-org test must keep its org-id MISMATCH). This is why
  this branch does NOT wire the sites yet — doing it right means updating fixtures across the suites in the
  same PR, verified, not rushed.
- `membership` SELECT passes under EITHER the workspace OR the user GUC (two permissive policies); writes
  need the workspace GUC. Set both where available.

## BLOCKER (decisive): provisioning under RLS — the create-the-first-tenant chicken-and-egg
`organization_isolation` / `brand_isolation` are `cmd=ALL` with NO explicit `WITH CHECK`, so Postgres uses
the USING expr as the INSERT check: `id = current_setting('app.current_<workspace|brand>_id')`.
- **brand**: id is APP-supplied (`INSERT INTO brand (id, …)`) → solvable (set brand GUC = new id first).
- **organization**: id is **DB-generated** (`INSERT INTO organization (name, slug, …) RETURNING id`) → the
  app cannot set `app.current_workspace_id` to an id it doesn't know yet → the insert FAILS under brain_app.

This works TODAY only because the superuser connection bypasses the check — onboarding's provisioning has
NEVER actually run under brain_app (the `txnClientAdapter` comments are aspirational). Two clean fixes,
both real work — choose in the PR:
1. **SECURITY DEFINER `provision_workspace_and_brand(...)`** *(recommended)* — one function creates org +
   2 memberships + brand + status atomically AS the owner (controlled, authorized, bypasses RLS for just
   this provisioning), returns the ids; replaces the onboarding rawPgPool txn. Audit-blessed pattern
   (`list_active_brand_ids`, `issue_invoice`, `resolve_merge_review`). Cost: 1 migration + onboarding
   refactor + onboarding test updates.
2. **App-generated ids + GUC-before-insert** — `OrganizationRepository.insert` takes an explicit id;
   onboarding generates org/brand uuids and sets the GUC to each before its insert. No migration; threads
   GUC sequencing through the provisioning txn + repo signatures.

## Final honest status
A1 is NOT a wiring tweak. Verified end-to-end, it requires: (1) a provisioning solution above, (2) mid-txn
GUCs for the token flows, (3) ~8 site wirings via `beginRlsTxn`, (4) mock-fixture UUID updates across the
suites, (5) the atomic runtime DSN flip + migration-DSN split, (6) full live re-verification of register/
login/onboard/invite/accept/suspend/connector under brain_app. Each is real; together they are a focused,
self-contained PR — NOT safely doable piecemeal. This branch ships the `beginRlsTxn` primitive + this fully
de-risked spec as the PR's foundation. A2 + A3 (keystone proof) + A4 are already done/merged.

## Status
A2 (txn-wrapped GUC in @brain/db) + A3 (the keystone brain_app proof) + A4 (StarRocks fail-closed) are
DONE/merged. A1 is this scoped, atomic follow-on; the `beginRlsTxn` primitive lands here as its foundation.
