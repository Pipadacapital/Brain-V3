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
import { withTickLeaderLock, LEADER_LOCK_SYNC_CLAIMER } from '../../infrastructure/pg/LeaderLock.js';
import { log } from "../../log.js";

/** Sentinel cursor resource for the sync request signal (matches PgSyncRequestRepository). */
const SYNC_REQUEST_RESOURCE = 'sync.request' as const;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Provider → the existing repull run() entrypoint (lazy-imported to avoid eager Kafka init). */
type RepullRun = (connectorInstanceId: string) => Promise<void>;

/**
 * REPULL_DISPATCH — the DECLARATIVE provider→repull-loader registry (re-platform Phase B).
 *
 * Replaces the former switch statement: a single data-driven map so a provider's scheduled re-pull
 * dispatch lives in ONE place (the audit's bottleneck was "forget a switch case → the connector shows
 * connected but polls zero times, a silent miss"). Each value lazy-imports its run() (avoids eager
 * Kafka init at module load). Adding a connector's re-pull = one entry. Coverage vs the connector
 * catalog is asserted by sync-request-claimer dispatch tests.
 */
const REPULL_DISPATCH: Readonly<Record<string, () => Promise<RepullRun>>> = {
  shopify: async () => (await import('../shopify-repull/run.js')).run,
  razorpay: async () => (await import('../razorpay-settlement-repull/run.js')).run,
  // The ad-spend repull enumerates both meta + google_ads; run(ciId) targets one.
  meta: async () => (await import('../meta-spend-repull/run.js')).run,
  google_ads: async () => (await import('../google-ads-spend-repull/run.js')).run,
  gokwik: async () => (await import('../gokwik-awb-repull/run.js')).run,
  shiprocket: async () => (await import('../shiprocket-shipment-repull/run.js')).run,
  woocommerce: async () => (await import('../woocommerce-orders-repull/run.js')).run,
};

/** Providers that have a scheduled re-pull dispatch (the registry keys). */
export const REPULL_PROVIDERS: readonly string[] = Object.keys(REPULL_DISPATCH);

export async function loadRun(provider: string): Promise<RepullRun | null> {
  const loader = REPULL_DISPATCH[provider];
  return loader ? await loader() : null;
}

export interface ConnectorRow {
  connector_instance_id: string;
  brand_id: string;
  provider: string;
}

/**
 * P1 work-queue claim: atomically claim up to `batch` connectors whose next_repull_at is DUE and
 * stamp them +intervalSeconds (via the SECURITY DEFINER claim_due_repull_connectors, 0053). Two
 * replicas calling this concurrently get DISJOINT batches (FOR UPDATE SKIP LOCKED) — so the ingest
 * scheduler runs PARALLEL across replicas with no ordinals and each connector dispatched at most
 * once per interval. brand_id/provider are server-trusted (from the DB row, MT-1).
 */
export async function claimDueRepullConnectors(
  pool: Pool,
  batch: number,
  intervalSeconds: number,
): Promise<ConnectorRow[]> {
  const res = await pool.query<ConnectorRow>(
    `SELECT connector_instance_id, brand_id, provider FROM claim_due_repull_connectors($1, $2)`,
    [batch, intervalSeconds],
  );
  return res.rows;
}

/**
 * Enumerate all connected connectors via the generic SECURITY DEFINER fn
 * list_connectors_for_repull(provider) (migration 0091, Gap A).
 *
 * Runs as brain_app (which calls the SECURITY DEFINER fn running as 'brain') — no GUC,
 * fail-closed: under brain_app without a GUC the fn is the ONLY way to see the rows.
 *
 * One DB query per provider, parallel (Promise.all). The function returns
 * (connector_instance_id, brand_id, provider) — provider is already stamped so callers
 * need no per-provider branching. Replaces 6 bespoke per-provider SECURITY DEFINER calls.
 */
export async function enumerateConnectedConnectors(pool: Pool): Promise<ConnectorRow[]> {
  const results = await Promise.all(
    REPULL_PROVIDERS.map((provider) =>
      pool.query<ConnectorRow>(
        `SELECT connector_instance_id, brand_id, provider
         FROM list_connectors_for_repull($1)`,
        [provider],
      ),
    ),
  );
  return results.flatMap((r) => r.rows);
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
      log.error(`claim failed connector=${connector.connector_instance_id}`, { err: err });
      continue;
    }
    if (!claimed) continue;

    const run = await loadRun(connector.provider);
    if (!run) {
      log.warn(`no repull run() for provider=${connector.provider} connector=${connector.connector_instance_id}`);
      continue;
    }

    log.info(`dispatching ${connector.provider} repull connector=${connector.connector_instance_id} brand=${connector.brand_id}`);
    try {
      // Same-code-path: the identical run() the scheduler invokes. Its OWN
      // FOR UPDATE SKIP LOCKED overlap-lock guarantees no double-run.
      await run(connector.connector_instance_id);
      dispatched++;
    } catch (err) {
      // run() writes connector_sync_status.state='error' + last_error itself (dev-honesty).
      log.error(`repull run failed connector=${connector.connector_instance_id}`, { err: err });
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
          // P1: single-leader across replicas (the per-row claim is already atomic; this also stops
          // every replica re-enumerating + re-claiming each tick).
          await withTickLeaderLock(pool, LEADER_LOCK_SYNC_CLAIMER, () => tick(pool));
        } catch (err) {
          log.error('tick error', { err: err });
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
