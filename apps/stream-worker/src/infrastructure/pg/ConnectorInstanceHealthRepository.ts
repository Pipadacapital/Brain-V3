/**
 * ConnectorInstanceHealthRepository — updates connector_instance.health_state + safety_rating.
 *
 * GAP: health-state-operational-transitions.
 * connector_instance.health_state was never transitioned during operational lifecycle: the repull/
 * backfill runners wrote connector_sync_status but never the health_state column on
 * connector_instance. This meant TokenExpired and RateLimited were dead enum values — the BFF
 * foundation-health gate always read a stale 'Healthy' even when a token had expired.
 *
 * This repository provides the SINGLE place where a health_state transition is persisted. All
 * repull runners route their auth-failure and rate-limit branches through the shared helper
 * `updateConnectorInstanceHealth` below, so the transition cannot be forgotten per-connector.
 *
 * RLS contract:
 *   connector_instance has FORCE RLS under brain_app. Set app.current_brand_id GUC inside a
 *   txn-local transaction BEFORE the UPDATE (NN-1 / ADR-LV-7). brand_id comes from the
 *   enumeration fn result (MT-1) — never from env or API response.
 *
 * Non-fatal on error: a failed health-state write MUST NOT abort the job. The primary
 * correctness primitive is the event pipeline and cursor watermark; the health_state is a
 * secondary observability signal that informs the BFF gate and stakeholder dashboards.
 *
 * Thread safety: each call acquires a dedicated pool client, wraps in BEGIN/COMMIT, releases in
 * finally. No shared state between concurrent callers.
 */

import type { Pool } from 'pg';
import type { HealthState, SafetyRating } from '@brain/connector-core';
import { log } from '../../log.js';

/** The health transitions this module drives from operational error branches. */
export type HealthTransitionKind = 'token_expired' | 'rate_limited' | 'account_disabled';

const HEALTH_TRANSITION_MAP: Record<
  HealthTransitionKind,
  { healthState: HealthState; safetyRating: SafetyRating }
> = {
  token_expired: { healthState: 'TokenExpired', safetyRating: 'blocked' },
  rate_limited:  { healthState: 'RateLimited',  safetyRating: 'degraded' },
  // account_disabled: the provider rejected the ad account itself (e.g. Google CUSTOMER_NOT_ENABLED
  // — deactivated / not yet enabled). 'Disabled'/blocked is terminal until the account is re-enabled
  // and reconnected; the repull backs off (no value retrying a disabled account every tick).
  account_disabled: { healthState: 'Disabled', safetyRating: 'blocked' },
};

/**
 * Persist a health_state transition on connector_instance.
 *
 * Called from the common error path in each repull/backfill runner:
 *   - on 401/invalid-token  → kind='token_expired'  → TokenExpired/blocked
 *   - on 429/throttle       → kind='rate_limited'   → RateLimited/degraded
 *
 * Non-fatal: errors are logged and swallowed — the caller's sync_status write and cursor
 * watermark remain the correctness primitives; this is the health-signal side-effect.
 *
 * @param pool       brand_app pg pool (FORCE RLS; GUC will be set inside the txn)
 * @param brandId    from enumeration fn (MT-1) — GUC authority
 * @param connectorInstanceId  connector_instance.id
 * @param kind       which health transition to apply
 */
