# feat-tenancy-runtime-brain-app — status (2026-06-20)

Re-scoped against the CURRENT tree (the requirement was written 2026-06-18; A2/A4 have since shipped).

## Done
- **A2 (txn-wrap the GUC in @brain/db)** — ALREADY MERGED. `packages/db/src/index.ts` now runs every
  context query as `BEGIN; SET LOCAL ROLE brain_app; SET LOCAL <gucs>; <query>; COMMIT` (ROLLBACK on
  error) via `executeInRlsTxn` — the code comment cites "fixes audit R-01/R-02". So @brain/db traffic
  already enforces RLS even on a superuser connection.
- **A4 (StarRocks password prod fail-closed)** — MERGED as `fix/starrocks-password-fail-closed` (#65):
  `requireEnvInProd('STARROCKS_ANALYTICS_PASSWORD', …)` at all 3 sites; dev keeps the default.
- **A3 (the keystone non-inert proof)** — THIS BRANCH. `tools/isolation-fuzz/src/brain-app-runtime.test.ts`
  connects as the REAL `brain_app` LOGIN, asserts `current_user='brain_app'` + `is_superuser=off` +
  `rolbypassrls=false` FIRST (R-14), then proves through the actual app path (`createPool→connect→query`):
  own rows return (A2 works, no outage) · cross-brand read → 0 · no-GUC → 0 (fail-closed) ·
  cross-brand WRITE blocked + victim untouched. 6/6 green; full isolation suite 22/22 under brain_app.
- The `brain_app` role already exists with the correct attributes in dev: `rolsuper=f, rolbypassrls=f,
  rolcanlogin=t` (0001 creates it NOLOGIN; dev grants LOGIN+password out-of-band).

## Remaining — A1 (runtime DSN cutover) is a SEPARATE, higher-risk change
Switching the app PROCESS to connect as `brain_app` is NOT safe as a drop-in, because core's
`rawPgPool` (apps/core/src/main.ts:369) bypasses @brain/db and relies on the superuser connection to
skip RLS. ~20 call-sites use it WITHOUT setting the brand GUC:
- AuthService, InviteService, onboarding org+brand INSERTs (RLS tables), member routes, BFF routes,
  ContactPiiVaultRepository, KmsVaultKeyProvider, LocalSecretsManager, Razorpay/Shopflo/Gokwik connectors,
  and the raw `rawPgPool.connect()` clients at lines 685/1105/1183/1258.

Flipping `config.databaseUrl` → `brain_app` without first GUC-wrapping (or explicitly routing as a
documented system role) each of these would fail-close their reads/writes to 0 rows → **login + onboarding
outage** (exactly the R-01-without-R-02 coupling the requirement warns of).

### A1 plan (its own PR, with the named build tracks)
1. Classify each `rawPgPool` site: (a) brand-scoped → migrate to the @brain/db pool or `withBrandTxn`
   with the request's brand context; (b) genuine control-plane/system op on non-RLS or owner-only data
   (vault, secrets, audit_log) → keep on a documented superuser/system DSN.
2. Add a separate `MIGRATION_DATABASE_URL` (superuser) for `pnpm migrate`; point the app runtime DSN
   (`BRAIN_APP_DATABASE_URL`) at `brain_app` in `.env`/compose/Terraform.
3. Re-run brain-app-runtime.test.ts + the full suite + a live login→brand-scoped-read smoke under
   `brain_app` (no 0-row outage) before merge.

Until A1 lands, runtime isolation rests on A2's `SET LOCAL ROLE brain_app` (proven by A3) for all
@brain/db traffic; the residual exposure is the `rawPgPool` system paths, which run as owner.
