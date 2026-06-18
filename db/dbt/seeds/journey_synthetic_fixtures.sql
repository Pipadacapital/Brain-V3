-- ============================================================================
-- journey_synthetic_fixtures.sql — CLEARLY-LABELLED synthetic journey enrichment.
-- feat-journey-touchpoint (Stage 3, @data-engineer). Architecture §5.
--
-- DEV-HONESTY BOUNDARY (the rule): the real-Bronze build is proven FIRST
--   (`make journey-build` + `make journey-verify` on the 23 real anon-bearing
--   page.viewed events). These synthetic fixtures are loaded ONLY to enrich the demo
--   with (a) multi-touch journeys (so first≠last touch is demoable) and (b) matched
--   anon↔order pairs (so stitch-hit-rate is demoable). NEVER fake coverage.
--
-- THE FLAG RIDES THROUGH: every synthetic Bronze event carries
--   payload.properties._synthetic=true → stg_touchpoint_events sets is_synthetic=true →
--   silver_touchpoint.is_synthetic=true → the metric-engine emits data_source='synthetic'
--   → the UI badges the panel "Synthetic (dev)". The synthetic flag is observable end-to-end.
--
-- IDEMPOTENT: deterministic event_ids (gen via md5→uuid below) + ON CONFLICT DO NOTHING
--   on the Bronze (brand_id, event_id) PK, + upsert on the stitch map PK. Re-loading is a
--   no-op → the journey-verify replay fingerprint stays stable.
--
-- REVERSIBLE: rollback = DELETE the two synthetic brands' rows (see the trailer).
-- ============================================================================

-- Synthetic brand ids (throwaway, clearly out-of-band so they never collide with real).
-- 5e5e... = "synthetic". Two brands so cross-brand isolation has synthetic rows too.
\set sb_a '5e5e0001-0000-4000-8000-000000000001'
\set sb_b '5e5e0002-0000-4000-8000-000000000002'

-- Helper: a deterministic uuid from a text seed (md5 → uuid-shaped). Idempotent ids.
-- (Inline; no function created so the seed is self-contained/reversible.)

-- ── Brand A — anon J1: a 4-touch journey (google → meta → email → direct) → ORDER ──
INSERT INTO bronze_events
  (event_id, brand_id, occurred_at, ingested_at, schema_name, schema_version,
   event_type, correlation_id, partition_key, payload)
