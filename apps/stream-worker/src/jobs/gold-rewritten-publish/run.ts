/**
 * gold-rewritten-publish — bust the brand-scoped serving cache at Gold-batch completion.
 *
 * ADR-0015 WS3: the gold.rewritten.v1 Kafka lane + AnalyticsCacheInvalidateConsumer are RETIRED —
 * this job now performs the SAME eviction DIRECTLY (ServingCacheEvictor: SCAN `${brandId}:*` +
 * DEL with the cross-brand guard and the AMD-23 durable-config `{brand}:flag:*` exemption). The
 * job name is kept so the refresh-loop call sites stay unchanged: invoked by
 * tools/dev/v4-refresh-loop.sh at the END of Phase 2 (after the BI Gold marts + serving views),
 * and runnable standalone: `tsx src/jobs/gold-rewritten-publish/run.ts`.
 *
 * SCOPE: every active brand, whole-brand bust — a refresh-loop Phase-2 pass rewrites the brand's
 * whole BI Gold surface, so the honest scope is "everything for this brand" (exactly the
 * affected_scope.all=true the retired wire event carried).
 *
 * FAIL-OPEN: cache busting is an optimization. The caller treats a non-zero exit as a warning,
 * never a refresh-cycle failure; the per-metric TTL remains the correctness safety net. Tenant
 * isolation: brand_id leads every evicted key (guards enforced inside ServingCacheEvictor).
 */
import pg from 'pg';
import { Redis } from 'ioredis';
import { ServingCacheEvictor } from '../../infrastructure/redis/ServingCacheEvictor.js';
import { log } from '../../log.js';

// intentional raw: same distinct fallback chain as the sibling journey-stitch-export job.
const PG_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export interface GoldRewrittenPublishResult {
  brands: number;
  /** Brands whose serving-cache keys were swept (idempotent — 0 keys deleted still counts). */
  evicted: number;
  keysDeleted: number;
}

export async function runGoldRewrittenPublish(): Promise<GoldRewrittenPublishResult> {
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  const redis = new Redis(REDIS_URL);
  const evictor = new ServingCacheEvictor(redis);
  try {
    const brandRes = await pgPool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    const brandIds = brandRes.rows.map((r) => r.id);
    if (brandIds.length === 0) {
      log.info('[gold-rewritten-publish] no active brands — nothing to evict');
      return { brands: 0, evicted: 0, keysDeleted: 0 };
    }

    let evicted = 0;
    let keysDeleted = 0;
    for (const brandId of brandIds) {
      // evictBrand is fail-open per brand (a Redis blip logs + returns partial count).
      keysDeleted += await evictor.evictBrand(brandId);
      evicted += 1;
    }
    log.info('[gold-rewritten-publish] serving cache evicted directly (gold rewrite)', {
      brand_count: evicted,
      keys_deleted: keysDeleted,
    });
    return { brands: brandIds.length, evicted, keysDeleted };
  } finally {
    await redis.quit().catch(() => {});
    await pgPool.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runGoldRewrittenPublish()
    .then((r) => {
      log.info(`[gold-rewritten-publish] done — ${r.evicted}/${r.brands} brand(s) evicted (${r.keysDeleted} keys)`);
      process.exit(0);
    })
    .catch((err) => {
      log.error('[gold-rewritten-publish] fatal (fail-open — serving cache falls back to TTL expiry)', { err });
      process.exit(1);
    });
}
