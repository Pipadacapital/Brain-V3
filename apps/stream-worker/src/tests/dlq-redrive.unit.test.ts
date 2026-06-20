/**
 * dlq-redrive.unit.test.ts — P2.2: the redrive decision logic + report (pure, no broker).
 *
 * Covers the correctness-critical pieces of DlqRedriver:
 *   • routing: republish target comes from x-dlq-original-topic, falling back to stripping ".dlq".
 *   • loop guard: a message at/above max-redrive is EXHAUSTED (parked), never republished.
 *   • count bump: x-redrive-count increments by exactly one each pass.
 *   • reason filter: only messages whose x-dlq-reason contains the substring are redriven.
 *   • header rewrite: forensic headers preserved; redrive-count/ts/from stamped.
 *   • CLI arg parsing: .dlq suffix enforced; flags parsed.
 */
import { describe, it, expect } from 'vitest';
import type { IHeaders } from 'kafkajs';
import {
  decideRedrive,
  buildRedriveHeaders,
  headerString,
  H_ORIGINAL_TOPIC,
  H_DLQ_REASON,
  H_REDRIVE_COUNT,
  H_REDRIVE_TS,
  H_REDRIVE_FROM,
  DEFAULT_MAX_REDRIVE,
} from '../infrastructure/kafka/DlqRedriver.js';
import { parseArgs, formatReport } from '../jobs/dlq-redrive/run.js';

const h = (o: Record<string, string>): IHeaders =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));

describe('decideRedrive (P2.2 loop guard + routing)', () => {
  it('routes to the stamped original topic', () => {
    const d = decideRedrive('dev.collector.event.v1.dlq', h({ [H_ORIGINAL_TOPIC]: 'dev.collector.event.v1' }), 3);
    expect(d.action).toBe('redrive');
    expect(d.targetTopic).toBe('dev.collector.event.v1');
  });

  it('falls back to stripping .dlq when the original-topic header is absent', () => {
    const d = decideRedrive('dev.collector.event.v1.dlq', undefined, 3);
    expect(d.action).toBe('redrive');
    expect(d.targetTopic).toBe('dev.collector.event.v1');
  });

  it('EXHAUSTS (parks) a message whose redrive-count has reached max — loop guard', () => {
    const at = decideRedrive('t.dlq', h({ [H_REDRIVE_COUNT]: '3' }), 3);
    expect(at.action).toBe('exhausted');
    const over = decideRedrive('t.dlq', h({ [H_REDRIVE_COUNT]: '9' }), 3);
    expect(over.action).toBe('exhausted');
  });

  it('redrives a message still under the ceiling and bumps the count by one', () => {
    const d = decideRedrive('t.dlq', h({ [H_REDRIVE_COUNT]: '2' }), 3);
    expect(d.action).toBe('redrive');
    expect(d.currentCount).toBe(2);
    expect(d.nextCount).toBe(3);
  });

  it('treats a missing/garbage redrive-count as zero (first redrive)', () => {
    expect(decideRedrive('t.dlq', undefined, 3).nextCount).toBe(1);
    expect(decideRedrive('t.dlq', h({ [H_REDRIVE_COUNT]: 'nonsense' }), 3).nextCount).toBe(1);
  });

  it('reason filter: skips messages whose reason does not contain the substring', () => {
    const reason = h({ [H_DLQ_REASON]: 'max_retry_exceeded: ECONNREFUSED postgres' });
    expect(decideRedrive('t.dlq', reason, 3, 'postgres').action).toBe('redrive');
    expect(decideRedrive('t.dlq', reason, 3, 'starrocks').action).toBe('filtered');
  });

  it('a reason-filtered message is NOT counted against the loop guard', () => {
    // filtered takes precedence over exhausted: an operator targeting one failure class should not
    // accidentally "use up" the redrive budget of unrelated parked messages.
    const d = decideRedrive('t.dlq', h({ [H_REDRIVE_COUNT]: '9', [H_DLQ_REASON]: 'foo' }), 3, 'bar');
    expect(d.action).toBe('filtered');
  });
});

describe('buildRedriveHeaders (P2.2 forensic chain)', () => {
  it('preserves forensic headers and stamps redrive metadata', () => {
    const src = h({
      [H_ORIGINAL_TOPIC]: 'dev.collector.event.v1',
      [H_DLQ_REASON]: 'max_retry_exceeded: boom',
      'x-dlq-ts': '2026-06-19T00:00:00.000Z',
    });
    const out = buildRedriveHeaders(src, 2, 'dev.collector.event.v1.dlq', '2026-06-20T01:02:03.000Z');
    expect(headerString(out, H_ORIGINAL_TOPIC)).toBe('dev.collector.event.v1');
    expect(headerString(out, H_DLQ_REASON)).toBe('max_retry_exceeded: boom');
    expect(headerString(out, H_REDRIVE_COUNT)).toBe('2');
    expect(headerString(out, H_REDRIVE_TS)).toBe('2026-06-20T01:02:03.000Z');
    expect(headerString(out, H_REDRIVE_FROM)).toBe('dev.collector.event.v1.dlq');
  });

  it('headerString tolerates Buffer[], string, and undefined', () => {
    expect(headerString({ a: [Buffer.from('x')] }, 'a')).toBe('x');
    expect(headerString({ a: 'y' } as unknown as IHeaders, 'a')).toBe('y');
    expect(headerString(undefined, 'a')).toBeUndefined();
    expect(headerString({}, 'missing')).toBeUndefined();
  });
});

describe('dlq-redrive CLI (P2.2)', () => {
  it('requires --topic and enforces the .dlq suffix (refuses to drain a live topic)', () => {
    expect(() => parseArgs([])).toThrow(/--topic/);
    expect(() => parseArgs(['--topic', 'dev.collector.event.v1'])).toThrow(/\.dlq/);
  });

  it('parses flags with sane defaults', () => {
    const a = parseArgs(['--topic', 'dev.collector.event.v1.dlq']);
    expect(a.maxRedrive).toBe(DEFAULT_MAX_REDRIVE);
    expect(a.dryRun).toBe(false);
    expect(a.idleMs).toBe(5000);
    const b = parseArgs(['--topic', 'x.dlq', '--max-redrive', '5', '--limit', '100', '--reason', 'pg', '--dry-run']);
    expect(b.maxRedrive).toBe(5);
    expect(b.limit).toBe(100);
    expect(b.reason).toBe('pg');
    expect(b.dryRun).toBe(true);
  });

  it('formatReport surfaces the operator-facing summary (the stakeholder UI for this slice)', () => {
    const out = formatReport(
      { topic: 'x.dlq', maxRedrive: 3, dryRun: true, idleMs: 5000, group: 'g' },
      { scanned: 10, redriven: 7, exhausted: 2, filtered: 1, errors: 0, byTargetTopic: { 'dev.collector.event.v1': 7 } },
    );
    expect(out).toContain('DRY RUN');
    expect(out).toContain('scanned        : 10');
    expect(out).toContain('exhausted      : 2');
    expect(out).toContain('dev.collector.event.v1 ← 7');
  });
});
