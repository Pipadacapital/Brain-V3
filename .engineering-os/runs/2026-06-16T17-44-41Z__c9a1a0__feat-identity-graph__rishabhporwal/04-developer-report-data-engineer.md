# Developer Report — Data Engineer — feat-identity-graph

**Stage:** 3 (Build) · **Layer:** stream+batch+lakehouse · **Tier:** deterministic
**Timestamp:** 2026-06-16T22:30:00Z · **Branch:** feat/identity-graph
**Req ID:** feat-identity-graph

---

## Files Produced

### New files

| File | Role |
|------|------|
| `/Users/rishabhporwal/Desktop/Brain V3/db/migrations/0017_identity_graph.sql` | Identity graph schema (8 tables + brand columns), FORCE RLS, two-arg fail-closed, contact_pii elevated policy, NN-1 assertion block |
| `/Users/rishabhporwal/Desktop/Brain V3/packages/identity-core/src/index.ts` | Real SHA-256 (stubSha256 deleted), E.164 phone norm, CONFORMANCE_EMAIL_VECTOR |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/infrastructure/secrets/SaltProvider.ts` | Per-brand salt fetch + 32-byte guard + 5-min cache |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/domain/identity/IdentityResolver.ts` | Pure deterministic resolution algorithm (v1-deterministic) + computeMergeId |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/domain/identity/SharedUtilityPolicy.ts` | Phone-guard threshold evaluation (windowed, D-1) |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts` | One-txn write (set_config GUC + all INSERTs ON CONFLICT DO NOTHING) + readState |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/application/ResolveIdentityUseCase.ts` | Extract → normalize → hash → resolve → write; @effort(deterministic) |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` | KafkaJS consumer, mirrors CollectorEventConsumer offset/DLQ discipline |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/jobs/phone-guard-reeval.ts` | Argo-job entry point: windowed re-evaluation of suppressed phones |
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/tests/identity.e2e.test.ts` | 26-test suite against live PG (all pass) |

### Modified files

| File | Change |
|------|--------|
| `/Users/rishabhporwal/Desktop/Brain V3/apps/stream-worker/src/main.ts` | Wired IdentityBridgeConsumer alongside CollectorEventConsumer (D-7, no new deployable) |
| `/Users/rishabhporwal/Desktop/Brain V3/packages/identity-core/package.json` | Added @types/node devDep for node:crypto types |

---

## Slice Dispositions

### Slice 1 — mig 0017 + real SHA-256 + SaltProvider
**Commit:** `8ac9771`

- Migration `0017_identity_graph.sql` applied. 8 identity tables created with ENABLE+FORCE RLS on all. Policies all two-arg fail-closed.
- `brand.identity_salt_ciphertext BYTEA`, `phone_guard_threshold INT DEFAULT 10`, `suppression_window_days INT DEFAULT 30` added additively.
- `stubSha256` (MurmurHash variant) deleted. Real `node:crypto` SHA-256 implemented. CONFORMANCE_EMAIL_VECTOR exported.
- E.164 normalization: `normalizePhone(raw, regionCode)` returns `{normalized, confidence}`. Default region 'IN'. `+91` prefix applied for 10-digit and 11-digit (leading-0) Indian numbers.
- `SaltProvider.forBrand(brandId)` → 32-byte Buffer; throws on empty/null fetch, wrong length. Never defaults.

### Slice 2 — deterministic resolver + idempotent bridge writer
**Commit:** `a8a52d1`

- `IdentityResolver.resolve()`: pure domain, zero DB/Kafka imports. 0-match → mint; 1-match → link; ≥2-match → merge (canonical=lowest UUID); cycle-guard routes to review queue.
- `computeMergeId(brand, canonical, merged)` → UUID-formatted deterministic ID from SHA-256 of inputs + 'v1-deterministic' rule_version (D-4).
- `IdentityRepository.writeOutcome()`: ONE transaction — set_config brand GUC → customer/link/merge/alias INSERTs ON CONFLICT DO NOTHING → COMMIT. contact_pii additionally sets `app.role=send_service` in same txn.
- `IdentityBridgeConsumer`: mirrors CollectorEventConsumer exactly — autoCommit:false, DLQ@MAX_RETRY=5, offset committed only after write confirmed.
- Wired to main.ts: same process, same DB URL (brain_app), same Kafka instance. Graceful drain of both consumers on SIGTERM.

### Slice 3 — phone-guard + contact_pii gate + re-eval job
**Commit:** `dd96233`

- Phone-guard fully integrated in Slice 2 (IdentityResolver + IdentityRepository). Slice 3 added the Argo re-eval job.
- `phone-guard-reeval.ts`: reads brands, fetches expired suppressions, re-counts windowed distinct brain_ids, un-suppresses if below threshold, extends if still above. Connects as brain_app + per-brand GUC.

### Slice 4 — tests (26/26 pass against live PG)
**Commit:** `c9278a3`

All 26 tests pass. Details in proofs section below.

---

## Proofs

### Isolation + contact_pii send_service gate (verified under SET ROLE brain_app)

