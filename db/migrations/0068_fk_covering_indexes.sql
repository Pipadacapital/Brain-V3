-- 0068_fk_covering_indexes.sql
--
-- DB-AUDIT H5 — index the 8 foreign-key columns that had no supporting index. Without one,
-- every parent-row DELETE/UPDATE does a SEQ SCAN of the child to enforce the FK (and the
-- corresponding joins seq-scan too). Each index LEADS with the FK column so it serves the FK
-- reverse-check (`WHERE <fk_col> = $1` on parent delete); brand-leading lookups are already
-- covered by existing brand-first unique constraints, so these are deliberately FK-col-leading.
-- Partial `WHERE ... IS NOT NULL` keeps the index lean for the nullable FKs (the reverse-check
-- predicate always implies NOT NULL). Plain CREATE INDEX (repo convention; these are bounded
-- operational tables, not the lakehouse analytical tables).

-- iam.user_session.rotated_from → user_session (session-rotation family lineage)
CREATE INDEX IF NOT EXISTS idx_user_session_rotated_from
  ON iam.user_session (rotated_from) WHERE rotated_from IS NOT NULL;

-- iam.invite.invited_by_user_id → app_user
CREATE INDEX IF NOT EXISTS idx_invite_invited_by_user_id
  ON iam.invite (invited_by_user_id) WHERE invited_by_user_id IS NOT NULL;

-- connectors.connector_sync_status.connector_instance_id → connector_instance
-- (disconnect/delete of a connector scans this table without it)
CREATE INDEX IF NOT EXISTS idx_connector_sync_status_instance
  ON connectors.connector_sync_status (connector_instance_id);

-- connectors.connector_cursor.connector_instance_id → connector_instance
CREATE INDEX IF NOT EXISTS idx_connector_cursor_instance
  ON connectors.connector_cursor (connector_instance_id);

-- identity.brain_id_alias.merge_id → identity_merge_event
CREATE INDEX IF NOT EXISTS idx_brain_id_alias_merge_id
  ON identity.brain_id_alias (merge_id) WHERE merge_id IS NOT NULL;

-- billing.tax_ledger.invoice_id → invoice
CREATE INDEX IF NOT EXISTS idx_tax_ledger_invoice_id
  ON billing.tax_ledger (invoice_id) WHERE invoice_id IS NOT NULL;

-- billing.tax_ledger.credit_note_id → credit_note
CREATE INDEX IF NOT EXISTS idx_tax_ledger_credit_note_id
  ON billing.tax_ledger (credit_note_id) WHERE credit_note_id IS NOT NULL;

-- billing.credit_note.invoice_id → invoice
CREATE INDEX IF NOT EXISTS idx_credit_note_invoice_id
  ON billing.credit_note (invoice_id) WHERE invoice_id IS NOT NULL;

-- ── Guard: all 8 indexes must now exist ──────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_indexes WHERE indexname IN (
    'idx_user_session_rotated_from','idx_invite_invited_by_user_id',
    'idx_connector_sync_status_instance','idx_connector_cursor_instance',
    'idx_brain_id_alias_merge_id','idx_tax_ledger_invoice_id',
    'idx_tax_ledger_credit_note_id','idx_credit_note_invoice_id');
  IF n <> 8 THEN
    RAISE EXCEPTION '0068 VIOLATION: expected 8 FK indexes, found %', n;
  END IF;
END $$;
