--
-- 0136_reference_data_seed.sql — restore the tenancy reference-data seeds (ref_currency, ref_timezone).
--
-- BUG (issue #229): the migration-baseline consolidation (0000_baseline_2026_07.sql, from
-- "chore(db): consolidate 0001-0128 migrations into a single baseline") is a schema-only pg_dump —
-- it CREATEs tenancy.ref_currency / tenancy.ref_timezone but does not populate them. The old
-- pre-consolidation migrations carried the reference-data INSERTs, which were lost in the dump.
-- Result: on ANY fresh `migrate:up` (a new environment, dev-up from zero, CI integration lanes) a
-- `tenancy.brand` insert fails its FKs — brand_currency_code_fkey (→ ref_currency.code) and
-- brand_timezone_fkey (→ ref_timezone.name) — so no brand can be created. Existing prod is unaffected
-- (it was seeded before the consolidation); this only bites clean re-bootstraps.
--
-- FIX: seed the supported currencies (India + GCC, the CurrencyCode enum in
-- packages/contracts/src/api/brand.api.v1.ts) with ISO-4217 minor units, and the matching IANA
-- timezones (brand.timezone defaults to 'Asia/Kolkata'). Idempotent — safe on an already-seeded DB.
--

INSERT INTO tenancy.ref_currency (code, display_name, minor_unit_digits) VALUES
  ('INR', 'Indian Rupee',  2),
  ('AED', 'UAE Dirham',    2),
  ('SAR', 'Saudi Riyal',   2),
  ('QAR', 'Qatari Riyal',  2),
  ('KWD', 'Kuwaiti Dinar', 3),
  ('BHD', 'Bahraini Dinar', 3),
  ('OMR', 'Omani Rial',    3)
ON CONFLICT (code) DO NOTHING;

INSERT INTO tenancy.ref_timezone (name) VALUES
  ('Asia/Kolkata'),
  ('Asia/Dubai'),
  ('Asia/Riyadh'),
  ('Asia/Qatar'),
  ('Asia/Kuwait'),
  ('Asia/Bahrain'),
  ('Asia/Muscat')
ON CONFLICT (name) DO NOTHING;
