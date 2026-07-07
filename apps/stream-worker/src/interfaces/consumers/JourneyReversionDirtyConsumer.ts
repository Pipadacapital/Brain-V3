/**
 * SPEC: B.2 (WB-B2, AMD-08, AMD-11) — JourneyReversionDirtyConsumer: the event-driven cross-device
 * journey re-version hand-off.
 *
 * Consumes the identity map-mutation lane — identity.{linked,merged,unmerged}.v1 (AMD-08 R1: the live
 * {env}.identity.*.v1 lane IS the spec's `identity.map.changed.v1`; IdentityChangeRecomputeConsumer /
 * RestitchDirtyConsumer are the wiring templates). For every mutation it marks the affected BRAIN_IDS
 * DIRTY (brain grain) in ops.journey_reversion_pending with the re-version CAUSE (merge|unmerge|restitch).
 * The Spark reversion job (gold_journey_events_reversion.py) drains the set each run, rebuilds those
 * brains' journeys as version N+1, writes journey_version_log {brand_id, brain_id, from_version,
 * to_version, cause, at} (AMD-11), and clears the drained rows AFTER its MERGE commits (crash-safe).
 *
 * SEPARATE consumer group from the recompute consumer (Gold-mart dirty) AND the restitch consumer
 * (session dirty): three responsibilities, one shared lane, independent offsets (AMD-08 "consumers
 * subscribe to N topics"). This consumer owns the BRAIN-grain journey dirty set.
 *
 * FLAG GATE (§0.5): per-brand `journey.engine` (fail-closed, DEFAULT OFF). A mutation for a brand whose
 * flag is OFF is consumed and SKIPPED — nothing is enqueued. So with every brand default-OFF the dirty set
 * stays EMPTY, the Spark drain no-ops, and golden journey outputs are byte-identical. Keeps the set
 * BOUNDED: off-brand mutations never accumulate rows the drain would never claim.
 *
 * OFFSET DISCIPLINE (D-7, mirrors RestitchDirtyConsumer): commit ONLY after the PG dirty write returns
 * without throwing. On write error: do NOT commit; increment the durable (Redis) retry counter; DLQ after
 * MAX_RETRY=5. A skip (flag OFF / not a re-version trigger / no dirty keys) commits immediately. An
 * unparseable / contract-invalid record goes straight to the DLQ (no retry helps).
 *
 * TENANT ISOLATION: the group is brand-agnostic but every enqueued row carries brand_id FIRST from the
 * event envelope (I-S01). No cross-brand mixing.
 */
import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import {
  IdentityLinkedEventSchema,
  IdentityMergedEventSchema,
  IdentityUnmergedEventSchema,
} from '@brain/contracts';
import {
  linkedToJourneyDirty,
  mergedToJourneyDirty,
  unmergedToJourneyDirty,
  type JourneyDirtyEntry,
} from '../../domain/journey/JourneyReversionDirty.js';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { log } from '../../log.js';

const MAX_RETRY = 5;
const JOURNEY_ENGINE_FLAG = 'journey.engine' as const;

// ── Ports (injected — testable without real infrastructure) ────────────────────

/** The port for persisting dirty entries to ops.journey_reversion_pending. Impl: PgJourneyReversionDirtyRepository. */
export interface IJourneyReversionDirtyRepository {
  /** Idempotent upsert of the brand-first, brain-grain dirty entries (PK brand_id+brain_id). */
  markDirty(entries: JourneyDirtyEntry[]): Promise<void>;
}

/**
 * Narrow per-brand flag port — the composition root injects the shared @brain/platform-flags FlagService
 * (structurally assignable). Fail-closed DEFAULT-OFF is the service's own guarantee.
 */
export interface IJourneyFlagGate {
  isFlagEnabled(brandId: string, flag: typeof JOURNEY_ENGINE_FLAG): Promise<boolean>;
}

// ── Per-message outcome ─────────────────────────────────────────────────────────

export type JourneyReversionOutcome =
  | { outcome: 'marked'; brandId: string; triggerEvent: string; brainCount: number }
  | { outcome: 'skipped'; brandId?: string; eventName?: string; reason: string }
  | { outcome: 'invalid'; reason: string };

