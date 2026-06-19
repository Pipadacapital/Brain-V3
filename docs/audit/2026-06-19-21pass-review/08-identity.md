# Pass 8: Identity Audit (identity)

## Board Verdict

The identity resolution pipeline has a correct architectural skeleton: deterministic SHA-256 hashing with per-brand salts, RLS-enforced tenant isolation using two-arg `current_setting`, phone-guard with windowed suppression, replay-idempotent `ON CONFLICT DO NOTHING` writes, and an append-only audit trail. The hard-crash guard on missing/short salts (D-2) and the dual-GUC contact_pii gate (D-3) are implemented correctly and tested. However, four concrete code defects were found that collectively compromise the phone-guard lifecycle, the merge review queue's forensic value, the audit trail's accuracy for cycle-guard events, and (under concurrent load) the fragmentation safety of the graph. One of these defects (phone-guard-reeval SQL parameter binding) causes the re-evaluation job to silently fail on every run, permanently locking suppressed phone numbers — defeating the entire windowed-suppression design. The N>2 merge gap silently orphans intermediate brain_ids when a single event matches three or more existing profiles. No probabilistic merge is present (D-5 satisfied). PII isolation is sound. The core resolution path is correct for the common case; the failures are in the correctness boundaries and operational tooling.

**Severity counts: Critical 1 | High 2 | Medium 1 | Low 0**

---

## Finding IDENT-1

**Title:** phone-guard-reeval.ts SQL parameter binding bug makes suppression permanent

**Severity:** Critical
**Priority:** P0
**Category:** Data Correctness / Operational Bug
**Tenant Impact:** Every brand; all suppressed phone identifiers on all brands are permanently frozen once flagged.

**evidenceRef:**
- `apps/stream-worker/src/jobs/phone-guard-reeval.ts:92-101` (un-suppress branch)
- `apps/stream-worker/src/jobs/phone-guard-reeval.ts:111-119` (re-suppress branch)
- `db/migrations/0017_identity_graph.sql:172` (profile_count INT NOT NULL)

**Root Cause:**

Both UPDATE branches in the re-evaluation job have incorrect parameter binding. In the un-suppress branch (lines 92-101):

```sql
UPDATE shared_utility_identifier
  SET suppressed_until = NULL,
      profile_count = $3,         -- BUG: $3 = sui.identifier_value (64-hex text)
      ...
  WHERE brand_id = $1
    AND identifier_type = $2
    AND identifier_value = $3     -- correct: $3 = identifier_value
```
params: `[brand.id, sui.identifier_type, sui.identifier_value, count]`

`$3` is `sui.identifier_value` (a 64-char hex string). `profile_count` is `INT NOT NULL`. PostgreSQL 16 raises `ERROR: invalid input syntax for type integer` when it tries to cast the hex string. The per-brand `catch` block at line 131 catches this, rolls back, logs the error, and continues to the next brand. **The phone is never un-suppressed.**

The re-suppress branch (lines 111-119) has the same `profile_count = $3` mistake, plus `suppressed_until = $4` where `$4 = count` (integer, not timestamptz).

**Impact:**

The windowed suppression design (D-1) is supposed to re-evaluate suppressed phones after `suppression_window_days` and un-suppress when the windowed count drops below threshold. This job is the only un-suppress path. With it permanently broken, any phone number flagged by the threshold guard stays suppressed indefinitely. Legitimate repeat customers whose phone was caught in a burst window can never be re-recognized by phone — their identity resolution is permanently degraded unless they have an email or storefront ID in every event. The suppression window concept is effectively dead.

**Fix:**

Un-suppress branch — change params to `[brand.id, sui.identifier_type, sui.identifier_value, count]` and fix the SET:
```sql
SET suppressed_until = NULL,
    profile_count = $4,           -- was $3; $4 = count (integer)
```
Re-suppress branch — params `[brand.id, sui.identifier_type, sui.identifier_value, count, newSuppressedUntil]`:
```sql
SET suppressed_until = $5,        -- was $4; $5 = newSuppressedUntil (timestamptz)
    profile_count = $4,           -- was $3; $4 = count (integer)
```
Add an e2e test: insert a suppressed row with `suppressed_until = NOW() - interval '1 day'` and count=0, run the job, assert `suppressed_until IS NULL`.

**Detection:** The SQL error is currently logged as `[phone-guard-reeval] error for brand <id>` with a PostgreSQL cast error. The job exits with success (`process.exit(0)`), so no alert fires. Add a metric counter `phone_guard_reeval_errors_total` and alert on non-zero; or assert `totalUnsuppressed + totalExtended > 0` on brands with expired suppressions.

