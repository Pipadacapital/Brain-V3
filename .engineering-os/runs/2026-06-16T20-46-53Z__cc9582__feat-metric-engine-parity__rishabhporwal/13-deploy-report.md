# 13 — Deploy Report — feat-metric-engine-parity

**Stage:** 8 (Platform/SRE) · **Phase:** 1-dev-only · **Date:** 2026-06-17T02:20:00Z
**Branch:** `feat/metric-engine-parity` · **Base:** `master` · **HEAD:** `facacfe`
**Stakeholder decision:** APPROVED 2026-06-17T02:15:00Z

---

## 1. Migration 0020 — verified

**Command run:**
```
docker exec brainv3-postgres-1 psql -U brain -d brain \
  -c "SELECT proname, prosecdef FROM pg_proc WHERE proname='provisional_gmv_as_of';"
```

**Result:**
```
        proname        | prosecdef
-----------------------+-----------
 provisional_gmv_as_of | f
(1 row)
```

- `proname = provisional_gmv_as_of` — function is present.
- `prosecdef = f` — SECURITY INVOKER confirmed (not SECURITY DEFINER; RLS applies under `brain_app`).
- Migration was applied by the builder (Slice 2 commit `a6d4870`). Idempotent: `CREATE OR REPLACE FUNCTION`.
- Assertion block in the SQL itself validates both existence and `prosecdef = false` at apply time.

**Down migration (reversibility):** `DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date);`

---

## 2. Build gate — typecheck (EXIT 0)

**Command:** `pnpm turbo run typecheck --filter=@brain/metric-engine --filter=@brain/tool-parity-oracle --filter=@brain/core --filter=@brain/money`

| Package | Result |
|---|---|
| `@brain/metric-engine` | PASS |
| `@brain/tool-parity-oracle` | PASS |
| `@brain/core` | PASS |
| `@brain/money` | PASS |

**Turbo summary:** 16 tasks successful, 16 total. Time: 1.924s.

---

## 3. Parity gate — M1 'parity oracle green' exit criterion — GREEN 16/16

**Command:** `pnpm turbo run test:parity`

**Result:** 16/16 tests passed. Tolerance: 0 (exact `bigint` equality). Duration: 277ms.

### Golden fixtures (live Postgres, `brain_app` pool, RLS active)

| Fixture | Engine result | Reference result | Delta | Status |
|---|---|---|---|---|
| F1 clean_finalized | `{INR: 50000n}` | `{INR: 50000n}` | `0n` | PASS |
| F2 full_rto_to_zero | `{INR: 0n}` | `{INR: 0n}` | `0n` | PASS |
| F3 partial_refund | `{INR: 35000n}` | `{INR: 35000n}` | `0n` | PASS |
| F4 provisional_plus_finalized | realized `{INR: 50000n}`, prov `{INR: 20000n}` | realized `{INR: 50000n}` | `0n` | PASS |
| F5 two_brand_two_currency | A: `{INR: 50000n}`, B: `{AED: 30000n}` | A: `{INR: 50000n}`, B: `{AED: 30000n}` | `0n` | PASS |

### RED proof (non-tautological confirmation)

```
FAIL: TS=50001 REF=50000 delta=1 > tolerance=0 — parity drift detected
→ reverted → PASS: TS=50000 REF=50000 delta=0 <= tolerance=0
```

Gate is real: a 1-minor-unit perturbation fails CI. Not a tautology.

### Independence confirmed

`reference.ts` sole import: `import type { PoolClient } from 'pg'`. No call to `realized_gmv_as_of`, `provisional_gmv_as_of`, or `@brain/metric-engine`. Structurally different predicate: `recognition_label = 'finalized' GROUP BY currency_code` vs engine's `event_type <> 'provisional_recognition'` (scalar).

### CI wiring (pr.yml)

- Line 68-69: `pnpm turbo run test:parity --affected` — no `continue-on-error` — BLOCKING.
- Lines 17-30: `services: postgres:16` (health-checked) — SEC-001 fix: CI now runs live-DB.
- Line 32: `BRAIN_APP_DATABASE_URL=postgres://brain_app:brain_app@localhost:5432/brain` — `brain_app` NOBYPASSRLS provisioned before parity runs (lines 43-61).
- Line 61: `pnpm migrate:up` runs all 0001–0020 migrations before `test:parity`.
- Turbo dependency edge: `tools/parity-oracle/turbo.json` declares `test:parity dependsOn: [@brain/metric-engine#build, ^build]` — engine changes trigger oracle in affected set.

