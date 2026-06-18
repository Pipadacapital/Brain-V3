-- ============================================================================
-- attribution_synthetic_fixtures.sql — CLEARLY-LABELLED synthetic attribution credit.
-- feat-attribution-ledger (Phase 5, Stage 3, @data-engineer). Architecture 05 §2–§5.
--
-- DEV-HONESTY BOUNDARY (the rule): real journey data is THIN (23 real anon-bearing
--   touchpoints in silver.touchpoint). So most attribution coverage in dev is synthetic.
--   These fixtures exist ONLY to make the four oracle scenarios + the channel-ROAS UI
--   demoable. They NEVER masquerade as real coverage.
--
-- THE FLAG RIDES THROUGH: every row here uses the synthetic brand ids (5e5e… prefix,
--   the SAME synthetic brands as journey_synthetic_fixtures.sql) and model_version
--   'v1-synthetic-fixture'. The BFF labels any panel sourced from a synthetic brand
--   data_source='synthetic' → the UI badges it "Synthetic (dev)". The synthetic provenance
--   is observable end-to-end. The credit math itself is REAL (Tier-0 deterministic) —
--   only the underlying journeys are synthetic.
--
-- WHAT THESE ROWS PROVE (the four parity-oracle fixtures, materialized for the demo):
--   J1  multi-touch:    4-touch position_based (40/40/20-split) → Σ weight = 1.00000000,
--                       Σ credited = realized (closed-sum at order grain).
--   J2  full-RTO:       2-touch credit, then mirrored clawback (saved weights) → net 0.
--   J3  partial-refund: 2-touch credit, 50% refund → clawback = 50% of EACH saved weight.
--   J4  cookieless:     no journey credit → lands entirely in the unattributed residual
--                       (no credit rows written for the order → the engine's residual leg).
--   The closed-sum invariant Σ channel_contribution + unattributed = realized_gmv holds
--   over this set (asserted by attribution-parity-oracle.test.ts — Track B).
--
-- IDEMPOTENT: deterministic credit_ids + ON CONFLICT DO NOTHING on the dedup key →
--   re-loading is a no-op (the credit ledger is append-only; replay writes no new rows).
-- REVERSIBLE: rollback = DELETE the two synthetic brands' attribution rows (trailer).
--
-- NOTE: the synthetic brands must exist with currency_code='INR' (the BEFORE-INSERT
--   currency trigger enforces it). journey_synthetic_fixtures.sql seeds those brands;
--   this seed upserts them defensively so it is self-contained.
-- ============================================================================

\set sb_a '5e5e0001-0000-4000-8000-000000000001'
\set sb_b '5e5e0002-0000-4000-8000-000000000002'

-- Defensive upsert of the synthetic brands (INR — required by the currency trigger).
INSERT INTO brand (id, organization_id, display_name, currency_code, status)
SELECT :'sb_a'::uuid, (SELECT id FROM organization LIMIT 1), 'Synthetic Brand A (dev)', 'INR', 'active'
WHERE EXISTS (SELECT 1 FROM organization)
ON CONFLICT (id) DO UPDATE SET currency_code='INR', status='active';

INSERT INTO brand (id, organization_id, display_name, currency_code, status)
SELECT :'sb_b'::uuid, (SELECT id FROM organization LIMIT 1), 'Synthetic Brand B (dev)', 'INR', 'active'
WHERE EXISTS (SELECT 1 FROM organization)
ON CONFLICT (id) DO UPDATE SET currency_code='INR', status='active';

-- Clean any prior synthetic attribution (idempotent re-seed; superuser path).
DELETE FROM attribution_credit_ledger
 WHERE brand_id IN (:'sb_a'::uuid, :'sb_b'::uuid)
   AND model_version = 'v1-synthetic-fixture';

-- ── J1 — MULTI-TOUCH (position_based 40/40/20): 4 touches, realized 200000 paise ──
-- weights: first=0.40, last=0.40, two middles=0.10 each (0.20 split evenly) → Σ=1.0.
-- credited (largest-remainder over 200000): 80000 / 20000 / 20000 / 80000 → Σ=200000.
INSERT INTO attribution_credit_ledger
 (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id, model_id, row_kind,
  weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
  confidence_grade, attribution_confidence, model_version,
  occurred_at, economic_effective_at, billing_posted_period)
VALUES
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j1-t1'))::text, 'syn-order-j1', 'syn-anon-j1', 1, 'paid_search', 'summer_sale', 'position_based', 'credit',
  0.40000000,  80000, 'INR', 200000, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-10 09:00:00+00', '2026-06-10 09:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j1-t2'))::text, 'syn-order-j1', 'syn-anon-j1', 2, 'paid_social', 'summer_sale', 'position_based', 'credit',
  0.10000000,  20000, 'INR', 200000, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-10 10:00:00+00', '2026-06-10 10:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j1-t3'))::text, 'syn-order-j1', 'syn-anon-j1', 3, 'email', 'summer_sale', 'position_based', 'credit',
  0.10000000,  20000, 'INR', 200000, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-10 11:00:00+00', '2026-06-10 11:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j1-t4'))::text, 'syn-order-j1', 'syn-anon-j1', 4, 'direct', NULL, 'position_based', 'credit',
  0.40000000,  80000, 'INR', 200000, 'partial', 0.700, 'v1-synthetic-fixture', '2026-06-10 12:00:00+00', '2026-06-10 12:00:00+00', '2026-06')
ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, COALESCE(reversed_of_credit_id,'')) DO NOTHING;

