# Architecture Plan — feat-identity-graph

**Stage:** 2 (architecture) · **Architect:** Architect (Opus tier) · **Timestamp:** 2026-06-16T22:10:00Z
**req_id:** `feat-identity-graph` · **Decision:** ADVANCE → Stage 3 (build)
**Branch:** `feat/identity-graph` (base `master`)
**Cost paradigm:** **Tier-1 deterministic** end-to-end (parse → SHA-256 → hash-equality lookup → count-threshold rule). **Zero model calls.** `@effort("deterministic")` on the merge-writer entry-point. Justification: identity resolution is pure equality + counting; a statistical/ML approach is an explicit Phase-2 non-goal (req §Non-goals; CTO §7). Cheapest-sufficient-effort gate passes trivially.

---

## 0. What this plan binds (the seven CTO bindings + 3 grounding decisions)

| ID | Binding | Where it lands |
|----|---------|----------------|
| **D-1** | Phone-guard threshold (default 10, windowed 30d, brand-configurable) | mig 0017 `brand.phone_guard_threshold`/`suppression_window_days` + `shared_utility_identifier.suppressed_until`; `SharedUtilityPolicy`; re-eval Argo job (existing job type) |
| **D-2** | Per-brand salt — fetch+decrypt at startup, **HARD CRASH on failure** | mig 0017 `brand.identity_salt_ciphertext`; `SaltProvider` (extends existing `SecretsProvider`); CI cross-brand-differs vector |
| **D-3** | `contact_pii` elevated RLS (`brand_id` AND `app.role='send_service'`), dev plaintext | mig 0017 `contact_pii` two-arg-both-GUCs RLS; negative test |
| **D-4** | Idempotent merge — deterministic `merge_id` + ON CONFLICT DO NOTHING | `IdentityResolver` + `IdentityRepository`; mig 0017 PKs + UNIQUE PARTIALs; replay-3× test |
| **D-5** | Deterministic-only (`rule_version='v1-deterministic'`) | `IdentityResolver` constant; `merge_rule` table **deferred** (CTO §6 simplification) |
| **D-6** | E.164 phone normalization (region `+91`) | `normalizeIdentifier('phone')` in identity-core |
| **D-7** | No new deployable | All code in the 3 existing scaffolds; re-eval = existing Argo-job type |
| **C-1** | `stubSha256` → **real SHA-256** (`node:crypto`) | identity-core; conformance vector |
| **C-2** | Migration `0017_identity_graph.sql` (+ brand columns), additive, RLS FORCE fail-closed, down=DROP | `db/migrations/0017_identity_graph.sql` |
| **C-3** | `identity-bridge` async writer rebuildable from Bronze | `apps/stream-worker/src/identity-bridge/IdentityBridgeConsumer.ts` |

---

## 1. Grounding — what already exists (cite `file:line`, extend-before-create)

