/**
 * AnalyticsCacheInvalidateConsumer — consumes cache.invalidate.v1 AND gold.rewritten.v1
 * events and evicts the brand_id-leading Redis keys from the Analytics serving cache.
 *
 * ── FLOW ─────────────────────────────────────────────────────────────────────
 * IdentityChangeRecomputeConsumer
 *   → publishes cache.invalidate.v1 (CacheInvalidatePublisher, FAIL-OPEN)
 * v4-refresh-loop Phase 2 (Gold-batch completion)
 *   → publishes gold.rewritten.v1 (gold-rewritten-publish job, FAIL-OPEN)
 * THIS consumer (both intelligence.* lanes, one consumer group)
 *   → parses the event envelope (CacheInvalidateEventSchema | GoldRewrittenEventSchema —
 *     discriminated by event_name; gold.rewritten carries its scope as payload.affected_scope)
 *   → evicts brand_id-leading Redis keys per the CacheScopeSchema:
 *       scope.all=true       → SCAN `${brandId}:*`  → DEL all matches
 *       scope.key_prefixes   → SCAN `${brandId}:${prefix}*` → DEL for each prefix
 *       scope.keys (exact)   → DEL each key, ONLY if it starts with `${brandId}:`
 *   → commits the Kafka offset after eviction (FAIL-SAFE: eviction errors → log + commit)
 *
 * ── TENANT ISOLATION INVARIANTS ──────────────────────────────────────────────
 * 1. SCAN patterns are ALWAYS prefixed with `${brandId}:` — a SCAN that lacks the
 *    brand_id prefix MUST NOT run (would scan all tenants' keys = P0 isolation breach).
 * 2. Exact-key deletes are gated: a key is ONLY deleted if key.startsWith(`${brandId}:`)
 *    — ignores keys that don't belong to this brand.
 * 3. brand_id comes EXCLUSIVELY from the event envelope (not from user input).
 * 4. An empty or missing brand_id → the message is treated as invalid (no eviction).
 *
 * ── FAIL-SAFE (FAIL-OPEN for eviction) ───────────────────────────────────────
 * Redis eviction failures are non-fatal: the serving cache will become stale until
 * the next TTL expiry or the next Spark recompute cycle's cache.invalidate event.
 * On eviction error: log warn, commit the offset (never retry an eviction failure
 * through the standard retry path — it would DLQ a non-critical cache bust event).
 * On schema validation failure: log warn, commit the offset (malformed event; cannot
 * process; the producer (stream-worker itself) controls the schema).
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────────────
 * Redis DEL on a non-existent key is a no-op. SCAN+DEL on already-evicted keys
 * returns 0 keys found. Re-delivering the same cache.invalidate event is always safe.
 *
 * ── PORT ─────────────────────────────────────────────────────────────────────
 * ICacheEvictionClient is a structural interface so tests can inject a fake without
 * standing up Redis. The concrete ioredis.Redis instance satisfies the interface.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import {
  CacheInvalidateEventSchema,
  CACHE_INVALIDATE_V1_TOPIC_SUFFIX,
  GoldRewrittenEventSchema,
  GOLD_REWRITTEN_V1_TOPIC_SUFFIX,
  GOLD_REWRITTEN_V1_EVENT_NAME,
  buildTopic,
  type CacheScope,
} from '@brain/contracts';
import { log } from '../../log.js';

// ── Redis eviction PORT (structural — no ioredis import) ──────────────────────

/**
 * Minimal Redis eviction port. Structurally compatible with ioredis.Redis.
 * The concrete implementation is the shared ioredis instance from main.ts.
 */
export interface ICacheEvictionClient {
  /**
   * Delete an exact Redis key. Returns the number of keys deleted (0 if not found).
   * Safe to call on non-existent keys (idempotent).
   */
  del(key: string): Promise<number>;

  /**
   * Cursor-based SCAN. Returns [nextCursor, matchedKeys].
   * When nextCursor === '0', the scan is complete.
   * The adapter uses: scan(cursor, 'MATCH', pattern, 'COUNT', batchSize).
   */
  scan(cursor: string, matchArg: string, pattern: string, countArg: string, batchSize: number): Promise<[string, string[]]>;
}

// ── Processing result ──────────────────────────────────────────────────────────

