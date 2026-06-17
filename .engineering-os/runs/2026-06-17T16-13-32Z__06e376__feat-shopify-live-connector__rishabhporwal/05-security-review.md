# Security Review — feat-shopify-live-connector
**Stage:** 4 · **Mode:** FULL · **Verdict:** PASS
**Req ID:** feat-shopify-live-connector
**Branch:** feat/shopify-live-connector
**Reviewer:** Security Reviewer (Sonnet 4.6)
**Date:** 2026-06-17T00:00:00Z
**Lane:** high_stakes — connectors, multi_tenancy, money, pii, schema_proto, outbound_channel, oauth/secrets

---

## 1. Scope

All high-stakes surfaces verified at source (not from reports):
- `apps/core/.../webhooks/shopifyWebhookHandler.ts` — HMAC-first gate + brand resolution
- `apps/core/src/modules/connector/sources/storefront/shopify/domain/value-objects/ShopifyHmac.ts` — HMAC algorithm
- `apps/core/src/main.ts` — raw-body plugin registration, Kafka producer wiring, CSRF exemption
- `db/migrations/0026_live_connector_security_definer_fns.sql` — both SECURITY DEFINER fns
- `apps/stream-worker/src/jobs/shopify-repull/run.ts` — re-pull enumeration + GUC + SKIP LOCKED
- `apps/stream-worker/src/jobs/shopify-repull/shopify-live-client.ts` — Shopify HTTP client
- `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts` — writeReversal (D-13)
- `packages/shopify-mapper/src/index.ts` — PII boundary, money, UUID
- `apps/stream-worker/src/interfaces/consumers/LiveOrderConsumer.ts` — routing logic
- `apps/stream-worker/src/tests/live-connector.e2e.test.ts` — 16 tests (T1-T8)
- `apps/core/.../tests/shopifyWebhookHandler.integration.test.ts` — 8 tests (B3)
- COMPLIANCE.md + INVARIANTS.md + durable-rules/INDEX.md verified

Scanner scope (delta-mode runners not available in this environment; diff reviewed manually):
- Secret grep on full diff: CLEAN — no hardcoded secrets, tokens, client secrets, or ARNs with embedded credentials
- SAST (manual equivalent): no hardcoded secrets; clientSecret fetched from ISecretsManager at runtime; never logged; no `console.log(clientSecret)` or similar
- Dependency audit: new deps are `kafkajs ^2.2.4` (existing dep in stream-worker, known-good), `fastify-raw-body ^5.0.0` (established plugin), `@brain/shopify-mapper workspace:*` (internal); no CRITICAL/HIGH CVEs identified in these additions
- Migration diff: additive only (two CREATE FUNCTION, no table/policy changes); 0025 untouched

---

## 2. HMAC-First Gate (NN-4) — VERIFIED PASS

**File:** `apps/core/.../webhooks/shopifyWebhookHandler.ts:93-114`

Execution order (confirmed at source, immovable by code structure):
1. `rawBody = (req as ... & { rawBody?: Buffer }).rawBody` — error if absent (400, not 401; this is a raw-body-plugin configuration error, not an auth failure — acceptable)
2. `ShopifyHmac.validateWebhook(rawBody, hmacHeader, clientSecret)` — false → `reply.code(401)`, function returns immediately
3. Only on HMAC pass: `rawPgPool.query('SELECT ... FROM resolve_connector_by_shop_domain($1)')` (step 2 in handler)
4. No produce, no write, no log of the body before HMAC passes

**ShopifyHmac.validateWebhook** (`ShopifyHmac.ts:70-91`): HMAC-SHA256 over raw body Buffer, digest as base64, timing-safe comparison (`timingSafeEqual`) with length check before comparison. Correct algorithm, correct encoding, timing-safe.

**rawBody plugin** (`main.ts:184-189`): registered with `runFirst: true`, `encoding: false` (Buffer), `global: false`, BEFORE webhook route registration. Plugin type-cast workaround is standard Fastify 5 pattern. Confirmed the CSRF hook exempts `/api/v1/webhooks/` paths (`main.ts:231`).

**Secret seam** (`main.ts:380`, `connectorSecretsManager`): dev=LocalSecretsManager (env-based), prod=AwsSecretsManager (ARN reference → Secrets Manager). clientSecret never in logs or events.