- **identity-core stub** — `packages/identity-core/src/index.ts:30` `normalizeIdentifier` (email/phone/device/external; phone strips non-digits keeps `+`); `:56` `hashIdentifier(value,type,perBrandSalt)`; `:90` `stubSha256` (MurmurHash variant — **must not ship**). Per-brand-salt param already threaded. **Extend this file; do not rewrite the API.**
- **Bronze source** — `db/migrations/0016_bronze_events.sql:33` `payload JSONB`; PK `(brand_id,event_id)`; two-arg RLS `:50`; `brain_app` SELECT+INSERT only. Identifier extraction parses `payload`.
- **Brand table** — `db/migrations/0004_brand.sql:17` — **has NO `identity_salt_ciphertext` and NO `phone_guard_threshold` columns yet** (doc-08 §5.1:128 specifies `identity_salt_ciphertext bytea`). 0017 **adds them additively** via `ALTER TABLE brand ADD COLUMN IF NOT EXISTS`. Two-arg RLS pattern + NN-1 assertion block are at `0004_brand.sql:37` and `:61` — **copy that NN-1 DO-block into 0017**.
- **Stream-worker layering** (the pattern `identity-bridge` mirrors):
  - `interfaces/consumers/CollectorEventConsumer.ts:29` — KafkaJS, `autoCommit:false`, offset-commit ONLY after write confirmed (D-7), per-(partition,offset) retry → DLQ at MAX_RETRY=5. **`IdentityBridgeConsumer` copies this exact offset/DLQ discipline.**
  - `infrastructure/pg/BronzeRepository.ts:53` — `BEGIN` → `SELECT set_config('app.current_brand_id',$1,true)` → INSERT ON CONFLICT DO NOTHING → COMMIT; connects as `brain_app` (NOT superuser). **`IdentityRepository` copies the set_config-then-write-in-one-txn discipline.**
  - `application/ProcessEventUseCase.ts:38` — parse → dedup → write, returns an outcome enum the consumer maps to offset commits. **`ResolveIdentityUseCase` mirrors this shape.**
  - `main.ts:24` — wires `BRAIN_APP_DATABASE_URL` (NOT superuser `brain`), graceful drain. **identity-bridge wiring is added to the SAME `main.ts`** (one deployable — D-7).
- **Secrets primitive (EXTEND, do not create)** — `apps/core/src/infrastructure/secrets/SecretsProvider.ts` (`getSecret(nameOrArn)`), `LocalSecretsProvider.ts` (returns value as-is in dev), `AwsSecretsProvider.ts` (prod). **Single-Primitive: the salt fetch reuses this interface**; a thin `SaltProvider` wraps `SecretsProvider` + decode. Do NOT invent a second secrets abstraction.
- **tenant-context** — `packages/tenant-context/src/index.ts` (already a stream-worker dep). Reuse for the per-brand GUC scoping helper.
- **Migration runner** — `node-pg-migrate` raw `.sql` files (`package.json:20`); additive, `CREATE TABLE IF NOT EXISTS`, `down` = `DROP`. (See I-E02 in 0016 header.)
- **Deploy** — `infra/argocd/envs/{staging,prod}/stream-worker.yaml` already exist; ArgoCD health-probe auto-rollback (STACK ADR-010). **Canary/percentage-rollout is Phase-4 deferred (ADR-010)** — do NOT add canary; the deploy track is affected-only build + image + ArgoCD sync of the EXISTING stream-worker app.

**Single-Primitive sweep: CLEAN.** Identity resolution is ONE primitive (core-service `identity` bounded context, written by the stream-worker bridge). Salt fetch reuses the existing `SecretsProvider`. No per-channel fork, no second hashing path (identity-core is the one hasher). `merge_rule` deferred — fewer primitives, not more.

---

## 2. Architecture — bounded context, data flow, layering

**Bounded context:** `identity` (core-service domain, per `domain-driven-design` table). The graph is OWNED by the `identity` context; the stream-worker `identity-bridge` is an `interfaces/consumers/` adapter that drives the same resolution use-case. No new service, no new DB (D-7) — identity tables live in the core Postgres (the control-plane store the stream-worker already writes Bronze into).

```
Bronze event stream (dev.collector.event.v1, same source the bridge replays from)
        │
        ▼  IdentityBridgeConsumer (interfaces/consumers/) — autoCommit:false, DLQ@5 (copies CollectorEventConsumer)
        ▼  ResolveIdentityUseCase (application/) — @effort("deterministic")
        │     1. extract email/phone/storefront_customer_id from payload JSONB
        │     2. normalizeIdentifier (E.164 for phone, D-6) → hashIdentifier(salt) [identity-core, real SHA-256]
        │     3. SaltProvider.forBrand(brandId) — fetched+decrypted; HARD CRASH on failure (D-2)
        │     4. IdentityResolver (domain/) — hash lookup → existing brain_id OR mint; phone-guard check (D-1)
        │     5. compute deterministic merge_id (D-4)
        ▼  IdentityRepository (infrastructure/pg/) — ONE txn: set_config GUC → INSERTs ON CONFLICT DO NOTHING
        │     identity_link · brain_id_alias · identity_merge_event · shared_utility_identifier · identity_audit
        │     (+ contact_pii under send_service role, D-3)
        ▼  commit Kafka offset ONLY after txn commits (D-7 at-least-once + idempotent writer = safe)
```