---

## Finding IDENT-2

**Title:** merge_review_queue INSERT uses same brain_id for both sides of the conflict

**Severity:** High
**Priority:** P1
**Category:** Data Correctness / Forensics Gap
**Tenant Impact:** All brands; every cycle-guard event produces a forensically useless review queue entry.

**evidenceRef:**
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:277-287`
- `apps/stream-worker/src/domain/identity/IdentityResolver.ts:234-244`
- `db/migrations/0017_identity_graph.sql:196-207`

**Root Cause:**

In `writeOutcome`, the `merge_review_queue` INSERT uses parameter `$2` for **both** `brain_id_a` and `brain_id_b`:

```sql
INSERT INTO merge_review_queue (brand_id, brain_id_a, brain_id_b, trigger_reason, evidence)
VALUES ($1, $2, $2, $3, $4::jsonb)
```
params: `[brandId, outcome.brainId, outcome.reviewReason, JSON.stringify(...)]`

When the cycle-guard fires (action='skipped'), `outcome.brainId = canonicalBrainId` (line 238 of IdentityResolver). The `mergedBrainId` (the other side of the detected cycle) is embedded only in `outcome.reviewReason` as a plain string, not passed as `$3`. The review queue row therefore has `brain_id_a = brain_id_b = canonicalBrainId`.

The `merge_review_queue` table has no uniqueness constraint, so duplicate identical rows accumulate for repeated cycle events.

**Impact:**

The review queue is the only operational surface for human investigation of identity conflicts. With `brain_id_a = brain_id_b`, an operator cannot query `WHERE brain_id_b = ?` to find the other party in the cycle. The only way to recover the second brain_id is to parse the `trigger_reason` text column — a fragile, unsupported path. The table also has no `ON CONFLICT DO NOTHING` guard, so a replay will insert duplicate rows for the same cycle.

**Fix:**

Pass `mergedBrainId` (from `outcome.reviewReason` parsing or, better, as a new field on `ResolveOutcome`) as the `brain_id_b` parameter. Add a `mergedBrainId?: string` field to `ResolveOutcome` for the 'skipped' case. Change the INSERT to `VALUES ($1, $2, $3, $4, $5::jsonb)` and add a unique partial index on `(brand_id, brain_id_a, brain_id_b) WHERE status = 'pending'` to prevent duplicates.

**Detection:** Query `SELECT brain_id_a, brain_id_b FROM merge_review_queue WHERE brand_id=$1` — if `brain_id_a = brain_id_b` for any row, this bug is present. There are no tests that verify the content of `merge_review_queue` rows (confirmed by grep: only cleanup queries reference it in the e2e test).

---

## Finding IDENT-3

**Title:** N>2 brain_id merge silently orphans intermediate profiles

**Severity:** High
**Priority:** P1
**Category:** Identity Graph Correctness / Fragmentation
**Tenant Impact:** All brands; affects multi-identifier events that match 3+ existing brain_ids simultaneously.

**evidenceRef:**
- `apps/stream-worker/src/domain/identity/IdentityResolver.ts:229-231`
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:213-247`
- `apps/stream-worker/src/tests/identity.e2e.test.ts` (no test covers N>2 case)

**Root Cause:**

When `matchedBrainIds.size >= 2`, the resolver picks only the first (lowest UUID) and last (highest UUID) from the sorted array:

```typescript
const sortedIds = [...matchedBrainIds].sort();
const canonicalBrainId = sortedIds[0]!;
const mergedBrainId = sortedIds[sortedIds.length - 1]!;
```

If `matchedBrainIds = {A, B, C}` (sorted: `[A, B, C]`), canonical=A and merged=C. `B` is silently dropped: no `identity_merge_event`, no `brain_id_alias`, no `merge_review_queue` entry. The `writeOutcome` call merges only the `(A, C)` pair. `B` retains its original `identity_link` rows as an unresolved independent profile.

A future event would need to simultaneously match BOTH `B`'s identifiers AND A's identifiers to trigger a subsequent `(A, B)` merge — but the event that triggered the current resolution already had both sets. This means `B` may remain orphaned indefinitely.

**Impact:**

Identity fragmentation: a real customer who has linked their email to profile A and their phone (pre-suppression) to profile B, and now presents a checkout with storefront ID linked to profile C gets profiles A and C merged but B orphaned. Downstream LTV, attribution, and journey stitching for B's historical events will never re-point to the canonical `A`. Revenue attribution for B's orders is permanently split.