**Non-inert proof:** B3 Test 2 — HMAC-invalid returns 401 AND Kafka producer mock `send` was never called. Removing the HMAC check causes Test 2 to return 200 (test goes RED). Confirmed non-inert.

**Verdict: PASS**

---

## 3. Brand-from-DB Anti-Spoof (D-4) — VERIFIED PASS

**File:** `shopifyWebhookHandler.ts:116-158`

After HMAC passes:
1. `shopDomain = req.headers['x-shopify-shop-domain']` — used ONLY as lookup key, explicitly documented
2. `rawPgPool.query('SELECT ... FROM resolve_connector_by_shop_domain($1)', [shopDomain])` — SECURITY DEFINER fn, no GUC needed
3. `connectorRow = result.rows[0] ?? null` — if null → 401, no write
4. `const brandId = connectorRow.brand_id` — from DB row, not from header

Code comment at line 157: `// brand_id is authoritative from the DB row (never from header/body — D-4 / MT-1)`

There is NO code path where a header or body value reaches a write as `brand_id`. The header is only ever passed as a SQL parameter (`$1`), and the query returns the DB's brand_id.

**Anti-spoof attack surface:** An attacker who knows the client_secret (app-level — same for all connectors in M1) and signs a valid body can forge the `x-shopify-shop-domain` header to any value. The handler will look up whichever shop is in the header — if that shop exists in the DB, it resolves to that shop's brand, which is correct. If it doesn't exist → 401. The attacker cannot write to Brand A by claiming Brand A's shop_domain in a request signed by Brand B's connector at M1 (they both use the shared client_secret — the HMAC tells us the signer holds the secret; the shop_domain lookup determines WHICH connector it is). The test correctly proves `brand_id` is ALWAYS from the DB row.

**B3 Test 3 (anti-spoof, non-inert):** Two seeded brands with distinct shop_domains (SHOP_A → Brand A, SHOP_B → Brand B). A request with SHOP_A header produces brand_id = B3_BRAND_A. A request with SHOP_B header produces brand_id = B3_BRAND_B. Neither the raw header string nor an empty value appears as brand_id in the envelope. Test 8 adds explicit assertion: `envelope.brand_id === B3_BRAND_A`, `envelope.brand_id !== SHOP_A`. Non-inert because Brand A and Brand B are both seeded, so an inert test would accept either.

**Verdict: PASS**

---

## 4. SECURITY DEFINER Functions (migration 0026) — VERIFIED PASS

**File:** `db/migrations/0026_live_connector_security_definer_fns.sql`

Both functions (`list_connectors_for_repull`, `resolve_connector_by_shop_domain`):

| Property | list_connectors_for_repull | resolve_connector_by_shop_domain |
|---|---|---|
| SECURITY DEFINER | YES (line 54 / 143) | YES (line 143 / 144) |
| SET search_path = public | YES (line 56 / 145) | YES (line 146) |
| LANGUAGE sql | YES | YES |
| STABLE | YES | YES |
| GRANT EXECUTE TO brain_app | YES (line 69 / 160) | YES (line 160) |
| Dispatch-only return cols | (id, brand_id, shop_domain, secret_ref) | (id, brand_id, shop_domain, secret_ref) |
| Migration-time assertions | 3 DO blocks each: prosecdef=true, search_path=public, EXECUTE grant | Same |

`resolve_connector_by_shop_domain` has `LIMIT 1` (line 157) — cannot leak multiple brands' data even if somehow multiple rows matched.

`list_connectors_for_repull` filters `provider='shopify' AND status='connected'` — correctly scoped, no excess tenant data.

Both mirror the pattern from migration 0023 (backfill enumeration) confirmed PASS in prior review.

No table changes, no RLS policy changes, no GRANT weakening. `0025` untouched. Rollback is `DROP FUNCTION` — additive and reversible.

**Verdict: PASS**

---

## 5. Re-pull Enumeration + GUC Order (D-7, durable rule) — VERIFIED PASS

**File:** `apps/stream-worker/src/jobs/shopify-repull/run.ts`

Enumeration path (`enumerateConnectors`, lines 130-151):
- Calls `list_connectors_for_repull()` via pool.query — no GUC set at this point
- Returns dispatch-only rows: `connector_instance_id, brand_id, shop_domain, secret_ref`
- `brand_id` authority = fn result (MT-1)