export type CacheInvalidateProcessResult =
  | { outcome: 'evicted'; brandId: string; keysDeleted: number; goldProduct: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'invalid'; reason: string };

// ── Consumer ───────────────────────────────────────────────────────────────────

export class AnalyticsCacheInvalidateConsumer {
  private readonly consumer: Consumer;
  private readonly topics: string[];

  constructor(
    private readonly kafka: Kafka,
    private readonly cacheClient: ICacheEvictionClient,
    /** Kafka env prefix ('dev' | 'prod'). */
    private readonly env: string,
    private readonly groupId: string,
  ) {
    // Both intelligence lanes bust the same brand-scoped serving cache: the explicit
    // cache.invalidate command AND the Gold-batch-completion gold.rewritten signal.
    this.topics = [
      buildTopic(this.env, CACHE_INVALIDATE_V1_TOPIC_SUFFIX),
      buildTopic(this.env, GOLD_REWRITTEN_V1_TOPIC_SUFFIX),
    ];
    this.consumer = kafka.consumer({ groupId });
  }

  /**
   * Process a single cache.invalidate.v1 message value.
   *
   * CONTRACT:
   *   - Returns 'evicted' on successful Redis key eviction (even if 0 keys were found/deleted).
   *   - Returns 'skipped' for events with no eviction scope (e.g. empty scope, no keys to bust).
   *   - Returns 'invalid' for unparseable / contract-violating messages.
   *   - NEVER throws from this method — all errors are caught and reflected in the result.
   *     The caller (eachMessage) commits the offset regardless of outcome because eviction
   *     is FAIL-SAFE (non-fatal errors → warn + commit; no retry/DLQ for cache busts).
   *
   * TENANT SAFETY:
   *   - brandId MUST be a non-empty string; missing → invalid.
   *   - All SCAN patterns MUST start with `${brandId}:` — the guard is enforced here, not by callers.
   *   - Exact-key deletes are skipped unless the key starts with `${brandId}:`.
   */
  async processMessage(rawValue: Buffer | null): Promise<CacheInvalidateProcessResult> {
    if (!rawValue || rawValue.length === 0) {
      return { outcome: 'invalid', reason: 'null_or_empty_message' };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawValue.toString('utf8'));
    } catch {
      return { outcome: 'invalid', reason: 'json_parse_error' };
    }

    // Discriminate by event_name: gold.rewritten.v1 carries its eviction scope as
    // payload.affected_scope; cache.invalidate.v1 as payload.scope. Both normalize to
    // the same (brandId, goldProduct, scope) eviction inputs.
    let brandId: string;
    let goldProduct: string;
    let scope: CacheScope;
    const eventName = (raw as { event_name?: unknown } | null)?.event_name;
    if (eventName === GOLD_REWRITTEN_V1_EVENT_NAME) {
      const parsed = GoldRewrittenEventSchema.safeParse(raw);
      if (!parsed.success) {
        return { outcome: 'invalid', reason: 'schema_validation_failed' };
      }
      brandId = parsed.data.brand_id;
      goldProduct = parsed.data.payload.gold_product;
      scope = parsed.data.payload.affected_scope;
    } else {
      const parsed = CacheInvalidateEventSchema.safeParse(raw);
      if (!parsed.success) {
        return { outcome: 'invalid', reason: 'schema_validation_failed' };
      }
      brandId = parsed.data.brand_id;
      goldProduct = parsed.data.payload.gold_product;
      scope = parsed.data.payload.scope;
    }

    // Tenant isolation guard: brand_id must be a non-empty string.
    if (!brandId || typeof brandId !== 'string' || brandId.trim().length === 0) {
      return { outcome: 'invalid', reason: 'missing_brand_id' };
    }

    let totalDeleted = 0;

