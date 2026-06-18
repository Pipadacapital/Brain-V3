/**
 * sync-request-claimer/run.ts — the in-worker claimer for on-demand "Sync now"
 * (feat-connector-sync-now / architecture §3, §6 Track A).
 *
 * NOT a new deployable / topic / envelope. An interval loop wired into the already-
 * running apps/stream-worker/src/main.ts. It turns a sentinel sync-request row
 * (connector_cursor.resource='sync.request', written by the core POST .../sync route)
 * into the SAME run(connectorInstanceId) the scheduler invokes — the "same code path".
 *
 * Flow (mirrors the repull jobs' enumerate→GUC→lock conventions):
 *   1. Enumerate CONNECTED connectors via the EXISTING SECURITY DEFINER fns
 *      (no GUC at this step — discovering WHICH brand to work for; fail-closed under RLS).
 *        - list_connectors_for_repull()                       → shopify
 *        - list_razorpay_connectors_for_settlement_repull()   → razorpay
 *        - list_ad_connectors_for_spend_repull()              → meta / google_ads
 *   2. For each, under the brand GUC, claim the PENDING sentinel request row
 *      (cursor_value <> '') with FOR UPDATE SKIP LOCKED + UPDATE it to '' (tombstone)
 *      inside the same txn (so a second claimer tick / instance can't double-claim —
 *      the claim is the tombstone). NOT a DELETE: brain_app has no DELETE grant on
 *      connector_cursor (SELECT/INSERT/UPDATE only — a DELETE 42501s under RLS).
 *   3. Dispatch the matching existing run(connectorInstanceId). That run() has its OWN
 *      FOR UPDATE SKIP LOCKED overlap-lock on the live cursor row, so a manual click can
 *      NEVER run concurrently with a scheduled run or a second claim — the late one is a
 *      no-op skip. This claimer adds NO new lock semantics; it reuses the repull's.
 *
 * Invariants: brand_id authority = the SECURITY DEFINER fn result (MT-1), GUC set AFTER
 * enumerate, RLS FORCE on connector_cursor verified under brain_app, token NEVER read here.
 */

import { Pool } from 'pg';

/** Sentinel cursor resource for the sync request signal (matches PgSyncRequestRepository). */
const SYNC_REQUEST_RESOURCE = 'sync.request' as const;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Provider → the existing repull run() entrypoint (lazy-imported to avoid eager Kafka init). */
type RepullRun = (connectorInstanceId: string) => Promise<void>;

async function loadRun(provider: string): Promise<RepullRun | null> {
  switch (provider) {
    case 'shopify':
      return (await import('../shopify-repull/run.js')).run;
    case 'razorpay':
      return (await import('../razorpay-settlement-repull/run.js')).run;
    case 'meta':
    case 'google_ads':
      // The ad-spend repull enumerates both meta + google_ads; run(ciId) targets one.
      return (
        provider === 'meta'
          ? (await import('../meta-spend-repull/run.js')).run
          : (await import('../google-ads-spend-repull/run.js')).run
      );
    default:
      return null;
  }
}

interface ConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
}

/**
 * Enumerate all connected connectors across the three existing SECURITY DEFINER fns.
 * Runs as brain_app (which calls the SECURITY DEFINER fns running as 'brain') — no GUC,
 * fail-closed: under brain_app without a GUC the fns are the ONLY way to see the rows.
 */
async function enumerateConnectedConnectors(pool: Pool): Promise<ConnectorRow[]> {
  const rows: ConnectorRow[] = [];

  const shopify = await pool.query<{ connector_instance_id: string; brand_id: string }>(
    `SELECT connector_instance_id, brand_id FROM list_connectors_for_repull()`,
  );
  for (const r of shopify.rows) {
    rows.push({ ...r, provider: 'shopify' });
  }

  const razorpay = await pool.query<{ connector_instance_id: string; brand_id: string }>(
    `SELECT connector_instance_id, brand_id FROM list_razorpay_connectors_for_settlement_repull()`,
  );
  for (const r of razorpay.rows) {
    rows.push({ ...r, provider: 'razorpay' });
  }

  const ads = await pool.query<{ connector_instance_id: string; brand_id: string; provider: string }>(
    `SELECT connector_instance_id, brand_id, provider FROM list_ad_connectors_for_spend_repull()`,
  );
  for (const r of ads.rows) {
    rows.push({ connector_instance_id: r.connector_instance_id, brand_id: r.brand_id, provider: r.provider });
  }

  return rows;
}

