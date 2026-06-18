# Audit Report — PASS 6 (Database) + PASS 20 (Multi-Tenancy Isolation)

**Board:** database
**Scope:** `db/migrations` (37 files), `docs/requirements/08`, `packages/db`, `packages/metric-engine` (RLS seams), `apps/core/src/main.ts`, `db/starrocks`, `infra/terraform`.
**Reviewer posture:** Independent principal. Every finding cites code/config/migration evidence.

---

## Executive summary

The migration *authoring* discipline is exceptional: nearly every brand-scoped table ships `ENABLE` + `FORCE ROW LEVEL SECURITY`, a two-arg fail-closed `current_setting('app.current_brand_id', TRUE)` policy, append-only-by-GRANT where appropriate, money-as-BIGINT guards, deterministic dedup keys, and *in-migration assertion DO-blocks* that fail the migration if the invariants regress (NN-1, FORCE-RLS, no-float, append-only). This is far above industry norm.

However, the **entire RLS edifice is inert at runtime as currently wired**, and there is **no executable rollback path**. The two highest-severity findings (C1, C2) are not theoretical — they are direct reads of `main.ts`, the Terraform RDS module, `.env.example`, `docker-compose.yml`, and the `package.json` migration scripts. The RLS policies are correct; nothing the application actually runs ever exercises them under a non-superuser role, and the IaC provisions only a superuser. Multi-tenancy isolation is, in production-as-coded, enforced by application `WHERE` clauses and a fail-closed-if-it-were-active GUC — not by the database.

**Counts:** Critical 2 · High 5 · Medium 5 · Low 3

---

## CRITICAL

### C1 — App connects as the table-owning superuser; FORCE RLS is bypassed in dev AND in the production IaC
**Severity:** Critical | **Category:** Multi-tenancy isolation / RLS enforcement

**Evidence:**
- `docker-compose.yml:20-22` — `POSTGRES_USER: brain` / `POSTGRES_PASSWORD: brain` (the superuser that owns every table).
- `.env.example:2` — `DATABASE_URL=postgres://brain:brain@localhost:5432/brain`.
- `apps/core/src/main.ts:350-353` and `:371` — both pools use `config.databaseUrl`:
  ```ts
  const rawPgPool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
  ...
  const pool = await createPool({ connectionString: config.databaseUrl });
  ```
- No `SET ROLE brain_app` anywhere in `main.ts` (grep: only `actor_role` audit strings).
- `infra/terraform/modules/rds/main.tf:127` — `username = "brainadmin"` with `manage_master_user_password = true`. The RDS module provisions **only the master/superuser**. No Terraform/bootstrap/migration resource creates a `brain_app NOSUPERUSER NOBYPASSRLS LOGIN` role, grants it, or wires the app's `DATABASE_URL` to it.
- The `brain_app` *login* role is created **only inside test fixtures** (`tools/isolation-fuzz/src/pg.test.ts:115` `CREATE ROLE ... NOSUPERUSER NOBYPASSRLS`; `BRAIN_APP_DATABASE_URL` default `postgres://brain_app:brain_app@...` exists only in `*.live.test.ts`).

**Impact (production terms):** A Postgres **superuser bypasses RLS unconditionally**, regardless of `FORCE ROW LEVEL SECURITY`. Every brand-scoped policy in migrations 0001–0036 is therefore a no-op for the running application: tenant isolation reduces to whatever application `WHERE brand_id = $1` clauses happen to be correct. One missing/incorrect `WHERE` in any query → full cross-tenant read of revenue ledgers, identity graph, contact PII, consent state, and ad spend. The migrations themselves repeatedly warn "superuser 'brain' BYPASSES → proves nothing" (e.g. `0035:28`, `0036:31`) — the authors *know* the running role must be `brain_app`, but no runtime/IaC artifact makes it so.

**Root cause:** The non-owner application role (`brain_app`) is created `NOLOGIN` in `0001_init.sql:38` with a comment "GRANT brain_app TO <app_login_role> — done at provisioning time, not in migrations." That provisioning step does not exist in the repository (not in Terraform, not in Helm, not in a bootstrap script). Dev deliberately runs as superuser (the documented `dev-db-superuser-masks-RLS` risk), and the prod IaC never closes the gap.

