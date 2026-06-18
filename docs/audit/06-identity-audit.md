# PASS 8 — Identity Resolution Audit

**Auditor:** Independent principal reviewer (Data Engineer lane)
**Scope:** `packages/identity-core` · `apps/core/src/modules/identity` · `apps/stream-worker` identity-bridge / resolver / repository / phone-guard · `db/migrations/0017_identity_graph.sql` · `brain_id_alias`
**Reference truth:** `docs/data-collection-platform/03-identity-and-journey.md`, migration `0017`
**Posture verified:** deterministic-strong-only merge, per-brand salted SHA-256, RLS FORCE on every identity table, replay-idempotent writes.

The hashing/salt/RLS layer is genuinely strong and well-tested. The **graph-resolution and merge-consumption layer is broken**: merges are recorded but never *applied* — `brain_id_alias` is written but read by nothing except its own cycle-guard, so every downstream store keeps counting against stale `brain_id`s. There is no UNMERGE path despite the schema and docs promising read-time re-pointing. These are the headline findings.

---

## CRITICAL

### C1. `brain_id_alias` is write-only — no consumer ever re-points reads, so merges do not actually merge

**Severity:** Critical | **Category:** Identity correctness / data integrity | **Priority:** P0 | **Tenant Impact:** Single-tenant per occurrence, but systemic across every brand that ever merges.

**Evidence:** Grep of the entire `apps/` + `packages/` tree (excluding tests/migrations) for `brain_id_alias`:
```
apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:143  SELECT observed_brain_id FROM brain_id_alias ... (cycle-guard read)
apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:240  INSERT INTO brain_id_alias ... (merge write)
```
The ONLY read of `brain_id_alias` (`IdentityRepository.ts:142-147`) builds `aliasChain` for the resolver's own cycle-guard. No analytics, attribution, measurement, customer-profile, or journey read resolves `observed_brain_id → canonical_brain_id`. The measurement ledger stores the raw event `brain_id` verbatim (`OrderEventConsumer.ts:101` `brainId: raw.brain_id`; `PgLedgerRepository.ts:67`), and `docs-03 §D4.2 [4]`/`§D4.3` explicitly promise "read `brain_id_alias` for re-pointing" / "read-time re-pointing" for journeys — a consumer that does not exist (journey transform itself is unbuilt per `docs-03 §D4.1`).

**Impact (production terms):** When two profiles merge (canonical = lowest UUID), the merged profile's ledger rows, identity_links, contact_pii, and any future events that still resolve to the merged id are NEVER folded into the canonical entity. LTV, order counts, journey timelines, and CAPI audiences are computed against a `brain_id` that the system itself has declared non-canonical. The "Capture Truth → Build Trust" promise fails silently: the number renders, nobody is told it double-counts a merged customer. This is the exact "merge recorded but not applied" trap — the merge event row and alias row exist for audit, but no code path honors them at read time.

**Root cause:** The graph was designed as union-find with read-time re-pointing, but only the *write* half (record the alias) was implemented; the *read* half (a `resolveCanonical(brand_id, brain_id)` collapse used by every downstream query) was never built. Downstream consumers were wired against the raw `brain_id`.

**Recommended fix:** Implement a single `resolveCanonical()` primitive (recursive alias walk with the live-unique partial index, bounded by the cycle-guard) and route EVERY `brain_id` read through it — ledger aggregation, journey ordering, customer profile, CAPI audience build. Add a reconciliation assertion: zero ledger/identity_link rows keyed on a `brain_id` that appears as a live `observed_brain_id`. Until then, label merge-affected metrics "estimated" per `data-quality`.

**Detection:** Invisible today — no metric, no alert. Surfaces as a customer-reported "my LTV split in two" or an attribution discrepancy with no automated catch.

---

### C2. No UNMERGE path exists despite schema + docs promising reversible read-time re-pointing

**Severity:** Critical | **Category:** Identity safety / GDPR-DPDP reversibility | **Priority:** P0 | **Tenant Impact:** Single-tenant per bad merge; unbounded manual cleanup.

