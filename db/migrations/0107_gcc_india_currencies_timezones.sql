-- 0107_gcc_india_currencies_timezones.sql
--
-- MULTI-CURRENCY onboarding (GCC + India). The reference tables tenancy.ref_currency /
-- ref_timezone (migration 0071) seeded only INR/AED/SAR and 3 timezones, so a merchant in Kuwait
-- (KWD) or Qatar (QAR) could not pick their primary currency at brand onboarding — and a KWD order
-- crashed the dashboard money formatter. This widens the SUPPORTED SET to all six GCC currencies +
-- India (expandable later by INSERTing more rows — no migration needed, that's the whole point of
-- the reference-table design from 0071).
--
-- minor_unit_digits is the ISO-4217 exponent and MUST be correct: the GCC dinars KWD/BHD/OMR have
-- 1000 sub-units (3 digits); AED/SAR/QAR/INR have 2. A wrong exponent renders/sends amounts 10×
-- wrong. The @brain/money module carries the same table for the display layer; this is the DB-side
-- source of truth for the onboarding picker + the brand.currency_code FK.
--
-- ADDITIVE + IDEMPOTENT (ON CONFLICT DO NOTHING). Rollback = DELETE the rows added here (only if no
-- brand references them).

-- ── GCC + India currencies ───────────────────────────────────────────────────
INSERT INTO tenancy.ref_currency (code, display_name, minor_unit_digits) VALUES
  ('INR', 'Indian Rupee',       2),  -- (already seeded by 0071; idempotent)
  ('AED', 'UAE Dirham',         2),
  ('SAR', 'Saudi Riyal',        2),
  ('QAR', 'Qatari Riyal',       2),
  ('KWD', 'Kuwaiti Dinar',      3),  -- 1000 fils
  ('BHD', 'Bahraini Dinar',     3),  -- 1000 fils
  ('OMR', 'Omani Rial',         3)   -- 1000 baisa
ON CONFLICT (code) DO NOTHING;

-- ── GCC + India timezones ────────────────────────────────────────────────────
INSERT INTO tenancy.ref_timezone (name) VALUES
  ('Asia/Kolkata'),   -- India (already seeded by 0071; idempotent)
  ('Asia/Dubai'),     -- UAE
  ('Asia/Riyadh'),    -- Saudi Arabia
  ('Asia/Kuwait'),    -- Kuwait
  ('Asia/Bahrain'),   -- Bahrain
  ('Asia/Muscat'),    -- Oman
  ('Asia/Qatar')      -- Qatar
ON CONFLICT (name) DO NOTHING;

-- ── post-condition guard: all seven currencies present with correct exponents ──
DO $$
DECLARE
  n_cur int;
  n_tz  int;
BEGIN
  SELECT count(*) INTO n_cur FROM tenancy.ref_currency
   WHERE code IN ('INR','AED','SAR','QAR','KWD','BHD','OMR');
  IF n_cur <> 7 THEN
    RAISE EXCEPTION '0107 failed: expected 7 GCC+India currencies, found %', n_cur;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenancy.ref_currency WHERE code='KWD' AND minor_unit_digits=3) THEN
    RAISE EXCEPTION '0107 failed: KWD must have minor_unit_digits=3';
  END IF;
  SELECT count(*) INTO n_tz FROM tenancy.ref_timezone
   WHERE name IN ('Asia/Kolkata','Asia/Dubai','Asia/Riyadh','Asia/Kuwait','Asia/Bahrain','Asia/Muscat','Asia/Qatar');
  IF n_tz <> 7 THEN
    RAISE EXCEPTION '0107 failed: expected 7 GCC+India timezones, found %', n_tz;
  END IF;
END $$;
