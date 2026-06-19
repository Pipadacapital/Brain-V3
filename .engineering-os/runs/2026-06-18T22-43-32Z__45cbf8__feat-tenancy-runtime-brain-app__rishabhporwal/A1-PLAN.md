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

## Status
A2 (txn-wrapped GUC in @brain/db) + A3 (the keystone brain_app proof) + A4 (StarRocks fail-closed) are
DONE/merged. A1 is this scoped, atomic follow-on; the `beginRlsTxn` primitive lands here as its foundation.