-- ── J2 — FULL-RTO: 2-touch credit (realized 100000 → 50000/50000), then clawback ──
-- clawback uses the SAVED weights against basis -(100000) → -50000 / -50000 → net 0.
INSERT INTO attribution_credit_ledger
 (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
  weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
  reversed_of_credit_id, reversal_reason, confidence_grade, attribution_confidence, model_version,
  occurred_at, economic_effective_at, billing_posted_period)
VALUES
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j2-t1-credit'))::text, 'syn-order-j2', 'syn-anon-j2', 1, 'meta', 'position_based', 'credit',
  0.50000000,  50000, 'INR',  100000, NULL, NULL, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-11 09:00:00+00', '2026-06-11 09:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j2-t2-credit'))::text, 'syn-order-j2', 'syn-anon-j2', 2, 'paid_search', 'position_based', 'credit',
  0.50000000,  50000, 'INR',  100000, NULL, NULL, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-11 10:00:00+00', '2026-06-11 10:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j2-t1-clawback'))::text, 'syn-order-j2', 'syn-anon-j2', 1, 'meta', 'position_based', 'clawback',
  0.50000000, -50000, 'INR', -100000, (md5(:'sb_a' || ':syn-j2-t1-credit'))::text, 'rto_reversal', 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-13 09:00:00+00', '2026-06-13 09:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j2-t2-clawback'))::text, 'syn-order-j2', 'syn-anon-j2', 2, 'paid_search', 'position_based', 'clawback',
  0.50000000, -50000, 'INR', -100000, (md5(:'sb_a' || ':syn-j2-t2-credit'))::text, 'rto_reversal', 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-13 10:00:00+00', '2026-06-13 10:00:00+00', '2026-06')
ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, COALESCE(reversed_of_credit_id,'')) DO NOTHING;

-- ── J3 — PARTIAL-REFUND: 2-touch credit (saved 0.6/0.4 over 150000 → 90000/60000), ──
-- 50% refund basis -75000 → clawback proportional to SAVED weights: -45000 / -30000.
-- order net = 75000 (half kept); per-touch net 45000 / 30000 (proportional, not re-apportioned).
INSERT INTO attribution_credit_ledger
 (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
  weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
  reversed_of_credit_id, reversal_reason, confidence_grade, attribution_confidence, model_version,
  occurred_at, economic_effective_at, billing_posted_period)
