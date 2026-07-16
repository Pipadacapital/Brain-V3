--
-- 0134_rls_nullif_guard_brand_gucs.sql — finish the empty-uuid RLS guard (completes 0132).
--
-- BUG (live, 2026-07-16): dashboard/analytics reads on the raw pool 500 with
--   "invalid input syntax for type uuid: \"\"" (SQLSTATE 22P02). 0132 NULLIF-guarded the 9
-- iam/tenancy policies that cast app.current_{user,workspace}_id, but explicitly LEFT the ~68
-- brand-scoped policies casting `current_setting('app.current_brand_id', true)::uuid` unguarded.
-- Under pgbouncer TRANSACTION pooling a GUC set to '' by a prior txn can leak onto a pooled
-- connection; Postgres then evaluates EVERY permissive policy on a touched table, and `''::uuid`
-- throws — failing the whole query even for rows the caller would never see. This is the
-- app-side buildContextGucSql follow-up 0132 named, applied defensively at the RLS layer.
--
-- FIX: wrap each `current_setting(...)::uuid` cast in NULLIF(current_setting(...), '') so an empty
-- GUC becomes NULL (→ `col = NULL` is NULL → the SAME rows are hidden as before) instead of a cast
-- error. Row VISIBILITY is IDENTICAL for any non-empty GUC; the only change is that policy
-- EVALUATION no longer CRASHES on an empty/leaked GUC. Covers every remaining brand-scoped policy
-- (incl. partition children) plus data_plane.ingest_dedup (0129). Atomic: one txn, RLS never
-- unenforced; each recreated policy is byte-identical to its origin EXCEPT the NULLIF wrapper.
--
BEGIN;


-- ai_config.ai_provenance
DROP POLICY IF EXISTS ai_provenance_isolation ON ai_config.ai_provenance;
CREATE POLICY ai_provenance_isolation ON ai_config.ai_provenance TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ai_config.recommendation
DROP POLICY IF EXISTS recommendation_isolation ON ai_config.recommendation;
CREATE POLICY recommendation_isolation ON ai_config.recommendation TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ai_config.recommendation_action
DROP POLICY IF EXISTS recommendation_action_isolation ON ai_config.recommendation_action;
CREATE POLICY recommendation_action_isolation ON ai_config.recommendation_action TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ai_config.recommendation_outcome
DROP POLICY IF EXISTS recommendation_outcome_isolation ON ai_config.recommendation_outcome;
CREATE POLICY recommendation_outcome_isolation ON ai_config.recommendation_outcome TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.audit_log
DROP POLICY IF EXISTS audit_log_isolation ON audit.audit_log;
CREATE POLICY audit_log_isolation ON audit.audit_log TO brain_app USING (((current_setting('app.role'::text, true) = 'audit_reader'::text) OR (brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))) WITH CHECK (true);

