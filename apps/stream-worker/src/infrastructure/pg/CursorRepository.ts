/**
 * CursorRepository — the shared connector_cursor access layer for trailing-window re-pull jobs.
 *
 * Before this module, the SAME three helpers were hand-copied into every re-pull job
 * (gokwik-awb-repull, razorpay-settlement-repull, meta-spend-repull, shopify-repull) — the
 * gokwik clone even comments "identical to razorpay-settlement-repull". Three byte-identical
 * SQL bodies × N jobs is a maintenance hazard: a fix to the GUC ordering or the overlap-lock
 * has to be made in N places or it silently drifts. This is the single definition.
 *
 * All three operations follow the same invariants the duplicated copies enforced:
 *   - GUC is set BEFORE any brand-scoped operation (MT-1 / NN-1): connector_cursor has FORCE RLS,
 *     so app.current_brand_id MUST be set first. The system worker has no human user/workspace, so
 *     app.current_user_id / app.current_workspace_id are set to NIL_UUID (a valid uuid the RLS
 *     policy can cast) — never a real identity.
 *   - Each call uses a short-lived dedicated client with BEGIN/COMMIT so the GUC is txn-local and
 *     the lock lifetime is bounded; the connection is always released in a finally/catch.
 *   - The overlap-lock uses FOR UPDATE SKIP LOCKED: if another replica holds the row, it returns
 *     0 rows → we skip (non-blocking), never wait.
 *
 * Jobs whose access pattern is NOT the standard read/upsert keep their own code on purpose:
 *   - shopify-backfill upsertConnectorCursor sets ONLY app.current_brand_id (no user/workspace GUC)
 *     and takes a params object — a deliberately different shape, left untouched.
 *   - sync-request-claimer claims a pending cursor (cursor_value <> '') and tombstones it to '' —
 *     a different access pattern entirely, not a read/upsert.
 */
import type { Pool } from 'pg';
import { log } from '../../log.js';

/** System-worker identity for RLS GUCs: no human user/workspace, but a valid uuid the policy casts. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Acquire the per-resource overlap-lock on the connector_cursor row via FOR UPDATE SKIP LOCKED.
 * Ensures the row exists (no-op upsert), then tries to lock it; if another replica holds it,
 * returns false immediately (non-blocking). On success COMMITs to release the txn lock so the
 * job can run without holding a DB lock for its full duration — the connector_sync_status 'syncing'
 * state is the in-progress signal, the cursor row is only the coordination primitive.
 */
export async function acquireCursorLock(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  resource: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    await client.query(
      `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
       VALUES ($1, $2, $3, '', NOW())
       ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key DO NOTHING`,
      [brandId, connectorInstanceId, resource],
    );
    const lockResult = await client.query(
      `SELECT id FROM connector_cursor
       WHERE brand_id = $1 AND connector_instance_id = $2 AND resource = $3
       FOR UPDATE SKIP LOCKED`,
      [brandId, connectorInstanceId, resource],
    );
    if ((lockResult.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      client.release();
      return false;
    }
    await client.query('COMMIT');
    client.release();
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    throw err;
  }
}

/**
 * Read the current cursor high-water value for a resource. Returns null when the row is absent or
 * the value is the empty-string sentinel (set by the lock-acquire no-op insert before first write).
 */
export async function getCursorValue(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  resource: string,
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    const result = await client.query<{ cursor_value: string }>(
      `SELECT cursor_value FROM connector_cursor
       WHERE brand_id = $1 AND connector_instance_id = $2 AND resource = $3`,
      [brandId, connectorInstanceId, resource],
    );
    await client.query('COMMIT');
    const value = result.rows[0]?.cursor_value;
    return (value && value.length > 0) ? value : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Advance the cursor high-water value (upsert). NON-FATAL on error: a failed cursor write is logged
 * but never aborts the job — the next run re-reads the trailing window and restates idempotently, so
 * a lost cursor write costs a little rework, not correctness.
 */
export async function upsertCursorValue(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  resource: string,
  cursorValue: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );
    await client.query(
      `INSERT INTO connector_cursor (brand_id, connector_instance_id, resource, cursor_value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key
       DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
      [brandId, connectorInstanceId, resource, cursorValue],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error(`cursor upsert failed (non-fatal) resource=${resource}`, { err: err });
  } finally {
    client.release();
  }
}