```
-- Correct brand GUC → 1 row (positive control)
BEGIN;
  set_config('app.current_brand_id', '11111111-...', true)
  SET ROLE brain_app; SELECT current_user → 'brain_app'
  SELECT COUNT(*) FROM customer → 1
ROLLBACK;

-- Wrong brand GUC → 0 rows (cross-brand isolation)
BEGIN;
  set_config('app.current_brand_id', '22222222-...', true)
  SET ROLE brain_app;
  SELECT COUNT(*) FROM customer → 0
ROLLBACK;

-- contact_pii: correct brand + NO send_service → 0 rows (D-3)
BEGIN;
  set_config('app.current_brand_id', '11111111-...', true)
  SET ROLE brain_app; SELECT current_user → 'brain_app'
  SELECT COUNT(*) FROM contact_pii → 0
ROLLBACK;

-- contact_pii: correct brand + send_service → 1 row
BEGIN;
  set_config('app.current_brand_id', '11111111-...', true)
  set_config('app.role', 'send_service', true)
  SET ROLE brain_app;
  SELECT COUNT(*) FROM contact_pii → 1
ROLLBACK;
```

### No raw PII in identity_link

Test output (26 tests):
- `identity_link.identifier_value` always matches `/^[0-9a-f]{64}$/`
- Never contains `@` character (no raw email stored)
- Never equals the raw email/phone input
- Matches the expected `sha256(salt||normalized)` hex

### Salt hard-fail proof

`SaltProvider`:
- `getSecret('')` (empty ARN) → LocalSecretsProvider throws `[LocalSecretsProvider] Empty secret value` → SaltProvider wraps and re-throws `[identity-bridge] salt fetch failed...`
- `Buffer.from(hex, 'hex').length !== 32` → throws `[identity-bridge] salt for brand X is Y bytes; expected 32 bytes. Refusing...`
- Guard is at lines 88–94 of SaltProvider.ts: `if (!salt || salt.length !== 32) throw new Error(...)`
- Test: `SaltProvider hard-crash guard` suite (4 tests, all pass)

### Phone-guard proof (N=10 boundary)

Setup: 10 distinct brain_ids with shared phone hash (medium-tier identity_links, simulating prior activity).
Windowed count at resolution time = 10. `existingCount (10) + 1 > threshold (10)` = TRUE → phone suppressed.
11th event: phone excluded from merge key set → minted as separate brain_id.
Verification: `shared_utility_identifier` row created with `profile_count >= 10`.
All 10 original brain_ids remain distinct (0 merge_events between them).
Test suite: `Phone-guard` suite (3 tests, all pass).

### Replay idempotency proof

- `computeMergeId(brand, canonical, merged)` → same UUID-formatted SHA-256 for same inputs.
- `INSERT INTO identity_merge_event ... ON CONFLICT (merge_id) DO NOTHING` → 3× replay → 1 row.
- `INSERT INTO brain_id_alias ... ON CONFLICT (brand_id, observed_brain_id) WHERE valid_to IS NULL DO NOTHING` → 3× → 1 live alias.
- Test: `Replay idempotency` suite (2 tests, pass).

### Grep proof: no raw PII path

```
grep -n "identifier_value" apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts
→ only hash (id.hash) is written to identifier_value column; never id.rawValue

grep -n "rawValue" apps/stream-worker/src/domain/identity/IdentityResolver.ts
→ rawValue only flows into contactPiiWrites[].raw_value (contact_pii writes only)
→ never into identity_link inserts

grep -n "pii_value\|rawValue" apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts
→ pii_value only in contact_pii INSERT (gated by app.role=send_service)
→ detail JSONB in identity_audit only contains identifier_types (not values)
```

---

## Verification Output

### Typecheck
```
pnpm --filter @brain/identity-core typecheck → EXIT 0
pnpm --filter @brain/stream-worker typecheck → EXIT 0
```

### Migration 0017 applied

```sql
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c WHERE c.relname IN (...identity tables...);
→ All 8 tables: rls_enabled=t, rls_forced=t

SELECT tablename, policyname, qual FROM pg_policies WHERE tablename IN (...);
→ contact_pii: brand_id = current_setting('app.current_brand_id', TRUE)::uuid
             AND current_setting('app.role', TRUE) = 'send_service'
→ All others: brand_id = current_setting('app.current_brand_id', TRUE)::uuid

SELECT column_name, column_default FROM information_schema.columns
WHERE table_name='brand' AND column_name IN (
  'identity_salt_ciphertext','phone_guard_threshold','suppression_window_days');
→ phone_guard_threshold DEFAULT 10
→ suppression_window_days DEFAULT 30
→ identity_salt_ciphertext (nullable bytea)
```

### All 26 tests pass

```
Tests  26 passed (26)
Test Files  1 passed (1)
Duration  206ms
```

Test names verified:
- [PASS] identity-core conformance × 7 (conformance vector, real SHA-256, cross-brand differs, E.164 × 3, low-confidence no-crash)
- [PASS] SaltProvider hard-crash guard × 4 (empty throw, wrong-length throw, valid 32-byte, never defaults)
- [PASS] Deterministic merge × 1
- [PASS] Phone-guard N=10 boundary × 3 (setup, suppress-on-11th, no-collapse proof)
- [PASS] Isolation negative control × 4 (mint, cross-brand=0, hash differs, no-GUC=0)
- [PASS] No raw PII in identity_link × 1
- [PASS] Replay idempotency × 2 (setup, 3×→1 row)
- [PASS] contact_pii send_service gate × 4 (resolve, no-role→0, with-role→1, hash is hex)

---

## Commits

| Slice | SHA | Message |
|-------|-----|---------|
| 1 | `8ac9771` | feat(identity): mig 0017 + real SHA-256 + per-brand SaltProvider [Slice 1] |
| 2 | `a8a52d1` | feat(identity): deterministic resolver + idempotent bridge writer [Slice 2] |
| 3 | `dd96233` | feat(identity): India phone-guard suppression + contact_pii send_service gate [Slice 3] |
| 4 | `c9278a3` | feat(identity): identity graph tests — all 26 pass against live PG [Slice 4] |