The docs describe a "union-find" graph (`docs/requirements/04_Brain_Architecture_and_Delivery_Plan.md:364`) but the implementation performs only pairwise merges, leaving the graph inconsistent after fan-in events.

**Fix:**

When `matchedBrainIds.size > 2`, emit multiple pairwise merge specs (one per non-canonical brain_id) or route ALL of them to the review queue. The simplest safe fix: when `matchedBrainIds.size > 2`, loop over `sortedIds.slice(1)` and produce a merge for each `(canonicalBrainId, sortedIds[i])` pair (each with its own deterministic mergeId). The `writeOutcome` must write all merge pairs. Alternatively, route the whole fan-in to `merge_review_queue` for human resolution. Add a unit test: construct `existingLinks` with 3 distinct brain_ids matching 3 identifiers, assert all 3 appear in the outcome.

**Detection:** Query `SELECT brain_id FROM customer WHERE brand_id=$1 AND lifecycle_state='active'` and cross-reference with `identity_link` for any brain_id with no active strong-tier link — these are candidates for the orphan pattern. No current alert covers this.

---

## Finding IDENT-4

**Title:** TOCTOU race between readState and writeOutcome produces orphan customer profiles under concurrent partition processing

**Severity:** Medium
**Priority:** P2
**Category:** Concurrency / Identity Fragmentation
**Tenant Impact:** All brands with high-throughput pixel events (same customer, multiple concurrent events on different partitions).

**evidenceRef:**
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:55-157` (readState — separate transaction)
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:165-328` (writeOutcome — separate transaction)
- `infra/redpanda/topics.yml:11` (12 partitions; partition key = brand_id:event_id)
- `infra/redpanda/README.md:26-34` (partition key = brand_id + ":" + event_id)

**Root Cause:**

The partition key is `brand_id:event_id` (confirmed in `packages/events/src/index.ts:141`). Two events for the **same customer** (same email, different event_id) hash to different partitions and are processed concurrently by the same consumer group's different partition threads.

The identity pipeline has a **two-transaction** design: `readState` opens a `BEGIN/COMMIT` READ COMMITTED transaction, then `writeOutcome` opens a second independent transaction. There is no lock or serializable isolation between them.

Race scenario (two concurrent threads, same brand, same customer email `E`):
1. Thread-A reads: existingLinks=[] (no match for `E`)
2. Thread-B reads: existingLinks=[] (no match for `E`)
3. Thread-A writes: INSERT customer(brain_id=X), INSERT identity_link(email=E → X) — succeeds
4. Thread-B writes: INSERT customer(brain_id=Y) — succeeds; INSERT identity_link(email=E → Y) → `ON CONFLICT ... DO NOTHING` — silently dropped

Result: customer row Y exists with no strong `identity_link`. Y is an orphan profile. A subsequent event matching email `E` resolves to X (the one that won), leaving Y undetected until a future event happens to also carry Y's weak identifiers.

**Impact:**

The `ON CONFLICT DO NOTHING` prevents data corruption in the identity_link table but creates silent ghost profiles in the `customer` table. The burst scenario (e.g., checkout pages firing multiple pixel events simultaneously) can create multiple ghost profiles per customer. These aren't merged without a future event that links them, and no review queue entry is created. Attribution and journey stitching will miss historical events attributed to ghost profiles.

This is a known-hard problem in identity resolution systems; the severity is Medium because the practical window is short (two events for the same new customer arriving in the same millisecond window), but it is non-zero in high-throughput checkout flows.

**Fix:**

Option A (least-invasive): After `writeOutcome`, re-read the identity_link for the brand+hash. If the written brain_id is NOT the canonical brain_id for that hash (i.e., another concurrent write won), immediately emit a merge event for the two brain_ids. This detection loop runs within the same `writeOutcome` transaction.

Option B (partition-key change): Change the Kafka message key from `brand_id:event_id` to `brand_id:<hash-of-first-strong-identifier>`. This routes all events for the same customer (same email hash) to the same partition, guaranteeing sequential processing. Requires a partition key change in the collector and a consumer group reset.

Option C (advisory lock): Add `SELECT pg_advisory_xact_lock(hashtext($1 || $2))` in `writeOutcome` keyed on `(brand_id, identifier_hash)` before writing, serializing concurrent writes for the same identity.

**Detection:** Monitor `customer` rows where `NOT EXISTS (SELECT 1 FROM identity_link WHERE brand_id=customer.brand_id AND brain_id=customer.brain_id AND is_active=TRUE AND tier IN ('strong','strong_on_link'))` and `lifecycle_state='active'`. Alert if count > 0 per brand.