VALUES
  -- touch 1: paid_google (first touch)
  ((md5(:'sb_a' || ':syn-j1-t1'))::uuid, :'sb_a'::uuid,
   '2026-06-10 09:00:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j1-1', :'sb_a' || ':j1t1',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000001","session_id":"5e5esess-0001-0001-0001-000000000001","landing_path":"/","click_ids":{"gclid":"GCL_SYN_J1"},"utm":{"source":"google","medium":"cpc","campaign":"summer_sale"}}}'::jsonb),
  -- touch 2: paid_meta (+45 min → same anon, new session by the 30-min rule)
  ((md5(:'sb_a' || ':syn-j1-t2'))::uuid, :'sb_a'::uuid,
   '2026-06-10 09:45:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j1-2', :'sb_a' || ':j1t2',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000001","session_id":"5e5esess-0001-0001-0001-000000000002","landing_path":"/products","click_ids":{"fbclid":"FBCL_SYN_J1"},"utm":{"source":"facebook","medium":"paid_social","campaign":"retarget"}}}'::jsonb),
  -- touch 3: email (next day)
  ((md5(:'sb_a' || ':syn-j1-t3'))::uuid, :'sb_a'::uuid,
   '2026-06-11 12:00:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j1-3', :'sb_a' || ':j1t3',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000001","session_id":"5e5esess-0001-0001-0001-000000000003","landing_path":"/cart","utm":{"source":"klaviyo","medium":"email","campaign":"abandoned_cart"}}}'::jsonb),
  -- touch 4: direct (last touch, converts)
  ((md5(:'sb_a' || ':syn-j1-t4'))::uuid, :'sb_a'::uuid,
   '2026-06-11 12:30:00+00', NOW(), 'brain.collector.event.v1', 1,
   'cart.viewed', 'syn-corr-j1-4', :'sb_a' || ':j1t4',
   '{"event_name":"cart.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000001","session_id":"5e5esess-0001-0001-0001-000000000003","landing_path":"/checkout"}}'::jsonb),

  -- ── Brand A — anon J2: a 2-touch direct→referral journey, NO order (un-stitched) ──
  ((md5(:'sb_a' || ':syn-j2-t1'))::uuid, :'sb_a'::uuid,
   '2026-06-12 08:00:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j2-1', :'sb_a' || ':j2t1',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000002","session_id":"5e5esess-0002-0001-0001-000000000001","landing_path":"/","referrer":"https://www.instagram.com/"}}'::jsonb),
  ((md5(:'sb_a' || ':syn-j2-t2'))::uuid, :'sb_a'::uuid,
   '2026-06-12 08:10:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j2-2', :'sb_a' || ':j2t2',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0001-0001-0001-000000000002","session_id":"5e5esess-0002-0001-0001-000000000001","landing_path":"/about"}}'::jsonb),

  -- ── Brand B — anon J3: a 3-touch journey (google → google → direct) → ORDER ──
  ((md5(:'sb_b' || ':syn-j3-t1'))::uuid, :'sb_b'::uuid,
   '2026-06-13 10:00:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j3-1', :'sb_b' || ':j3t1',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0002-0001-0001-000000000001","session_id":"5e5esess-0003-0001-0001-000000000001","landing_path":"/","click_ids":{"gclid":"GCL_SYN_J3"},"utm":{"source":"google","medium":"cpc","campaign":"brand"}}}'::jsonb),
  ((md5(:'sb_b' || ':syn-j3-t2'))::uuid, :'sb_b'::uuid,
   '2026-06-13 14:00:00+00', NOW(), 'brain.collector.event.v1', 1,
   'page.viewed', 'syn-corr-j3-2', :'sb_b' || ':j3t2',
   '{"event_name":"page.viewed","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0002-0001-0001-000000000001","session_id":"5e5esess-0003-0001-0001-000000000002","landing_path":"/products","click_ids":{"gclid":"GCL_SYN_J3B"},"utm":{"source":"google","medium":"cpc","campaign":"shopping"}}}'::jsonb),
  ((md5(:'sb_b' || ':syn-j3-t3'))::uuid, :'sb_b'::uuid,
   '2026-06-13 14:20:00+00', NOW(), 'brain.collector.event.v1', 1,
   'cart.item_added', 'syn-corr-j3-3', :'sb_b' || ':j3t3',
   '{"event_name":"cart.item_added","properties":{"_synthetic":true,"brain_anon_id":"5e5eanon-0002-0001-0001-000000000001","session_id":"5e5esess-0003-0001-0001-000000000002","landing_path":"/cart"}}'::jsonb)
ON CONFLICT (brand_id, event_id) DO NOTHING;

-- ── Deterministic cart-stitch map: matched anon↔order pairs (D-5 read-back demo) ──
-- These rows represent brain_anon_id read BACK from the order note_attributes at webhook
-- time. J1 (brand A) and J3 (brand B) converted; J2 did NOT (no stitch row → un-stitched).
-- Idempotent upsert on the (brand_id, order_id) PK.
INSERT INTO connector_journey_stitch_map
  (brand_id, order_id, stitched_anon_id, brain_id, click_ids, utms)
VALUES
  (:'sb_a'::uuid, 'SYN-ORDER-J1', '5e5eanon-0001-0001-0001-000000000001',
   '5e5eb001-0001-4001-8001-000000000001'::uuid,
   '{"gclid":"GCL_SYN_J1","fbclid":"FBCL_SYN_J1"}'::jsonb,
   '{"source":"google","medium":"cpc","campaign":"summer_sale"}'::jsonb),
  (:'sb_b'::uuid, 'SYN-ORDER-J3', '5e5eanon-0002-0001-0001-000000000001',
   '5e5eb002-0001-4001-8001-000000000001'::uuid,
   '{"gclid":"GCL_SYN_J3"}'::jsonb,
   '{"source":"google","medium":"cpc","campaign":"brand"}'::jsonb)
ON CONFLICT (brand_id, order_id) DO UPDATE
  SET stitched_anon_id = EXCLUDED.stitched_anon_id,
      brain_id         = EXCLUDED.brain_id,
      click_ids        = EXCLUDED.click_ids,
      utms             = EXCLUDED.utms;

-- ── Rollback (run manually to remove all synthetic enrichment) ────────────────
--   DELETE FROM bronze_events WHERE brand_id IN
--     ('5e5e0001-0000-4000-8000-000000000001','5e5e0002-0000-4000-8000-000000000002');
--   DELETE FROM connector_journey_stitch_map WHERE brand_id IN
--     ('5e5e0001-0000-4000-8000-000000000001','5e5e0002-0000-4000-8000-000000000002');
