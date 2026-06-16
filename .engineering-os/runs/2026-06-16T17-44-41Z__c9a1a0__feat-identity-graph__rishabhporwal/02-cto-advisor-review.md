# CTO Advisor Review — feat-identity-graph
**Stage:** 1 (intake, personas folded — adversarial stress-testing compressed into this pass)
**Reviewer:** Engineering Advisor (cto-advisor, Sonnet tier)
**Timestamp:** 2026-06-16T18:00:00Z
**Decision:** ADVANCE

---

## 1. Lane Confirmation

Deterministic scan assigned: `high_stakes` | surfaces: `multi_tenancy`, `pii`, `schema_proto`.

**Confirmed — no silent removals, one surface added:** `audit_integrity` is implicitly touched because every merge/suppress decision writes to `identity_audit` + the hash-chained `audit_log`. Adding it makes the invariant enforcement surface explicit for the Architect.

Final surfaces: `multi_tenancy`, `pii`, `schema_proto`, `audit_integrity`.

---

## 2. Requirement soundness

| Check | Finding |
|---|---|
| Problem statement present | Yes — Bronze events are anonymous rows; revenue attribution requires a stable customer anchor. |
| Target user clear | Internal platform substrate; India DTC M1 context. |
| Success metric testable | Yes — six automated test assertions in the requirement, all binary. |
| No new deployable | Confirmed — wires existing `packages/identity-core` + `apps/core/src/modules/identity/` + `apps/stream-worker/src/identity-bridge`. |
| Deterministic-only scope | Confirmed. Probabilistic = Phase 2 non-goal. |
| Prior dependency shipped | `feat-data-plane-ingest-spine` shipped (migration `0016_bronze_events.sql` present; `bronze_events` table live with RLS + idempotency PK). |
| Primary builder | data-engineer. Confirmed. |

---

## 3. Scaffold and schema grounding

**Scaffolds read:**

- `packages/identity-core/src/index.ts` — Sprint-0 stub present. `hashIdentifier()` uses a non-cryptographic stub sha256 (comment: "M1 replacement: `crypto.createHash('sha256').update(input).digest('hex')`"). `normalizeIdentifier()` for email (lowercase trim) and phone (strip non-digit, keep leading `+`) is present. Per-brand salt parameter is threaded in. **This is the right shape; the real crypto replacement is the first slice.**

- `apps/core/src/modules/identity/index.ts` — empty stub (`export {};` + TODO comment). `apps/core/src/modules/identity/internal/.gitkeep` only. The bounded context import boundary is declared; no implementation.

- `apps/stream-worker/src/identity-bridge` — **directory exists but is entirely empty** (no files, not even a `.gitkeep`). The async writer from Bronze to the identity graph has no scaffold beyond the directory. The Architect must define the entry-point file and the consumer wiring pattern (mirrors `CollectorEventConsumer.ts`).

**Schema read (doc-08 §6):**

- `customer`, `identity_link`, `brain_id_alias`, `identity_merge_event`, `merge_review_queue`, `merge_candidate`, `shared_utility_identifier`, `contact_pii`, `pii_vault_reference`, `identity_audit`, `merge_rule` — all specified in doc-08 §6.
- `identity_link.identifier_value` is declared "sha256(per-brand-salt ‖ normalized); HASH ONLY, never raw" — the constraint is documented, not yet a migration.
- `brand.identity_salt_ciphertext bytea` exists in doc-08 §5.1 (`brand` table DDL line 128) — the per-brand salt is stored encrypted on the brand row. This is the salt storage mechanism; the M1 implementation must fetch and decrypt it via KMS before hashing. **No migration for identity tables exists yet** (migrations 0001–0016 cover workspace, auth, brand, connector, pixel, session, onboarding, bronze — identity tables are not yet migrated).

**Bronze source read (migration `0016_bronze_events.sql`):**

- `payload JSONB NOT NULL` — identifier extraction must parse `payload` for email/phone/storefront-customer-id. The schema does not enforce a payload shape at the DB level; extraction correctness is a stream-worker concern.
- RLS policy uses two-arg `current_setting('app.current_brand_id', TRUE)` — fail-closed on missing GUC. Correct pattern confirmed.
- PK `(brand_id, event_id)` provides the idempotency backstop for the Bronze sink. The identity-bridge consumer must carry its own idempotency key (see D-4 below).