GUC-after-enumerate pattern in `acquireRepullLock` (lines 333-338):
```
BEGIN
SELECT set_config('app.current_brand_id', brandId, true) [+ user_id + workspace_id]
```
Before ANY brand-scoped write (`connector_cursor` INSERT/SELECT).

`setSyncState` (lines 454-457): GUC set before UPDATE on `connector_sync_status`.
`getRepullCursor` (lines 391-394): GUC set before SELECT on `connector_cursor`.
`upsertRepullCursor` (lines 422-425): GUC set before INSERT/UPDATE on `connector_cursor`.

**brand_id never from env, Shopify, or header** — always from `connector.brand_id` which is the fn result.

**Non-inert no-GUC negative control (T7-b):** Test at `live-connector.e2e.test.ts:696-757` under `appPool` (BRAIN_APP_DATABASE_URL, brain_app role, confirmed is_superuser=false in T7-a). Test resets GUC to DEFAULT, then does bare `SELECT COUNT(*) FROM connector_instance` → expects 0. If RLS throws on cast, test also passes (confirms security is real). Non-inert: BRAND_A connector was seeded with `status='connected'`, which would return 1 row if the GUC bypassed RLS.

**T7-c (positive control):** `list_connectors_for_repull()` returns the seeded row even without a GUC — proves SECURITY DEFINER works as intended.

**Verdict: PASS**

---

## 6. PII Boundary (D-10 / I-S02) — VERIFIED PASS

**File:** `packages/shopify-mapper/src/index.ts:228-244`

`mapOrderToEvent` receives raw Shopify order (with `customer.email`, `customer.phone`):
- `hashIdentifier(customer.email, 'email', saltHex, regionCode)` → `hashed_customer_email`
- `normalizePhone(customer.phone, regionCode)` then `hashIdentifier(...)` → `hashed_customer_phone`
- `storefrontCustomerId = String(customer.id)` — Shopify internal numeric ID (classified as non-PII, linkage ID; pre-existing behavior from backfill, confirmed in backfill e2e comment at line 570: "storefront_customer_id (Shopify numeric ID) is NOT PII")
- Raw `customer` object dropped; the mapper DOES NOT include it in properties

Output `properties` object: `hashed_customer_email`, `hashed_customer_phone`, `storefront_customer_id` (numeric, non-PII), `cancelled_at` (timestamp), standard order fields. No raw email, phone, or name.

**B3 Test 6 (PII probe):**
- Asserts `rawEnvelopeStr.not.toContain('test@example.com')` — raw email
- Asserts `rawEnvelopeStr.not.toContain('+919876543210')` — raw phone
- Asserts `rawEnvelopeStr.not.toContain('"customer"')` — raw customer object
- If `hashed_customer_email` present, asserts it is a non-empty string (hash, not empty)

**A4 T7-a/T7-b:** assertBrainApp checks run under brain_app. T8 cross-brand isolation.

Log inspection: webhook handler logs at lines 109, 148, 174, 257-265 — none include email/phone/body content/secret. `shopDomain` appears in one warn log (149) and in info log (261) — shop_domain is not PII under the compliance regime.

**Salt seam:** `getWebhookSaltHex(brandId)` in main.ts reads `IDENTITY_SALT_<UUID_NODASHES>` env var, throws if missing or wrong length. Re-pull uses `SaltProvider.saltHexForBrand(brandId)` — same env var pattern. Per-brand salt is correctly scoped.

**Token secrecy (I-S09):** `accessToken` in repull is never logged (code comment line 166: "NEVER logged (I-S09)"; no console.log/info/error of accessToken confirmed by source scan). `clientSecret` in webhook handler: used only in `ShopifyHmac.validateWebhook`, never logged.

**Verdict: PASS**

---

## 7. Money / Reversal Append-Only (D-13 / I-S07) — VERIFIED PASS

**File:** `apps/stream-worker/src/infrastructure/pg/LedgerWriter.ts:173-264`

`writeReversal`:
- `negativeAmountMinor = '-${order.amountMinor}'` — string negation of BigInt-as-string (I-S07, no float)
- `$6::bigint` cast in SQL — PostgreSQL validates integer at DB layer
- `event_type = 'rto_reversal' | 'cancellation'` — existing allowed values in schema
- `recognition_label = 'finalized'` — correct per schema (no 'reversal' label exists; the negative amount IS the reversal)
- `ON CONFLICT (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date)) DO NOTHING` — idempotent append
- NO UPDATE, NO DELETE of existing rows
- GUC set before write (lines 182-184)