-- audit.capi_deletion_log
DROP POLICY IF EXISTS capi_deletion_log_isolation ON audit.capi_deletion_log;
CREATE POLICY capi_deletion_log_isolation ON audit.capi_deletion_log TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.capi_passback_log
DROP POLICY IF EXISTS capi_passback_log_isolation ON audit.capi_passback_log;
CREATE POLICY capi_passback_log_isolation ON audit.capi_passback_log TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.decision_log
DROP POLICY IF EXISTS decision_log_isolation ON audit.decision_log;
CREATE POLICY decision_log_isolation ON audit.decision_log TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.decision_log_p2026_06
DO $guard$ BEGIN
  IF to_regclass('audit.decision_log_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS decision_log_p2026_06_isolation ON audit.decision_log_p2026_06$q$;
    EXECUTE $q$CREATE POLICY decision_log_p2026_06_isolation ON audit.decision_log_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.decision_log_p2026_07
DO $guard$ BEGIN
  IF to_regclass('audit.decision_log_p2026_07') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS decision_log_p2026_07_isolation ON audit.decision_log_p2026_07$q$;
    EXECUTE $q$CREATE POLICY decision_log_p2026_07_isolation ON audit.decision_log_p2026_07 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.decision_log_pdefault
DROP POLICY IF EXISTS decision_log_pdefault_isolation ON audit.decision_log_pdefault;
CREATE POLICY decision_log_pdefault_isolation ON audit.decision_log_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.dq_check_result
DROP POLICY IF EXISTS dq_check_result_isolation ON audit.dq_check_result;
CREATE POLICY dq_check_result_isolation ON audit.dq_check_result TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.dq_check_result_p2026_06
DO $guard$ BEGIN
  IF to_regclass('audit.dq_check_result_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS dq_check_result_p2026_06_isolation ON audit.dq_check_result_p2026_06$q$;
    EXECUTE $q$CREATE POLICY dq_check_result_p2026_06_isolation ON audit.dq_check_result_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.dq_check_result_p2026_07
DO $guard$ BEGIN
  IF to_regclass('audit.dq_check_result_p2026_07') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS dq_check_result_p2026_07_isolation ON audit.dq_check_result_p2026_07$q$;
    EXECUTE $q$CREATE POLICY dq_check_result_p2026_07_isolation ON audit.dq_check_result_p2026_07 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.dq_check_result_pdefault
DROP POLICY IF EXISTS dq_check_result_pdefault_isolation ON audit.dq_check_result_pdefault;
CREATE POLICY dq_check_result_pdefault_isolation ON audit.dq_check_result_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.identity_audit
DROP POLICY IF EXISTS identity_audit_isolation ON audit.identity_audit;
CREATE POLICY identity_audit_isolation ON audit.identity_audit TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.identity_audit_p2026_06
DO $guard$ BEGIN
  IF to_regclass('audit.identity_audit_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS identity_audit_p2026_06_isolation ON audit.identity_audit_p2026_06$q$;
    EXECUTE $q$CREATE POLICY identity_audit_p2026_06_isolation ON audit.identity_audit_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.identity_audit_pdefault
DROP POLICY IF EXISTS identity_audit_pdefault_isolation ON audit.identity_audit_pdefault;
CREATE POLICY identity_audit_pdefault_isolation ON audit.identity_audit_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.send_log
DROP POLICY IF EXISTS send_log_isolation ON audit.send_log;
CREATE POLICY send_log_isolation ON audit.send_log TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- audit.send_log_p2026_06
DO $guard$ BEGIN
  IF to_regclass('audit.send_log_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS send_log_p2026_06_isolation ON audit.send_log_p2026_06$q$;
    EXECUTE $q$CREATE POLICY send_log_p2026_06_isolation ON audit.send_log_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- audit.send_log_pdefault
DROP POLICY IF EXISTS send_log_pdefault_isolation ON audit.send_log_pdefault;
CREATE POLICY send_log_pdefault_isolation ON audit.send_log_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.billing_plan
DROP POLICY IF EXISTS billing_plan_isolation ON billing.billing_plan;
CREATE POLICY billing_plan_isolation ON billing.billing_plan TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.cost_input
DROP POLICY IF EXISTS cost_input_isolation ON billing.cost_input;
CREATE POLICY cost_input_isolation ON billing.cost_input TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.credit_note
DROP POLICY IF EXISTS credit_note_isolation ON billing.credit_note;
CREATE POLICY credit_note_isolation ON billing.credit_note TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.gmv_meter_snapshot
DROP POLICY IF EXISTS gmv_meter_snapshot_isolation ON billing.gmv_meter_snapshot;
CREATE POLICY gmv_meter_snapshot_isolation ON billing.gmv_meter_snapshot TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.invoice
DROP POLICY IF EXISTS invoice_isolation ON billing.invoice;
CREATE POLICY invoice_isolation ON billing.invoice TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.invoice_line
DROP POLICY IF EXISTS invoice_line_isolation ON billing.invoice_line;
CREATE POLICY invoice_line_isolation ON billing.invoice_line TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.tax_ledger
DROP POLICY IF EXISTS tax_ledger_isolation ON billing.tax_ledger;
CREATE POLICY tax_ledger_isolation ON billing.tax_ledger TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- billing.tax_ledger_p2026_06
DO $guard$ BEGIN
  IF to_regclass('billing.tax_ledger_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS tax_ledger_p2026_06_isolation ON billing.tax_ledger_p2026_06$q$;
    EXECUTE $q$CREATE POLICY tax_ledger_p2026_06_isolation ON billing.tax_ledger_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- billing.tax_ledger_pdefault
DROP POLICY IF EXISTS tax_ledger_pdefault_isolation ON billing.tax_ledger_pdefault;
CREATE POLICY tax_ledger_pdefault_isolation ON billing.tax_ledger_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_cursor
DROP POLICY IF EXISTS connector_cursor_isolation ON connectors.connector_cursor;
CREATE POLICY connector_cursor_isolation ON connectors.connector_cursor TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_dlq_record
DROP POLICY IF EXISTS connector_dlq_record_isolation ON connectors.connector_dlq_record;
CREATE POLICY connector_dlq_record_isolation ON connectors.connector_dlq_record TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_dlq_record_p2026_06
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_dlq_record_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_dlq_record_p2026_06_isolation ON connectors.connector_dlq_record_p2026_06$q$;
    EXECUTE $q$CREATE POLICY connector_dlq_record_p2026_06_isolation ON connectors.connector_dlq_record_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_dlq_record_p2026_07
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_dlq_record_p2026_07') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_dlq_record_p2026_07_isolation ON connectors.connector_dlq_record_p2026_07$q$;
    EXECUTE $q$CREATE POLICY connector_dlq_record_p2026_07_isolation ON connectors.connector_dlq_record_p2026_07 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_dlq_record_p2026_08
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_dlq_record_p2026_08') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_dlq_record_p2026_08_isolation ON connectors.connector_dlq_record_p2026_08$q$;
    EXECUTE $q$CREATE POLICY connector_dlq_record_p2026_08_isolation ON connectors.connector_dlq_record_p2026_08 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_dlq_record_pdefault
DROP POLICY IF EXISTS connector_dlq_record_pdefault_isolation ON connectors.connector_dlq_record_pdefault;
CREATE POLICY connector_dlq_record_pdefault_isolation ON connectors.connector_dlq_record_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_instance
DROP POLICY IF EXISTS connector_instance_isolation ON connectors.connector_instance;
CREATE POLICY connector_instance_isolation ON connectors.connector_instance TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_journey_stitch_map
DROP POLICY IF EXISTS connector_journey_stitch_map_isolation ON connectors.connector_journey_stitch_map;
CREATE POLICY connector_journey_stitch_map_isolation ON connectors.connector_journey_stitch_map TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_razorpay_order_map
DROP POLICY IF EXISTS connector_razorpay_order_map_isolation ON connectors.connector_razorpay_order_map;
CREATE POLICY connector_razorpay_order_map_isolation ON connectors.connector_razorpay_order_map TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_sync_run
DROP POLICY IF EXISTS connector_sync_run_isolation ON connectors.connector_sync_run;
CREATE POLICY connector_sync_run_isolation ON connectors.connector_sync_run TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_sync_run_p2026_07
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_sync_run_p2026_07') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_sync_run_p2026_07_isolation ON connectors.connector_sync_run_p2026_07$q$;
    EXECUTE $q$CREATE POLICY connector_sync_run_p2026_07_isolation ON connectors.connector_sync_run_p2026_07 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_sync_run_p2026_08
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_sync_run_p2026_08') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_sync_run_p2026_08_isolation ON connectors.connector_sync_run_p2026_08$q$;
    EXECUTE $q$CREATE POLICY connector_sync_run_p2026_08_isolation ON connectors.connector_sync_run_p2026_08 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_sync_run_p2026_09
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_sync_run_p2026_09') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_sync_run_p2026_09_isolation ON connectors.connector_sync_run_p2026_09$q$;
    EXECUTE $q$CREATE POLICY connector_sync_run_p2026_09_isolation ON connectors.connector_sync_run_p2026_09 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_sync_status
DROP POLICY IF EXISTS connector_sync_status_isolation ON connectors.connector_sync_status;
CREATE POLICY connector_sync_status_isolation ON connectors.connector_sync_status TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_webhook_raw_archive
DROP POLICY IF EXISTS connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive;
CREATE POLICY connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_webhook_raw_archive_legacy
DROP POLICY IF EXISTS connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive_legacy;
CREATE POLICY connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive_legacy TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- connectors.connector_webhook_raw_archive_p2026_06
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_webhook_raw_archive_p2026_06') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_webhook_raw_archive_p2026_06_isolation ON connectors.connector_webhook_raw_archive_p2026_06$q$;
    EXECUTE $q$CREATE POLICY connector_webhook_raw_archive_p2026_06_isolation ON connectors.connector_webhook_raw_archive_p2026_06 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_webhook_raw_archive_p2026_07
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_webhook_raw_archive_p2026_07') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_webhook_raw_archive_p2026_07_isolation ON connectors.connector_webhook_raw_archive_p2026_07$q$;
    EXECUTE $q$CREATE POLICY connector_webhook_raw_archive_p2026_07_isolation ON connectors.connector_webhook_raw_archive_p2026_07 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_webhook_raw_archive_p2026_08
DO $guard$ BEGIN
  IF to_regclass('connectors.connector_webhook_raw_archive_p2026_08') IS NOT NULL THEN
    EXECUTE $q$DROP POLICY IF EXISTS connector_webhook_raw_archive_p2026_08_isolation ON connectors.connector_webhook_raw_archive_p2026_08$q$;
    EXECUTE $q$CREATE POLICY connector_webhook_raw_archive_p2026_08_isolation ON connectors.connector_webhook_raw_archive_p2026_08 TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid))$q$;
  END IF;
END $guard$;

-- connectors.connector_webhook_raw_archive_pdefault
DROP POLICY IF EXISTS connector_webhook_raw_archive_pdefault_isolation ON connectors.connector_webhook_raw_archive_pdefault;
CREATE POLICY connector_webhook_raw_archive_pdefault_isolation ON connectors.connector_webhook_raw_archive_pdefault TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- consent.consent_record
DROP POLICY IF EXISTS consent_record_isolation ON consent.consent_record;
CREATE POLICY consent_record_isolation ON consent.consent_record TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- consent.consent_tombstone
DROP POLICY IF EXISTS consent_tombstone_isolation ON consent.consent_tombstone;
CREATE POLICY consent_tombstone_isolation ON consent.consent_tombstone TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- data_plane.ingest_dedup
DROP POLICY IF EXISTS ingest_dedup_brand_isolation ON data_plane.ingest_dedup;
CREATE POLICY ingest_dedup_brand_isolation ON data_plane.ingest_dedup TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- identity.contact_pii
DROP POLICY IF EXISTS contact_pii_isolation ON identity.contact_pii;
CREATE POLICY contact_pii_isolation ON identity.contact_pii TO brain_app USING (((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid) AND (current_setting('app.role'::text, true) = 'send_service'::text)));

-- identity.pii_erasure_log
DROP POLICY IF EXISTS pii_erasure_log_isolation ON identity.pii_erasure_log;
CREATE POLICY pii_erasure_log_isolation ON identity.pii_erasure_log TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- jobs.backfill_job
DROP POLICY IF EXISTS backfill_job_isolation ON jobs.backfill_job;
CREATE POLICY backfill_job_isolation ON jobs.backfill_job TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- jobs.resource_backfill_state
DROP POLICY IF EXISTS resource_backfill_state_isolation ON jobs.resource_backfill_state;
CREATE POLICY resource_backfill_state_isolation ON jobs.resource_backfill_state TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ml.model_registry
DROP POLICY IF EXISTS model_registry_isolation ON ml.model_registry;
CREATE POLICY model_registry_isolation ON ml.model_registry TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ops.brand_identity_priority
DROP POLICY IF EXISTS brand_identity_priority_isolation ON ops.brand_identity_priority;
CREATE POLICY brand_identity_priority_isolation ON ops.brand_identity_priority TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ops.saved_segment
DROP POLICY IF EXISTS saved_segment_isolation ON ops.saved_segment;
CREATE POLICY saved_segment_isolation ON ops.saved_segment TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- ops.stitch_conflict_review
DROP POLICY IF EXISTS stitch_conflict_review_isolation ON ops.stitch_conflict_review;
CREATE POLICY stitch_conflict_review_isolation ON ops.stitch_conflict_review TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- pixel.pixel_installation
DROP POLICY IF EXISTS pixel_installation_isolation ON pixel.pixel_installation;
CREATE POLICY pixel_installation_isolation ON pixel.pixel_installation TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- pixel.pixel_status
DROP POLICY IF EXISTS pixel_status_isolation ON pixel.pixel_status;
CREATE POLICY pixel_status_isolation ON pixel.pixel_status TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- public.gold_product_costs
DROP POLICY IF EXISTS gold_product_costs_isolation ON public.gold_product_costs;
CREATE POLICY gold_product_costs_isolation ON public.gold_product_costs TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- tenancy.brand_config_history
DROP POLICY IF EXISTS brand_config_history_isolation ON tenancy.brand_config_history;
CREATE POLICY brand_config_history_isolation ON tenancy.brand_config_history TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- tenancy.brand_identity_salt
DROP POLICY IF EXISTS brand_identity_salt_isolation ON tenancy.brand_identity_salt;
CREATE POLICY brand_identity_salt_isolation ON tenancy.brand_identity_salt TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- tenancy.brand_keyring
DROP POLICY IF EXISTS brand_keyring_isolation ON tenancy.brand_keyring;
CREATE POLICY brand_keyring_isolation ON tenancy.brand_keyring TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

-- tenancy.subject_keyring
DROP POLICY IF EXISTS subject_keyring_isolation ON tenancy.subject_keyring;
CREATE POLICY subject_keyring_isolation ON tenancy.subject_keyring TO brain_app USING ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid)) WITH CHECK ((brand_id = (NULLIF(current_setting('app.current_brand_id'::text, true), ''))::uuid));

COMMIT;