/**
 * Atomically claim (read PENDING FOR UPDATE SKIP LOCKED + UPDATE to '' tombstone) the
 * sentinel request row for one connector, under its brand GUC. Returns true if a pending
 * request (cursor_value <> '') was claimed. The tombstone-on-claim makes the claim
 * idempotent: a second claimer tick sees an empty (consumed) row and returns false.
 * NOT a DELETE — brain_app has no DELETE grant on connector_cursor (RLS-enforced).
 */
export async function claimSyncRequest(
  pool: Pool,
  brandId: string,
  connectorInstanceId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC BEFORE any brand-scoped op (NN-1 / RLS FORCE — verified under brain_app).
    await client.query(
      `SELECT set_config('app.current_brand_id', $1, true),
              set_config('app.current_user_id', $2, true),
              set_config('app.current_workspace_id', $2, true)`,
      [brandId, NIL_UUID],
    );

    // Lock ONLY a pending row (non-empty cursor_value). An empty '' tombstone is already
    // consumed → 0 rows → false (no re-dispatch).
    const locked = await client.query<{ id: string }>(
      `SELECT id FROM connector_cursor
        WHERE brand_id = $1
          AND connector_instance_id = $2
          AND resource = $3
          AND cursor_value IS NOT NULL
          AND cursor_value <> ''
        FOR UPDATE SKIP LOCKED`,
      [brandId, connectorInstanceId, SYNC_REQUEST_RESOURCE],
    );

    if ((locked.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }

    // The claim IS the tombstone (UPDATE to '') — within the same txn, so no other
    // claimer can re-claim. brain_app holds UPDATE (not DELETE) on connector_cursor.
    await client.query(
      `UPDATE connector_cursor
          SET cursor_value = '', updated_at = NOW()
        WHERE brand_id = $1
          AND connector_instance_id = $2
          AND resource = $3`,
      [brandId, connectorInstanceId, SYNC_REQUEST_RESOURCE],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * One claimer tick: enumerate connected connectors, claim pending sync requests, and
 * dispatch the matching existing run(connectorInstanceId). Errors per-connector are
 * logged and isolated (one bad connector never stalls the tick).
 */
export async function tick(pool: Pool): Promise<number> {
  let dispatched = 0;
  const connectors = await enumerateConnectedConnectors(pool);
  for (const connector of connectors) {
    let claimed = false;
    try {
      claimed = await claimSyncRequest(pool, connector.brand_id, connector.connector_instance_id);
    } catch (err) {
      console.error(
        `[sync-claimer] claim failed connector=${connector.connector_instance_id}`,
        err,
      );
      continue;
    }
    if (!claimed) continue;

    const run = await loadRun(connector.provider);
    if (!run) {
      console.warn(
        `[sync-claimer] no repull run() for provider=${connector.provider} connector=${connector.connector_instance_id}`,
      );
      continue;
    }

    console.info(
      `[sync-claimer] dispatching ${connector.provider} repull connector=${connector.connector_instance_id} brand=${connector.brand_id}`,
    );
    try {
      // Same-code-path: the identical run() the scheduler invokes. Its OWN
      // FOR UPDATE SKIP LOCKED overlap-lock guarantees no double-run.
      await run(connector.connector_instance_id);
      dispatched++;
    } catch (err) {
      // run() writes connector_sync_status.state='error' + last_error itself (dev-honesty).
      console.error(
        `[sync-claimer] repull run failed connector=${connector.connector_instance_id}`,
        err,
      );
    }
  }
  return dispatched;
}

export interface SyncRequestClaimer {
  stop(): Promise<void>;
}

/**
 * Start the interval claimer. Returns a handle with stop() for graceful shutdown.
 * Default interval 5s. The pool MUST be a brain_app pool (RLS enforced) — never superuser.
 */
export function startSyncRequestClaimer(pool: Pool, intervalMs = 5_000): SyncRequestClaimer {
  let running = true;
  let inFlight = false;

  const loop = async (): Promise<void> => {
    while (running) {
      if (!inFlight) {
        inFlight = true;
        try {
          await tick(pool);
        } catch (err) {
          console.error('[sync-claimer] tick error', err);
        } finally {
          inFlight = false;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  void loop();

  return {
    stop: async (): Promise<void> => {
      running = false;
    },
  };
}
