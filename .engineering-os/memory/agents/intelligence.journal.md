# AI/ML Engineer — Journal

> Append-only. See /Users/rishabhporwal/.claude/plugins/cache/engineering-os/engineering-os/2.3.1/docs/role-empowerment-model.md for entry shape.

## 2026-06-15T07:19:27Z — system — bootstrap
**Action:** Journal initialized by /eos-init on 2026-06-15T07:19:27Z.

## 2026-06-17T01:16:00Z — AI/ML Engineer — feat-metric-engine-parity
**Stage:** 3 · **Service:** analytics/measurement · **Paradigm mix:** Tier-0 deterministic ($0/mo, 0 tokens/day, 0 model calls)
**Parity:** PASS (16/16 green, tolerance=0, RED proof captured) · **Verification:** `pnpm --filter @brain/tool-parity-oracle test:parity` → 16/16 · **Next:** READY-FOR-SECURITY

**Slices completed:**
- Slice 1 (d31fc84): metric-engine registry (D-1), withBrandTxn F-SEC-02 fix, computeRealizedRevenue Map<CurrencyCode,bigint>, eslint fence fix (D-6)
- Slice 2 (a6d4870): migration 0020 provisional_gmv_as_of SECURITY INVOKER, computeProvisionalRevenue, applied to dev PG
- Slice 3 (5ec1c50): parity oracle index.ts bigint retype, reference.ts independent SQL, golden fixtures, CI dep edge turbo.json
- Slice 4 (e9019b2): all 16 tests GREEN, RED proof: delta=1 FAIL captured + reverted GREEN

**Key invariants held:**
- Non-tautological: reference.ts imports only 'pg'; uses recognition_label='finalized' (not event_type<>'provisional_recognition')
- Per-currency: Map<CurrencyCode,bigint>, 2-brand/2-currency fixture proves no blend
- Provisional never blended into realized (F4, section F tests)
- No float anywhere in engine (no parseFloat/Math.abs)
- Isolation under brain_app (NOT superuser): cross-brand=0, no-GUC fail-closed
- CI gate fires: turbo --affected lists both @brain/metric-engine + @brain/tool-parity-oracle

## 2026-06-17T01:45:00Z — AI/ML Engineer — feat-metric-engine-parity BOUNCE r1
**Stage:** 3 BOUNCE-r1 · **Service:** analytics/measurement · **Paradigm mix:** Tier-0 deterministic
**Parity:** PASS (16/16 × 2 back-to-back, tolerance=0, unchanged) · **Verification:** two consecutive `pnpm --filter @brain/tool-parity-oracle test:parity` runs both EXIT 0, 16/16 · **Next:** READY-FOR-SECURITY (delta re-review)

**Fixes (3 commits):**
- 08dcc2f: SEC-001/SEC-004 — pr.yml postgres:16 service + job env + migration-apply step + turbo globalPassThroughEnv BRAIN_APP_DATABASE_URL
- 7d92fb8: QA-F2 — ISO-2 seeds Brand A rows (100000n INR), proves Brand B engine sees 0 (active RLS block); adds afterEach to describe D
- 7a55c10: QA-F1/SEC-002 — afterEach guards to describes D/E/F; dirty-DB determinism proven (2× back-to-back 16/16)

**Tolerance unchanged:** 0n on all parity assertions. No parity assertions weakened.
