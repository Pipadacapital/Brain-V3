/**
 * DlqRedriver — P2.2: operator tooling to REDRIVE (replay) dead-lettered messages.
 *
 * The DLQ (DlqProducer, D-7) was a forensic sink only: after MAX_RETRY a message lands in
 * `<topic>.dlq` with its original key/value/headers and is never reprocessed. A transient outage
 * (Postgres failover, StarRocks hiccup, a deploy mid-flight) therefore PARKS otherwise-valid events
 * with manual-only recovery — exactly the kind of silent event loss the product forbids ("no event
 * loss", "support replay, backfill, deduplication, and retries").
 *
 * This drains a `.dlq` topic and republishes each message to its ORIGINAL topic (from the
 * `x-dlq-original-topic` header the producer stamped) so the normal consumer reprocesses it with a
 * fresh retry budget (the message gets a new offset → a new retry-counter scope). Dedup at the
 * Bronze write seam (RedisDedupAdapter) makes replay safe: a message that actually succeeded before
 * being mistaken for poison is idempotent.
 *
 * LOOP GUARD — the one correctness risk of redrive is an infinite DLQ→source→DLQ cycle for a
 * genuinely-poison message. Each redrive increments `x-redrive-count`; once it reaches `maxRedrive`
 * the message is left in the DLQ (counted `exhausted`) and NOT republished. Poison stays parked;
 * transient-failure messages flush on the first pass.
 *
 * The decision logic is factored into PURE functions (decideRedrive / buildRedriveHeaders) so the
 * guard, routing, and header rewrite are unit-tested without a broker.
 */
import type { Kafka, Producer, Consumer, IHeaders } from 'kafkajs';
import { incrementCounter } from '@brain/observability';

/** Default max number of times a single message may be redriven before it is left parked as poison. */
export const DEFAULT_MAX_REDRIVE = 3;

/** Header names (stamped by DlqProducer + this redriver). */
export const H_ORIGINAL_TOPIC = 'x-dlq-original-topic';
export const H_DLQ_REASON = 'x-dlq-reason';
export const H_REDRIVE_COUNT = 'x-redrive-count';
export const H_REDRIVE_TS = 'x-redrive-ts';
export const H_REDRIVE_FROM = 'x-redrive-from';

export type RedriveAction = 'redrive' | 'exhausted' | 'filtered';

export interface RedriveDecision {
  action: RedriveAction;
  /** Topic to republish to (original topic). Only meaningful when action === 'redrive'. */
  targetTopic: string;
  /** The redrive-count this message currently carries (BEFORE this pass). */
  currentCount: number;
  /** The redrive-count to stamp on the republished message (currentCount + 1). */
  nextCount: number;
}

/** Read a single header value as a string, tolerating Buffer | string | Buffer[] | undefined. */
export function headerString(headers: IHeaders | undefined, name: string): string | undefined {
  const v = headers?.[name];
  if (v === undefined || v === null) return undefined;
  const one = Array.isArray(v) ? v[0] : v;
  if (one === undefined) return undefined;
  return Buffer.isBuffer(one) ? one.toString('utf8') : String(one);
}

/**
 * PURE decision: should this DLQ message be redriven, and where to?
 *
 * @param dlqTopic       the topic this message was read FROM (e.g. dev.collector.event.v1.dlq)
 * @param headers        the message headers
 * @param maxRedrive     loop-guard ceiling
 * @param reasonFilter   if set, only redrive messages whose x-dlq-reason CONTAINS this substring
 */
export function decideRedrive(
  dlqTopic: string,
  headers: IHeaders | undefined,
  maxRedrive: number,
  reasonFilter?: string,
): RedriveDecision {
  // Original topic: prefer the stamped header; fall back to stripping a trailing ".dlq".
  const stamped = headerString(headers, H_ORIGINAL_TOPIC);
  const targetTopic = stamped && stamped.length > 0 ? stamped : dlqTopic.replace(/\.dlq$/, '');

  const currentCount = Number.parseInt(headerString(headers, H_REDRIVE_COUNT) ?? '0', 10) || 0;
  const nextCount = currentCount + 1;

  if (reasonFilter && reasonFilter.length > 0) {
    const reason = headerString(headers, H_DLQ_REASON) ?? '';
    if (!reason.includes(reasonFilter)) {
      return { action: 'filtered', targetTopic, currentCount, nextCount };
    }
  }

  if (currentCount >= maxRedrive) {
    return { action: 'exhausted', targetTopic, currentCount, nextCount };
  }

  return { action: 'redrive', targetTopic, currentCount, nextCount };
}

/**
 * PURE: build the headers for the republished message — preserve forensic headers, bump the redrive
 * count, stamp when/where it was redriven from. (Does NOT carry x-dlq-original-topic forward as
 * authoritative-only; it is preserved so a re-DLQ keeps the chain.)
 */
