/**
 * SpendLedgerConsumer — KafkaJS consumer for spend.live.v1 → ad_spend_ledger (ADR-AD-6).
 *
 * WIRING CRITICAL (NON-NEGOTIABLE — mirrors SettlementLedgerConsumer MB-4):
 *   This consumer MUST be imported + instantiated + started + stopped in main.ts.
 *   Leaving it unwired is the wired-to-nothing anti-pattern (ORCH-LV-H1/H2 history) — a hard
 *   bounce. The MANDATORY e2e wiring test (spend-ledger-wiring.e2e.test.ts) catches it:
 *   un-wire `await consumer.start()` → poll for ad_spend_ledger row → timeout → RED in CI.
 *
 * Lane design (mirrors SettlementLedgerConsumer exactly):
 *   - Topic:          {env}.collector.event.v1 (the same live topic — NO new topic).
 *   - Consumer group: spend-ledger-bridge (env: SPEND_LEDGER_CONSUMER_GROUP_ID).
 *   - Separate group = independent offset from the other live consumers.
 *
 * Responsibility (NARROW — single concern, spend.live.v1 only):
 *   1. Filter: skip any message whose event_name != 'spend.live.v1' (commit + continue).
 *   2. Map properties → LedgerWriter.writeAdSpend(...). NO join (spend has its own grain).
 *      ROAS (spend ↔ revenue) is computed in the metric engine at READ time — never stored.
 *   3. autoCommit=false — commit only after the confirmed ledger write (or skip).
 *   4. MAX_RETRY=5 → DLQ after retries exhausted.
 *
 * Brand GUC (NN-1): LedgerWriter.writeAdSpend() calls set_config('app.current_brand_id', ...)
 *   before the INSERT. brand_id is from the event envelope (MT-1 — set by the re-pull job
 *   from the SECURITY DEFINER fn result, NEVER from the ad-platform API response).
 *
 * Idempotent (I-ST04): writeAdSpend uses ON CONFLICT DO NOTHING on the dedup key
 *   (brand_id, platform, level, level_id, stat_date) → trailing re-read creates no duplicate.
 */

import { Consumer, Kafka, EachMessagePayload } from 'kafkajs';
import { extractKafkaTraceContext } from '@brain/observability';
import { context } from '@opentelemetry/api';
import { DlqProducer } from '../../infrastructure/kafka/DlqProducer.js';
import type { IRetryCounter } from '../../infrastructure/redis/RetryCounterAdapter.js';
import { LedgerWriter } from '../../infrastructure/pg/LedgerWriter.js';
import { log } from "../../log.js";

const MAX_RETRY = 5;

const SPEND_LIVE_V1 = 'spend.live.v1';

/** Parsed spend event properties from spend.live.v1 (shape from @brain/ad-spend-mapper). */
interface SpendEventProperties {
  source?: string;
  platform?: 'meta' | 'google_ads';
  level?: 'campaign' | 'adset' | 'ad' | 'creative';
  level_id?: string;
  parent_id?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  stat_date?: string;
  spend_minor?: string;
  currency_code?: string;
  impressions?: string | null;
  clicks?: string | null;
  conversions_raw?: Record<string, unknown> | null;
  account_timezone?: string | null;
  occurred_at?: string;
}

export class SpendLedgerConsumer {
  private readonly consumer: Consumer;
  private readonly dlqProducer: DlqProducer;
  /** Durable retry-counter scope (T2-8): `{groupId}:{topic}` — isolates same-topic groups. */
  private readonly retryScope: string;

  constructor(
    private readonly kafka: Kafka,
    private readonly ledgerWriter: LedgerWriter,
    private readonly topic: string,
    private readonly groupId: string,
    /** Durable (Redis) retry counter — survives restarts so a poison message reaches the DLQ (T2-8). */
    private readonly retryCounter: IRetryCounter,
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.dlqProducer = new DlqProducer(kafka);
    this.retryScope = `${groupId}:${topic}`;
  }

