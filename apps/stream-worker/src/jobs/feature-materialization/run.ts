/**
 * feature-materialization/run.ts — offline feature materialization job (re-platform Phase F).
 *
 * Reads the Gold customer mart (brain_serving.mv_gold_customer_360) from StarRocks and materializes the
 * customer feature set into the Redis online store (@brain/feature-store) for low-latency serving to
 * recommendations / the decision engine. ETL-writer posture: enumerates all brands present in Gold and
 * writes brand-scoped online keys. Idempotent (overwrites per key). Runs on a schedule (Argo cron),
 * same pattern as revenue-finalization — no new deployable.
 */
import mysql from 'mysql2/promise';
import { RedisOnlineStore, materializeCustomerFeatures, type Customer360Row } from '@brain/feature-store';
import { loadStreamWorkerConfig } from '@brain/config';
import { log } from '../../log.js';

export async function run(): Promise<void> {
  const cfg = loadStreamWorkerConfig();
  const host = cfg.STARROCKS_HOST ?? '127.0.0.1';
  const port = cfg.STARROCKS_QUERY_PORT;
  // Dev: root/''. Prod: a SELECT-grant feature user. STARROCKS_FEATURE_USER overrides.
  const user = cfg.STARROCKS_FEATURE_USER;
  const password = cfg.STARROCKS_FEATURE_PASSWORD;
  const redisUrl = cfg.REDIS_URL;
  const computedAt = new Date().toISOString();

  const sr = mysql.createPool({ host, port, user, password, database: 'brain_serving', connectionLimit: 4 });
  const store = new RedisOnlineStore(redisUrl);
  try {
    const [brandRows] = await sr.query('SELECT DISTINCT brand_id FROM mv_gold_customer_360');
    const brandIds = (brandRows as Record<string, unknown>[]).map((r) => String(r['brand_id']));
    let totalCustomers = 0;
    let totalFeatures = 0;
    for (const brandId of brandIds) {
      const [rowsRaw] = await sr.query(
        'SELECT brain_id, lifetime_value_minor, lifetime_orders, delivered_orders, rto_orders FROM mv_gold_customer_360 WHERE brand_id = ?',
        [brandId],
      );
      const rows: Customer360Row[] = (rowsRaw as Record<string, unknown>[]).map((r) => ({
        brain_id: String(r['brain_id']),
        lifetime_value_minor: Number(r['lifetime_value_minor']),
        lifetime_orders: Number(r['lifetime_orders']),
        delivered_orders: Number(r['delivered_orders']),
        rto_orders: Number(r['rto_orders']),
      }));
      const { customers, featuresWritten } = await materializeCustomerFeatures(brandId, rows, store, computedAt);
      totalCustomers += customers;
      totalFeatures += featuresWritten;
      log.info(`[feature-materialization] brand=${brandId} customers=${customers} features=${featuresWritten}`);
    }
    log.info(`[feature-materialization] DONE brands=${brandIds.length} customers=${totalCustomers} features=${totalFeatures}`);
  } finally {
    await store.close();
    await sr.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  run().catch((err) => {
    log.error('[feature-materialization] fatal', { err });
    process.exit(1);
  });
}