export function buildRedriveHeaders(
  source: IHeaders | undefined,
  nextCount: number,
  fromDlqTopic: string,
  nowIso: string,
): IHeaders {
  const out: IHeaders = {};
  // Preserve the original forensic headers (reason, original-topic, original ts) for the chain.
  for (const k of [H_ORIGINAL_TOPIC, H_DLQ_REASON, 'x-dlq-ts']) {
    const v = headerString(source, k);
    if (v !== undefined) out[k] = Buffer.from(v);
  }
  out[H_REDRIVE_COUNT] = Buffer.from(String(nextCount));
  out[H_REDRIVE_TS] = Buffer.from(nowIso);
  out[H_REDRIVE_FROM] = Buffer.from(fromDlqTopic);
  return out;
}

export interface RedriveReport {
  scanned: number;
  redriven: number;
  exhausted: number;
  filtered: number;
  errors: number;
  /** redriven count broken down by target (original) topic. */
  byTargetTopic: Record<string, number>;
}

export interface RedriveOptions {
  /** Loop-guard ceiling. Default DEFAULT_MAX_REDRIVE. */
  maxRedrive?: number;
  /** Stop after redriving (or scanning) this many messages. Default: drain the whole backlog. */
  limit?: number;
  /** Only redrive messages whose x-dlq-reason contains this substring. */
  reasonFilter?: string;
  /** Report only — never publish. */
  dryRun?: boolean;
  /** Stop once no new message arrives for this long (the backlog is drained). Default 5000ms. */
  idleMs?: number;
  /** Consumer group used to track redrive progress. Default brain.stream-worker.dlq-redrive. */
  groupId?: string;
}

/**
 * Drain a `.dlq` topic, republishing eligible messages to their original topic. One-shot: returns
 * once the backlog is drained (idle) or `limit` is reached, then the caller disconnects.
 */
export class DlqRedriver {
  private readonly consumer: Consumer;
  private readonly producer: Producer;

  constructor(
    kafka: Kafka,
    producer: Producer,
    groupId = 'brain.stream-worker.dlq-redrive',
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {
    this.consumer = kafka.consumer({ groupId });
    this.producer = producer;
  }

  async redrive(dlqTopic: string, opts: RedriveOptions = {}): Promise<RedriveReport> {
    const maxRedrive = opts.maxRedrive ?? DEFAULT_MAX_REDRIVE;
    const idleMs = opts.idleMs ?? 5000;
    const report: RedriveReport = {
      scanned: 0,
      redriven: 0,
      exhausted: 0,
      filtered: 0,
      errors: 0,
      byTargetTopic: {},
    };

    await this.producer.connect();
    await this.consumer.connect();
    // fromBeginning: a fresh group drains the whole backlog; a reused group resumes after the last
    // committed offset (already-redriven messages are not redriven again).
    await this.consumer.subscribe({ topic: dlqTopic, fromBeginning: true });

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const done = new Promise<void>((resolve) => {
      const arm = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(resolve, idleMs);
      };
      arm();
      this.consumer
        .run({
          autoCommit: true,
          eachMessage: async ({ message }) => {
            arm(); // a message arrived → reset the idle timer
            report.scanned += 1;

            const decision = decideRedrive(dlqTopic, message.headers, maxRedrive, opts.reasonFilter);

            if (decision.action === 'filtered') {
              report.filtered += 1;
            } else if (decision.action === 'exhausted') {
              report.exhausted += 1;
              incrementCounter('dlq_redrive_exhausted_total', { target_topic: decision.targetTopic });
            } else if (!opts.dryRun) {
              try {
                await this.producer.send({
                  topic: decision.targetTopic,
                  messages: [
                    {
                      key: message.key ?? undefined,
                      value: message.value,
                      headers: buildRedriveHeaders(
                        message.headers,
                        decision.nextCount,
                        dlqTopic,
                        this.nowIso(),
                      ),
                    },
                  ],
                });
                report.redriven += 1;
                report.byTargetTopic[decision.targetTopic] =
                  (report.byTargetTopic[decision.targetTopic] ?? 0) + 1;
                incrementCounter('dlq_redrive_total', { target_topic: decision.targetTopic });
              } catch {
                report.errors += 1;
                incrementCounter('dlq_redrive_error_total', { target_topic: decision.targetTopic });
              }
            } else {
              // dry-run: would have redriven
              report.redriven += 1;
              report.byTargetTopic[decision.targetTopic] =
                (report.byTargetTopic[decision.targetTopic] ?? 0) + 1;
            }

            if (opts.limit && report.scanned >= opts.limit) {
              if (idleTimer) clearTimeout(idleTimer);
              resolve();
            }
          },
        })
        .catch(() => resolve());
    });

    await done;
    if (idleTimer) clearTimeout(idleTimer);
    await this.consumer.stop().catch(() => {});
    await this.consumer.disconnect().catch(() => {});
    return report;
  }
}
