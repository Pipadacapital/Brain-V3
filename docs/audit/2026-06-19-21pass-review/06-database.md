# Pass 6: Database Audit (database)

**Board:** Database
**Date:** 2026-06-19
**Auditor:** Principal-level independent review
**Scope:** `db/migrations/`, `packages/db/src/`, `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md`, application query paths

---

## Board Verdict

The migration discipline in this repo is genuinely strong: every brand-scoped table has ENABLE + FORCE RLS, the two-arg `current_setting('app.current_brand_id', TRUE)` NN-1 invariant is applied consistently across all 37 migrations, append-only-by-GRANT is enforced and migration-time asserted, BIGINT money is lint-enforced, SECURITY DEFINER functions always pin `SET search_path = public`, and the `@brain/db` pool correctly resets all three GUCs on checkout. No cross-tenant data exposure vector was found in the RLS or GUC layer. However, four concrete structural defects were identified and are reported below: a duplicate migration prefix that breaks deterministic rollback ordering, a schema-vs-doc drift where `contact_pii` stores raw PII in a plaintext column instead of the KMS-encrypted column required by doc-08, an unbounded memory load of the full alias chain on every identity resolution event, and an index mis-alignment where the as-of seam functions apply a `::date` cast that the `idx_rrl_asof` / `idx_acl_asof` indexes cannot satisfy as a matching predicate (requiring a table scan filtered post-index).

**Severity counts:** Critical: 0 | High: 2 | Medium: 2 | Low: 0

---

## Finding DB-1

**Title:** Duplicate migration prefix `0033_` (two files share the same ordinal) makes rollback order non-deterministic and blocks future migrations from inserting safely between them

**Severity:** High
**Category:** Migration safety / schema management
**Priority:** P1

**evidenceRef:** `db/migrations/0033_consent_record_tombstone.sql` (exists) and `db/migrations/0033_send_log.sql` (exists) — confirmed via `ls db/migrations/0033*`

**Impact:** `node-pg-migrate` derives the sort key from `getNumericPrefix()` which extracts the integer prefix (`0033` for both files). When the numeric prefixes are equal it falls through to `localeCompareStringsNumerically` on the full filename, producing alphabetical order: `consent_record_tombstone` before `send_log`. The DB migrations table records each by full filename (distinct names), so both run — but: (1) the sort order is locale-and-OS-dependent, creating a CI/CD environment portability risk; (2) the `checkOrder()` guard in runner.js (line 130–141) will throw `"Not run migration X is preceding already run migration Y"` if any third file is later inserted between the two 0033 names in the directory; (3) `migrate:down -1` always rolls back `send_log` (last alphabetically), never `consent_record_tombstone` first as a human would expect; (4) if both migrations land in the `migrations` table at the same wall-clock `run_on` timestamp (same-second CI), the row ordering for the `down` path becomes undefined — potentially attempting to rollback `send_log` when `consent_record_tombstone` depends on the 5-category consent vocabulary not yet being present (migration 0034 widens consent category to add 'advertising' and depends on both 0033 tables existing).

**RootCause:** Two feature branches (`feat-d13-consent-cancontact` Track A and Track B) were both assigned ordinal 0033 during concurrent development and merged without renaming. The EOS reconciliation doc does not flag this collision.

**Fix:** Rename `0033_send_log.sql` to `0034_send_log.sql` and shift `0034_capi_passback_log.sql` → `0035_capi_passback_log.sql`, `0035_dq_check_result.sql` → `0036_dq_check_result.sql`, `0036_ai_provenance.sql` → `0037_ai_provenance.sql`. If the environment has already run both 0033 migrations, execute a data migration that renames the `0033_send_log` entry in the `migrations` table to `0034_send_log` before renaming the file. Add a CI lint that asserts no duplicate numeric prefixes exist: `ls db/migrations/ | sed 's/_.*//' | sort | uniq -d` must be empty.

**tenantImpact:** No per-brand data exposure; this is a schema management / migration-runner safety defect. Blast radius: the entire production database on a rollback operation that mis-sequences the two 0033 migrations.

**Detection:** The bug surfaces as either a silent wrong rollback order (`migrate:down`) or a hard error from `checkOrder()` on the next `migrate:up` if someone inserts a file alphabetically between the two 0033 names. Currently invisible in logs (both run successfully on first `migrate:up`).

---

## Finding DB-2

