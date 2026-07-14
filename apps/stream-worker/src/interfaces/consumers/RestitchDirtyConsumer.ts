/**
 * SPEC: A.2.3.5 (WA-18, AMD-08) — RestitchDirtyConsumer: the event-driven re-stitch hand-off.
 *
 * Consumes the identity map-mutation lane — identity.{minted,linked,merged,unmerged}.v1 (AMD-08 R1: the
 * live {env}.identity.*.v1 lane IS the spec's `identity.map.changed.v1`; IdentityChangeRecomputeConsumer
 * is the wiring template). For every mutation it marks the affected (brand_id, identifier_hash | brain_id)
 * keys DIRTY in ops.restitch_pending. The Spark stitch job (silver_session_identity.py) drains the set
 * each run, re-evaluates the matching historical sessions within the attribution lookback, and clears the
 * drained rows AFTER its MERGE commits (crash-safe). This lifts PAST journeys — the A.2.3(5) / A.5.5
 * "day-7 identification stitches day-1 sessions within one incremental run" behavior.
 *
 * SEPARATE consumer group (not the recompute consumer's): the two responsibilities differ — recompute
 * marks Gold marts dirty for merge/suppress; this marks SESSIONS dirty for re-stitch on link/merge/
 * unmerge/mint. One shared lane, independent offsets (AMD-08 "consumers subscribe to N topics").
 *
 * FLAG GATE (§0.5): per-brand `stitch.v2` (fail-closed, DEFAULT OFF). A mutation for a brand whose flag is
 * OFF is consumed and SKIPPED — nothing is enqueued. So with every brand default-OFF the dirty set stays
 * EMPTY, the Spark drain no-ops, and golden outputs are byte-identical (A.5.8). Keeps the set BOUNDED:
 * off-brand mutations never accumulate rows the drain would never claim.
 *
 * OFFSET DISCIPLINE (D-7, mirrors IdentityChangeRecomputeConsumer): commit ONLY after the PG dirty write
 * returns without throwing. On write error: do NOT commit; increment the durable (Redis) retry counter;
 * DLQ after MAX_RETRY=5. A skip (flag OFF / no dirty keys / unknown event) commits immediately. An
 * unparseable / contract-invalid record goes straight to the DLQ (no retry helps).
 *
 * TENANT ISOLATION: the group is brand-agnostic but every enqueued row carries brand_id FIRST from the
 * event envelope (I-S01). No cross-brand mixing.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import {
  IdentityMintedEventSchema,
  IdentityLinkedEventSchema,
  IdentityMergedEventSchema,
  IdentityUnmergedEventSchema,
} from '@brain/contracts';
import {
  mintedToDirty,
  linkedToDirty,
  mergedToDirty,
  unmergedToDirty,
  type RestitchDirtyEntry,
} from '../../domain/identity/RestitchDirty.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

const MAX_RETRY = 5;
const STITCH_V2_FLAG = 'stitch.v2' as const;

// ── Ports (injected — testable without real infrastructure) ────────────────────

/** The port for persisting dirty entries to ops.restitch_pending. Impl: PgRestitchDirtyRepository. */
export interface IRestitchDirtyRepository {
  /** Idempotent upsert of the brand-first dirty entries (PK brand_id+dirty_kind+dirty_key). */
  markDirty(entries: RestitchDirtyEntry[]): Promise<void>;
}

/**
 * Narrow per-brand flag port — the composition root injects the shared @brain/platform-flags FlagService
 * (structurally assignable). Fail-closed DEFAULT-OFF is the service's own guarantee.
 */
export interface IStitchFlagGate {
  isFlagEnabled(brandId: string, flag: typeof STITCH_V2_FLAG): Promise<boolean>;
}

// ── Per-message outcome ─────────────────────────────────────────────────────────

export type RestitchOutcome =
  | { outcome: 'marked'; brandId: string; triggerEvent: string; keyCount: number }
  | { outcome: 'skipped'; brandId?: string; eventName?: string; reason: string }
  | { outcome: 'invalid'; reason: string };

// ── Consumer ─────────────────────────────────────────────────────────────────────