**Resolution algorithm (deterministic, `v1-deterministic`):**
1. Extract identifiers from `payload`. Normalize + hash each (per-brand salt).
2. For each strong identifier (`email`, `phone`, `storefront_customer_id`): look up `identity_link` WHERE `(brand_id, identifier_type, identifier_value)` AND `is_active`.
3. **Phone-guard gate (D-1):** before treating a `phone` hash as a merge key, check `shared_utility_identifier` — if the phone is flagged AND `suppressed_until > now()`, the phone is **excluded from the merge key set** (it can still attach to its own brain_id but cannot collapse two). Also: if resolving this event would push `distinct brain_id count for this phone in the window` past `brand.phone_guard_threshold`, insert/update the `shared_utility_identifier` row (suppress) and do NOT merge — route the conflict to nothing (M1: suppress, no review-queue UI; `merge_review_queue` insert is allowed but unworked).
4. **Decision:**
   - 0 matches → **mint** new `brain_id` (uuid app-side) + `identity_link` rows + `identity_audit('mint'|'link')`.
   - 1 match → resolve to that `brain_id`, attach any new identifiers (`identity_audit('link')`).
   - ≥2 distinct `brain_id` matches via non-suppressed strong ids → **merge**: pick canonical (lowest uuid = deterministic), INSERT `brain_id_alias(observed→canonical, valid_to=NULL)` + `identity_merge_event(merge_id)` + `identity_audit('merge')`. Cycle-guard: walk the alias chain; a loop → skip merge, enqueue `merge_review_queue` (doc-08 §6:326 rule).
5. Raw email/phone (the values, not hashes) are written to `contact_pii` ONLY (D-3) — never to `identity_link`, never to logs, never to audit `detail` (audit references `brain_id`/hashes only).

**Read-time re-pointing (history never rewritten):** a merge is an `INSERT` of an alias row, never an UPDATE of `identity_link`. Consumers resolve `observed_brain_id → canonical_brain_id` at query time by walking `brain_id_alias WHERE valid_to IS NULL`. Unmerge (Phase-2, not built) = set `valid_to=now()` + reversal event.

**Rebuildable from Bronze:** the bridge is a derived projection — drop all identity rows, replay Bronze from the beginning, and (because the writer is idempotent, D-4, and hashing is deterministic real SHA-256, C-1) the graph reconstructs identically. This is the load-bearing reason `stubSha256` must die: a non-cryptographic hash that no future real-SHA-256 replay reproduces = a second brain_id minted for the same person on every rebuild.

---

## 3. Schema — migration `0017_identity_graph.sql` (additive, RLS FORCE fail-closed)

**Style:** mirror `0016_bronze_events.sql` + `0004_brand.sql` headers (I-E02 additive; `CREATE TABLE IF NOT EXISTS`; two-arg `current_setting('app.current_brand_id', TRUE)`; `ENABLE` + `FORCE ROW LEVEL SECURITY`; `REVOKE ALL` then `GRANT` minimal; copy the NN-1 DO-block from `0004_brand.sql:61`). **`down` migration = `DROP TABLE IF EXISTS` (reverse FK order) + `ALTER TABLE brand DROP COLUMN IF EXISTS`** — clean, identity is a derived projection (rebuildable from Bronze), not an immutable SoR.