**Title:** `contact_pii.pii_value` stores raw plaintext PII in production; doc-08 mandates `pii_ciphertext bytea` (KMS-encrypted); no code path ever writes to the ciphertext column

**Severity:** High
**Category:** Schema design vs spec / data compliance
**Priority:** P1

**evidenceRef:** 
- `db/migrations/0017_identity_graph.sql:228` — column `pii_value TEXT NULL` annotated "dev plaintext stand-in (prod: use pii_ciphertext)"
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:319-323` — production write path: `INSERT INTO contact_pii (brand_id, brain_id, pii_type, pii_value, identifier_hash) VALUES ($1, $2, $3, $4, $5)` where `$4 = pii.raw_value`
- `docs/requirements/08_Brain_Data_Model_and_Database_Schema.md:283` — spec: `contact_pii(brand_id, brain_id, pii_type text, pii_ciphertext bytea, kms_key_id text, identifier_hash text, ...)`
- No code anywhere writes to `pii_ciphertext`: `grep -rn "pii_ciphertext" apps/` returns zero results

**Impact:** Raw PII (email, phone, name) is stored unencrypted in Postgres, contradicting the KMS vault design in doc-08 §6 and the compliance controls required by DPDP 2023. The `contact_pii` table's elevated RLS policy (requiring both `app.current_brand_id` AND `app.role='send_service'`) correctly restricts read access, but RLS does not protect against a DB-level breach (backup exfiltration, superuser access, replication subscriber). The `brand_keyring` and KMS infrastructure built in migration 0001 is never connected to this table. Doc-08 §13 requires "crypto-shred (destroy per-brand/per-subject key material)" for DPDP erasure — this is only possible if PII was encrypted; plaintext erasure requires a DELETE that the schema structure cannot safely accommodate.

**RootCause:** The migration was written with a documented placeholder ("dev: plaintext pii_value; prod: pii_ciphertext bytea") but the application layer was never updated to perform KMS encryption before writing. There is no env-gate in IdentityRepository.ts that distinguishes dev from prod.

**Fix:** Add `pii_ciphertext BYTEA` column to `contact_pii` via an additive migration (IF NOT EXISTS). Implement a `PiiVaultService` that calls AWS KMS `Encrypt` before each `contact_pii` write, writing to `pii_ciphertext` and `kms_key_id` columns (using the brand's `brand_keyring.kms_key_id`). Remove `pii_value` writes from `IdentityRepository.ts` (or gate them to non-production environments with `NODE_ENV` check). The column must be kept nullable during the migration window to avoid breaking existing rows. Add a migration-time assertion that checks `pii_ciphertext` is NOT NULL for production rows (or alternatively, add a DB CHECK constraint enforcing that at least one of pii_value/pii_ciphertext is non-null in prod mode).

**tenantImpact:** All brands whose customers have been identity-resolved. Each customer's email, phone, and name are stored in plaintext in Postgres. In a credential breach scenario, a single DB read exposes PII across all brands simultaneously.

**Detection:** Silent in application logs; no alert fires. Would surface only in a security audit (this audit) or a breach post-mortem.

---

## Finding DB-3

**Title:** `realized_gmv_as_of()` and all as-of seam functions use `economic_effective_at::date` cast that prevents index range seek on `idx_rrl_asof` and is timezone-dependent

**Severity:** Medium
**Category:** Index coverage / query-path analysis / scalability ceiling
**Priority:** P2

**evidenceRef:**
- `db/migrations/0018_realized_revenue_ledger.sql:107-109` — index: `CREATE INDEX idx_rrl_asof ON realized_revenue_ledger (brand_id, economic_effective_at) WHERE event_type <> 'provisional_recognition'`
- `db/migrations/0018_realized_revenue_ledger.sql:184-186` — function predicate: `AND economic_effective_at::date <= p_as_of`
- `db/migrations/0032_attribution_credit_ledger.sql:127-128` — same pattern on attribution_credit_ledger
- `db/migrations/0032_attribution_credit_ledger.sql:203,233-234,265-266` — all three as-of seam functions use `::date` cast
- `db/migrations/0020_provisional_gmv_as_of.sql:35` — same pattern on provisional seam
- `apps/core/src/main.ts:371` — no timezone is set on the connection pool; session timezone is Postgres server default
- Contrast: `db/migrations/0018_realized_revenue_ledger.sql:101-104` — the dedup index correctly uses `timezone('UTC', occurred_at)::date` (IMMUTABLE)

**Impact:** Two distinct problems: (A) **Index mis-match**: The index stores `economic_effective_at` as TIMESTAMPTZ. The query predicate `economic_effective_at::date <= p_as_of` applies a cast operator to the stored value, which means PostgreSQL cannot directly use the index as a b-tree range scan for `::date <= date_val` without inferring an equivalent TIMESTAMPTZ bound. Postgres does handle this via a cast approximation (`economic_effective_at < (p_as_of + interval '1 day' at timezone session_tz)`), but it is not guaranteed to use `idx_rrl_asof` as the primary index path; without a functional index `ON ((timezone('UTC', economic_effective_at)::date))`, the planner may fall back to a sequential scan filtered post-index. For large brands with millions of ledger rows, the `realized_gmv_as_of()` call (the core billing and metric-engine read path) will be slow. (B) **Timezone correctness**: `TIMESTAMPTZ::date` uses the session timezone. The pool sets no explicit timezone; if the Postgres server is configured with `timezone = 'Asia/Kolkata'` (IST), `economic_effective_at::date` returns IST dates not UTC dates. An event at 23:45 UTC on 2026-06-01 would have `::date = '2026-06-02'` in IST but `'2026-06-01'` in UTC. This silently shifts as-of reads by up to one day for brands in the IST/GCC timezone range. Doc-08 §4 states "timestamptz UTC" as the global convention.

**RootCause:** The `::date` cast was likely written for simplicity (comparing `TIMESTAMPTZ::date` to a `DATE` parameter). The IMMUTABLE fix was applied to the dedup index but not to the as-of seam functions.

**Fix:** Replace all `economic_effective_at::date <= p_as_of` predicates in the four as-of seam functions with `timezone('UTC', economic_effective_at)::date <= p_as_of`. Create matching functional indexes: `CREATE INDEX idx_rrl_asof_date ON realized_revenue_ledger (brand_id, (timezone('UTC', economic_effective_at)::date)) WHERE event_type <> 'provisional_recognition'` and similarly for `attribution_credit_ledger`. The `timezone('UTC', …)` form is IMMUTABLE and allows the planner to use a b-tree range seek on the expression index. Additionally, add `options: "-c timezone=UTC"` to the pg.Pool configuration in `createPool()` to pin all connections to UTC.

**tenantImpact:** All brands. The as-of correctness issue affects any brand whose events straddle midnight UTC in their local timezone. The index performance issue affects all brands at scale; at high event volume the metric-engine billing read will degrade to O(n) table scans.

**Detection:** Performance: slow queries visible in `pg_stat_statements` once ledger grows. Correctness: a subtle off-by-one-day discrepancy in revenue metrics near period boundaries; detectable only with timezone-aware reconciliation tests.

---

## Finding DB-4

**Title:** `IdentityRepository.readState()` loads the ENTIRE live `brain_id_alias` set for a brand into memory on every identity resolution call — no upper bound

**Severity:** Medium
**Category:** Scalability ceiling / query-path analysis
**Priority:** P2

**evidenceRef:**
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:141-147` — `SELECT observed_brain_id FROM brain_id_alias WHERE brand_id = $1 AND valid_to IS NULL` — no LIMIT, no pagination
- `db/migrations/0017_identity_graph.sql:146-148` — UNIQUE PARTIAL index `brain_id_alias_live_unique ON brain_id_alias (brand_id, observed_brain_id) WHERE valid_to IS NULL` — the index exists and will be used for the scan, but the entire result set for a brand is fetched
- `apps/stream-worker/src/infrastructure/pg/IdentityRepository.ts:147` — `const aliasChain = new Set(aliasRows.rows.map((r) => r.observed_brain_id))` — full set materialized in Node.js heap