export class RestitchDirtyConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;

  constructor(
    private readonly kafka: Kafka,
    private readonly repository: IRestitchDirtyRepository,
    private readonly flags: IStitchFlagGate,
    /** All identity.* map-mutation topics (env-prefixed, e.g. 'dev.identity.linked.v1'). */
    private readonly topics: string[],
    private readonly groupId: string,
    private readonly retryCounter: IRetryCounter,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
  }

  /**
   * Per-message logic, extracted for unit-testability.
   *   - 'marked'  : flag ON + ≥1 dirty key + PG write succeeded.
   *   - 'skipped' : flag OFF, or an event with no re-stitch keys, or an unknown event_name.
   *   - 'invalid' : unparseable / contract-violating (→ DLQ).
   *   - THROWS if the PG write throws (→ retry path, offset not committed).
   */
  async processMessage(rawValue: Buffer | null): Promise<RestitchOutcome> {
    if (!rawValue || rawValue.length === 0) {
      return { outcome: 'invalid', reason: 'null_or_empty_message' };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawValue.toString('utf8'));
    } catch {
      return { outcome: 'invalid', reason: 'json_parse_error' };
    }

    const rec = raw as Record<string, unknown>;
    const eventName = rec['event_name'] as string | undefined;
    const brandId = rec['brand_id'] as string | undefined;

    // Parse + map by event_name. Each arm returns the brand-first dirty entries for that mutation.
    let entries: RestitchDirtyEntry[] | null = null;
    if (eventName === 'identity.minted') {
      const p = IdentityMintedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.minted' };
      entries = mintedToDirty(p.data);
    } else if (eventName === 'identity.linked') {
      const p = IdentityLinkedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.linked' };
      entries = linkedToDirty(p.data);
    } else if (eventName === 'identity.merged') {
      const p = IdentityMergedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.merged' };
      entries = mergedToDirty(p.data);
    } else if (eventName === 'identity.unmerged') {
      const p = IdentityUnmergedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.unmerged' };
      entries = unmergedToDirty(p.data);
    } else {
      // identity.suppressed / identity.review_queued / anything else → not a re-stitch trigger.
      return { outcome: 'skipped', brandId, eventName, reason: 'not_a_restitch_trigger' };
    }

    const eventBrandId = entries[0]?.brand_id ?? brandId;
    if (!eventBrandId) {
      return { outcome: 'skipped', eventName, reason: 'no_brand_id' };
    }

    // FLAG GATE — per-brand stitch.v2 (fail-closed, DEFAULT OFF). OFF → do not enqueue (bounded, A.5.8).
    const on = await this.flags.isFlagEnabled(eventBrandId, STITCH_V2_FLAG);
    if (!on) {
      return { outcome: 'skipped', brandId: eventBrandId, eventName, reason: 'stitch_v2_off' };
    }

    if (entries.length === 0) {
      // e.g. an idempotent re-link that carried no identifier hashes.
      return { outcome: 'skipped', brandId: eventBrandId, eventName, reason: 'no_dirty_keys' };
    }

    // Durable dirty write — FAIL-CLOSED. Throws on error → consumer retries → DLQ after 5.
    await this.repository.markDirty(entries);

    return { outcome: 'marked', brandId: eventBrandId, triggerEvent: eventName, keyCount: entries.length };
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    for (const topic of this.topics) {
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }

    await this.consumer.run({
      autoCommit: false,
      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;
        // Include the topic in the retry scope: the same partition number exists across all subscribed
        // topics, so without it retries from different topics would collide (recompute-consumer rule).
        const retryScope = `${this.groupId}:${topic}`;

        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );
        const correlationId = message.headers?.['correlation_id']?.toString();
        const msgLog = correlationId ? log.child({ correlation_id: correlationId }) : log;

        return context.with(traceCtx, async () => {
          try {
            const result = await this.processMessage(message.value);

            if (result.outcome === 'invalid') {
              await this.dlqProducer.send(
                `${topic}.dlq`,
                message.key?.toString() ?? null,
                message.value,
                result.reason,
              );
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              await this.retryCounter.reset(retryScope, partition, offset);
              msgLog.info(
                `[restitch-dirty] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`,
              );
              return;
            }

            // marked | skipped → commit after the confirmed write (or correct skip).
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            await this.retryCounter.reset(retryScope, partition, offset);

            if (result.outcome === 'marked') {
              msgLog.info(
                `[restitch-dirty] marked brand=${result.brandId} trigger=${result.triggerEvent} ` +
                `keys=${result.keyCount} partition=${partition} offset=${offset}`,
              );
            } else {
              msgLog.info(
                `[restitch-dirty] skipped event=${result.eventName ?? 'unknown'} ` +
                `brand=${result.brandId ?? 'unknown'} reason=${result.reason} ` +
                `partition=${partition} offset=${offset}`,
              );
            }
          } catch (err) {
            const current = await this.retryCounter.increment(retryScope, partition, offset);
            msgLog.error(
              `[restitch-dirty] write error (attempt ${current}/${MAX_RETRY}) ` +
              `partition=${partition} offset=${offset}`,
              { err },
            );

            if (current >= MAX_RETRY) {
              try {
                await this.dlqProducer.send(
                  `${topic}.dlq`,
                  message.key?.toString() ?? null,
                  message.value,
                  `max_retry_exceeded: ${String(err)}`,
                );
                await this.consumer.commitOffsets([
                  { topic, partition, offset: String(Number(offset) + 1) },
                ]);
                await this.retryCounter.reset(retryScope, partition, offset);
                msgLog.warn(`[restitch-dirty] DLQ (max retry) partition=${partition} offset=${offset}`);
              } catch (dlqErr) {
                msgLog.error('[restitch-dirty] DLQ produce failed — not committing offset', { err: dlqErr });
              }
            }

            if (current < MAX_RETRY) {
              throw err;
            }
          }
        });
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }
}