---

## 4. Compressed adversarial findings — severity-ranked

### FINDING-1 [CRITICAL] — Phone-guard threshold is unbound; no suppression_threshold column in schema

**File:** `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md` line 281, `shared_utility_identifier` table.

The schema defines `profile_count int` and `flagged_at` but has **no `suppression_threshold` column and no canonical N**. The requirement text says "an abnormal number of distinct customers" without specifying N. Doc-08 §24 (line 642) says "fan-out threshold per brand" — meaning it is brand-configurable — but neither a default nor a storage location for the threshold is defined.

**False-merge vs over-suppression trade-off (concrete):**

The failure modes are asymmetric:

- **Too low (e.g. N=3):** a genuine repeat COD customer who has placed 4 orders from the same family phone gets her phone suppressed and the four orders become four anonymous `brain_id`s. Revenue attribution fails silently; her LTV is shattered. This is the under-merge failure. It is recoverable (un-suppress + replay) but damages M1 metrics.

- **Too high (e.g. N=50):** a COD courier's registered phone (used as contact for 40+ deliveries across a single brand) remains eligible for merge. All 40 "customers" who gave that number collapse into one `brain_id`. Revenue is over-attributed to one ghost customer. This is the false-merge failure and is the worse outcome — the spec agrees ("false-merge, the worse failure") because the ledger and attribution see a single high-LTV entity that is actually 40 people.

**Recommended binding (see D-1):** default threshold of **N=10 distinct customers per identifier per brand per rolling 30-day window**, stored as a brand-level config column (`brand.phone_guard_threshold INT DEFAULT 10`). Rationale: COD courier phones accumulate 30–100+ contacts per month in India DTC; genuine repeat customers rarely place >5–7 orders in 30 days from the same phone. 10 is a defensible false-merge guard with low over-suppression risk at M1 scale. The Architect must confirm against any available sample data. It must be brand-configurable and not hardcoded.

**The count-vs-windowed question:** a pure lifetime count will suppress a genuinely popular family-phone over time even if usage is legitimate and sparse. A rolling window (30-day) is preferred because it allows a number to "cool down" after a burst (e.g. a kiosk) and return to merge eligibility. However, the `shared_utility_identifier` table as specified has no `window_start`/`window_end` columns — only `flagged_at`. The Architect must decide: add a `suppression_window_days` column and a re-evaluation job, or accept lifetime suppression once flagged (simpler, but not re-evaluatable). **Recommend windowed with a re-evaluation Argo job.**

---

### FINDING-2 [CRITICAL] — Salt cross-brand correlation risk

**File:** `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md` line 128 (`brand.identity_salt_ciphertext`), `packages/identity-core/src/index.ts` line 9.