**Impact:** `readState()` is called on **every event** processed by the identity resolution pipeline. For a brand with 1 million customers and a 30% merge rate, `aliasChain` will contain ~300,000 UUIDs per call. At 32 bytes per UUID string plus object overhead, this is ~15–20 MB per resolution event in Node.js heap. Under high throughput (hundreds of events/second per brand), the stream-worker will experience GC pressure and eventual OOM. The query itself does an index scan on `brain_id_alias_live_unique` (efficient), but the network transfer and heap materialization are O(merged_profiles). There is no deduplication guard — the same `aliasChain` data is fetched even if no cycle detection is needed for the current batch. Additionally, the cycle-detection purpose (`aliasChain` is used only to prevent re-merging an already-canonical brain_id) does not require loading all aliases, only checking the lookup for the specific `observed_brain_id` values in the current batch.

**RootCause:** The `aliasChain` was designed to detect merge cycles (a brain_id that is already an alias of another cannot be promoted to canonical). This is a sound requirement, but the implementation loads all live aliases rather than checking only the relevant subset (the identifiers being processed in the current batch).

**Fix:** Replace the unbounded read with a targeted lookup: instead of `SELECT observed_brain_id FROM brain_id_alias WHERE brand_id = $1 AND valid_to IS NULL`, query `SELECT observed_brain_id FROM brain_id_alias WHERE brand_id = $1 AND observed_brain_id = ANY($2::uuid[]) AND valid_to IS NULL` — where `$2` is the set of `brain_id` values from the current resolution batch (only those need cycle-detection). The existing UNIQUE PARTIAL index makes this a point-lookup. If a broader cycle check is genuinely needed, add a `LIMIT` as a safety circuit (e.g., `LIMIT 100000`) with a metric emitted on breach. Also consider caching the `aliasChain` per `brand_id` with a short TTL (e.g., 10 seconds) in the stream-worker to avoid re-loading on back-to-back events for the same brand.

