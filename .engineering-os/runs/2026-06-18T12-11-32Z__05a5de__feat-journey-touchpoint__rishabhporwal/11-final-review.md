# 11 — Final Review (Stage 6, Engineering Advisor): feat-journey-touchpoint

**Stage:** 6 (final go/no-go) · **req_id:** `feat-journey-touchpoint` · **Lane:** high_stakes (data plane, multi-tenancy, identity/PII-adjacent, new Silver mart + read seam)
**Reviewer:** Engineering Advisor (Opus tier) · **Upstream:** QA BUILD-OK · Security PASS (0 CRITICAL/HIGH/MED/LOW)

---

## VERDICT: PASS

Reconciles with QA (BUILD-OK) and Security (PASS). Recommend advance to the Stakeholder gate (Stage 7). Residual risk one-liner below.

---

## What I independently re-verified (not a re-read — re-execution + file:line)

THE invariant for this lane: **per-brand isolation is enforced at the metric-engine read seam (`withSilverBrand` injects `${BRAND_PREDICATE}` at a single seam), NOT the StarRocks engine** (row-policy is the documented prod graduation). dbt is the cross-brand ETL writer by design. I confirmed this is structural and proven non-inert.

### Gates spot-re-run (≥3, captured output)

| # | Gate | Command | Result | Replicates QA? |
|---|------|---------|--------|----------------|
| 1 | journey-mix + registry unit | `vitest run journey-mix.test.ts registry.test.ts` | **41 passed (21+20)** | yes (metric-engine 81 total) |
| 2 | **isolation-fuzz non-inert** (live StarRocks) | `vitest run silver-touchpoint.test.ts --reporter=verbose` | **4/4, port 9030 OPEN, mart present → [positive] + [mutation/NON-INERT] genuinely EXECUTED** (not skipped) | yes (4/4 live) |
| 3 | full metric-engine suite (regression) | `vitest run packages/metric-engine` | **81 passed (6 files)** — order-status-mix/cod-mix/checkout-funnel all green, no regression | yes (metric-engine 81) |

Gate 2 is the load-bearing one. I confirmed StarRocks was actually reachable (`nc -z localhost 9030` succeeded, `SELECT COUNT(*) FROM brain_silver.silver_touchpoint` succeeded), so the mutation test did NOT silently PEND — the `[mutation / NON-INERT proof]` materially passed: with `__unsafeDisableBrandPredicate: true` the seam **leaks brand-B rows** (`silver-touchpoint.test.ts:148-167`), proving the predicate is doing real work. The positive test confirmed `withSilverBrand(brandA)` returns only brand-A, zero brand-B (`:133-146`). This is a real negative control, not a tautology.

### The five highest-risk claims (file:line)

| Claim | Evidence | Verdict |
|-------|----------|---------|
| Read-seam isolation NON-INERT | `journey-mix.ts:232-243,293-301,335-368` all reads via `withSilverBrand` + `${BRAND_PREDICATE}` through `runScoped` (no hand-written brand filter); `silver-touchpoint.test.ts:148-167` mutation leaks brand-B live | PASS |
| Cart-stitch DETERMINISTIC (no probabilistic path) | `shopify-mapper/src/index.ts:293-328` `projectOrderStitch` = pure read-back of `note_attributes`; `shopifyWebhookHandler.ts:286-294,347-383` upsert read-back only; full-diff grep: every `probabilistic/ml/fuzzy/infer/classifier` mention is a **negation/assertion**, zero probabilistic code | PASS |
| No raw PII in silver.touchpoint | mart (`silver_touchpoint.sql:77-106`) carries `referrer_host` only — raw `referrer` (query-string PII) dropped at the mart projection (`int_touchpoint_sessionized.sql:153-157` host-only regex); email/phone hashed+dropped in mapper (`shopify-mapper/src/index.ts:243-261`); journey path never touches raw customer PII | PASS |
| dbt replay-idempotency | `silver_touchpoint.sql` pure ordering over append-only Bronze + deterministic `murmur_hash3_32` session/touch numbering + key-equality LEFT JOIN; QA `journey-verify` byte-identical fingerprint; `assert_touchpoint_replay.sql` present | PASS (QA captured; structure confirmed) |
| No new credential in the diff | secret-grep on `master...HEAD` clean; only `STARROCKS_PASSWORD` = `process.env[...] ?? ''` in 3 test seeders (`silver-touchpoint.test.ts:64`), no hardcoded secret | PASS |

