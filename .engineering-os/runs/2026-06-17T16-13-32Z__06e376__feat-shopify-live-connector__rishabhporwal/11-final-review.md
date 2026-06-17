# Final Review — feat-shopify-live-connector
**Stage:** 6 — Final Review (Engineering Advisor, Opus tier) · **Lane:** high_stakes
**Branch:** `feat/shopify-live-connector` (base `master`) · **Date:** 2026-06-17
**Mode:** post-DELTA (ORCH-LV-H1 fix RESOLVED upstream by QA + Security; both DELTAs PASS)

## Recommendation: **APPROVE** → Stakeholder gate (Stage 7)

**Blocking findings: 0.**

**One-line risk:** The only residual risk is a deferred MEDIUM lock-window race (SEC-LV-M1) whose worst case is duplicate Shopify API calls — never a correctness, isolation, or money-integrity breach (Bronze event_id dedup + ledger ON CONFLICT DO NOTHING absorb it).

---

## What this slice ships
The deep Shopify LIVE connector — order webhooks (HMAC-first) + the COD 35-day re-pull + live recognition through the append-only ledger — landing on the existing live streaming substrate. No new deployable, no new lane, no new topic. Migration `0026` is additive (two `CREATE FUNCTION`, `DROP FUNCTION` rollback).

---

## Verification summary (independently replicated at source by the final reviewer)

All re-runs under the REAL `brain_app` role (`current_user=brain_app`, `is_superuser=off`) — RLS genuinely enforced, NOT masked by the dev superuser (per MEMORY: dev-db-superuser-masks-rls).

| Gate re-run by final reviewer | Captured result |
|---|---|
| **live-ledger-wiring.e2e (TW1-TW4)** — the ORCH-LV-H1 fix proof | **4/4 PASS** (real Kafka produce → wired consumer → ledger row; idempotency = exactly 1 row) |
| **live-connector.e2e (T1-T8)** — D-6, RTO-reversal, no-GUC NC, isolation | **16/16 PASS** |
| **shopifyWebhookHandler.integration (B3 T1-T8)** — HMAC + anti-spoof | **8/8 PASS** |
| **No-GUC negative control** (direct DB, brain_app, no GUC) | `connector_instance` bare SELECT = **0 rows** (FORCE RLS fail-closed, non-inert) |
| **SECURITY DEFINER bypass** (direct DB) | `list_connectors_for_repull()` = **2 rows** without a GUC |
| **Append-only ledger GRANT** (direct DB) | brain_app = **INSERT, SELECT only** (no UPDATE/DELETE — reversal-by-new-row enforced by GRANT) |
| **Both 0026 fns** (`pg_proc`) | `prosecdef=true`, `search_path=public` — both fns |
| **Live ledger move** (production brand 60d543dc) | `total=20285, reversals=49` — replicates the orchestrator's live re-pull proof exactly |
| **stream-worker tsc** | 1 error (`worker-secrets.ts` AwsSecretsManager cross-rootDir) — **confirmed pre-existing on master**; exit 0; 0 new errors |