**Evidence:**
- `0017_identity_graph.sql:58-59` (identity_link comment): "unmerge deactivates (is_active=FALSE, new row) — never deletes." `0017:128` (brain_id_alias): "unmerge sets valid_to (Phase-2)." `identity_audit` CHECK admits `'unmerge','rebind'` actions (`0017:256`).
- No code writes them: `grep "UPDATE identity_link\|SET is_active\|SET valid_to\|'unmerge'\|'rebind'" apps packages --include='*.ts'` (excluding tests) returns **zero matches**. There is no UNMERGE use-case, no `valid_to` setter, no `is_active=FALSE` writer anywhere.
- `brain_id_alias` GRANTs `UPDATE` (`0017:162`) precisely so `valid_to` can be stamped — but nothing uses the grant.

**Impact (production terms):** A bad deterministic merge (e.g. a phone that slipped past the guard, a data-entry email shared by two people) is **permanent and irreversible** in code. The only recovery is hand-written SQL by an operator who must reverse-engineer union-find semantics under live RLS. Because the merge also (per C1) never propagated, you cannot even cleanly identify what to unwind. For DPDP/GDPR erasure-by-individual, an over-merged ghost entity that fused two real people cannot be split to honor one person's deletion without affecting the other.

**Root cause:** UNMERGE was scoped "Phase-2" and never built; the schema/docs advertise a capability the runtime does not have.

