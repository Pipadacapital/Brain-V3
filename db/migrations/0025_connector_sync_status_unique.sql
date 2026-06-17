-- 0025_connector_sync_status_unique.sql — one sync-status row per connector instance
--
-- Bug: connector_sync_status had only a non-unique index on (brand_id, connector_instance_id),
-- and the repository did a plain INSERT on every connect. So reconnecting after a disconnect
-- created a SECOND sync-status row, leaving the stale 'error' row from the disconnect
-- (markError → state='error', last_error='Connector disconnected by user'). The dashboard
-- connection-status query (LEFT JOIN connector_sync_status … ORDER BY ci.created_at DESC LIMIT 1)
-- could then surface the stale 'error' row → the dashboard showed a red "Error" for a freshly,
-- healthily reconnected connector.
--
-- Fix: dedupe to the latest row per (brand_id, connector_instance_id), then add a UNIQUE
-- constraint so the repository can UPSERT (reconnect resets the single row to waiting_for_data
-- + clears last_error). Additive (I-E02): no column drop, RLS/grants unchanged.

-- 1. Dedupe — keep the most-recently-updated row per (brand_id, connector_instance_id).
DELETE FROM connector_sync_status a
USING connector_sync_status b
WHERE a.brand_id = b.brand_id
  AND a.connector_instance_id = b.connector_instance_id
  AND (a.updated_at < b.updated_at
       OR (a.updated_at = b.updated_at AND a.id < b.id));

-- 2. Enforce one row per connector instance (enables ON CONFLICT upsert).
ALTER TABLE connector_sync_status
  ADD CONSTRAINT connector_sync_status_brand_connector_unique
  UNIQUE (brand_id, connector_instance_id);