VALUES
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j3-t1-credit'))::text, 'syn-order-j3', 'syn-anon-j3', 1, 'meta', 'position_based', 'credit',
  0.60000000,  90000, 'INR',  150000, NULL, NULL, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-12 09:00:00+00', '2026-06-12 09:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j3-t2-credit'))::text, 'syn-order-j3', 'syn-anon-j3', 2, 'paid_search', 'position_based', 'credit',
  0.40000000,  60000, 'INR',  150000, NULL, NULL, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-12 10:00:00+00', '2026-06-12 10:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j3-t1-clawback'))::text, 'syn-order-j3', 'syn-anon-j3', 1, 'meta', 'position_based', 'clawback',
  0.60000000, -45000, 'INR',  -75000, (md5(:'sb_a' || ':syn-j3-t1-credit'))::text, 'refund', 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-14 09:00:00+00', '2026-06-14 09:00:00+00', '2026-06'),
 (:'sb_a'::uuid, (md5(:'sb_a' || ':syn-j3-t2-clawback'))::text, 'syn-order-j3', 'syn-anon-j3', 2, 'paid_search', 'position_based', 'clawback',
  0.40000000, -30000, 'INR',  -75000, (md5(:'sb_a' || ':syn-j3-t2-credit'))::text, 'refund', 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-14 10:00:00+00', '2026-06-14 10:00:00+00', '2026-06')
ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, COALESCE(reversed_of_credit_id,'')) DO NOTHING;

-- ── J4 — COOKIELESS RESIDUAL: an order with NO journey credit ──────────────────
-- Intentionally NO credit rows for syn-order-j4. Its realized revenue lands ENTIRELY in
-- the unattributed residual (the engine's realized_gmv − attributed_gmv leg). This is the
-- honest "no journey → unattributed, never fabricate a touch" path. The order's realized
-- revenue lives in realized_revenue_ledger (seeded elsewhere / demoed via the residual card).
-- We assert here only by ABSENCE — grep-friendly marker for the parity oracle fixture.
-- (syn-order-j4 → grade D / weak coverage is represented by the residual, not a credit row.)

-- ── Brand B — one multi-touch journey so cross-brand isolation has synthetic rows too ──
INSERT INTO attribution_credit_ledger
 (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
  weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
  confidence_grade, attribution_confidence, model_version,
  occurred_at, economic_effective_at, billing_posted_period)
VALUES
 (:'sb_b'::uuid, (md5(:'sb_b' || ':syn-jb1-t1'))::text, 'syn-order-jb1', 'syn-anon-jb1', 1, 'paid_search', 'position_based', 'credit',
  0.50000000,  40000, 'INR', 80000, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-10 09:00:00+00', '2026-06-10 09:00:00+00', '2026-06'),
 (:'sb_b'::uuid, (md5(:'sb_b' || ':syn-jb1-t2'))::text, 'syn-order-jb1', 'syn-anon-jb1', 2, 'meta', 'position_based', 'credit',
  0.50000000,  40000, 'INR', 80000, 'strong', 1.000, 'v1-synthetic-fixture', '2026-06-10 10:00:00+00', '2026-06-10 10:00:00+00', '2026-06')
ON CONFLICT (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, COALESCE(reversed_of_credit_id,'')) DO NOTHING;

-- ── Verification echo (visible at seed time) ─────────────────────────────────
\echo '--- synthetic attribution: per-order closed-sum (Σ credited per order) ---'
SELECT order_id,
       SUM(credited_revenue_minor) AS net_credited,
       SUM(weight_fraction) FILTER (WHERE row_kind='credit') AS sum_credit_weights
FROM attribution_credit_ledger
WHERE brand_id IN (:'sb_a'::uuid, :'sb_b'::uuid) AND model_version='v1-synthetic-fixture'
GROUP BY order_id ORDER BY order_id;

-- ROLLBACK (reverse this seed):
--   DELETE FROM attribution_credit_ledger
--    WHERE brand_id IN ('5e5e0001-0000-4000-8000-000000000001',
--                       '5e5e0002-0000-4000-8000-000000000002')
--      AND model_version = 'v1-synthetic-fixture';
