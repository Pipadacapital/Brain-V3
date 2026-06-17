# Retro — feat-shopify-live-connector
**Stage:** 6 · **Date:** 2026-06-17 · **Verdict:** PASS / APPROVE · **Blocking:** 0

## What shipped
Deep Shopify LIVE connector: order webhooks (HMAC-first, brand-from-DB anti-spoof) + the COD 35-day re-pull (SECURITY DEFINER enumerate + SKIP LOCKED overlap-lock) + live recognition through the append-only ledger (provisional / rto_reversal). On the existing live substrate — no new deployable, no new lane, no new topic. Migration `0026` additive (two SECURITY DEFINER fns). Tier-0 deterministic ($0/mo).

## What went well
- D-6 (the make-or-break dedup-vs-update) was resolved at design before a line was written, and the resolution held: per-state composite live event_id (namespace-separated from backfill) → status changes land, retries dedup, backfill never collides. Independently re-replicated (T2/T3 16/16).
- The system-job-force-rls-enumeration durable rule was honored end-to-end with a non-inert no-GUC negative control — re-replicated by the final reviewer under the real brain_app role (0 rows bare, 2 rows via the SECURITY DEFINER fn).
- Money correctness is enforced by GRANT, not convention: brain_app has INSERT+SELECT only on the ledger — reversal-by-new-negative-row is structurally the only option. Live-proven (49 rto_reversal rows from real cancelled orders).

## What we caught (the root cause)
**ORCH-LV-H1 — wired-to-nothing (occurrence #2 of this pattern).** `LiveOrderConsumer.routeLiveOrderToLedger()` was unit-tested in isolation but the consumer was never `.start()`-ed in `main.ts`. order.live.v1 → ledger did not run in the deployable. Caught by a LIVE re-pull (903 events → Bronze, ledger FLAT), NOT by the unit-tested QA/Security reviews. Fixed: `LiveLedgerBridgeConsumer` wired into main.ts + an end-to-end wiring test (TW1-TW4) that does a real produce → real subscribe → polls the sink. Re-proven LIVE (ledger 19,488 → 20,285).

**Root cause class:** a method-isolation test proves the logic but is structurally blind to whether the consumer is subscribed and started in the deployable. The automated reviews inherit that blindness. This is the SAME class as ADR-BF-9 (backfill OrderEventConsumer scaffolded-not-wired) — occurrence #1.

## Action: watch, not yet a rule
This is occurrence #2. The OS precedent (system-job-force-rls-enumeration) adopted at the 3-occurrence threshold. A lessons-learned entry is filed now + a watch note in pending-stakeholder-attention.md; the durable-rule proposal is drafted in the final review and should be raised at occurrence #3. No rule-proposals/<slug>.md written this run (threshold not met). Human runs /adopt-rule when the bar is met.

## Tracked debt (non-blocking)
- SEC-LV-M1 (MED): re-pull lock-window race → double API calls; M1+.
- SEC-LV-L1 (LOW): NaN-date guard on webhook updatedAt; one-line.
- Dev webhook delivery needs public ingress (platform follow-up); dev freshness is the live re-pull + synthetic HMAC inject().
- Pre-existing worker-secrets AwsSecretsManager cross-rootDir tsc error (out of scope).
</content>