---

## 4. Smoke / bake proxy

No new deployable; no new service/container/GitOps app. `packages/metric-engine` is an in-process library (already declared `workspace:*` in `apps/core/package.json`); `tools/parity-oracle` is CI-only.

The committed parity suite (16/16 live-PG) is the bake proxy. Engine ships as part of `core`'s next image build (unchanged build pipeline). Migration 0020 applies via the existing additive-migration path (node-pg-migrate, same as 0018/0019).

---

## 5. PR status

**gh CLI:** unauthenticated (exit 1 on `gh auth status`).

**Manual compare URL:** https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/metric-engine-parity

Branch `feat/metric-engine-parity` is clean off master (not stacked). Not pushed yet (dev-only phase). Push when ready: `git push -u origin feat/metric-engine-parity` then open the compare URL above.

**Commits on branch (9):**
- `d31fc84` feat(metric-engine): Slice 1 — registry + realized engine + deps + eslint fence fix
- `a6d4870` feat(metric-engine): Slice 2 — provisional_gmv_as_of migration (0020) + provisional engine
- `5ec1c50` feat(parity-oracle): Slice 3 — independent reference + golden fixtures + CI dep edge + bigint fix
- `e9019b2` feat(parity-oracle): Slice 4 — full parity suite GREEN + RED proof + isolation tests
- `08dcc2f` fix(ci): SEC-001/SEC-004 — provision postgres:16 service + brain_app role + migrations in lint-typecheck-unit job
- `7d92fb8` test(parity-oracle): QA-F2 — strengthen ISO-2 to prove RLS blocks cross-brand
- `7a55c10` test(parity-oracle): QA-F1/SEC-002 — add afterEach guards to describes D/E/F
- `a8eb637` chore(eos): Stage 3 developer report + journal + live.log
- `facacfe` chore(eos): BOUNCE r1 — developer report + journal + live.log

---

## 6. Rollback

**Additive migration — rollback is:**
```sql
DROP FUNCTION IF EXISTS provisional_gmv_as_of(uuid, date);
```

No table was created or altered. No existing function was modified. The engine is an in-process library — reverting the `core` image to the prior SHA removes engine code. The parity oracle is CI-only and has no prod footprint.

`realized_gmv_as_of` (0018) and all existing tables are unaffected.

---

## 7. Tech-debt carry-forward

| Item | Severity | Must-fix milestone | Detail |
|---|---|---|---|
| **F-SEC-02** (old `GetRealizedGmvAsOf` GUC-reset) | P2 MED | **Before Phase-2** | Pre-existing: `GetRealizedGmvAsOf.execute()` sets `set_config(...,true)` with no wrapping BEGIN/COMMIT under autocommit — GUC local-scope may reset on pool reuse. Worst case: fail-closed (two-arg `current_setting(...,TRUE)` → NULL → 0 rows). NEW engine path uses `withBrandTxn` (correct-by-construction). The old query path is NOT regressed by this slice. |
| **QA-F1** dirty-DB idempotency | LOW | M2 | Local-dev only; CI starts clean. First-run may see stale seed from prior test run without afterEach cleanup. afterEach added for critical describes but not exhaustively. |
| **QA-F2** ISO-2 absence-vs-block | LOW | M2 | Strengthened in the bounce (active RLS block confirmed: Brand B query for Brand A's currency returns `0n`). Residual: row-count assertion not verified separately from aggregate. |
| **Recommended /adopt-rule** | Advisory | Next ledger/identity slice | Cross-tenant system jobs should use `list_active_brand_ids` (SECURITY DEFINER enumeration) to iterate brands — identity re-eval + ledger finalization pattern. 2nd occurrence of this pattern. Stakeholder `/adopt-rule` pending. |

---

## 8. Observability note (phase-1 dev-only)

No new service, no new dashboard required. The parity gate IS the observability surface for this slice (CI-blocking live-DB assertion on every PR). When `core` next deploys with the engine wired in, the existing `core` dashboard/alarms cover it — no new alarm needed (no new endpoint/job surface).

Phase-2 promotion needs: real infra postgres (RDS/managed), `brain_app` NOBYPASSRLS role provisioned in prod DB, `pnpm migrate:up` in the deploy pipeline before `core` starts.
