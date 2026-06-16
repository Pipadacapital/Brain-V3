/**
 * ProcessEventUseCase — the core pipeline for Slice 3 (Track A).
 *
 * Pipeline (architecture-plan §2 + §6 Slice 3 acceptance contract):
 *   1. Zod parse (M1-local validate; NOT Apicurio fetch per §3 simplification)
 *   2. Redis SETNX dedup — dedup:{brand_id}:{event_id} EX 604800
 *      → hit (NX fails): return { outcome: 'dedup_hit' }
 *      → miss: proceed
 *   3. Postgres INSERT under brain_app + set_config GUC (D-8)
 *      → unique violation (PK backstop): return { outcome: 'pk_conflict' }
 *      → success: return { outcome: 'written' }
 *
 * Caller (KafkaConsumer) commits offset ONLY after this method returns without
 * throwing (D-7). If this throws, caller must NOT commit — the message will be
 * re-delivered and retried (or routed to DLQ after MAX_RETRY=5).
 *
 * M2 marker: // M2: replace Zod-local validate with Apicurio validateSchemaCompatibility
 */
import { CollectorEventV1Schema } from '@brain/contracts';
import { buildPartitionKey } from '@brain/events';
import { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';
import { BronzeRow } from '../domain/bronze/BronzeRow.js';

export type ProcessOutcome =
  | 'written'       // first sight, successfully inserted to bronze_events
  | 'dedup_hit'     // Redis NX failed — already seen
  | 'pk_conflict'   // PK unique violation — durable second-line dedup
  | 'invalid';      // Zod parse failed — goes to DLQ without retry

export interface ProcessResult {
  outcome: ProcessOutcome;
  brandId?: string;
  eventId?: string;
  reason?: string;
}

export class ProcessEventUseCase {
  constructor(
    private readonly dedup: RedisDedupAdapter,
    private readonly bronze: BronzeRepository,
  ) {}

  /**
   * Process one Kafka message through the full pipeline.
   *
   * @param rawValue - raw Buffer from the Kafka message value
   * @param now - current timestamp (ISO-8601) for ingested_at when not present in envelope
   * @returns ProcessResult describing what happened (caller uses this to decide offset commit)
   */
  async execute(rawValue: Buffer | null, now: string): Promise<ProcessResult> {
    // ── Step 1: Deserialise + Zod validate ───────────────────────────────────
    // M1: local Zod parse (§3 simplification; Apicurio fetch is M2 refinement)
    // M2: replace with Apicurio validateSchemaCompatibility
    if (rawValue == null) {
      return { outcome: 'invalid', reason: 'null message value' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawValue.toString('utf8'));
    } catch {
      return { outcome: 'invalid', reason: 'JSON parse error' };
    }

    const zodResult = CollectorEventV1Schema.safeParse(parsed);
    if (!zodResult.success) {
      return {
        outcome: 'invalid',
        reason: `Zod validation failed: ${JSON.stringify(zodResult.error.issues)}`,
      };
    }

    const event = zodResult.data;
    const { brand_id, event_id, occurred_at, ingested_at, correlation_id, event_name, properties } = event;

    // ── Step 2: Redis dedup (D-3) ─────────────────────────────────────────────
    const dedupResult = await this.dedup.checkAndClaim(brand_id, event_id);
    if (!dedupResult.isFirstSight) {
      // Redis NX failed → duplicate event → commit offset, skip write
      return { outcome: 'dedup_hit', brandId: brand_id, eventId: event_id };
    }

    // ── Step 3: Build BronzeRow ───────────────────────────────────────────────
    const row: BronzeRow = {
      brand_id,
      event_id,
      occurred_at,                              // ISO-8601 string → timestamptz at write (D-6)
      ingested_at: ingested_at ?? now,          // from envelope or fallback to now
      schema_name: 'brain.collector.event.v1', // M1 literal (F-10)
      schema_version: 1,                        // M1 literal; Apicurio-resolved in M2
      event_type: event_name,                   // semantic event type from envelope
      correlation_id,
      partition_key: buildPartitionKey(brand_id, event_id),
      payload: {
        event_name,
        properties: properties ?? {},
        // hashed_user_id and hashed_session_id included if present (no raw PII, I-S02)
        ...(event.hashed_user_id != null ? { hashed_user_id: event.hashed_user_id } : {}),
        ...(event.hashed_session_id != null ? { hashed_session_id: event.hashed_session_id } : {}),
      },
      processing_flags: { dedup_layer: 'redis_nx', stream_worker_ts: now },
      collector_version: null,
    };

    // ── Step 4: Write to bronze_events under brain_app + GUC (D-8) ───────────
    // BronzeRepository handles BEGIN, set_config GUC, INSERT, COMMIT.
    // ON CONFLICT DO NOTHING → writeResult.inserted = false (PK backstop hit).
    const writeResult = await this.bronze.write(row);

    if (!writeResult.inserted) {
      // PK conflict — treat as dedup-hit (durable backstop, §5)
      return { outcome: 'pk_conflict', brandId: brand_id, eventId: event_id };
    }

    return { outcome: 'written', brandId: brand_id, eventId: event_id };
  }
}