The salt architecture is per-brand (STACK.md locked choice #8; `identity-core/src/index.ts` line 9: "Per-brand salt ensures cross-brand hashes are uncorrelatable"). The salt is stored as `brand.identity_salt_ciphertext bytea` (doc-08 §5.1 line 128) — encrypted under the brand's KMS DEK.

**Risk correctly stated in the requirement but the binding is missing:** if two brands share a salt (even accidentally, e.g. a bug in salt generation at brand creation time mints the same random bytes), then the same customer's phone hash is identical across both brands. An RLS bypass, a StarRocks misconfiguration, or a log leak would immediately cross-correlate customers across brand boundaries. This violates both the "one invariant" (brand isolation) and DPDP purpose-limitation.

**Where the risk lives in the implementation:**

1. Brand creation path (not yet built at M1) must mint a cryptographically random salt per brand and store it as `identity_salt_ciphertext`. If the salt generation is seeded from a global source (e.g. `Math.random()`, a timestamp, or a UUID used directly), two brands could collide with non-negligible probability.
2. The `identity-core` stub currently takes `perBrandSalt: string` as a parameter — the caller is responsible for fetching and decrypting the salt from `brand.identity_salt_ciphertext` via KMS. This fetch path is not yet wired anywhere in the identity-bridge or identity module. **If the salt fetch fails and the code falls back to an empty string or a hardcoded default, all brands share the same hash namespace.**

**Required binding (see D-2):** salt must be 32 random bytes (256 bits) generated via `crypto.randomBytes(32)` at brand creation time, stored encrypted under the brand's per-brand KMS DEK. The identity-bridge must fetch + decrypt the salt on startup (or per-batch) and fail hard (not silently default) if the KMS call fails. A CI conformance test must assert that `hashIdentifier(value, type, saltA) !== hashIdentifier(value, type, saltB)` for two randomly-generated salts.

---

### FINDING-3 [HIGH] — Idempotent merge on replay not specified at the implementation level

**File:** `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md` lines 274–275 (`identity_merge_event`), requirement §3 ("rebuildable from Bronze").

The requirement says "Merges are recorded via `brain_id_alias` read-time re-pointing — history is NEVER rewritten; merge events are append-only." This describes the storage invariant but not the idempotency mechanism for the merge writer itself.

**The replay scenario:** the identity-bridge reprocesses a Bronze event (e.g. a consumer group reset, a DLQ retry, or a full replay). The same `bronze_event.event_id` triggers the same identifier extraction, the same hash lookup, and the same merge decision. If the merge writer is not idempotent, two `identity_merge_event` rows are inserted for the same logical merge, and two `brain_id_alias` rows are written. The alias table has a UNIQUE PARTIAL on `(brand_id, observed_brain_id) WHERE valid_to IS NULL` (doc-08 line 273) — so a second insert of the same live alias would fail with a unique violation. **This is a crash loop risk on replay if the idempotency is enforced only by the DB constraint rather than by the writer's logic.**

**Required binding (see D-4):** the merge writer must compute a deterministic `merge_id` = `sha256(brand_id ‖ canonical_brain_id ‖ merged_brain_id ‖ rule_version)` before any insert. The `identity_merge_event.merge_id` is the PK (doc-08 line 274) — an ON CONFLICT DO NOTHING on that PK makes the merge INSERT idempotent. The alias insert is protected by the UNIQUE PARTIAL; the writer must use ON CONFLICT DO NOTHING there too. The test: replay the same Bronze event 3× and assert exactly 1 `identity_merge_event` row and 1 active alias row exist.

---

### FINDING-4 [HIGH] — `contact_pii` dev vault stand-in is undefined

The requirement states: "Raw contact PII lives ONLY in `contact_pii` (KMS vault in prod; dev: an isolated, access-controlled table standing in for the vault)." No migration for `contact_pii` exists yet. The dev stand-in mechanism is described in words only.

**Risk:** if the dev stand-in does not enforce `app.role='send_service'` (the additional RLS condition doc-08 §6 line 284 requires), developers will read raw PII from the dev table under `brain_app` without restriction. This is precisely the RLS masking risk the memory note (`dev-db-superuser-masks-rls.md`) flags — the dev superuser `brain` bypasses RLS entirely.

**Required binding (see D-3):** the `contact_pii` migration must create the table with its own RLS policy requiring BOTH `app.current_brand_id` AND `app.role = 'send_service'` (two-arg form for both). For dev, `contact_pii` uses a plaintext `pii_value text` column instead of `pii_ciphertext bytea` (no KMS in dev), but the RLS policy is identical. Integration tests must verify that a query under `SET ROLE brain_app` without `SET app.role = 'send_service'` returns 0 rows even with `app.current_brand_id` set.

---

### FINDING-5 [HIGH] — RLS on identity tables not yet enforced (no migrations)

**File:** `db/migrations/` — migrations 0001–0016 present; no migration for `brain_id`, `brain_id_alias`, `identity_link`, `contact_pii`, `customer`, `shared_utility_identifier`, `identity_merge_event`, `identity_audit`.

All identity tables are specified in doc-08 §6 but have no migration. The Architect must scope a migration (`0017_identity_graph.sql`) that:
- Creates all identity tables with RLS enabled + FORCE ROW LEVEL SECURITY.
- Uses the two-arg `current_setting('app.current_brand_id', TRUE)` predicate (not the one-arg form).
- Grants `brain_app` INSERT + SELECT only on append-only tables (`identity_link`, `brain_id_alias`, `identity_merge_event`, `identity_audit`, `shared_utility_identifier`, `contact_pii`).
- Adds the `send_service` role-check RLS on `contact_pii`.
- Adds `brand.phone_guard_threshold INT DEFAULT 10` (or equivalent config table) per D-1.

The dev superuser masking note (memory: `dev-db-superuser-masks-rls.md`) means all RLS assertions must be verified under `SET ROLE brain_app`, not under the `brain` superuser.

---

### FINDING-6 [MEDIUM] — `identity-bridge` scaffold is an empty directory

`apps/stream-worker/src/identity-bridge` exists as a directory with no files. The requirement says "wire the EXISTING scaffold" — but there is nothing to wire, only a directory. This is not a blocker for ADVANCE (the directory signals intent and the pattern to follow is `CollectorEventConsumer.ts` + `BronzeRepository.ts`), but the Architect must define the entry-point explicitly: `IdentityBridgeConsumer.ts` + `IdentityRepository.ts` matching the existing stream-worker layering.

---

### FINDING-7 [MEDIUM] — `identity-core` stub sha256 must not ship as-is in M1

**File:** `packages/identity-core/src/index.ts` lines 90–103.

The `stubSha256` function is a 64-char hex string from a non-cryptographic hash (MurmurHash variant). Comments correctly say "M1 replacement: `crypto.createHash('sha256').update(input).digest('hex')`." **If M1 ships without replacing this, hashes in `identity_link` will be non-cryptographic, collide more frequently, and critically — will not match the hash computed by any future replay that uses real SHA-256.** A hash mismatch on replay = a second `brain_id` minted for the same person.

This is a slice-1 task for the data-engineer: replace `stubSha256` with real Node.js `crypto` before writing a single row to `identity_link`. Add a conformance test vector: `hashIdentifier('user@example.com', 'email', 'test-salt') === <known sha256 hex>`.

---

### FINDING-8 [LOW] — Phone normalization edge case: E.164 vs local India format

**File:** `packages/identity-core/src/index.ts` line 36.

Current normalization for `phone`: `value.trim().replace(/[^\d+]/g, '')` keeps leading `+`. India mobile numbers arrive in multiple formats: `+919876543210`, `09876543210`, `9876543210`. A number stored as `+919876543210` and the same number stored as `9876543210` will hash differently, creating a false split (under-merge). The Architect must bind a canonical phone form before hashing: normalize to E.164 for India (`+91` prefix, 10 digits). The `normalizeIdentifier` function should be extended for `phone` with a country-code injection step using the brand's `region` (already on the `brand` table).

---

## 5. Architect decision bindings

**D-1 [phone-guard threshold]:** Default threshold = 10 distinct `brain_id`s per phone identifier per brand per rolling 30-day window. Stored as `brand.phone_guard_threshold INT DEFAULT 10` (brand-configurable, not hardcoded). Use windowed count (not lifetime count). Add `suppression_window_days INT DEFAULT 30` and `suppressed_until TIMESTAMPTZ` to `shared_utility_identifier`. Add an Argo re-evaluation job that un-suppresses identifiers whose window has expired and `profile_count` has dropped below threshold. Threshold must be tested: N=10 boundary case in the automated test suite.

**D-2 [salt strategy]:** Per-brand salt, 32 random bytes generated via `crypto.randomBytes(32)` at brand-creation time, stored as `brand.identity_salt_ciphertext bytea` encrypted under the brand's KMS DEK. The identity-bridge fetches and decrypts the salt from `brand.identity_salt_ciphertext` at consumer startup. If the KMS call fails, the bridge must fail hard (crash, not silently hash with an empty/default salt). CI conformance test: two brands must produce different hashes for the same identifier value. Cross-brand hash correlation = ZERO under this scheme.

**D-3 [dev `contact_pii` vault stand-in]:** The migration `0017_identity_graph.sql` creates `contact_pii` with a `pii_value text` column (plaintext dev substitute for `pii_ciphertext bytea`). RLS policy requires BOTH `app.current_brand_id` AND `app.role = 'send_service'` (two-arg forms). Integration test asserts `brain_app` without `send_service` role returns 0 rows. The KMS encryption step is a no-op in dev (identity passthrough); prod migration `0018_contact_pii_kms.sql` adds KMS wiring as a follow-up (platform task, not M1 scope).

**D-4 [idempotent merge on replay]:** The merge writer computes `merge_id = sha256(brand_id ‖ canonical_brain_id ‖ merged_brain_id ‖ rule_version)` before any insert. `identity_merge_event` INSERT uses `ON CONFLICT (merge_id) DO NOTHING`. `brain_id_alias` INSERT uses `ON CONFLICT ON CONSTRAINT (brand_id, observed_brain_id) WHERE valid_to IS NULL DO NOTHING`. `identity_link` INSERT uses `ON CONFLICT (brand_id, identifier_type, identifier_value) WHERE is_active DO NOTHING` (the UNIQUE PARTIAL in doc-08 line 266). The identity-bridge consumer tracks its offset only after all inserts commit (at-least-once delivery; idempotent writer = safe). Test: replay the same Bronze event 3× → exactly 1 `identity_merge_event` row, 1 active alias, 1 active identity_link.

**D-5 [deterministic-only scope]:** Confirm — no probabilistic or ML merge in M1. `merge_rule` table supports `action='review'` for phone-guard conflicts and `action='never'` for suppressed identifiers. The only auto-merge action is `action='merge'` on strong-identifier match (same hash, same brand, no phone-guard flag). Anything else goes to `merge_review_queue` (not auto-merged). This is Phase 2.

**D-6 [phone normalization canonical form]:** `normalizeIdentifier` for `phone` must produce E.164 format for India (`+91` + 10-digit local number). The brand's `region` drives the country code injection. A phone that cannot be normalized to E.164 is stored as-received (strip non-digits + keep `+`) with an `identifier_confidence = 'low'` marker on the `identity_link` row. This prevents a normalization failure from crashing the bridge.

**D-7 [no new deployable confirmed]:** All code lives in the three existing scaffolds. No new process, container, or Argo job (beyond a re-evaluation job for phone-guard windowing, which is an Argo job type already in the stack).

---

## 6. "Make it less dumb" — simplification check

- **Can we delete the `merge_rule` table for M1?** Yes — for a deterministic-only Phase 1 with a fixed rule set (strong hash match = merge; phone = review; suppressed = never), the `merge_rule` table can be deferred to Phase 2 when brand-customizable rules are needed. Recommend the Architect evaluate deferring it to reduce migration scope. A hardcoded rule version string (`'v1-deterministic'`) suffices for M1.
- **Can we defer `pii_vault_reference`?** Yes for M1 — marts are not yet consuming the vault reference. Add it in the same migration for schema completeness but defer the mart join until Customer 360 is built.
- **Can `brain_id_alias` be a simpler table?** No — the UNIQUE PARTIAL invariant and the `valid_to` bitemporal pattern are load-bearing for history preservation and replay correctness. Cannot simplify.

---

## 7. Cost-routing audit

The identity resolution pipeline is **tier 1 (deterministic)** throughout:
- Identifier extraction from `payload JSONB` = deterministic parsing.
- Hashing = deterministic SHA-256.
- Merge decision = deterministic hash lookup + rule evaluation.
- Phone-guard suppression = deterministic count threshold.

No model calls anywhere in this feature. The cost-routing audit passes trivially. An `@effort("deterministic")` annotation should be placed on the merge writer entry point per the cost-routing paradigm.

---

## 8. Decision

**ADVANCE to Stage 2 (Architect).**

The requirement is sound. The data model in doc-08 §6 is well-specified. The per-brand salt + two-arg RLS pattern is correctly established in the canonical docs and STACK.md. The five concerns above are all resolvable at architecture/build time; none is a blocker that requires Stakeholder escalation. The phone-guard threshold (D-1) and salt fetch failure mode (D-2) are the highest-risk bindings and must be the Architect's first decisions.

The single most important thing: **the phone-guard threshold is unbound in the schema and must be decided before the Architect draws the migration** — getting it wrong in either direction has silent, hard-to-detect consequences (false splits = shattered LTV; false merges = ghost customers in the revenue ledger). The second most important: **the salt fetch must fail hard on KMS error**, not silently hash with an empty default, or the cross-brand isolation guarantee evaporates.