**brain_app GRANT:** confirmed SELECT+INSERT only on `realized_revenue_ledger` from prior review of migration 0018. `writeReversal` uses `INSERT ... RETURNING` — consistent with the grant; no UPDATE/DELETE.

**LiveOrderConsumer routing (lines 99-119):**
- `cancelled_at` checked from `props['cancelled_at']` as string — only non-empty string triggers reversal
- `null`, empty string, or absent → provisional path
- No type coercion issues (explicitly checks `typeof cancelledAt === 'string' && cancelledAt.length > 0`)

**`extractLiveOrderForLedger` validation (lines 62-64):** `amountMinor` must match `/^\d+$/` (non-negative integer string) — rejects negative input, floats, empty strings. The negation happens only in `writeReversal`, not in input.

**A4 T4 proof:**
- Non-cancelled → `provisional_recognition` with positive amount; `realized_gmv_as_of` not yet negative (provisional excluded)
- Cancelled → `rto_reversal` row with negative amount; sale row UNTOUCHED; second call → idempotent (DO NOTHING, still 1 reversal row); `realized_gmv_as_of <= 0` confirmed

**Verdict: PASS**

---

## 8. Isolation / Tenant-Key Assertion — VERIFIED PASS

All writes gated by GUC (brand_id from DB fn / fn result, never input):
- Webhook: GUC set before sync_status touch (txn-local in touchSyncStatus)
- Re-pull: GUC set before cursor read/write, sync_status update
- LedgerWriter.writeReversal: GUC set before INSERT
- Bronze write: envelope brand_id from connector row (not header); CollectorEventConsumer propagates brand_id from envelope

**T8 cross-brand isolation:** Brand B GUC → 0 Brand A Bronze rows. Positive control: Brand A GUC → 1 Brand A Bronze row. Both under `assertBrainApp` (is_superuser=false confirmed).

**Migration 0026 additive:** no table drops, no GRANT weakening, no RLS policy changes. `connector_instance` UNIQUE(brand_id, provider) constraint untouched.

**Verdict: PASS**

---

## 9. Traceability / Correlation ID — VERIFIED PASS

Webhook: `correlationId = req.headers['x-correlation-id'] ?? requestId` (line 91). Propagated to `CollectorEventV1` envelope (`correlation_id` field, line 220). B3 Test 1 asserts `envelope.correlation_id === 'test-correlation-b3-001'`.

Re-pull: `correlation_id: 'repull:${ciId}:${eventId}'` (line 259) — traceable to connector instance and event.

No PII in any correlation/log field.

**Verdict: PASS**

---

## 10. Compliance Check — VERIFIED PASS

**DPDP 2023 / COMPLIANCE.md:**
- PII minimization: hashed identifiers only in all events/Bronze/logs (confirmed §6 above)
- No raw PII in logs (confirmed — webhook logs at lines 109/148/174/257-265 use request_id, event_id, brand_id, order_id, topic — no PII fields)
- Data residency: no new data stores introduced; existing ap-south-1 data stores handle Bronze/ledger writes
- No outbound communication path added (inbound webhooks only; no email/SMS/WhatsApp send path)
- Money: BigInt-as-string throughout (I-S07 satisfied)
- Consent: not applicable to this ingest path (no outbound contact)
- PCI SAQ-A: no card data in any field; cancelled_at/amount_minor/currency are financial-status fields, not payment instrument data
- Audit trail: LedgerWriter writes to realized_revenue_ledger (append-only, existing GRANT confirmed)

**Verdict: PASS — no compliance violations**

---

## 11. Verification-Validity Confirmation

**Tests confirmed non-inert:**
- T2 (HMAC-invalid → 401, zero Kafka sends): removing HMAC check → would return 200 → RED
- T3 (anti-spoof): two real brands seeded; either could be the resolution target; test asserts specific brand → would fail if wrong brand selected
- T7-b (no-GUC negative control): seeded connector exists; a bypassed RLS would return count=1 → RED (expects 0)
- T7-c (positive control): fn without GUC returns data → would fail if SECURITY DEFINER property missing
- T4 (reversal idempotency): writes twice, asserts 1 row → would fail if DO NOTHING broken
- T8 (isolation): Brand A row written; Brand B GUC should see 0 → would fail if RLS bypassed

