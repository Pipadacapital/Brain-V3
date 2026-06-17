# Engineering OS — Lessons Learned

> Append-only registry. Each entry sourced from a per-requirement retro (`14-retro.md`).
> The Engineering Advisor reads relevant entries at every Stage 1 intake.
> Mutation rule: append only.

No lessons filed yet. First entry will come from the first requirement's retro.

---

## Tech-Debt Waiver: audit hash-chain sha256 deferral

| Field | Value |
|-------|-------|
| **Waiver ID** | L-02-audit-sha256 |
| **req_id** | chore-platform-foundations-sprint0 |
| **Logged** | 2026-06-15T18:35:00Z |
| **Item** | `packages/audit` hash-chain uses djb2 stub (non-cryptographic) instead of sha256 |
| **Why deferred** | Sprint-0 is a platform foundation sprint with no business logic and no live system. No production audit entries are written before M1. The structural protections (audit_log DDL, hash-chain columns, GRANT-level WORM = INSERT+SELECT only, S3 Object-Lock COMPLIANCE/7yr) are already in place. The djb2 stub occupies a column that no live system reads or relies on before M1. |
| **Condition that closes this debt** | sha256 hash function implemented and live in `packages/audit`; hourly S3 Object-Lock checkpoint job deployed and verified; R-2 in the Sprint-0 residual register marked shipped |
| **Must close by** | M1 — before the first production audit write under any live tenant |
| **Owner** | Security Reviewer |
| **Stakeholder approval** | Approved 2026-06-15 (12-stakeholder-decision.json, ts: 2026-06-15T14:06:21Z); 8 M1 follow-ups acknowledged at decision gate |
| **Risk if not closed** | The audit hash-chain would be non-cryptographic, undermining tamper-evidence of the system-of-record audit log (the moat). This is HIGH severity if production audit writes proceed without closing. |
| **Cross-ref** | 11-final-review.md "Stakeholder Waiver Logged (pre-deploy)" section; residual R-2 in Stage 6 final review |

## 2026-06-17T09:59:08Z — system-job-force-rls-enumeration (adopted durable rule)
System/cron/worker jobs that enumerate tenants across a FORCE-RLS table MUST use a SECURITY DEFINER fn (search_path pinned, dispatch-only columns, brain_app EXECUTE) or a superuser pool — a bare brain_app SELECT returns 0 rows (inert in prod, masked by dev superuser). 3 occurrences (phone-guard-reeval, revenue-finalization, shopify-backfill). Carries a non-inert no-GUC negative control under brain_app. See durable-rules/2026-06-17T09-59-08Z__system-job-force-rls-enumeration.md.

## 2026-06-17T22:15:00Z — wired-to-nothing: consumer/recognition-writer built but not wired into the deployable (WATCH — #2 of 3)
| Field | Value |
|-------|-------|
| **req_id** | feat-shopify-live-connector |
| **Source** | 14-retro.md (Stage 6) |
| **Pattern** | A new Kafka consumer / recognition-writer is unit-tested in isolation (the routing method works) but is NEVER subscribed + `.start()`-ed in `main.ts` — so the effect (Bronze→ledger) does not run in the deployable. Method-isolation tests are structurally blind to it; the automated QA/Security reviews inherit that blindness. Caught only by live/manual verification. |
| **Occurrences** | #1 = ADR-BF-9 (feat-connector-backfill: OrderEventConsumer→provisional ledger scaffolded-not-wired). #2 = ORCH-LV-H1 (feat-shopify-live-connector: LiveLedgerBridgeConsumer never started; 903 order.live.v1 events → Bronze, ledger FLAT). Both caught by live verification, not unit-tested reviews. |
| **Proposed rule (raise at #3)** | A new Kafka consumer / recognition-writer requires an END-TO-END wiring test (real produce → real subscribe → observed effect in the sink), not just a method-isolation test. Reviewers verify the consumer is wired into the deployable (`main.ts` import + instantiate + `.start()` + shutdown), not only that the class works. Architect adds a design-gate check; QA/Security bounce a consumer/writer lacking a real-subscribe wiring test. |
| **Status** | WATCH at #2 (threshold for /adopt-rule is 3 occurrences, per the system-job-force-rls precedent). No rule-proposal file written yet. Propose + write rule-proposals/wired-to-nothing-end-to-end-wiring-test.md at occurrence #3. |
| **Mitigation already in tree** | ORCH-LV-H1 fix added live-ledger-wiring.e2e (TW1-TW4): real Kafka produce → wired consumer → polled ledger row. This is the template the eventual rule mandates. |