### Load-bearing source spot-checks (git diff master...feat)
- **D-6 (make-or-break dedup-vs-update):** `packages/shopify-mapper/src/index.ts:152/172` — live event_id = `sha256(brand:order:updatedAtMs:order.live.v1)`, backfill = `sha256(brand:order:order.backfill.v1)`. Distinct namespaces → provably non-colliding; distinct `updated_at` → new Bronze row per state; same `updated_at` → dedup. CONFIRMED non-inert by QA mutation (T3-a RED) + re-replicated (T2/T3 16/16).
- **ORCH-LV-H1 fix:** `apps/stream-worker/src/main.ts` — `LiveLedgerBridgeConsumer` imported (28), instantiated (102), `await liveLedgerConsumer.start()` (148, the previously-missing call), `.stop()` in shutdown (113). The consumer does a REAL `kafka.consumer({groupId:'live-ledger-bridge'}).subscribe()` + `.run()`, filters `event_name==='order.live.v1'`, routes to ledger ONLY (no `BronzeRepository`/`ProcessEventUseCase` import → no double-Bronze). TW1/TW2 produce a real message and poll the ledger — catches the wired-to-nothing trap in CI.
- **Anti-spoof (D-4):** `shopifyWebhookHandler.ts` — HMAC `validateWebhook` at 107 is the absolute first op (401 on fail); brand resolved via `resolve_connector_by_shop_domain($1)` at 134; `brandId = connectorRow.brand_id` (158) — never the header/body. Header used only as the lookup key after HMAC proves secret-holder.
- **Reversal / money:** `LedgerWriter.writeReversal` — GUC at 183, `negativeAmountMinor = '-${order.amountMinor}'` at 206/240 (BigInt-as-string, I-S07), `ON CONFLICT ... DO NOTHING` at 231 (no UPDATE/DELETE). Sale/provisional rows untouched; `realized_gmv_as_of` falls. Live-proven: 49 rto_reversal rows from real cancelled Boddactive orders.

---

## Paradigm + over-engineering audit
- **Cost paradigm:** Tier-0 deterministic — $0/mo model spend, 0 tokens/day. Diff scan for LLM/gateway/model calls = CLEAN (the only "gateway" hits are Shopify payment-gateway COD detection, not a model gateway). Matches the plan's declared paradigm.
- **Tenant isolation at every layer:** webhook (GUC before sync_status touch; brand from DB fn) · re-pull (SECURITY DEFINER enumerate → GUC-after → brand-scoped writes) · Bronze (envelope brand_id asserted) · ledger (GUC before every write; RLS + append-only GRANT). Cross-brand = 0 replicated (T8 + direct no-GUC NC).
- **Observability:** `connector_sync_status` (syncing→connected + last_sync_at) wired by both tracks; web tile surfaces it honestly (no fake "Live"). Implemented, not just planned.
- **Over-engineering: CLEAN.** Every new artifact is plan-sanctioned: 1 package (`@brain/shopify-mapper`, ADR-LV-0), 1 webhook wire, 1 re-pull job, 1 reversal writer, 1 bridge consumer (the fix), 2 SECURITY DEFINER fns (0026). No files/deps/abstractions beyond plan. New deps = `@brain/shopify-mapper` (workspace), `kafkajs ^2.2.4` (existing known-good), `fastify-raw-body ^5.0.0` (D-2) — all sanctioned. No drive-by refactoring (working tree clean of product files).
- **Verification validity:** QA + Security both carry negative_control evidence — HMAC-invalid→401-zero-emit, no-GUC→0-rows, forged-header→right-brand-or-401, writeReversal-noop→RED, filter negative control (page.viewed→0 ledger rows). No bypass-green, no inert probe, no tautological parity on any tenancy/auth/money path.

---

## The 2 tracked findings — my call: ACCEPTABLE AS TRACKED (both non-blocking)
- **SEC-LV-M1 (MEDIUM, OPEN):** `acquireRepullLock` commits the `FOR UPDATE SKIP LOCKED` lock before the page loop, leaving a narrow window where two concurrent triggers could both proceed. **Worst case = duplicate Shopify API calls, NOT a correctness/isolation/money breach** — Bronze event_id dedup (same state → same id → DO NOTHING) and ledger ON CONFLICT DO NOTHING fully absorb the double-run. At M1 the re-pull is manually/triggered (no concurrent cron), so the trigger condition is itself rare. **Accept as tracked**; remediation (hold the lock for the full re-pull, or a `status='syncing'` pre-check) is an M1+ follow-up. This is not a Security VETO surface (no CRITICAL/HIGH).
- **SEC-LV-L1 (LOW, OPEN):** non-null assertion on `updatedAt` could pass NaN to the live event_id if an order webhook arrives with no `updated_at`/`processed_at`/`created_at`. Shopify always sends `updated_at` on order webhooks; a dateless order is malformed in other ways too. **Accept as tracked**; remediation (guard → discard with 200, mirroring the existing `order.id` type-check) is a one-line follow-up.