    try {
      // ── 1. Exact keys (scope.keys) ─────────────────────────────────────────
      // ONLY delete keys that start with `${brandId}:` — never delete cross-brand keys.
      if (scope.keys.length > 0) {
        for (const key of scope.keys) {
          if (!key.startsWith(`${brandId}:`)) {
            // Cross-brand key guard: skip keys that don't belong to this brand.
            log.warn(
              '[cache-invalidate] scope.keys entry does NOT start with brand_id — skipped (cross-brand guard)',
              { key, brand_id: brandId, gold_product: goldProduct },
            );
            continue;
          }
          const n = await this.cacheClient.del(key);
          totalDeleted += n;
        }
      }

      // ── 2. Key-prefix scans (scope.key_prefixes) ──────────────────────────
      // SCAN pattern: `${brandId}:${prefix}*` — brand_id is always the first segment.
      for (const prefix of scope.key_prefixes) {
        const pattern = `${brandId}:${prefix}*`;
        totalDeleted += await this.scanAndDelete(pattern, brandId);
      }

      // ── 3. Scope.all — evict ALL keys for this brand's product ────────────
      // Pattern: `${brandId}:*` — always brand-scoped (never a bare `*`).
      if (scope.all) {
        const pattern = `${brandId}:*`;
        totalDeleted += await this.scanAndDelete(pattern, brandId);
      }
    } catch (err) {
      // Redis error during eviction — log and return evicted with partial count.
      // Eviction is FAIL-SAFE: the offset will still be committed by the caller.
      log.warn('[cache-invalidate] Redis eviction error (fail-safe — offset will be committed)', {
        brand_id: brandId,
        gold_product: goldProduct,
        err,
      });
      // Return 'evicted' with partial count so the caller commits the offset.
      return { outcome: 'evicted', brandId, keysDeleted: totalDeleted, goldProduct };
    }

    // If all three scope lists were empty and scope.all=false — nothing to evict.
    if (!scope.all && scope.keys.length === 0 && scope.key_prefixes.length === 0) {
      return { outcome: 'skipped', reason: 'empty_scope' };
    }

    return { outcome: 'evicted', brandId, keysDeleted: totalDeleted, goldProduct };
  }

  /**
   * Cursor-based SCAN + DEL for a given pattern.
   * INVARIANT: pattern MUST start with `${brandId}:` — verified by the caller.
   * Returns the total number of keys deleted.
   */
  private async scanAndDelete(pattern: string, brandId: string): Promise<number> {
    // Double-check the brand_id prefix invariant — defence in depth.
    if (!pattern.startsWith(`${brandId}:`)) {
      log.error(
        '[cache-invalidate] INVARIANT VIOLATED: SCAN pattern does not start with brand_id — aborting scan (cross-brand safety)',
        { pattern, brand_id: brandId },
      );
      return 0;
    }

    let cursor = '0';
    let deleted = 0;
    const BATCH_SIZE = 100;

    do {
      const [nextCursor, keys] = await this.cacheClient.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH_SIZE);
      cursor = nextCursor;

      for (const key of keys) {
        // Final cross-brand guard: even inside a SCAN result, skip keys that don't match.
        if (!key.startsWith(`${brandId}:`)) {
          log.error(
            '[cache-invalidate] SCAN returned a key not starting with brand_id — skipped',
            { key, brand_id: brandId, pattern },
          );
          continue;
        }
        const n = await this.cacheClient.del(key);
        deleted += n;
      }
    } while (cursor !== '0');

    return deleted;
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.topics, fromBeginning: false });

    await this.consumer.run({
      // autoCommit: false — we commit manually AFTER each message is processed.
      // Eviction is FAIL-SAFE so we ALWAYS commit, even on Redis error (commit after log).
      autoCommit: false,

      eachMessage: async ({ topic, partition, message }: EachMessagePayload) => {
        const offset = message.offset;

        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;

        return context.with(traceCtx, async () => {
          const result = await this.processMessage(message.value);

          switch (result.outcome) {
            case 'evicted':
              msgLog.info(
                `[cache-invalidate] evicted brand=${result.brandId} product=${result.goldProduct} ` +
                `keys_deleted=${result.keysDeleted} partition=${partition} offset=${offset}`,
              );
              break;
            case 'skipped':
              msgLog.info(
                `[cache-invalidate] skipped reason=${result.reason} ` +
                `partition=${partition} offset=${offset}`,
              );
              break;
            case 'invalid':
              // Invalid → log warn but still commit (malformed message; retry won't help).
              msgLog.warn(
                `[cache-invalidate] invalid message reason=${result.reason} ` +
                `partition=${partition} offset=${offset}`,
              );
              break;
          }

          // ALWAYS commit — eviction is FAIL-SAFE (non-fatal). A DLQ loop for cache busts
          // would create useless retry noise; Redis TTL is the correctness safety net.
          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
        });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
  }
}