### 3.1 Brand column additions (additive ALTER — D-1, D-2)
```sql
ALTER TABLE brand ADD COLUMN IF NOT EXISTS identity_salt_ciphertext bytea;          -- D-2 (doc-08 §5.1:128)
ALTER TABLE brand ADD COLUMN IF NOT EXISTS phone_guard_threshold     INT NOT NULL DEFAULT 10;  -- D-1
ALTER TABLE brand ADD COLUMN IF NOT EXISTS suppression_window_days   INT NOT NULL DEFAULT 30;  -- D-1
```
(Existing brand rows backfill to the DEFAULTs — additive-safe. `brand` GRANT already has UPDATE — `0004_brand.sql:42`.)

### 3.2 New tables (canonical shapes — doc-08 §6:258-288)
Create with `(brand_id, …)` PKs and the documented UNIQUE PARTIALs. All: `ENABLE`+`FORCE ROW LEVEL SECURITY`, policy `USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)`, `REVOKE ALL` + `GRANT SELECT, INSERT` (append-only; **`shared_utility_identifier` also gets UPDATE** — the re-eval job flips `suppressed_until`; `contact_pii` gets the elevated policy below):

| Table | PK | UNIQUE PARTIAL / key constraint | grants |
|-------|-----|------|--------|
| `customer` | `(brand_id, brain_id)` | — | SELECT, INSERT, UPDATE (lifecycle_state transitions) |
| `identity_link` | `(brand_id, link_id)` | `UNIQUE (brand_id,identifier_type,identifier_value) WHERE is_active AND tier IN('strong','strong_on_link')` (doc-08 :266) | SELECT, INSERT (append-only; unmerge deactivates via INSERT-new, never UPDATE in M1 → INSERT only) |
| `brain_id_alias` | `(brand_id, alias_id)` | `UNIQUE (brand_id,observed_brain_id) WHERE valid_to IS NULL` (doc-08 :273) + `CHECK(observed_brain_id<>canonical_brain_id)` | SELECT, INSERT, **UPDATE** (unmerge sets valid_to — Phase-2; grant now, additive) |
| `identity_merge_event` | `merge_id uuid PK` (deterministic, D-4) | — | SELECT, INSERT |
| `shared_utility_identifier` | `(brand_id,identifier_type,identifier_value)` | **add `suppressed_until TIMESTAMPTZ`, `window_days INT`** to doc-08 shape (D-1) | SELECT, INSERT, **UPDATE** (re-eval flips suppressed_until) |
| `merge_review_queue` | `(brand_id, review_id)` | — (unworked in M1; insert-only) | SELECT, INSERT |
| `contact_pii` | `(brand_id, brain_id, pii_type)` | dev: `pii_value text` (plaintext stand-in for `pii_ciphertext bytea`, D-3) | SELECT, INSERT (elevated policy below) |
| `identity_audit` | `(brand_id, audit_id)` | — | SELECT, INSERT |

**Deferred (CTO §6 simplification — confirmed):** `merge_rule` (a constant `rule_version='v1-deterministic'` suffices for M1), `merge_candidate`, `pii_vault_reference` (no mart consumer yet). NOT created in 0017 → smaller, more reversible migration. Re-evaluate at Customer-360.

### 3.3 `contact_pii` elevated RLS (D-3) — the two-arg-BOTH-GUCs policy
```sql
CREATE POLICY contact_pii_isolation ON contact_pii
  AS PERMISSIVE FOR ALL TO brain_app
  USING (
    brand_id = current_setting('app.current_brand_id', TRUE)::uuid
    AND current_setting('app.role', TRUE) = 'send_service'   -- two-arg fail-closed: missing → NULL ≠ 'send_service' → 0 rows
  );
```
A `brain_app` session with `app.current_brand_id` set but WITHOUT `app.role='send_service'` → **0 rows** (both predicates two-arg fail-closed). This is the test in §5.

### 3.4 NN-1 assertion
Append the `0004_brand.sql:61` NN-1 DO-block (extended to also assert no one-arg `app.role`) at the end of 0017 — fails the migration if any new policy uses one-arg `current_setting`.

---

## 4. identity-core changes (C-1, D-6) — `packages/identity-core/src/index.ts`