Neither is on a money/tenancy/auth correctness path; both have a sound containment argument. They do not block ship.

---

## Lessons-learned / rule recommendation — the "consumer/recognition-writer built but not wired into the deployable" pattern

**This is occurrence #2** of the wired-to-nothing pattern:
1. **ADR-BF-9** (feat-connector-backfill): `OrderEventConsumer → provisional ledger` was scaffolded but never wired — caught by live verification (real backfill ran, ledger logic existed but the consumer was unbound).
2. **ORCH-LV-H1** (this run): `LiveOrderConsumer.routeLiveOrderToLedger()` was unit-tested in isolation but `LiveLedgerBridgeConsumer` was never `.start()`-ed in `main.ts` — caught by a LIVE re-pull (903 order.live.v1 events → Bronze, ledger FLAT). NOT caught by the unit-tested QA/Security reviews; caught by manual/live verification.

Both share the root cause: **a method-isolation test proves the logic works but does NOT prove the consumer is subscribed to the topic and started in the deployable.** The unit-tested reviews are structurally blind to it.

**My call: WATCH + LESSONS-LEARNED entry now; PROPOSE the durable rule at occurrence #3.**

Rationale: the precedent on this exact OS is calibrated — `system-job-force-rls-enumeration` was adopted at the **3-occurrence threshold** (phone-guard-reeval, revenue-finalization, shopify-backfill). The auto-candidate rule (root cause repeating in ≥3 distinct prior runs) is NOT yet met at #2. Adopting at #2 would be premature relative to the established bar. I am writing a lessons-learned entry and flagging the watch; if a 3rd occurrence lands, the proposed rule is ready:

> **Proposed rule (at #3):** A new Kafka consumer / recognition-writer requires an END-TO-END wiring test (real produce → real subscribe → observed effect in the sink), not just a method-isolation test. Reviewers must verify the consumer is wired into the deployable (`main.ts` import + instantiate + `.start()` + shutdown), not only that the class works. Architect adds a design-gate check; QA/Security bounce a consumer/writer that lacks a real-subscribe wiring test.

I do NOT adopt this myself (human runs `/adopt-rule`). No `rule-proposals/<slug>.md` written this run (threshold not met); a lessons-learned entry + a watch note in `pending-stakeholder-attention.md` is the correct action at #2.

---

## Hard-rule deviation check — CLEAN
- Dependency violations: none (deps sanctioned).
- Single-Primitive: CLEAN (extend-only; mapper extraction is a move, not a fork; reversal reuses the existing `0018` event_type model).
- Compliance: DPDP/PII boundary intact (hashed-only); no outbound channel added; money BigInt-as-string; audit/append-only by GRANT.
- Paradigm escalation: none (Tier-0 unchanged).
- Un-codified gate-skip: none (the system-job-force-rls rule was honored with a non-inert no-GUC negative control, re-replicated by me).

No hard-rule deviation requires Stakeholder escalation beyond the normal gate.

---

## Residuals the Stakeholder consciously accepts (all non-blocking)
- SEC-LV-M1 (MED, open) — re-pull lock-window race → worst case double API calls; M1+ remediation.
- SEC-LV-L1 (LOW, open) — NaN-date null-guard on webhook updatedAt; one-line follow-up.
- Dev-honesty boundary (stated): real Shopify webhook delivery needs public ingress (platform follow-up); dev proves the receive path via synthetic HMAC inject() + the 35-day re-pull against live Boddactive.
- Pre-existing `worker-secrets.ts` AwsSecretsManager cross-rootDir tsc error (not introduced here; out of scope).
- Watch: wired-to-nothing pattern at #2 — propose durable rule at #3.

---

## Decision
**PASS → APPROVE.** Advance to the Stakeholder gate (Stage 7). The final reviewer did NOT commit and did NOT advance the gate. The mechanical commit command + residuals are in `pending-stakeholder-commit.md`.
</content>
</invoke>