// ── Consumer ─────────────────────────────────────────────────────────────────────

export class JourneyReversionDirtyConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;

  constructor(
    private readonly kafka: Kafka,
    private readonly repository: IJourneyReversionDirtyRepository,
    private readonly flags: IJourneyFlagGate,
    /** All identity.* map-mutation topics (env-prefixed, e.g. 'dev.identity.merged.v1'). */
    private readonly topics: string[],
    private readonly groupId: string,
    private readonly retryCounter: IRetryCounter,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
  }

  /**
   * Per-message logic, extracted for unit-testability.
   *   - 'marked'  : flag ON + >=1 dirty brain + PG write succeeded.
   *   - 'skipped' : flag OFF, or an event that is not a journey re-version trigger (minted / suppressed /
   *                 review_queued), or an event with no brain keys.
   *   - 'invalid' : unparseable / contract-violating (-> DLQ).
   *   - THROWS if the PG write throws (-> retry path, offset not committed).
   */
  async processMessage(rawValue: Buffer | null): Promise<JourneyReversionOutcome> {
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

    // Parse + map by event_name. Each arm returns the brand-first, brain-grain dirty entries.
    let entries: JourneyDirtyEntry[] | null = null;
    if (eventName === 'identity.linked') {
      const p = IdentityLinkedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.linked' };
      entries = linkedToJourneyDirty(p.data);
    } else if (eventName === 'identity.merged') {
      const p = IdentityMergedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.merged' };
      entries = mergedToJourneyDirty(p.data);
    } else if (eventName === 'identity.unmerged') {
      const p = IdentityUnmergedEventSchema.safeParse(raw);
      if (!p.success) return { outcome: 'invalid', reason: 'schema_validation_failed:identity.unmerged' };
      entries = unmergedToJourneyDirty(p.data);
    } else {
      // identity.minted (brand-new brain — no journey yet) / identity.suppressed / identity.review_queued
      // / anything else → not a journey re-version trigger.
      return { outcome: 'skipped', brandId, eventName, reason: 'not_a_reversion_trigger' };
    }

    const eventBrandId = entries[0]?.brand_id ?? brandId;
    if (!eventBrandId) {
      return { outcome: 'skipped', eventName, reason: 'no_brand_id' };
    }

    // FLAG GATE — per-brand journey.engine (fail-closed, DEFAULT OFF). OFF → do not enqueue (bounded).
    const on = await this.flags.isFlagEnabled(eventBrandId, JOURNEY_ENGINE_FLAG);
    if (!on) {
      return { outcome: 'skipped', brandId: eventBrandId, eventName, reason: 'journey_engine_off' };
    }

    if (entries.length === 0) {
      return { outcome: 'skipped', brandId: eventBrandId, eventName, reason: 'no_dirty_keys' };
    }

    // Durable dirty write — FAIL-CLOSED. Throws on error → consumer retries → DLQ after 5.
    await this.repository.markDirty(entries);

    return {
      outcome: 'marked',
      brandId: eventBrandId,
      triggerEvent: eventName,
      brainCount: entries.length,
    };
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
                `[journey-reversion-dirty] DLQ (invalid) partition=${partition} offset=${offset} reason=${result.reason}`,
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
                `[journey-reversion-dirty] marked brand=${result.brandId} trigger=${result.triggerEvent} ` +
                `brains=${result.brainCount} partition=${partition} offset=${offset}`,
              );
            } else {
              msgLog.info(
                `[journey-reversion-dirty] skipped event=${result.eventName ?? 'unknown'} ` +
                `brand=${result.brandId ?? 'unknown'} reason=${result.reason} ` +
                `partition=${partition} offset=${offset}`,
              );
            }
          } catch (err) {
            const current = await this.retryCounter.increment(retryScope, partition, offset);
            msgLog.error(
              `[journey-reversion-dirty] write error (attempt ${current}/${MAX_RETRY}) ` +
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
                msgLog.warn(`[journey-reversion-dirty] DLQ (max retry) partition=${partition} offset=${offset}`);
              } catch (dlqErr) {
                msgLog.error('[journey-reversion-dirty] DLQ produce failed — not committing offset', { err: dlqErr });
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