1. **Replace `stubSha256` with real SHA-256** (`packages/identity-core/src/index.ts:90`):
   ```ts
   import { createHash } from 'node:crypto';
   function sha256Hex(input: string): string {
     return createHash('sha256').update(input, 'utf8').digest('hex');
   }
   ```
   `hashIdentifier` (`:63`) calls `sha256Hex(`${perBrandSalt}||${normalized}`)`. **Delete `stubSha256` entirely** — it must not ship.
2. **E.164 phone normalization (D-6)** — extend `normalizeIdentifier('phone')` (`:34`): strip non-digits; if 10 digits → prefix `+91` (region default); if `+91` + 10 digits → keep; if already E.164 with `+` → keep; otherwise (un-normalizable) return the digit-stripped form and surface a `low-confidence` flag to the caller (the bridge writes `tier`/confidence on the `identity_link` row; a normalization failure must NOT crash the bridge — D-6). Region comes from the brand's `region` (already on `brand`), threaded as a param — do NOT hardcode `+91` inside identity-core's pure function; pass `regionCode`.
3. **CI conformance vectors** (the contract that protects replay correctness):
   - `hashIdentifier('user@example.com','email','test-salt')` === a pinned known SHA-256 hex (real, computed at build — the test asserts stability across replays).
   - **Cross-brand-differs (D-2):** `hashIdentifier(v,t,saltA) !== hashIdentifier(v,t,saltB)` for two random 32-byte salts.
   - E.164: `normalizeIdentifier('09876543210','phone','IN') === normalizeIdentifier('+919876543210','phone','IN')`.

---

## 5. Salt strategy (D-2 — CRITICAL, load-bearing)

- **Generation:** per-brand 32-byte salt via `crypto.randomBytes(32)` at brand-creation time, stored as `brand.identity_salt_ciphertext`. (Brand-creation salt-minting wiring is a thin addition; the salt column lands in 0017.) Dev: a fixed-per-brand random value seeded into the local secrets backend.
- **Fetch path — `SaltProvider` (EXTENDS existing `SecretsProvider`, Single-Primitive):** at `IdentityBridgeConsumer` startup (and cached per brand for the consumer lifetime), resolve the brand's salt via the existing `SecretsProvider.getSecret()` (prod: AWS Secrets Manager + KMS decrypt of `identity_salt_ciphertext`; dev: `LocalSecretsProvider` returns the configured value). A thin `SaltProvider.forBrand(brandId): Promise<Buffer>` wraps it + base64/hex-decode.
- **HARD CRASH on failure (the heart of cross-brand isolation):** if the fetch/decrypt throws OR returns empty/missing, the bridge **throws and the process exits non-zero** — it MUST NEVER fall back to an empty string, a default, or a global salt. A shared salt = identical hashes across brands = cross-brand correlation = the ONE invariant violated. Code-level guard: `if (!salt || salt.length !== 32) throw new Error('[identity-bridge] salt fetch failed — refusing to hash with empty/default salt (D-2)')`. The `LocalSecretsProvider` already throws on empty (`LocalSecretsProvider.ts` — "Empty secret value") — reuse that fail-closed behavior.
- **Dev stand-in:** `LocalSecretsProvider` (existing) provides the dev salt from env; CI conformance test (§4.3) proves two brands → different hashes.

---

## 6. identity-bridge async writer (C-3, D-7) — `apps/stream-worker/src/identity-bridge/`

New files (mirror the existing stream-worker layering — the empty dir gets its entry-point defined here):