**Recommended fix (P0):**
1. Add a Terraform/SQL bootstrap that creates `brain_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` with a Secrets-Manager-managed password, runs the `GRANT`s, and revokes superuser DDL from the app path.
2. Point the application `DATABASE_URL` (and `rawPgPool`) at `brain_app`, keeping a separate `brainadmin` connection only for the migration runner.
3. Add a startup assertion in `main.ts`: refuse to boot if `SELECT rolsuper FROM pg_roles WHERE rolname = current_user` is true (fail-closed against accidental superuser runtime).
4. Run the existing isolation-fuzz suite against the real app connection in CI, not just a synthetic fixture role.

**Tenant Impact:** Multi-tenant, full blast radius — every tenant's data is reachable from any request if any query lacks a correct brand filter.
**Detection:** Currently silent. Would surface only as an incident (a customer seeing another brand's numbers). Add the `rolsuper` boot guard + a per-environment "current_user is brain_app" smoke test as the detector.

---

### C2 — No executable down-migrations; `migrate:down` is non-functional; rollback is comment-only
**Severity:** Critical | **Category:** Migration safety / operability

**Evidence:**
- `package.json:24-27` declares `node-pg-migrate` scripts including `"migrate:down": "node-pg-migrate -m db/migrations down"`.
- Every migration is a **plain `.sql` file** with no `-- Down`/`-- Up` markers and no `exports.down` (e.g. `db/migrations/0032_attribution_credit_ledger.sql:1` begins with a comment banner; same for all 37). `grep` for any down section returns only files whose *header comments* contain the literal word "down" in `ROLLBACK (migrate down):` prose.
- `Makefile:145` applies migrations by raw psql piping: `$(PG_PSQL) -v ON_ERROR_STOP=1 < db/migrations/0032_attribution_credit_ledger.sql`. The `ROLLBACK:` blocks (e.g. `0027:23-31`, `0018:41-48`, `0029:25-30`) are **SQL comments** — never executed.

**Impact (production terms):** There is no tested, automated rollback for any schema change. `pnpm migrate:down` will either error (node-pg-migrate cannot parse these as reversible) or silently do nothing, depending on how the file is interpreted. If a forward migration ships a defect (a bad CHECK, a wrong index, a column that breaks a hot query), the operator must hand-execute the comment-block DDL under pressure — exactly when human error is most likely. For append-only ledgers (`realized_revenue_ledger`, `attribution_credit_ledger`) the comments even hand-wave "drop is safe, rebuildable from Bronze," but no rebuild automation is invoked by the rollback.

**Root cause:** A schema-management tool (`node-pg-migrate`) is declared in `package.json` but the actual workflow is "psql the next numbered `.sql` file." The two were never reconciled; reversibility was documented as prose instead of code.

**Recommended fix (P1):** Either (a) convert migrations to node-pg-migrate's reversible format (`exports.up`/`exports.down`, or paired `*_up.sql`/`*_down.sql`) and make `migrate:down` actually run them, or (b) drop the misleading `migrate:down` script and adopt an explicit forward-only + restore-from-snapshot policy documented in a runbook. Add a CI check that the declared tool and the applied mechanism agree.
**Tenant Impact:** Platform-wide — a bad migration blocks/corrupts all tenants until manual remediation.
**Detection:** Surfaces during an incident rollback attempt; add a CI smoke test that runs `migrate up` then `migrate down` against a throwaway DB.

---

## HIGH

### H1 — `@brain/db` GUC middleware sets `SET LOCAL` outside a transaction; the GUC does not apply to the subsequent query
**Severity:** High | **Category:** RLS correctness

**Evidence:** `packages/db/src/index.ts:200-211`:
```ts
const gucSql = buildContextGucSql(ctx);          // "SET LOCAL app.current_workspace_id = '...'"
if (gucSql) { await rawClient.query(gucSql); }    // round-trip #1 (autocommits)
const result = await rawClient.query(sql, params); // round-trip #2 — separate txn
```
`buildSetGucSql` (`:94-97`) and `buildContextGucSql` (`:118-133`) emit `SET LOCAL`. There is no `BEGIN`/`COMMIT` around the pair. The BFF routes use exactly this path: `bff.routes.ts:658` `pool.connect()` → `OrganizationRepository(client)` → `client.query(ctx, sql, params)`.

**Impact:** `SET LOCAL` outside an explicit transaction block is scoped to the *current statement/transaction* only; under pg autocommit each `query()` is its own transaction, so the GUC set in round-trip #1 is discarded before round-trip #2 runs the real SQL. The actual query therefore executes with **no GUC set**. Because the policies are two-arg fail-closed, this fails *safe* to 0 rows (not a leak) — but it means every BFF read via this path would return empty if RLS were active. Today it is masked by C1 (superuser ignores the GUC entirely and returns data). The moment C1 is fixed, all `@brain/db`-path reads break (0 rows) until this is fixed too. The metric-engine path is correct (`packages/metric-engine/src/deps.ts:39-60` `withBrandTxn` wraps `BEGIN` + `set_config(...,true)` + work + `COMMIT`); the `@brain/db` path is the divergent one.

**Root cause:** Two parallel DB access layers (`@brain/db` createPool vs `withBrandTxn`); only the latter got the F-SEC-02 transaction fix (`deps.ts:7-12` references it). The `@brain/db` "reset-all-then-set-per-query" design assumed `SET LOCAL` persists across autocommit statements on the same checked-out client — it does not.
**Recommended fix (P1):** Wrap the GUC-set + query in a single transaction in `createPool().connect().query()`, or switch to `SELECT set_config(name, val, false)` (session scope) paired with the existing checkout RESET, or route all reads through `withBrandTxn`. Add a live test under `brain_app` proving a BFF read returns the brand's rows (it would currently return 0).
**Tenant Impact:** Correctness (not leak) — fail-closed. Becomes a hard outage of BFF reads once C1 lands.
**Detection:** Would surface as "dashboard shows no data" immediately after switching to `brain_app`.

### H2 — StarRocks Silver/Gold tier has NO engine-level row policy; tenant isolation is app-seam-only
**Severity:** High | **Category:** Multi-tenancy isolation (analytics tier)

**Evidence:** `db/starrocks/row_policy_template.sql:46-53` and `db/starrocks/bootstrap.sql:51-67` — `CREATE ROW POLICY` is "an enterprise/managed StarRocks feature… open-source allin1 does NOT support it," commented out as a future "M1 STEP." Isolation rests entirely on `packages/metric-engine/src/silver-deps.ts:15-24`: the `withSilverBrand` seam appends `AND brand_id = ?` and sets `SET @brain_current_brand_id`. `apps/core/src/main.ts:361-369` connects `srPool` as `brain_analytics` (SELECT-only) but the engine-level filter is absent.

**Impact:** Unlike Postgres FORCE RLS (defense in the DB), the Silver/Gold tenant boundary is a single application choke point. Any code path that issues a raw `srPool.query(...)` bypassing `withSilverBrand`, or any bug in the predicate-injection seam, yields a cross-brand analytics read with no database backstop. The `brand_id = ''` → "matches nothing" semantics only protect *if* the policy is actually applied — and it is not in any environment the repo provisions.
**Root cause:** Dev uses the open-source StarRocks allin1 image that lacks row policies; the production application of the policy is a manual, un-automated step.
**Recommended fix (P1):** Make the row-policy application a provisioned, asserted step on staging/prod StarRocks (or move Silver reads behind a view that enforces the predicate); add a non-superuser isolation-fuzz gate that runs against the real cluster and fails loud if a plain SELECT returns cross-brand rows.
**Tenant Impact:** Multi-tenant on the analytics plane (order-state, ROAS, funnel reads).
**Detection:** `tools/isolation-fuzz/src/starrocks.test.ts` is designed to fail loud, but only runs against dev where the policy can't exist — so it cannot detect the prod gap.

### H3 — No `statement_timeout`; single shared 10-connection pool; no per-tenant query quota → noisy-neighbor
**Severity:** High | **Category:** Multi-tenancy / scalability ceiling

**Evidence:** `apps/core/src/main.ts:371` — `createPool({ connectionString: config.databaseUrl })` passes **no** `statementTimeoutMs` and **no** `maxConnections`. `packages/db/src/index.ts:182-184` defaults `max: 10` and `statement_timeout: undefined`. `rawPgPool` (`main.ts:350`) caps at `max: 5`. The only rate limiting (`rate-limiter.ts`) is keyed on auth flows by email/IP (`loginFailKeySync`, `registerIpKey`, etc., `:63-81`) and is **fail-open** (`:43-47`). There is no per-brand DB-level connection partitioning or query quota anywhere.

**Impact:** A single tenant running an expensive dashboard/range query has no statement timeout and competes for 10 shared connections. One runaway query saturates the pool and degrades every other tenant (classic noisy-neighbor). Fail-open rate limiting means a Redis outage removes even the auth throttle. This is the practical scalability ceiling: there is no mechanism to bound any one tenant's DB load.
**Root cause:** Pool created with defaults; rate limiting scoped to auth abuse, not data-plane fairness.
**Recommended fix (P2):** Set `statement_timeout` (e.g. 5–15s for interactive reads, higher for batch) on the read pool; size the pool deliberately; add per-brand concurrency/quota (e.g. a Redis token bucket keyed on brand_id at the read seam) and make the limiter fail-closed for non-auth data reads or add a backstop.
**Tenant Impact:** Multi-tenant — one heavy tenant degrades all.
**Detection:** P95 latency spikes + pool-exhaustion errors; no current per-brand metric to attribute it.

### H4 — `dev_secret` stores connector credentials with full DML to `brain_app` and no RLS
**Severity:** High | **Category:** Secret storage / isolation

**Evidence:** `db/migrations/0024_dev_secret.sql:20-35` — table `dev_secret(name, secret_value, …)` keyed by ARN-name, **no RLS**, `GRANT SELECT, INSERT, UPDATE, DELETE ON dev_secret TO brain_app`. The comment scopes it "DEV ONLY" and says the Local/Worker secrets managers "hard-fail in production," but the migration runs in every environment and grants the app role unrestricted DML over plaintext connector credentials.
**Impact:** In dev (and any environment where this migration is applied and the prod guard is mis-set), connector OAuth tokens live in a non-RLS Postgres table any brand context can read/write/delete — a cross-tenant credential store. Even as a dev stand-in, it widens the blast radius of the C1 superuser issue (tokens for all brands in one unprotected table).
**Root cause:** A dev convenience (cross-process token sharing) implemented as a real migrated table rather than a dev-only, environment-gated artifact.
**Recommended fix (P2):** Gate this migration to non-prod (or a separate dev-only migration set), scope grants to a dedicated dev role, and add a runtime assertion that the table is empty/absent in prod. Verify the "hard-fail in prod" guard in `LocalSecretsManager`/`WorkerLocalSecretsManager` is enforced and tested.
**Tenant Impact:** Cross-tenant for connector credentials wherever applied.
**Detection:** No current detector; add a prod boot check that `dev_secret` has zero rows / does not exist.

### H5 — Duplicate migration sequence number `0033` (two files) — non-deterministic apply order
**Severity:** High | **Category:** Migration safety

**Evidence:** `db/migrations/0033_consent_record_tombstone.sql` AND `db/migrations/0033_send_log.sql` both exist (and `0029_ad_spend.sql:7-9` already documents a prior numbering collision with 0028). Migrations are applied by filename sort; two `0033_*` files mean apply order depends on lexical tie-break (`consent` < `send`), and any tracking table keyed on a numeric version could conflict.
**Impact:** Ambiguous/duplicated version identity. Under `node-pg-migrate`'s version tracking, a duplicate numeric prefix can cause one file to be skipped or a "version already applied" conflict; under the psql-pipe Makefile it "works by luck" of sort order. New collisions are likely given the history of off-by-one renumbering.
**Root cause:** Concurrent feature branches both claimed 0033; no CI guard rejecting duplicate prefixes.
**Recommended fix (P2):** Renumber one file; add a CI check that migration numeric prefixes are unique and monotonic.
**Tenant Impact:** Platform-wide (schema integrity).
**Detection:** CI lint on the migrations directory.

---

## MEDIUM

### M1 — `audit_log` has RLS explicitly DISABLED; per-brand row isolation is application-only
**Severity:** Medium | **Category:** Isolation / audit integrity
**Evidence:** `0001_init.sql:105-109` — `ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY` with `GRANT INSERT, SELECT ON audit_log TO brain_app` (`:101-102`). The comment justifies it (cross-brand system events) and relies on the app inserting only its own brand's rows plus the hash-chain for tamper evidence. But `brand_id` is a column with no DB-level filter: any read of `audit_log` returns all brands' audit rows under `brain_app`. Combined with C1 (superuser), audit reads are fully cross-tenant.
**Impact:** A bug or misuse in any audit-read path exposes every brand's audit trail (actor, action, entity, payload). The hash-chain protects integrity, not confidentiality.
**Recommended fix (P2):** If a per-brand audit view is ever exposed to tenants, add an RLS SELECT policy (system writer keeps a definer function for cross-brand inserts), or front audit reads with a brand-scoped function.
**Tenant Impact:** Multi-tenant on audit reads.
**Detection:** Code review of any audit-read endpoint.

### M2 — `brand_keyring` has RLS disabled; SELECT granted to `brain_app` across all brands
**Severity:** Medium | **Category:** Key management isolation
**Evidence:** `0001_init.sql:142-148` — `GRANT SELECT ON brand_keyring TO brain_app` + `ALTER TABLE brand_keyring DISABLE ROW LEVEL SECURITY`, relying on an application `WHERE brand_id = $1`. `wrapped_dek_b64` for every brand is readable under one app role with no DB filter.
**Impact:** Although the wrapped DEK is useless without KMS, removing the DB-level brand filter means a query bug enumerates all brands' key references and KMS key IDs (`kms_key_id`), aiding lateral mapping. With C1, fully cross-tenant.
**Recommended fix (P2):** Add an RLS SELECT policy scoped to `app.current_brand_id`, or move DEK reads behind a brand-scoped definer function.
**Tenant Impact:** Multi-tenant on key metadata.
**Detection:** Review of keyring read path.

### M3 — `contact_pii` elevated policy depends on an `app.role` GUC never set by the standard write path
**Severity:** Medium | **Category:** RLS correctness / PII access
**Evidence:** `0017_identity_graph.sql:239-247` — policy requires `brand_id = current_setting('app.current_brand_id', TRUE) AND current_setting('app.role', TRUE) = 'send_service'`, with `GRANT SELECT, INSERT`. But `withBrandTxn` (`deps.ts:48`) sets only `app.current_brand_id`, never `app.role`; the `@brain/db` middleware (`index.ts:118-133`) has no `app.role` GUC at all (only brand/workspace/user). 
**Impact:** Correct *read* behavior (non-send paths get 0 PII rows — good, fail-closed). But the **INSERT** path that writes contact PII must also run under a context that sets `app.role='send_service'`, and the only GUC plumbing in `packages/db` doesn't support `app.role`. Any PII write must use a bespoke connection that sets it; this is undocumented in the shared DB layer and easy to get wrong (a write under the standard path will be filtered to 0 rows / fail). Worth verifying the send-service writer actually sets it.
**Recommended fix (P3):** Add `app.role` (and a `role`/`sendService` flag) to `QueryContext` + the GUC builders so the elevated path is first-class and testable; assert a live test that contact_pii is readable only with the role set.
**Tenant Impact:** Single-path (PII), correctness.
**Detection:** PII send path returning 0 rows unexpectedly.

### M4 — `connector_instance.razorpay_account_id` / `ad_account_id` indexed globally, but uniqueness not enforced per provider → webhook brand-resolution ambiguity
**Severity:** Medium | **Category:** Schema constraints / cross-tenant routing
**Evidence:** `0027_razorpay_settlement.sql:64-66` and `0029_ad_spend.sql:53-55` create **non-unique** partial indexes on `razorpay_account_id` / `ad_account_id`. `resolve_razorpay_connector_by_account()` (`0027:221-241`) does `LIMIT 1` over `WHERE razorpay_account_id = $1 AND status='connected'`. The only uniqueness is `UNIQUE (brand_id, provider)` (`0006:35`), not `(provider, account_id)`.
**Impact:** If two brands ever connect the same Razorpay/ad account id (mis-config, shared agency account, test/prod overlap), the SECURITY DEFINER resolver `LIMIT 1` deterministically routes a webhook to *whichever row sorts first* — a cross-tenant settlement/spend write. The resolver picks a brand from the DB row (good practice, MT-1), but the DB allows two candidate brands.
**Recommended fix (P2):** Add `UNIQUE (provider, razorpay_account_id) WHERE razorpay_account_id IS NOT NULL` (and analogously for `ad_account_id`), or have the resolver hard-fail (not `LIMIT 1`) when >1 row matches.
**Tenant Impact:** Cross-tenant for a specific mis-config; financial data.
**Detection:** Reconciliation mismatch; add a uniqueness assertion.

### M5 — Doc/code divergence: data-model doc references node-pg-migrate reversibility the code does not implement
**Severity:** Medium | **Category:** Architecture-vs-code divergence
**Evidence:** `package.json:24-27` advertises reversible migrations (`migrate:down`, `migrate:create`) and the migration headers carry `ROLLBACK (migrate down):` sections (e.g. `0016:19`, `0017:21-22`, `0018:41-48`) implying an executable down path. The implemented mechanism is forward-only psql piping (`Makefile:145`). This is the documentation-vs-auditable-code gap of C2, called out separately because the *artifacts claim a capability that does not exist*.
**Impact:** Operators and reviewers are misled into believing rollback is automated.
**Recommended fix (P2):** Align docs/scripts with reality (see C2).
**Tenant Impact:** Operational.
**Detection:** First rollback attempt.

---

## LOW

### L1 — No `updated_at` triggers; `updated_at` columns rely on application discipline
**Severity:** Low | **Category:** Schema correctness
**Evidence:** Many tables declare `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (e.g. `brand` `0004:26`, `connector_instance` `0006:32`, `organization` `0003:25`) but there is no `BEFORE UPDATE` trigger to maintain it; the only trigger present is the currency-match guard (`0018:129`). `updated_at` is only correct if every app UPDATE remembers to set it.
**Impact:** Stale `updated_at` on rows mutated by paths that forget it → unreliable change-tracking / cache invalidation.
**Recommended fix (P3):** Add a shared `set_updated_at()` trigger, or document that `updated_at` is app-maintained.
**Detection:** Audit of update paths.

### L2 — `collector_spool` is unbounded append with no retention/archival job wired
**Severity:** Low | **Category:** Scalability / retention
**Evidence:** `0015_collector_spool.sql:12-13,36-38` — "No DELETE — spool rows are append-only; archival is a future housekeeping job." `brain_app` has SELECT/INSERT/UPDATE only; nothing reclaims drained rows. The hot partial index `WHERE status='pending'` stays small, but the heap grows unbounded.
**Impact:** Table/heap bloat over time; eventual vacuum/storage pressure on the ingest hot path.
**Recommended fix (P3):** Schedule a retention job to archive/delete `status='drained'` rows past a window.
**Detection:** Table-size growth metric.

### L3 — `realized_revenue_ledger.fx_rate_id` references a non-existent table; forward-FK gap
**Severity:** Low | **Category:** Schema constraints
**Evidence:** `0018_realized_revenue_ledger.sql:81` — `fx_rate_id UUID NULL` with comment "M1 single-currency → always NULL; no FK (no fx_rate table yet)." A nullable orphan column with no referential integrity awaiting a future table.
**Impact:** When multi-currency lands, historical rows have an unconstrained column; risk of dangling references if the FK is added without backfill validation.
**Recommended fix (P3):** Track the deferred FK explicitly; add the constraint with validation when `fx_rate` ships.
**Detection:** Multi-currency rollout review.

---

## What is genuinely strong (for balance)
- **RLS authoring discipline:** Every brand-scoped business table (`brand`, `connector_*`, `pixel_*`, `bronze_events`, the full identity graph in `0017`, `realized_revenue_ledger`, `ad_spend_ledger`, `attribution_credit_ledger`, `consent_record`/`consent_tombstone`, `send_log`, `capi_passback_log`/`capi_deletion_log`, `dq_check_result`, `ai_provenance`, `connector_razorpay_order_map`) ships `ENABLE` + `FORCE` RLS with the two-arg fail-closed policy. The deliberate exceptions (`app_user` `0002:42`, `audit_log`, `brand_keyring`, `collector_spool`, `dev_secret`) are each documented (though M1/M2/H4 flag the trade-offs).
- **In-migration assertion DO-blocks** that fail the migration on NN-1 one-arg regression, missing FORCE RLS, non-BIGINT money, or append-only GRANT violations (e.g. `0029:257-348`, `0035:71-164`, `0027:389-455`). This is self-verifying schema — excellent.
- **SECURITY DEFINER enumeration functions** for cross-tenant system jobs are correctly `SET search_path = public`, `STABLE`, and guarded by prosecdef/search_path/EXECUTE assertions (`0027:190-387`, `0029:146-255`).
- **Tenant-first composite PKs** and deterministic dedup unique indexes throughout (idempotent replay), and money as `BIGINT` minor units paired with `currency_code` everywhere.
- **Index coverage** for the documented hot paths (as-of scans, latest-per-category, brand+date ranges, partial indexes for pending/active) is appropriate.

The schema design and RLS *policies* are top-tier. The gap is entirely in **runtime role provisioning (C1)** and **rollback executability (C2)** — fix those two and the multi-tenancy posture moves from "documented but inert" to "enforced by the database."
