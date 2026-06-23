-- 0096_attribution_model_id_data_driven.sql
--
-- Add 'data_driven' (the Markov removal-effect model) to the attribution credit-ledger model_id CHECK.
--
-- The data-driven model is the GLOBAL attribution model: per-channel weights are learned from the
-- whole journey corpus (computeMarkovChannelWeights, packages/metric-engine/src/attribution-datadriven.ts)
-- and applied per recognized order by reconcileDataDrivenAttribution. The credit rows it writes carry
-- model_id='data_driven', which migration 0032's CHECK never allowed → every data-driven insert hit
-- attribution_credit_ledger_model_id_check (SQLSTATE 23514). This widens the allowed set to include it.
--
-- ADDITIVE + reversible: DROP + re-ADD the CHECK (the only change). No data rewrite.
--   Rollback: re-create the CHECK with the original 4-model array (after deleting any data_driven rows).
--
-- The schema-split (Phase A) moved this table to the `billing` schema.

ALTER TABLE billing.attribution_credit_ledger
  DROP CONSTRAINT IF EXISTS attribution_credit_ledger_model_id_check;

ALTER TABLE billing.attribution_credit_ledger
  ADD CONSTRAINT attribution_credit_ledger_model_id_check
  CHECK (model_id IN ('first_touch', 'last_touch', 'linear', 'position_based', 'data_driven'));
