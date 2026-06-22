-- 0065_phase_a_operational_schemas_billing_audit_ai.sql
--
-- RE-PLATFORM PHASE A — PG operational-schema split (slice 3 of N: billing + audit + ai_config).
--
-- Builds on 0063/0064 (schemas + role search_path + default grants + all SECURITY DEFINER functions
-- already widened to the full operational path, so this slice is pure ALTER TABLE ... SET SCHEMA).
--
--   billing   — the financial/operational ledgers, invoicing, metering, and cost inputs. These money
--               ledgers remain the PG WRITE source-of-truth (the lakehouse copies are derived in
--               Phase G); their Phase-G JDBC read-shim views (silver_order_ledger_src,
--               silver_marketing_spend_src, gold_attribution_credit_src) live in public, are owned by
--               'brain', and reference the tables by OID — so they keep working after the move with no
--               extra grants (the view owner mediates access to billing).
--   audit     — the append-only audit / decision / feedback log tables (owned id sequences ride along).
--   ai_config — AI provenance + recommendation outputs.
--
-- RLS policies, triggers, FKs, indexes, and owned sequences travel with each table; grants preserved.
-- Reverse = SET SCHEMA public. Data is disposable.

-- ── billing: money ledgers + invoicing + metering + costs ──
ALTER TABLE ad_spend_ledger             SET SCHEMA billing;
ALTER TABLE attribution_credit_ledger   SET SCHEMA billing;
ALTER TABLE realized_revenue_ledger     SET SCHEMA billing;
ALTER TABLE tax_ledger                  SET SCHEMA billing;
ALTER TABLE invoice                     SET SCHEMA billing;
ALTER TABLE invoice_line                SET SCHEMA billing;
ALTER TABLE invoice_number_counter      SET SCHEMA billing;
ALTER TABLE credit_note                 SET SCHEMA billing;
ALTER TABLE credit_note_number_counter  SET SCHEMA billing;
ALTER TABLE billing_plan                SET SCHEMA billing;
ALTER TABLE gmv_meter_snapshot          SET SCHEMA billing;
ALTER TABLE cost_input                  SET SCHEMA billing;

-- ── audit: append-only audit / decision / feedback logs (owned sequences ride along) ──
ALTER TABLE audit_log          SET SCHEMA audit;
ALTER TABLE decision_log       SET SCHEMA audit;
ALTER TABLE identity_audit     SET SCHEMA audit;
ALTER TABLE send_log           SET SCHEMA audit;
ALTER TABLE dq_check_result    SET SCHEMA audit;
ALTER TABLE capi_passback_log  SET SCHEMA audit;
ALTER TABLE capi_deletion_log  SET SCHEMA audit;

-- ── ai_config: AI provenance + recommendation outputs ──
ALTER TABLE ai_provenance         SET SCHEMA ai_config;
ALTER TABLE recommendation        SET SCHEMA ai_config;
ALTER TABLE recommendation_outcome SET SCHEMA ai_config;