**Recommended fix:** Build an UNMERGE use-case that (a) sets `brain_id_alias.valid_to = now()`, (b) writes a compensating `identity_audit` row (`action='unmerge'`), (c) since re-pointing is read-time (C1's fix), NO historical rewrite is needed — the merged id simply stops collapsing to canonical. Gate it behind the merge_review_queue / an operator action. This is the correct read-time-repointing design; it just needs the read side (C1) plus the `valid_to` setter.

**Detection:** Surfaces only as an escalated support/compliance incident; no automated detection.

---

## HIGH

### H1. ≥3-way merge silently drops the middle brain_ids — partial, non-deterministic-coverage merge

**Severity:** High | **Category:** Merge correctness | **Priority:** P1 | **Tenant Impact:** Single-tenant; data fragmentation.

**Evidence:** `IdentityResolver.ts:228-231`:
```ts
const sortedIds = [...matchedBrainIds].sort();   // lowest UUID = canonical
const canonicalBrainId = sortedIds[0]!;
const mergedBrainId = sortedIds[sortedIds.length - 1]!;   // ONLY the highest
```
When one event's identifiers match **three or more** distinct existing brain_ids (e.g. email→B1, phone→B2, storefront_id→B3), the resolver merges only `B1` (lowest) and the single highest, and `newLinks: []` (`:254`) — the middle id(s) and ALL their identifiers are neither merged nor re-linked. Only one `brain_id_alias` row is written.

**Impact:** A genuinely-connected cluster of 3+ profiles is left fragmented after a single resolution pass. Subsequent events may eventually pairwise-merge them, but coverage is event-order-dependent, not deterministic-complete as `RULE_VERSION='v1-deterministic'` and the algorithm doc (`IdentityResolver.ts:13` "≥2 distinct brain_ids → merge") claim. Combined with C1, the fragments never reconcile downstream.

**Root cause:** The merge step collapses the matched set to a single (canonical, merged) pair instead of emitting `N-1` alias rows folding every non-canonical matched id into the canonical.

**Recommended fix:** Emit one `MergeSpec` per non-canonical matched brain_id (`sortedIds.slice(1).map(m => ({canonical: sortedIds[0], merged: m, mergeId: computeMergeId(...)}))`), and write all of them in `writeOutcome`. Add a test with 3 identifiers resolving to 3 distinct ids.

**Detection:** No alert; surfaces as residual duplicate customers after merges.

---

### H2. Merge does not transfer the merged profile's identifiers/PII to the canonical brain_id

**Severity:** High | **Category:** Graph construction | **Priority:** P1 | **Tenant Impact:** Single-tenant.

**Evidence:** On `action='merged'`, `IdentityResolver.ts:254` sets `newLinks: []` and `writeOutcome` (`IdentityRepository.ts:214-248`) inserts only the `customer` (merged, lifecycle='merged'), `identity_merge_event`, and `brain_id_alias` rows. The merged profile's existing `identity_link` rows are left pointing at `merged_brain_id` with no `brain_id` rewrite and no `is_active=FALSE`. There is no `UPDATE identity_link ... SET brain_id = canonical` anywhere (grep returns zero).

**Impact:** Because re-pointing was supposed to be read-time (C1), this is "correct by design" ONLY if a `resolveCanonical()` read layer exists. It does not (C1). So after merge, looking up an identifier that belonged to the merged profile returns the merged (non-canonical) `brain_id`, and the resolver on a *later* event will re-match the merged id and attempt to re-merge — churning merge events. The `customer` upsert with `WHERE customer.lifecycle_state != 'merged'` (`:223-224`) can also leave the canonical customer row absent if it was never created (no `INSERT customer` for canonical on the merge branch — only the `outcome.brainId` customer is inserted at `:181`, which IS canonical, so this one is OK).

**Root cause:** Same as C1 — the design relies on a read-time collapse that is unimplemented; without it, the merged links are orphaned.

**Recommended fix:** Tie to C1. Once `resolveCanonical()` exists, `readState` must collapse matched ids through it BEFORE the resolver decides, so a merged id is never re-matched as a distinct brain_id (prevents merge churn).

**Detection:** Repeated `merge` outcomes for the same pair in identity_audit; no alert today.

---

### H3. Phone-guard windowed count never decrements on merge — over-counts distinct brain_ids, can wrongly suppress a legitimate repeat customer

**Severity:** High | **Category:** Phone-guard correctness | **Priority:** P1 | **Tenant Impact:** Single-tenant; shattered LTV (the doc's own "too aggressive" failure mode).

**Evidence:** The windowed count is `COUNT(DISTINCT brain_id) FROM identity_link WHERE identifier_type='phone' AND identifier_value=$2 AND is_active=TRUE AND created_at > NOW()-window` (`IdentityRepository.ts:128-136`, repeated in `phone-guard-reeval.ts:78-86`). Because merges never deactivate or rewrite identity_link rows (H2), a phone legitimately belonging to one repeat customer who was minted under several anon→known fragments accumulates multiple *active* phone identity_link rows under distinct brain_ids that are *supposed to be merged*. The DISTINCT count counts the un-collapsed fragments, inflating toward the threshold (default 10, `0017:28`).

**Impact:** A real high-frequency repeat customer (the India-DTC repeat buyer the guard exists to protect) can be pushed over the threshold by their OWN fragmented-then-merged profiles and get their phone suppressed — `SharedUtilityPolicy.ts:14-15` names this exact "shattered LTV" failure as the cost of being too aggressive. The guard's safety case assumes distinct brain_ids ≈ distinct humans; un-applied merges break that assumption.

**Root cause:** Count is over the raw graph, not the canonical (post-alias) graph.

**Recommended fix:** Count `COUNT(DISTINCT resolveCanonical(brain_id))` — i.e. count distinct *canonical* entities, not raw brain_ids. Depends on C1.

**Detection:** `shared_utility_identifier` suppression of a phone with high legitimate order volume; no targeted alert.

---

### H4. Phone-guard threshold check is strict-greater in one place and uses `+1` projection in another — off-by-one vs the documented N=10 boundary

**Severity:** High | **Category:** Phone-guard correctness | **Priority:** P2 | **Tenant Impact:** Single-tenant.

**Evidence:** Two different predicates for "exceeds threshold":
- Resolver: `const wouldExceed = existingCount + 1 > brandConfig.phone_guard_threshold;` (`IdentityResolver.ts:141`) → suppresses when `existingCount >= threshold` (i.e. at the 10th distinct, count becomes 10, `10+1>10` true → suppress on the 10th, not the 11th).
- Policy (unused by the resolver — dead path): `if (distinctBrainIdCount > threshold)` (`SharedUtilityPolicy.ts:48`) → suppresses only when `count > 10` (the 11th).
- Re-eval job: `if (count <= brand.phone_guard_threshold)` un-suppresses at `<=10` (`phone-guard-reeval.ts:90`).

The e2e test name asserts "N=10 boundary: 11th event ... suppressed" (`identity.e2e.test.ts:483`), matching the `SharedUtilityPolicy` semantics — but the live resolver uses the `+1>threshold` semantics, which suppress at the 10th. **`SharedUtilityPolicy` is not invoked anywhere by the resolver** (the resolver inlines its own logic at `:141`), so the policy class and the resolver disagree on the boundary and one of them is dead code.

**Impact:** The actual suppression boundary is one customer tighter than documented/tested, and there are two competing, divergent implementations of the same rule (Single-Primitive violation). The phone-guard tipping point — a revenue-attribution-sensitive threshold — is ambiguous and untested at its true value.

**Root cause:** Inlined re-implementation of `SharedUtilityPolicy` inside the resolver with a different comparison; the policy class was never wired in.

**Recommended fix:** Delete the inlined logic, call `SharedUtilityPolicy.evaluate()` from the resolver (Single-Primitive), pick ONE boundary semantics, and align the e2e test to the live path (it currently exercises raw SQL fixtures, not the resolver branch).

**Detection:** Boundary-condition test gap; surfaces as merge/suppress disagreement under load.

---

## MEDIUM

### M1. Cycle-guard rejects legitimate merges whenever EITHER id already appears in any live alias — overly broad, sends valid merges to a dead review queue

**Severity:** Medium | **Category:** Merge correctness | **Priority:** P2 | **Tenant Impact:** Single-tenant.

**Evidence:** `IdentityResolver.ts:233-234`:
```ts
if (aliasChain.has(canonicalBrainId) || aliasChain.has(mergedBrainId)) { ... routeToReview ... }
```
`aliasChain` is **every** `observed_brain_id` with `valid_to IS NULL` for the brand (`IdentityRepository.ts:142-147`) — not the chain relevant to *these two* ids. Any brain_id that was ever the *merged* side of a prior merge is in this set. So a new, valid merge whose canonical or merged id happens to have been previously merged is rejected as a "cycle" and routed to `merge_review_queue`, which `0017:195` documents as "M1: unworked; insert-only" — i.e. nothing processes it.

**Impact:** Chained merges (A→B, later B→C, the normal union-find growth path) are blocked and parked in a queue no worker drains. Legitimate identity growth stalls; the entity stays fragmented. Combined with C1/H2 this compounds fragmentation.

**Root cause:** Cycle detection uses the global live-observed set as a proxy for "is in a cycle," which is far broader than an actual alias-chain walk between the two specific ids.

**Recommended fix:** Replace with a real bounded alias-chain walk from each id to its canonical root; declare a cycle only if the walk revisits a node. Build a worker (or auto-resolve) for `merge_review_queue` so parked items don't rot.

**Detection:** Growing `merge_review_queue` with `status='pending'`; no alert configured.

### M2. `merge_review_queue` insert uses `brain_id` for BOTH `brain_id_a` and `brain_id_b`, and the resolver discards the conflicting merged id

**Severity:** Medium | **Category:** Auditability | **Priority:** P3 | **Tenant Impact:** Single-tenant.

**Evidence:** `IdentityRepository.ts:276-288` inserts `VALUES ($1, $2, $2, $3, ...)` — `brain_id_a` and `brain_id_b` are the same value (`outcome.brainId`). On the cycle-guard path the resolver returns `brainId: canonicalBrainId` but does not surface `mergedBrainId` in a structured field (only embedded in the free-text `reviewReason`, `:242`). Phone-conflict suppressions never call `routeToReview` at all (they `continue` at `:135`/`:152`), so the queue only ever gets cycle-guard rows.

**Impact:** A reviewer cannot see which two entities conflicted from the structured columns — the second id is buried in a string. Manual merge review (already unbuilt, M1) is further hampered.

**Recommended fix:** Carry `mergedBrainId` as a first-class field on the review outcome; insert distinct `brain_id_a`/`brain_id_b`.

**Detection:** Manual review only.

### M3. Prod salt resolution conflates "secret ARN" with "raw hex value" — parity/prod-path risk

**Severity:** Medium | **Category:** Salt / parity | **Priority:** P2 | **Tenant Impact:** Cross-brand if it ever returns a wrong/shared value.

**Evidence:** The worker constructs `new SaltProvider(saltSecrets, resolveSaltHex)` (`apps/stream-worker/src/main.ts:128`) — `resolveSaltHex` is passed as the `saltArnFn`. Inside `SaltProvider.forBrand`, `arn = this.saltArnFn(brandId)` then `raw = await this.secrets.getSecret(arn)` (`SaltProvider.ts` ~99). In dev, `resolveSaltHex` returns a 64-hex value and `LocalSecretsProvider.getSecret` echoes it — fine. In **prod** (`NODE_ENV='production'`), `resolveSaltHex` returns `fromEnv ?? ''` (`identity-core/src/index.ts:98`) i.e. the raw env hex, NOT an AWS Secrets Manager ARN — so an `AwsSecretsProvider.getSecret(<64-hex>)` would treat the hex string as a secret name. The prod path therefore depends entirely on `IDENTITY_SALT_<BRAND>` env vars being present (the doc's `§D3.4` flags client/server salt as an unresolved high-stakes question), and the KMS-ARN path the comments describe (`SaltProvider.ts:6-9`) is not actually wired through `resolveSaltHex`.

**Impact:** The documented prod KMS/Secrets-Manager per-brand salt fetch is not reachable through the shared resolver; prod relies on env-var salts. If an env var is missing in prod, `resolveSaltHex` returns `''` → `getSecret('')`/empty → the D-2 guard fires (correct hard-crash), so it fails closed — but the advertised KMS path is effectively dead, and core↔worker parity holds ONLY because both read the same env var, not because both hit the same KMS secret.

**Root cause:** `resolveSaltHex` serves double duty as both salt-value resolver (dev) and ARN-mapper (prod) but only implements the value path.

**Recommended fix:** Split the two responsibilities: a dev value-resolver vs a prod ARN-mapper, selected by `NODE_ENV`, so the AwsSecretsProvider receives an ARN in prod and the env-var fallback is explicit, not accidental.

**Detection:** Would surface as a prod startup hard-crash (good) or — worse — a brand silently using an env-var salt while ops believe KMS is in force.

---

## LOW

### L1. `apps/core/src/modules/identity` is an empty stub — the identity bounded context has no public interface

**Severity:** Low | **Category:** Architecture drift | **Priority:** P3 | **Tenant Impact:** None directly.

**Evidence:** `apps/core/src/modules/identity/index.ts:7` is `export {}; // TODO: expose the public operations of this bounded context.` and `internal/` contains only `.gitkeep`. All identity logic lives in `apps/stream-worker`. The audit scope ("`apps/core/src/modules/identity`") names a module that does not exist in code.

**Impact:** Any core-side need to resolve canonical brain_id (the C1 fix) has no home module — it will be bolted onto consumers ad hoc. The doc-promised "identity-before-journey" read seam (`docs-03 §D4.2`) has no core surface.

**Recommended fix:** Expose `resolveCanonical()` / `lookupByIdentifierHash()` from this module so core consumers have one tenant-scoped seam.

### L2. `computeMergeId` forges UUID version/variant bits from a SHA-256 prefix — non-standard "v5" UUID

**Severity:** Low | **Category:** Determinism hygiene | **Priority:** P3 | **Tenant Impact:** None.

**Evidence:** `IdentityResolver.ts:281-288` slices the first 32 hex of `sha256(...)` and hand-stamps version nibble `'5'` and variant bits. It is deterministic and collision-resistant enough for a PK, but it is NOT a real RFC-4122 v5 UUID (v5 is SHA-1-based). Comment at `:265-268` acknowledges "closest standard." Determinism (the load-bearing property for `ON CONFLICT (merge_id)`) holds, so this is cosmetic.

**Recommended fix:** Either use a proper UUIDv5 (namespace + name via SHA-1) or store the raw 32-hex as the PK and stop pretending it is a typed UUID version.

### L3. Identity extraction reads only `payload.properties.{email,phone,customer_id}` — fragile coupling to one wire shape

**Severity:** Low | **Category:** Robustness | **Priority:** P3 | **Tenant Impact:** None.

**Evidence:** `ResolveIdentityUseCase.ts:72-82` reads `parsed.payload.properties` with a handful of key aliases. `docs-03 §D3.1`/`§D4.9` flag the Zod-vs-Avro envelope divergence as the #2 risk — if a producer emits identifiers at the envelope top level or a different nesting, they are silently treated as `no_identifiers` (`:84-86`), minting nothing and merging nothing, with no DLQ (it's a valid "no_identifiers" outcome, offset committed).

**Recommended fix:** Validate the identifier-bearing payload against the pinned Avro/contract shape and quarantine (DLQ) shape mismatches instead of silently dropping to `no_identifiers`.

---

## What is solid (verified, not flagged)

- **Per-brand salted SHA-256, cross-brand uncorrelatable:** `hashIdentifier` (`identity-core/src/index.ts:219-229`), hard-crash on missing/wrong-length salt (`SaltProvider.ts:120-127`), tested (`identity.e2e.test.ts:297,588`). Real SHA-256, stub removed.
- **RLS FORCE + fail-closed two-arg `current_setting` on every identity table**, with a migration-level assertion that fails the build on one-arg usage (`0017:276-314`). `contact_pii` requires the additional `app.role='send_service'` GUC (`0017:239-244`), tested (`identity.e2e.test.ts:775-783`).
- **Replay idempotency:** deterministic `merge_id` PK + `ON CONFLICT DO NOTHING` on every insert; partial-unique indexes for active-strong links and live aliases (`0017:80,146`), tested 3× (`identity.e2e.test.ts:687`).
- **Consent keyed on identifier hash, not brain_id** (`ProjectConsentUseCase.ts:153`) — survives merges correctly, the one place the un-applied-alias gap does NOT bite.
- **Meta CAPI unsalted match-hash is correctly isolated** to the one mandated boundary (`identity-core/src/index.ts:272-280`) and reuses the shared normalizer.
- **Offset/DLQ discipline** in `IdentityBridgeConsumer` (autoCommit=false, commit-after-write, retry→DLQ@5) is correct and mirrors the bronze consumer.

---

## Verdict

The identity **input** layer — salted per-brand hashing, RLS isolation, replay-idempotent writes, consent-by-hash — is principal-grade and well-tested. The identity **graph** layer is half-built in a way that breaks the product's core "Capture Truth" promise: `brain_id_alias` is written on every merge but **read by nothing except its own cycle-guard**, so merges are recorded for audit yet never applied to any downstream store (ledger, journey, CAPI) — every merged customer is double-counted with no detection (C1). There is **no UNMERGE path at all** despite schema and docs advertising reversible read-time re-pointing (C2), making any bad merge permanent and uncorrectable — a DPDP/GDPR liability. Compounding bugs follow from the same missing read-time-collapse: ≥3-way merges drop the middle ids (H1), merged identifiers are orphaned (H2), the phone-guard over-counts un-collapsed fragments and can suppress legitimate repeat customers (H3), and the guard boundary is implemented twice with conflicting off-by-one semantics where the live path diverges from the test (H4). The fix is largely one primitive — a tenant-scoped `resolveCanonical()` that walks the alias chain — wired into every `brain_id` read plus a `valid_to` setter for unmerge; until it exists, no merge-affected metric should be presented as authoritative.
