# Feature Journal — feat-metric-engine-parity

Metric engine (sole emitter) + parity oracle — `realized_revenue` (+ adjacent `provisional_revenue`), CI-blocking. The layer after the realized-revenue ledger. TypeScript engine = the only place a number is computed; the parity oracle CI-gates it against an INDEPENDENT SQL recompute on golden fixtures.

---

## 2026-06-17T01:05:00Z — Architect (Stage 2) — 03-architecture-plan.md

**Decision:** ADVANCE → @intelligence-engineer (Stage 3, single track). Branch `feat/metric-engine-parity` off `master` @ `f29e61d`.

**Paradigm:** Tier-0 deterministic, $0/mo, 0 tokens/day. Zero model calls (METRICS.md tier-0: the only tier that produces numbers).

**The heart (D-2):** the oracle's independent reference SQL is STRUCTURALLY different from `realized_gmv_as_of` — it filters `recognition_label='finalized'` (vs the fn's `event_type<>'provisional_recognition'`) and `GROUP BY currency_code` (vs scalar BIGINT). So a provisional leak OR a currency blend in the engine path yields a non-zero per-currency delta → tolerance 0 → fails CI. The reference (`getIndependentReferenceRevenue`) MUST NOT call the engine or the named fns — else the gate proves nothing.

**Bindings:** D-1 TS registry `(metric_id,version)` keyed, immutable; D-3 oracle gets `@brain/metric-engine` workspace dep + package-level `turbo.json` `test:parity dependsOn @brain/metric-engine#build` (Turbo 2.9.18 supports it; core already deps the engine); D-4 migration `0020_provisional_gmv_as_of.sql` additive, per-currency TABLE, SECURITY INVOKER, `recognition_label IN ('provisional','settling')`; D-5 `Map<CurrencyCode,bigint>` from day one; D-6 fix the mis-scoped eslint metric-engine fence (allow measurement+analytics only); D-7 no new deployable + `withBrandTxn` for F-SEC-02 txn-scoped GUC; bigint-fixtures: GoldenFixture money fields `number→bigint`, `checkParity` delta `bigint`.

**Slices:** S1 registry+realized engine+fence fix → S2 provisional fn 0020+metric → S3 oracle independent reference+5 fixtures+CI dep edge+bigint → S4 tests(9)+gate proof. COMMIT PER SLICE.

**Isolation:** parity/GUC tests under `brain_app` pool (dev superuser `brain` masks RLS).

**Carry-in:** F-SEC-02 (GetRealizedGmvAsOf GUC-reset) — engine new code is correct by construction (withBrandTxn); the pre-existing query is must-fix-before-Phase-2, not regressed here.

**ADR:** none new. Decision-log note: eslint metric-engine fence corrected (was over-blocking).

**Prior runs:** feat-realized-revenue-ledger (the `realized_gmv_as_of` seam + ledger SoR, 0018), feat-identity-graph (0017), feat-data-plane-ingest-spine (0016).