export async function updateConnectorInstanceHealth(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
  kind: HealthTransitionKind,
): Promise<void> {
  const { healthState, safetyRating } = HEALTH_TRANSITION_MAP[kind];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // NN-1 / ADR-LV-7: GUC BEFORE brand-scoped write — connector_instance has FORCE RLS.
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true)`,
      [brandId],
    );
    const result = await client.query(
      `UPDATE connector_instance
          SET health_state  = $3,
              safety_rating = $4,
              updated_at    = NOW()
        WHERE id = $2 AND brand_id = $1`,
      [brandId, connectorInstanceId, healthState, safetyRating],
    );
    await client.query('COMMIT');
    if ((result.rowCount ?? 0) > 0) {
      log.info(
        `[connector-health] connector=${connectorInstanceId} brand=${brandId} ` +
        `health_state=${healthState} safety_rating=${safetyRating}`,
      );
    } else {
      // Row not found — most likely connector was deleted between enumerate and repull. Non-fatal.
      log.warn(
        `[connector-health] connector=${connectorInstanceId} brand=${brandId} ` +
        `health update matched 0 rows (connector removed?)`,
      );
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Non-fatal: health-state is a secondary signal; never abort the pipeline over it.
    log.error(
      `[connector-health] health_state update failed (non-fatal) ` +
      `connector=${connectorInstanceId} brand=${brandId} kind=${kind}`,
      { err },
    );
  } finally {
    client.release();
  }
}

/**
 * The set of health_states this module RECOVERS from on a successful sync.
 *
 * These are the transient/operational error states that `updateConnectorInstanceHealth` itself
 * sets (TokenExpired ← token_expired, RateLimited ← rate_limited). A successful sync is positive
 * proof those conditions cleared: the connector just authenticated and was not throttled.
 *
 * EXCLUDED on purpose (must stay STICKY until an explicit lifecycle event):
 *   - 'Disabled'      — account-level rejection (account_disabled); terminal until the account is
 *                       re-enabled AND reconnected (the repull backs off, so a stray success should
 *                       not silently un-disable it).
 *   - 'Disconnected'  — user/lifecycle disconnect, not an operational error.
 *   - 'Failed' / 'Delayed' — set by other (non-operational) subsystems with their own clear paths.
 * Restricting recovery to the two states THIS module sets keeps the state machine's ownership
 * clean: we only reverse the edges we created.
 */
export const RECOVERABLE_HEALTH_STATES: readonly HealthState[] = ['TokenExpired', 'RateLimited'];

/**
 * Recover a connector's health back to Healthy/safe on a SUCCESSFUL sync/repull.
 *
 * This is the recovery edge of the operational state machine — the missing counterpart to
 * `updateConnectorInstanceHealth`. Without it, a connector that once hit a 401/429 stayed pinned
 * to TokenExpired/RateLimited forever (sticky "connector failing" badge) even though every
 * subsequent repull succeeded — because the success path only wrote connector_sync_status and
 * never reset connector_instance.health_state. Wire this into each repull/backfill SUCCESS path
 * (right after the `connected` sync-state write) so EVERY connector self-heals platform-wide.
 *
 * Atomic + non-clobbering: the UPDATE is guarded by `health_state IN (RECOVERABLE_HEALTH_STATES)`
 * in SQL, so it is a no-op (0 rows) when the connector is already Healthy or in a sticky state
 * (Disabled/Disconnected/Failed/Delayed). This is race-safe: a concurrent real-failure write to a
 * sticky state cannot be reverted by a late-arriving success.
 *
 * Non-fatal: errors are logged and swallowed — like its error-path sibling, the health signal is
 * secondary to the event pipeline + cursor watermark.
 *
 * @param pool                  brand_app pg pool (FORCE RLS; GUC will be set inside the txn)
 * @param brandId               from enumeration fn (MT-1) — GUC authority
 * @param connectorInstanceId   connector_instance.id
 */
export async function recoverConnectorInstanceHealth(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
): Promise<void> {
  const recoveredState: HealthState = 'Healthy';
  const recoveredRating: SafetyRating = 'safe';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // NN-1 / ADR-LV-7: GUC BEFORE brand-scoped write — connector_instance has FORCE RLS.
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true)`,
      [brandId],
    );
    const result = await client.query(
      `UPDATE connector_instance
          SET health_state  = $3,
              safety_rating = $4,
              updated_at    = NOW()
        WHERE id = $2 AND brand_id = $1
          AND health_state = ANY($5::text[])`,
      [brandId, connectorInstanceId, recoveredState, recoveredRating, RECOVERABLE_HEALTH_STATES],
    );
    await client.query('COMMIT');
    if ((result.rowCount ?? 0) > 0) {
      // Only logs when an actual recovery happened (was TokenExpired/RateLimited → now Healthy).
      log.info(
        `[connector-health] connector=${connectorInstanceId} brand=${brandId} ` +
        `RECOVERED health_state=${recoveredState} safety_rating=${recoveredRating}`,
      );
    }
    // 0 rows → already Healthy or in a sticky state: intentional no-op, no log noise.
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Non-fatal: health-state is a secondary signal; never abort the pipeline over it.
    log.error(
      `[connector-health] health recovery update failed (non-fatal) ` +
      `connector=${connectorInstanceId} brand=${brandId}`,
      { err },
    );
  } finally {
    client.release();
  }
}
