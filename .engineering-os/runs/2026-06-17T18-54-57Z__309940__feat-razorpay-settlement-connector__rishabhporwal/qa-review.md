# QA Review — feat-razorpay-settlement-connector

**Stage:** 5 · **Role:** QA Engineer · **Mode:** FULL · **Model:** claude-opus-4-8[1m]
**Verdict:** PASS (reconcile with Security) · **Reviewed:** 2026-06-18
**Scope:** Tracks A (data) + B (backend); Track C frontend DEFERRED (logged orchestrator decision, not a gap).

---

## Verdict: PASS

Every claim below carries fresh, captured command output from THIS session. Real infra
(Postgres 5432, Redis 6379, Redpanda 9092) confirmed up. All isolation/money tests ran under
`brain_app` (NOSUPERUSER, NOBYPASSRLS — confirmed), NOT the dev superuser `brain` that masks RLS.

---

## 1. Infra + role preconditions (captured)

- `pg_roles`: `brain` = super=t bypassrls=t; `brain_app` = super=f **bypassrls=f**. brain_app login OK.
- Migration 0027 applied: `connector_razorpay_order_map` exists, `relrowsecurity=t relforcerowsecurity=t` (FORCE RLS).
- SECURITY DEFINER fns present, `prosecdef=t`: `list_razorpay_connectors_for_settlement_repull`, `resolve_razorpay_connector_by_account`.
- Ledger `event_type` CHECK extended with all 7 new types (settlement_finalization, payment_fee, settlement_tax, rolling_reserve_deduction, rolling_reserve_release, settlement_reversal, settlement_adjustment); `reconciliation_type` CHECK ∈ {per_order, brand_level}.
- NOTE: `upsert_razorpay_order_map` is NOT a DB function — the map upsert is a direct `INSERT … ON CONFLICT (brand_id, razorpay_payment_id) DO UPDATE` in `PgRazorpayOrderMapRepository`, run under brand GUC against the FORCE-RLS table. Acceptable (no SECURITY DEFINER need for a brand-scoped lookup write); the plan's wording of "fn" was aspirational. Non-blocking.

## 2. Track A — mapper unit + wiring e2e (captured)