| File | Layer | Mirrors | Responsibility |
|------|-------|---------|----------------|
| `identity-bridge/IdentityBridgeConsumer.ts` | interfaces/consumers | `CollectorEventConsumer.ts:29` | KafkaJS `autoCommit:false`; offset-commit ONLY after the resolution txn commits (D-7); per-(partition,offset) retry → DLQ@5; same DLQ producer. Reads from the SAME Bronze event source (replayable). |
| `application/ResolveIdentityUseCase.ts` | application | `ProcessEventUseCase.ts:38` | `@effort("deterministic")`; extract → normalize+hash (salt) → resolve → returns outcome enum (`minted`/`linked`/`merged`/`suppressed`/`skipped`). No business rules inline — delegates to the domain resolver. |
| `domain/identity/IdentityResolver.ts` | domain | (pure) | The deterministic resolution algorithm (§2); imports NO pg/kafka. Phone-guard (`SharedUtilityPolicy`) + cycle-guard + canonical-pick (lowest uuid) + deterministic `merge_id = sha256(brand_id‖canonical‖merged‖rule_version)`. |
| `domain/identity/SharedUtilityPolicy.ts` | domain | (pure) | Phone-guard threshold rule (D-1): given the windowed distinct-brain_id count + `brand.phone_guard_threshold`, decide suppress / eligible. |
| `infrastructure/pg/IdentityRepository.ts` | infrastructure | `BronzeRepository.ts:53` | ONE txn: `BEGIN` → `set_config('app.current_brand_id',$1,true)` → all INSERTs `ON CONFLICT DO NOTHING` → COMMIT. Connects as `brain_app`. Writes `contact_pii` with `set_config('app.role','send_service',true)` in-txn (D-3). |
| `infrastructure/secrets/SaltProvider.ts` | infrastructure | extends `SecretsProvider` | §5 salt fetch + hard-crash guard. |

**Wiring:** add to the EXISTING `apps/stream-worker/src/main.ts:24` — instantiate `IdentityBridgeConsumer` alongside `CollectorEventConsumer` in the same process (D-7: no new deployable), same `BRAIN_APP_DATABASE_URL`, same graceful-drain. Whether the bridge consumes the live `dev.collector.event.v1` topic or replays `bronze_events` is a config choice — M1 binds: consume the same topic (live) with replay-from-Bronze as the rebuild path (a `--replay-from-bronze` mode reading `bronze_events` in `brand_id,event_id` order).

**Idempotency (D-4):** deterministic `merge_id`; `identity_merge_event` INSERT `ON CONFLICT (merge_id) DO NOTHING`; `brain_id_alias` INSERT `ON CONFLICT (brand_id, observed_brain_id) WHERE valid_to IS NULL DO NOTHING`; `identity_link` INSERT `ON CONFLICT (brand_id, identifier_type, identifier_value) WHERE is_active DO NOTHING`. At-least-once delivery + idempotent writer = replay-safe. Offset committed only after the txn commits.

---

## 7. Slices (smallest-first; COMMIT PER SLICE; single-track @data-engineer)

### Slice 1 — migration 0017 + real crypto + salt provider (the foundation)
**Goal:** the schema + the hashing contract exist and are proven, before any row is resolved.
- `db/migrations/0017_identity_graph.sql` (+ brand columns; §3) — additive, RLS FORCE, two-arg, NN-1 block, down=DROP.
- `packages/identity-core/src/index.ts` — `stubSha256` → real `node:crypto` SHA-256; E.164 phone norm with `regionCode` param; delete the stub (§4).
- `infrastructure/secrets/SaltProvider.ts` — extends `SecretsProvider`; hard-crash guard (§5).
- **Tests (pass-1 REQUIRED):** identity-core conformance vectors (known-hash, cross-brand-differs, E.164 equality); migration up/down clean; RLS smoke (table created, FORCE on).
- **COMMIT:** `feat(identity): mig 0017 + real SHA-256 + per-brand SaltProvider [Slice 1]`