  async start(): Promise<void> {
    await this.dlqProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });

    await this.consumer.run({
      autoCommit: false,

      eachMessage: async (payload: EachMessagePayload) => {
        const { topic, partition, message } = payload;
        const offset = message.offset;

        // Resume producer trace context across the Kafka boundary (observability skill).
        const traceCtx = extractKafkaTraceContext(
          (message.headers ?? {}) as Record<string, Buffer | string | undefined>,
        );

        return context.with(traceCtx, async () => {
        try {
          let parsed: Record<string, unknown> | null = null;
          let eventName: string | null = null;
          let brandId: string | undefined;
          let eventId: string | undefined;

          if (message.value) {
            try {
              parsed = JSON.parse(message.value.toString('utf8')) as Record<string, unknown>;
              eventName = typeof parsed['event_name'] === 'string' ? parsed['event_name'] : null;
              brandId = typeof parsed['brand_id'] === 'string' ? parsed['brand_id'] : undefined;
              eventId = typeof parsed['event_id'] === 'string' ? parsed['event_id'] : undefined;
            } catch {
              await this.consumer.commitOffsets([
                { topic, partition, offset: String(Number(offset) + 1) },
              ]);
              log.warn(`JSON parse error partition=${partition} offset=${offset} — skipping`);
              return;
            }
          }

          // Filter: only process spend.live.v1.
          if (eventName !== SPEND_LIVE_V1) {
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            return;
          }

          if (!brandId || !eventId || !parsed) {
            log.warn(`spend.live.v1 missing brand_id or event_id partition=${partition} offset=${offset} — skipping`);
            await this.consumer.commitOffsets([
              { topic, partition, offset: String(Number(offset) + 1) },
            ]);
            return;
          }

          const props = (parsed['properties'] as SpendEventProperties) ?? {};
          const result = await this.processSpendEvent(brandId, eventId, props);

          await this.consumer.commitOffsets([
            { topic, partition, offset: String(Number(offset) + 1) },
          ]);
          await this.retryCounter.reset(this.retryScope, partition, offset);

          log.info(`[spend-ledger] ${result} brand=${brandId} event=${eventId} ` +
                        `partition=${partition} offset=${offset}`);
        } catch (err) {
          const current = await this.retryCounter.increment(this.retryScope, partition, offset);

          log.error(`[spend-ledger] write error (attempt ${current}/${MAX_RETRY}) ` +
                        `partition=${partition} offset=${offset}`, { err: err });

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
              await this.retryCounter.reset(this.retryScope, partition, offset);
              log.warn(`DLQ (max retry) partition=${partition} offset=${offset}`);
            } catch (dlqErr) {
              log.error('DLQ produce failed — not committing offset', { err: dlqErr });
            }
          }

          if (current < MAX_RETRY) {
            throw err;
          }
        }

        }); // end context.with(traceCtx, ...)
      },
    });
  }

  async stop(): Promise<void> {
    await this.consumer.stop();
    await this.consumer.disconnect();
    await this.dlqProducer.disconnect();
  }

  // ── Spend event processing ──────────────────────────────────────────────────

  private async processSpendEvent(
    brandId: string,
    eventId: string,
    props: SpendEventProperties,
  ): Promise<string> {
    const platform = props.platform;
    const level = props.level;
    const levelId = props.level_id;
    const statDate = props.stat_date;

    // Defensive: a spend event MUST carry the dedup grain. Skip (commit) if malformed.
    if (!platform || !level || !levelId || !statDate) {
      log.warn(`spend.live.v1 missing dedup grain brand=${brandId} event=${eventId} — skipping`);
      return 'spend_skipped_malformed';
    }

    const inserted = await this.ledgerWriter.writeAdSpend({
      brandId,
      spendEventId: eventId,        // ADR-AD-5 deterministic id == envelope event_id
      platform,
      level,
      levelId,
      parentId: props.parent_id ?? null,
      campaignId: props.campaign_id ?? null,
      campaignName: props.campaign_name ?? null,
      statDate,
      spendMinor: props.spend_minor ?? '0',
      currencyCode: props.currency_code ?? 'USD',
      impressions: props.impressions ?? null,
      clicks: props.clicks ?? null,
      conversionsRaw: props.conversions_raw ?? null,
      accountTimezone: props.account_timezone ?? null,
      rawEventId: eventId,
      occurredAt: props.occurred_at ?? new Date().toISOString(),
    });

    return inserted ? 'ad_spend_written' : 'ad_spend_deduped';
  }
}