**tenantImpact:** Single-brand blast (the OOM/GC pressure is proportional to merge count per brand). Brands with large customer bases and high merge rates (e.g., DTC brands with heavy COD and phone-number reuse) will trigger this first. In a shared stream-worker process, one such brand can starve memory from all other brands.

**Detection:** Node.js heap used (visible via `process.memoryUsage()` metrics or Prometheus `nodejs_heap_size_used_bytes`). A spike in heap per identity-resolve batch is the signal. May also surface as `ENOMEM` process crash with a distinctive OOM trace in stream-worker logs.

---

## Appendix: What Was Checked and Found Clean

The following areas were investigated and found to be correctly implemented (no findings):

- **RLS two-arg form (NN-1):** All 20+ brand-scoped tables use `current_setting('app.current_brand_id', TRUE)` consistently. Migration-time DO-block assertions catch regressions. Confirmed across migrations 0001–0036.
- **FORCE ROW LEVEL SECURITY:** Every brand-scoped table has both `ENABLE` and `FORCE RLS`. The FORCE clause prevents bypass by the table owner. Confirmed via migration-time assertions in 0027, 0029, 0032, 0033, 0034, 0035.
- **Append-only-by-GRANT:** Financial ledgers (`realized_revenue_ledger`, `attribution_credit_ledger`, `ad_spend_ledger`), identity audit, consent tables, and CAPI logs all have `SELECT + INSERT` only for `brain_app`. UPDATE/DELETE asserted absent at migration time.
- **BIGINT money (I-S07):** No NUMERIC or float money columns found. Migration assertions guard against future regressions. The dedup index on `occurred_at` correctly uses the IMMUTABLE `timezone('UTC', occurred_at)::date` form.
- **SECURITY DEFINER functions:** All six enumeration/resolution SECURITY DEFINER functions (`list_connectors_for_repull`, `resolve_connector_by_shop_domain`, `list_razorpay_connectors_for_settlement_repull`, `resolve_razorpay_connector_by_account`, `list_ad_connectors_for_spend_repull`, `list_active_brand_ids`) pin `SET search_path = public` and are asserted at migration time. `prosecdef=true` assertion is verified.
- **GUC pool middleware:** `packages/db/src/index.ts` correctly resets all three GUCs at checkout and re-sets before every query. UUID injection guard is present. Unit tests cover the negative-control (missing GUC → 0 rows).
- **Deterministic ledger IDs / replay idempotency:** `ledger_event_id = sha256(...)` ensures ON CONFLICT DO NOTHING absorbs replays. Verified in migrations 0018 and 0032.
- **contact_pii elevated RLS:** The two-predicate policy (brand_id AND app.role='send_service') is correctly implemented. IdentityRepository.ts sets both GUCs before writing to contact_pii.
- **BYPASSRLS assertion:** Migration 0001 asserts at runtime that `brain_app` does NOT have BYPASSRLS, preventing the most critical isolation breach.
- **Schema-doc alignment (other tables):** The `realized_revenue_ledger`, `identity_link`, `brain_id_alias`, `consent_record`, `consent_tombstone`, `dq_check_result`, and `ai_provenance` schemas were compared against doc-08 and found to match. No extra or missing columns were found beyond the `pii_value` issue noted in DB-2.
