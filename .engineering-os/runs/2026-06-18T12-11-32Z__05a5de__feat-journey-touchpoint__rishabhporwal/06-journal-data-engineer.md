## 2026-06-18T12:31:00Z — Data Engineer — feat-journey-touchpoint
**Stage:** 3 · **Layer:** lakehouse (Silver dbt mart) + graph-adjacent (stitch map) · **Tier:** deterministic (Tier-0, $0/mo, 0 tokens/day)
**Parity:** N/A first mart for these metrics — non-additive math deferred to metric-engine (ADR-004); mart is additive projection only.
**Replayable:** yes — `make journey-verify` byte-identical across two full dbt runs (fp 15840198817, 32 rows real+synthetic; fp 15727652206, 23 rows real-only).
**Verification:**
- `make journey-run` → PASS=3 models, PASS=12 dbt tests (grain, no-money, replay-fold, not-null×7, accepted_values channel).
- Full `dbt test` → 23/23 PASS (11 order_state + 12 touchpoint, no regression).
- isolation-fuzz `silver-touchpoint.test.ts` → 4/4 PASS incl. NON-INERT mutation (disabling the seam predicate LEAKS brand-B; enabled → brand-A sees 0 of brand-B).
- deterministic stitch under real `brain_app` role → 2 re-deliveries = 1 row (idempotent); other brand's GUC sees 0 (FORCE RLS).
**Real-vs-synthetic split (dev-honest):** 94 Bronze journey events → 23 carry brain_anon_id → 23 real touchpoint rows (2 brands, all single-touch, 22 paid_google / 1 direct, 0 stitched). +9 CLEARLY-LABELLED synthetic touch rows (3 multi-touch journeys, 2 stitched) for the demo. is_synthetic rides to the mart → metric-engine data_source → UI badge.
**Next:** READY-FOR-SECURITY (RLS NN-1 + FORCE on 0031; seam-isolation non-inert; no money/float; deterministic D-5 stitch).