### Migration 0031 (tenancy invariant)
`0031_connector_journey_stitch_map.sql:35-109` — additive (`CREATE TABLE/INDEX IF NOT EXISTS`), tenant-first composite PK `(brand_id, order_id)`, **ENABLE+FORCE RLS**, NN-1 two-arg `current_setting('app.current_brand_id', TRUE)` policy verbatim, S/I/U grants (upsert lookup), plus G-1 FORCE-RLS + G-2 NN-1 post-migration assertion DO-blocks. Webhook upsert runs under `SET LOCAL app.current_brand_id` GUC (`shopifyWebhookHandler.ts:358-359`), idempotent `ON CONFLICT (brand_id, order_id)`. Verified by QA under `brain_app` (is_superuser=f). Correct — note the dev-DB superuser caveat (RLS inert under `brain`, enforced under `brain_app`) is the documented, accepted posture.

---

## Over-engineering audit (engineering-discipline) — CLEAN

- File count = the plan's track list, 1:1 (41 files, all clones of shipped patterns: Silver mart, `withSilverBrand` seam, `connector_*_order_map`, analytics BFF/UI chain). No new primitive, service, topic, envelope, or deployable.
- `attribution/touchpoint-layer.ts` (47 lines) is NOT scope creep — the requirement explicitly states the attribution module owns `silver.touchpoint` and "implements its first real capability" (01-requirement.md:24,29). It is a pure frozen domain descriptor (no I/O), the minimal form.
- Cost paradigm matches plan: **Tier-0 deterministic, $0/mo, 0 tokens/day** (05-architecture.md §Cost). Sessionization = windowed SQL fold; channel = deterministic CASE ladder (`int_touchpoint_sessionized.sql:104-114`, never a classifier); share = integer basis-point `ratePct` (`journey-mix.ts:153-160`, no float). No model call anywhere — a model call here would be a paradigm violation, and there is none.
- Single-Primitive sweep CLEAN: extends, nothing forked.

## Verification-validity confirm — CLEAN
QA + Security artifacts carry genuine negative controls on the tenancy path: the isolation-fuzz mutation control is non-inert (proven live above, not bypass-green), the RLS check ran under `brain_app` (not the superuser that masks RLS), the no-money assertion guards the money path. No empty/inert negative control on a tenancy/auth/money path.

## Hard-rule deviation check — NONE
No dependency violation, no Single-Primitive violation, no compliance gap, no paradigm escalation beyond plan, no un-codified gate-skip. Nothing requires Stakeholder pre-clearance beyond the normal gate.

---

## Reconciled findings

| Source | Verdict | Blocking |
|--------|---------|----------|
| QA Engineer | BUILD-OK (journey-build 3 models, dbt 12/12 + 23/23 suite, idempotent byte-identical, isolation-fuzz 4/4 live, RLS under brain_app, metric-engine 81, core 316, web clean) | none |
| Security Reviewer | PASS — 0 CRITICAL / 0 HIGH / 0 MED / 0 LOW | none |
| Final Review (this) | PASS — 3 gates re-run + replicated, 5 high-risk claims confirmed file:line, over-engineering CLEAN, hard-rule NONE | none |

## Risks remaining (tracked, NOT blocking)
1. **StarRocks engine row-policy graduation** — M1 isolation is the app-seam predicate (proven non-inert); engine `CREATE ROW POLICY` on `silver_touchpoint` is the documented prod graduation (defense-in-depth) on a managed cluster. Tracked, dev allin1 StarRocks has no row-policy support.
2. **Thin real journey data + synthetic supplement** — only 23/94 real `page.viewed` rows carry `brain_anon_id`; richer demo uses clearly-labelled synthetic fixtures. The `_synthetic`→`is_synthetic`→`data_source='synthetic'` flag rides honestly to the UI `SyntheticBadge` (`touchpoint-timeline.tsx:211`); coverage surfaced honestly. Never fakes coverage. Tracked as a data-maturity item, not a defect.

## Recommendation
**APPROVE → advance to Stakeholder gate (Stage 7).** Per-brand isolation is structurally enforced and independently proven non-inert against live StarRocks; cart-stitch is deterministic read-back only; no raw PII in the journey path; replay-idempotent; no new credential; cost paradigm Tier-0 as planned; over-engineering and hard-rule checks clean. The two residual risks are tracked graduations, not release blockers.

---

VERDICT: PASS