All tests run under `assertBrainApp()` (is_superuser=false verified). No test uses the dev superuser `brain` for isolation-sensitive assertions (MEMORY: dev superuser masks RLS).

**Verdict: ALL PROBES NON-INERT, NO BYPASS-GREEN**

---

## 12. Findings

| ID | Severity | Title | File | Status | Detail |
|---|---|---|---|---|---|
| SEC-LV-M1 | MEDIUM | acquireRepullLock commits before work begins — row lock released before re-pull executes | `apps/stream-worker/src/jobs/shopify-repull/run.ts:365-378` | OPEN | The `FOR UPDATE SKIP LOCKED` lock is acquired and committed in `acquireRepullLock`. On COMMIT the PG row-level lock is released. A second concurrent trigger can then also acquire the lock. The code's own comment acknowledges this (line 366-378): "COMMIT to release the transaction lock so we can do the work." The secondary guard is `connector_sync_status.state='syncing'` (SET before page loop begins) — but the state UPDATE is a separate txn after acquireRepullLock returns. There is a narrow window between COMMIT of acquireRepullLock and the `setSyncState('syncing')` call where two workers could both acquire and both proceed. Data correctness is protected by Bronze event_id dedup (same state → same id → DO NOTHING) and ledger ON CONFLICT DO NOTHING, so this is a correctness anomaly (double API calls to Shopify) rather than a data-integrity or security breach. Remediation: hold the lock open for the full re-pull duration (use a dedicated client held outside the COMMIT, or add a `status='syncing'` pre-check before inserting). Deferred to M1+ (not a security issue; no data leak). |
| SEC-LV-L1 | LOW | `updatedAtUtcMs` from `new Date(updatedAt!).getTime()` — NaN if updatedAt is null (non-null assertion) | `apps/core/.../shopifyWebhookHandler.ts:192-193` | OPEN | `const updatedAt = order.updated_at ?? order.processed_at ?? order.created_at`. If all three fields are null/undefined, `updatedAt` is `undefined`, `!` suppresses TS, `new Date(undefined).getTime()` → NaN. `uuidV5FromOrderLive(brandId, orderId, NaN)` produces a deterministic UUID (sha256 of `brand:order:NaN:...`) — the event lands but the dedup key is incorrect (NaN means any retry with NaN maps to same UUID = correct dedup, but the state-change semantics break). Mitigated by: Shopify always sends `updated_at` on order webhooks; order with no date is a malformed webhook that would also be problematic in other ways. Remediation: add an explicit null-guard: if `!updatedAt` → discard with 200 (same as the `order.id` type check at line 186). |

**Blocking findings (CRITICAL/HIGH):** 0

---

## 13. Verdict

**PASS** — 0 CRITICAL, 0 HIGH, 1 MEDIUM (SEC-LV-M1, overlap-lock race window — no security or data-integrity breach; remediation deferred), 1 LOW (SEC-LV-L1, NaN date guard — Shopify always provides dates in practice).

All high-stakes gates verified at source:
- HMAC-first entry gate: PASS
- Brand-from-DB anti-spoof (D-4): PASS
- Both SECURITY DEFINER fns (0026): PASS
- Re-pull enumeration + GUC order (D-7): PASS
- PII boundary / no raw PII in events/logs: PASS
- Token secrecy (I-S09): PASS
- Money append-only / reversal correctness (D-13): PASS
- Isolation / cross-brand = 0: PASS
- Traceability (correlation_id): PASS
- Compliance regime (COMPLIANCE.md): PASS — no violations
- Verification-validity (no bypass-green, no inert probes): CONFIRMED


---

## DELTA Re-review — ORCH-LV-H1 Fix
**Date:** 2026-06-17T22:00:00Z
**Mode:** DELTA
**Commits in scope:** 3bbdf86 (LiveLedgerBridgeConsumer + main.ts wiring) + c836011 (live-ledger-wiring.e2e.test.ts TW1-TW4)
**Verdict:** PASS

### Delta Scope
Files touched by these 2 commits only:
- `apps/stream-worker/src/interfaces/consumers/LiveLedgerBridgeConsumer.ts` (new)
- `apps/stream-worker/src/main.ts` (import + wiring + shutdown extension)
- `apps/stream-worker/src/tests/live-ledger-wiring.e2e.test.ts` (new)