### Slice 2 — deterministic resolver + idempotent writer (the brain_id engine)
**Goal:** Bronze event → stable brain_id; replay-idempotent; isolation enforced.
- `domain/identity/IdentityResolver.ts` + `application/ResolveIdentityUseCase.ts` + `infrastructure/pg/IdentityRepository.ts` (§6). Deterministic `merge_id`; ON CONFLICT DO NOTHING everywhere.
- `interfaces/consumers/IdentityBridgeConsumer.ts` (copy `CollectorEventConsumer` offset/DLQ discipline); wire into `main.ts`.
- **Tests (pass-1 REQUIRED):** deterministic-merge (same email, 2 events → 1 brain_id); replay-idempotency (replay 3× → exactly 1 `identity_merge_event` + 1 active alias + 1 active `identity_link`); isolation negative-control (cross-brand resolution = 0 rows under `SET ROLE brain_app` — NOT superuser `brain`); no-raw-PII-in-`identity_link` (assert `identifier_value` is a 64-hex SHA-256, never matches the raw input).
- **COMMIT:** `feat(identity): deterministic resolver + idempotent bridge writer [Slice 2]`

### Slice 3 — phone-guard suppression + contact_pii gate + re-eval job (the India guard)
**Goal:** shared phones do NOT false-merge; raw PII gated by send_service.
- `domain/identity/SharedUtilityPolicy.ts` (D-1); resolver integrates the windowed threshold + `shared_utility_identifier` write/suppress.
- `contact_pii` writes under `set_config('app.role','send_service',true)` (D-3).
- Re-eval Argo job (existing job type, D-7) — un-suppresses identifiers whose window expired + count dropped below threshold.
- **Tests (pass-1 REQUIRED):** phone-guard false-merge-prevention (one phone across N>threshold distinct customers → distinct brain_ids stay distinct; boundary at N=10); contact_pii send_service gate (`brain_app` WITHOUT `app.role='send_service'` → 0 rows even with brand_id set); re-eval un-suppress.
- **COMMIT:** `feat(identity): India phone-guard suppression + contact_pii send_service gate [Slice 3]`

### Slice 4 — deploy track (affected-only; existing app; no new deployable)
**Goal:** ship via the existing stream-worker pipeline — D-7, no canary (Phase-4 deferred, ADR-010).
- Affected-only build → ECR image for `@brain/stream-worker` (the bridge ships inside the existing deployable).
- ArgoCD sync of the EXISTING `infra/argocd/envs/{staging,prod}/stream-worker.yaml`; health-probe auto-rollback (ADR-010). Re-eval Argo-job manifest (existing job type) added under the existing jobs namespace.
- Migration 0017 applied via the standard `migrate:up` pipeline step before the consumer rolls.
- **Tests (pass-1 REQUIRED):** real-network smoke — bridge connects to dev Kafka + Postgres-as-`brain_app`, processes a fixture Bronze event end-to-end, brain_id minted, offset committed.
- **COMMIT:** `chore(identity): deploy 0017 + stream-worker (bridge inside existing app) [Slice 4]`

---

## 8. Acceptance contract (ALL CTO must-fixes folded as pass-1 REQUIRED)

The data-engineer's pass-1 MUST satisfy every item below (no rework bounce):

- [ ] **D-2 salt hard-fail** — salt fetch/decrypt failure → process exits non-zero; NEVER empty/default/global salt. Guard `salt.length !== 32 → throw`. (CTO FINDING-2 CRITICAL.)
- [ ] **D-1 phone-guard** — `brand.phone_guard_threshold` DEFAULT 10 + `suppression_window_days` DEFAULT 30, brand-configurable (NOT hardcoded); windowed distinct-brain_id count; `shared_utility_identifier.suppressed_until`; N=10 boundary test. (CTO FINDING-1 CRITICAL.)
- [ ] **C-1 real SHA-256** — `stubSha256` deleted; `node:crypto` SHA-256; known-vector + cross-brand-differs CI tests. (CTO FINDING-7.)
- [ ] **D-4 idempotent merge** — deterministic `merge_id`; ON CONFLICT DO NOTHING on `identity_merge_event` PK + the two UNIQUE PARTIALs; replay-3× → 1 merge row. (CTO FINDING-3.)
- [ ] **D-3 contact_pii** — RLS requires `brand_id` AND `app.role='send_service'` (both two-arg); `brain_app` without send_service → 0 rows test. (CTO FINDING-4.)
- [ ] **Isolation** — RLS FORCE fail-closed two-arg on every identity table; cross-brand resolution = 0 rows verified under `SET ROLE brain_app` (NOT superuser `brain` — masks RLS per memory note). (CTO FINDING-5.)
- [ ] **No raw PII in `identity_link`** — `identifier_value` is always a 64-hex SHA-256; raw PII only in `contact_pii`; no PII in logs/audit `detail`. (req constraint.)
- [ ] **D-6 E.164** — phone normalized to `+91`+10-digit before hashing; `09876543210` ≡ `+919876543210`; un-normalizable → low-confidence, no crash. (CTO FINDING-8.)
- [ ] **D-5 deterministic-only** — `rule_version='v1-deterministic'`; no probabilistic/ML; `@effort("deterministic")` on the writer entry-point.
- [ ] **D-7 no new deployable** — bridge inside the existing stream-worker process; re-eval = existing Argo-job type; migration via existing pipeline.
- [ ] Connects as `brain_app` everywhere (never superuser `brain`); migration additive (I-E02); down=DROP clean.