- **`pnpm --filter @brain/razorpay-mapper test:unit` → 43 passed / 43.** Covers C1 boundary-hash (raw utr/payment_id NEVER in emitted props — full-JSON-serialization absence assert), C4 card-field allowlist (every card.* + nested `card` object + non-allowlisted fields dropped; UT-5), MB-2 uuidv5 entityType discriminator (UT-2/UT-11: same (brand,settlement,payment) + diff entityType → DISTINCT ids → corrections don't collapse; summary seed distinct from per-payment).
- **`settlement-ledger-wiring.e2e.test.ts` → 6 passed / 6** (real Redpanda → SettlementLedgerConsumer → ledger, all reads under brain_app).
  - SW1 per-order: real ledger rows observed — finalization=+97640, payment_fee=-2000, settlement_tax=-360 (GST_18, SEPARATE row).
  - SW2 brand-level reserve release: +50000 against synthetic `__brand_level__:setl_…` spine key, no order join.
  - SW3 non-settlement event skipped. SW4 idempotency: same event twice → exactly 1 finalization row (ON CONFLICT DO NOTHING). SW5 no-GUC negative control → FORCE RLS fail-closed (22P02). SW6 cross-brand: brand B sees 0 of brand A's map rows.

### NON-INERT proof (occurrence-#3 wiring guard) — captured
Commented out `await consumer.start()` in beforeAll → **SW1 FAILED: `pollUntil timed out after 30000ms. Last: []`** (no ledger row written). Restored file (no diff). The wiring test genuinely goes RED when the consumer is un-wired — it is the real CI gate for the wired-to-nothing anti-pattern.

### Production wiring confirmed
`apps/stream-worker/src/main.ts`: SettlementLedgerConsumer imported (L30), instantiated (L121), `start()` (L183), `stop()` in shutdown Promise.all (L137). Not test-only.

## 3. Track B — webhook integration (captured)

- **`razorpayWebhookHandler.integration.test.ts` → 10 passed / 10** under real brain_app + Redis. Forged signatures use real `node:crypto createHmac` (not a mock): HMAC-invalid→401 zero-write; anti-spoof (valid HMAC + account_id lookup → brand from DB-fn ROW, never body); replay age-check→400; Redis SET NX dedup→409; payment.captured→map upsert under correct brand; cross-brand isolation under brain_app (assertBrainApp); 3-cred round-trip; disconnect→getSecret null→halt; resolve fn callable by brain_app; webhook_secret rotation preserves key_id/key_secret.

### NON-INERT proof (HMAC guard) — captured
Forced `hmacValid = true` in the handler → **HMAC-invalid test FAILED: Expected 401, Received 200.** Restored handler (no diff). The forged-signature probe genuinely exercises the production HMAC gate.

## 4. Typecheck (captured)
- `@brain/razorpay-mapper` tsc --noEmit → **EXIT 0.**
- `@brain/core` tsc --noEmit → **0 errors.**
- `@brain/stream-worker` tsc --noEmit → **exactly 1 error**, in `apps/stream-worker/src/jobs/shopify-backfill/worker-secrets.ts` (AwsSecretsManager module path) — **NOT touched by this branch** (empty `git diff` for the file) → pre-existing, unrelated, as the brief noted.

## 5. Money correctness (verified in code + observed in e2e logs)
- All amounts BIGINT-as-string end-to-end; `BigInt()` comparisons; NO parseFloat/Number()/float math (I-S07). Verified in SettlementLedgerConsumer + LedgerWriter.
- Signs (MB-3): finalization +, payment_fee − (`-${feeMinor}`), settlement_tax − GST_18 SEPARATE row, rolling_reserve_deduction −, settlement_reversal −, brand-level adjustment ±/release +. Provisional sale row UNTOUCHED (append-only) — net = signed-sum. e2e logs confirmed the real signed values.
- GUC-first (`set_config('app.current_brand_id', …, true)`) before every ledger write; ON CONFLICT dedup keyed (brand_id, order_id, event_type, date).

## 6. Idempotency / discriminator
- Duplicate delivery → ONE Bronze/ledger row (SW4 + UT-2). Corrections (diff entityType) → DISTINCT event_id (do NOT collapse) (UT-11). Both proven non-tautologically.

## 7. Verification-validity gate
`uv run validity_check.py --paths <3 test files>` → **clean (3 files scanned), EXIT 0.** No bypass-green, no superuser DSN in tests, no tautological/inert parity. Negative controls below are non-empty and captured RED.

```json
"negative_control": [
  {"path":"apps/stream-worker/src/tests/settlement-ledger-wiring.e2e.test.ts","protection_removed":"await consumer.start() (consumer un-wired)","command":"vitest run -t SW1","captured_red":"pollUntil timed out after 30000ms. Last: [] — no ledger row"},
  {"path":"apps/core/.../razorpayWebhookHandler.integration.test.ts","protection_removed":"HMAC verification forced hmacValid=true","command":"vitest run -t 'HMAC-invalid'","captured_red":"Expected 401, Received 200"},
  {"path":"connector_razorpay_order_map (SW5)","protection_removed":"no brand GUC under brain_app on FORCE-RLS table","command":"vitest SW5","captured_red":"FORCE RLS fail-closed 22P02 (0 rows / throw)"}
]
```

## 8. Bindings coverage (verify-not-trust)
MB-1 two-hop join + park-not-drop: PASS (SW1 join; map-table populate in webhook test). MB-2: PASS (UT-2/UT-11). MB-3 fee taxonomy + GST-separate: PASS (e2e logs + LedgerWriter). MB-4 consumer wired + e2e occurrence-#3: PASS (non-inert proven). MB-5 SECURITY DEFINER + no-GUC negative control non-inert: PASS (prosecdef=t; SW5). C1 boundary-hash: PASS (UT-6). C2 3-cred + disconnect halt: PASS (integration tests 7-11). C3 replay: PASS (age-400 + Redis-409). C4 card allowlist + lint: PASS (UT-5 + no-pci-card-fields.mjs). C5 log-grep: present (log-grep-patterns.json). C6 multi-cursor: PASS (3 resources + per-cursor FOR UPDATE SKIP LOCKED).

## Open items (non-blocking, for Security/Final reconcile)
1. `upsert_razorpay_order_map` documented as a fn but implemented as repo UPSERT (wording mismatch; behavior correct).
2. C5 log-grep is a nightly gate (config landed); not exercised in this session — recommend Security confirm the nightly job consumes the new patterns.
3. Real public webhook ingress is a platform follow-up (dev-honesty boundary, same as Shopify) — proven via synthetic HMAC-signed POSTs.

## Definition of Done
- [x] Every claim has captured command output (FULL).
- [x] Real-network smoke = real Redpanda→ledger e2e + real brain_app+Redis webhook integration, captured.
- [x] Verification-validity confirmed (validity_check clean; 3 non-inert negative controls with captured RED).
- [x] Money minor-unit/no-float; signed rows correct; append-only provisional untouched.
- [x] Mutation-equivalent rigor on high-stakes paths via the negative-control red-green proofs.