No migrations, no RLS changes, no new GRANT, no new deps, no IaC changes.

### Gate Verification

**GUC-before-ledger-write (E-4 / NN-1): PASS**
`LedgerWriter.writeProvisionalRecognition` lines 83-85 and `writeReversal` lines 182-184 both execute `SELECT set_config('app.current_brand_id', $1, true)` as the first statement inside `BEGIN`, unconditionally, before any `INSERT`. `brandId` flows from the parsed envelope's `brand_id` field (string type-guard at `LiveLedgerBridgeConsumer.ts:82`), never from env/header.

**Append-only / no UPDATE or DELETE: PASS**
Both LedgerWriter methods use `INSERT ... ON CONFLICT (brand_id, order_id, event_type, date) DO NOTHING RETURNING`. No UPDATE, no DELETE present in either method. The `brain_app` role holds SELECT+INSERT only on `realized_revenue_ledger` (migration 0018, confirmed in FULL review). `writeReversal` writes a new negative-amount row; prior sale/provisional rows are structurally untouched.

**No double-Bronze-write: PASS**
`LiveLedgerBridgeConsumer` imports only `DlqProducer`, `LedgerWriter`, and `routeLiveOrderToLedger`. There is no import of `BronzeRepository`, `ProcessEventUseCase`, or `CollectorEventConsumer`. Bronze writes remain exclusively in `CollectorEventConsumer` (group `stream-worker-live`).

**Filter cross-tenant safety: PASS**
`event_name` filter at `LiveLedgerBridgeConsumer.ts:97` is an exact string match (`'order.live.v1'`). The `brand_id` in any message on the live topic was set by the upstream webhook handler from a DB lookup (HMAC-first, brand-from-DB D-4, verified in FULL review). A cross-brand spoofed message would require forging `brand_id` on the Kafka broker, which is outside the threat model. Even if a message carried an arbitrary `brand_id` string, the GUC is set to THAT message's `brand_id` before the write, so any write lands in the correct (claimed) brand's RLS partition — the attack surface is the broker, not this consumer.

**No raw PII or token in consumer logs: PASS**
`console.info` at lines 119-121 logs: `brand=<UUID>`, `event=<UUID>`, `partition=<int>`, `offset=<int>`. `console.error` at lines 127-130 logs: `attempt`, `partition`, `offset`, and the error object. No email, phone, customer name, or token present in any log path.

**No new migration / RLS / grant change: PASS**
Confirmed: zero `.sql` files in scope of these two commits. No migration file, no `CREATE POLICY`, no `GRANT`, no `ALTER TABLE` introduced.

**Prior PASS surfaces not regressed: PASS**
HMAC handler, `ShopifyHmac.ts`, migration `0026`, `shopify-repull/run.ts`, `LedgerWriter.ts` (unchanged), `LiveOrderConsumer.ts` (unchanged), `shopify-mapper`, `BackfillOrderConsumer` — none of these files appear in the diff for 3bbdf86 or c836011. The prior FULL PASS on all these surfaces stands.

**Verification-validity (TW1-TW4): PASS**
- TW1 (sale): producer sends `order.live.v1` to real Kafka topic; poll under `brain_app`+GUC finds `provisional_recognition` row. Un-wire proof: comment out `await consumer.start()` → poll times out → RED.
- TW2 (cancellation): same path for `rto_reversal` with negative amount.
- TW3 (filter negative control): `page.viewed` event → 5s wait → 0 ledger rows. Injects fake `order_id`+`amount_minor` to make the probe genuinely non-inert.
- TW4 (idempotency): same event produced twice → exactly 1 row after 3s extra wait.
All four probes non-inert. Tests run under `BRAIN_APP_DATABASE_URL` (brain_app role, FORCE RLS). Superuser pool used only for seed/cleanup.

### Tracked Non-Blocking Findings (carried from FULL review — unchanged)
- SEC-LV-M1 (MEDIUM): lock-window race in `acquireRepullLock` — OPEN / deferred
- SEC-LV-L1 (LOW): NaN date guard on `updatedAt` — OPEN / deferred

### DELTA Verdict
**PASS** — 0 CRITICAL, 0 HIGH, 0 new findings. ORCH-LV-H1 fix confirmed correct. SEC-LV-M1 and SEC-LV-L1 remain open/deferred (unaffected by this delta).