---

## 9. Alternatives considered + rejection

- **(A) Resolve identity synchronously at the collector edge** — REJECTED. STACK locked-choice #8: identity write is an async idempotent writer off Bronze, never a sync edge gate (latency + replayability). The bridge is the right seam.
- **(B) Lifetime phone-guard count (no window)** — REJECTED (CTO FINDING-1). A burst (kiosk) would permanently suppress a number that later becomes a legitimate single-customer phone; no cool-down. Windowed + re-eval Argo job chosen. Trade-off: false-merge (the worse failure, ghost high-LTV customer in the ledger) weighted above over-suppression (recoverable via un-suppress + replay) → default N=10 leans guard-strong.
- **(C) Build `merge_rule` + `merge_candidate` + `pii_vault_reference` now** — REJECTED for M1 (CTO §6). A constant `v1-deterministic` rule version suffices; no mart consumes the vault reference yet. Deferring shrinks the migration and the reversibility surface. Re-add at Customer-360.
- **(D) Salt soft-fallback (empty default on KMS error)** — REJECTED, hard. This is the exact cross-brand-correlation failure (FINDING-2). Hard crash is non-negotiable.
- **(E) New identity micro-service now** — REJECTED. D-7 (no new deployable); Phase-2 extraction is a STACK-deferred amendment (ADR-008 / STACK §44 Phase-2). The bounded context is built clean so the future extraction is mechanical.

---

## 10. Cost estimate

Tier-1 deterministic, **zero model tokens/day, $0/mo incremental inference**. Compute cost = Postgres txn per Bronze event (one SELECT lookup + small INSERTs) inside the EXISTING stream-worker pod (no new pod, D-7). Re-eval Argo job: a periodic windowed COUNT — negligible. No new infra spend.

---

## 11. ADR flag

**No new ADR required.** This plan binds within ADR-008 (identity graph / per-brand salt), ADR-007 (per-brand KMS / Secrets), ADR-001 (RLS), ADR-010 (deploy — explicitly honoring the Phase-4 canary deferral). `merge_rule` deferral, `phone_guard_threshold` default, and the windowed re-eval are architecture decisions within the locked stack — recorded here, no Stakeholder escalation. Flag for the record: identity-tables migration `0017` is the first identity migration (none existed 0001-0016) — within scope, additive, no layer change.

---

## 12. Over-engineering self-check — PASS

Single deployable extended (no new service); one migration; `merge_rule`/`merge_candidate`/`pii_vault_reference` deferred; salt reuses the existing `SecretsProvider`; the bridge copies the proven `CollectorEventConsumer` discipline rather than inventing a new consumer framework. Single-track (no backend-developer track — no core-module API seam warrants it for M1; the `identity` core-module public surface stays `export {}` until a consumer needs it). Smallest, safest, most reversible path that ships the deterministic brain_id with the India phone-guard.
