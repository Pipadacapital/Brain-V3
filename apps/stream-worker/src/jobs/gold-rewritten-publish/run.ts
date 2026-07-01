/**
 * gold-rewritten-publish — emit gold.rewritten.v1 per active brand at Gold-batch completion.
 *
 * THE PRODUCER side of the serving-cache invalidation loop (the contract existed with ZERO
 * producers). Invoked by tools/dev/v4-refresh-loop.sh at the END of Phase 2 (after the BI Gold
 * marts + serving views), and runnable standalone: `tsx src/jobs/gold-rewritten-publish/run.ts`.
 * The AnalyticsCacheInvalidateConsumer consumes this lane and SCAN+DELs the brand's
 * `${brandId}:*` serving-cache keys — so a Gold rewrite busts stale Redis entries NOW instead
 * of waiting out the per-metric TTL (TTL remains the correctness safety net).
 *
 * SCOPE: one event per active brand with affected_scope.all=true — a refresh-loop Phase-2 pass
 * rewrites the brand's whole BI Gold surface, so the honest scope is "everything for this brand".
 * GOLD_PRODUCT names the batch for observability; a per-mart producer can later emit narrower
 * key_prefixes scopes (the consumer already supports them) without touching this job.
 *
 * FAIL-OPEN: cache busting is an optimization. The caller treats a non-zero exit as a warning,
 * never a refresh-cycle failure. Tenant isolation: brand_id is the partition key AND leads every
 * cache key the consumer evicts (cross-brand bust = P0 isolation breach — guarded consumer-side).
 *
 * IDEMPOTENCY: event_id is deterministic on (brand_id, product, correlation_id) — the refresh
 * loop exports one V4_CORRELATION_ID per cycle, so a retried publish re-emits identical events.
 */
import { createHash } from 'node:crypto';
import { Kafka } from 'kafkajs';
import pg from 'pg';
import {
  buildTopic,
  GoldRewrittenEventSchema,
  GOLD_REWRITTEN_V1_TOPIC_SUFFIX,
  GOLD_REWRITTEN_V1_EVENT_NAME,
} from '@brain/contracts';
import { log } from '../../log.js';

// intentional raw: same distinct fallback chain as the sibling journey-stitch-export job.
const PG_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (same as the repull jobs).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
/** Batch label for the rewritten product (observability; scope.all busts the whole brand). */
const GOLD_PRODUCT = process.env['GOLD_PRODUCT'] ?? 'gold_bi_batch';

/** Deterministic UUID (v5-like SHA-256) — same scheme as CacheInvalidatePublisher. */
function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex');
  const h = hex.slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

export interface GoldRewrittenPublishResult {
  brands: number;
  published: number;
}

export async function runGoldRewrittenPublish(): Promise<GoldRewrittenPublishResult> {
  const correlationId =
    process.env['V4_CORRELATION_ID'] ?? deterministicUuid(`gold-rewritten||${new Date().toISOString()}`);
  const pgPool = new pg.Pool({ connectionString: PG_URL, max: 2 });
  const kafka = new Kafka({ clientId: 'gold-rewritten-publish', brokers: BROKERS, retry: { retries: 5 } });
  const producer = kafka.producer();
  try {
    const brandRes = await pgPool.query<{ id: string }>('SELECT id FROM list_active_brand_ids()');
    const brandIds = brandRes.rows.map((r) => r.id);
    if (brandIds.length === 0) {
      log.info('[gold-rewritten-publish] no active brands — nothing to publish');
      return { brands: 0, published: 0 };
    }

    const topic = buildTopic(ENV, GOLD_REWRITTEN_V1_TOPIC_SUFFIX);
    const occurredAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const envelopes = brandIds.map((brandId) => ({
      schema_version: '1' as const,
      event_id: deterministicUuid(`${brandId}||gold-rewritten||${GOLD_PRODUCT}||${correlationId}`),
      brand_id: brandId,
      correlation_id: correlationId,
      event_name: GOLD_REWRITTEN_V1_EVENT_NAME,
      occurred_at: occurredAt,
      producer: 'stream-worker',
      partition_key: brandId, // tenant-first (I-S01)
      source: 'v4-refresh-loop',
      schema_name: GOLD_REWRITTEN_V1_EVENT_NAME,
      payload: {
        gold_product: GOLD_PRODUCT,
        layer: 'gold' as const,
        snapshot_id: null,
        rows_written: null,
        affected_scope: { all: true, keys: [] as string[], key_prefixes: [] as string[] },
      },
    }));

    // Drift guard: validate against the contract before produce (never publish junk).
    const valid = envelopes.filter((env) => {
      const r = GoldRewrittenEventSchema.safeParse(env);
      if (!r.success) {
        log.error('[gold-rewritten-publish] envelope failed contract validation — skipped', {
          brand_id: env.brand_id,
          issues: r.error.issues,
        });
        return false;
      }
      return true;
    });
    if (valid.length === 0) return { brands: brandIds.length, published: 0 };

    await producer.connect();
    await producer.send({
      topic,
      messages: valid.map((env) => ({
        key: env.brand_id,
        value: Buffer.from(JSON.stringify(env)),
        headers: {
          correlation_id: Buffer.from(correlationId),
          event_name: Buffer.from(GOLD_REWRITTEN_V1_EVENT_NAME),
        },
      })),
    });
    log.info('[gold-rewritten-publish] gold.rewritten events published', {
      topic,
      brand_count: valid.length,
      gold_product: GOLD_PRODUCT,
      correlation_id: correlationId,
    });
    return { brands: brandIds.length, published: valid.length };
  } finally {
    await producer.disconnect().catch(() => {});
    await pgPool.end();
  }
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  runGoldRewrittenPublish()
    .then((r) => {
      log.info(`[gold-rewritten-publish] done — ${r.published}/${r.brands} brand event(s) published`);
      process.exit(0);
    })
    .catch((err) => {
      log.error('[gold-rewritten-publish] fatal (fail-open — serving cache falls back to TTL expiry)', { err });
      process.exit(1);
    });
}
