-- 0052_capi_passback_unsupported_currency_status.sql
--
-- #68 follow-up — fail-closed multi-currency guard for the Meta CAPI passback.
--
-- The CAPI passback converts a BIGINT minor-units value to a major-unit float at the Meta wire
-- boundary (custom_data.value). That conversion is currency-exponent dependent: a 0-decimal (JPY)
-- or 3-decimal (KWD/BHD) value sent with a hardcoded 2-decimal divisor is 100x/10x wrong. The
-- exponent is now currency-aware (@brain/money MINOR_UNITS), but a currency Brain does NOT model
-- must NOT be sent to Meta with a fabricated value (revenue-truth-over-platform-truth / fail-safe).
-- The service now BLOCKS such a conversion; this records that terminal outcome honestly.
--
-- ADDITIVE ONLY (I-E02): widen the status CHECK (DROP IF EXISTS -> ADD widened). Widening a CHECK
-- is FULL_TRANSITIVE-safe — every existing row already satisfies the larger set.

ALTER TABLE capi_passback_log DROP CONSTRAINT IF EXISTS capi_passback_log_status_check;
ALTER TABLE capi_passback_log
  ADD CONSTRAINT capi_passback_log_status_check
  CHECK (status IN (
    'sent',
    'blocked_no_consent',
    'would_send_dev',
    'deleted',
    'failed',
    'blocked_unsupported_currency'   -- terminal: currency not in @brain/money MINOR_UNITS; never sent
  ));
