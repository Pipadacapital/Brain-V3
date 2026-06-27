/**
 * KafkaIdentityEventPublisher (adapter) — unit + contract tests with a FAKE producer (no broker).
 *
 * Asserts the wire behaviour:
 *   - produces to '{env}.identity.{event}.v1' with partition key = brand_id,
 *   - the produced envelope VALIDATES against IDENTITY_EVENT_SCHEMAS (doc-07 widened envelope),
 *   - producer/partition_key/source/schema_name/causation_id are set; partition_key == brand_id,
 *   - event_id is DETERMINISTIC (same prepared event → same event_id across publishes → idempotent),
 *   - FAIL-OPEN: a producer.send rejection does NOT throw (logged + continue),
 *   - empty events → no produce.
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Producer } from 'kafkajs';
import { IDENTITY_EVENT_SCHEMAS } from '@brain/contracts';
import {
  KafkaIdentityEventPublisher,
  deterministicEventId,
  type IdentityPublisherLog,
} from './KafkaIdentityEventPublisher.js';
import { buildIdentityEvents } from '../../domain/identity/IdentityEventPublisher.js';
import type { ExtractedIdentifier, ResolveOutcome } from '../../domain/identity/IdentityResolver.js';

const BRAND = randomUUID();
const BRAIN_A = randomUUID();
const hex = (c: string): string => c.repeat(64);

const log: IdentityPublisherLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Fake KafkaJS producer that records every send. */
function fakeProducer(opts?: { fail?: boolean }) {
  const sent: Array<{ topic: string; messages: Array<{ key?: unknown; value?: unknown; headers?: unknown }> }> = [];
  const send = vi.fn(async (rec: { topic: string; messages: Array<{ key?: unknown; value?: unknown; headers?: unknown }> }) => {
    if (opts?.fail) throw new Error('broker down');
    sent.push(rec);
    return [];
  });
  return { producer: { send } as unknown as Producer, sent, send };
}

const mintedIds: ExtractedIdentifier[] = [{ type: 'email', hash: hex('a'), tier: 'strong', confidence: 'high' }];
const mintedOutcome: ResolveOutcome = {
  action: 'minted',
  brainId: BRAIN_A,
  newLinks: mintedIds,
  phoneGuardUpdates: [],
  routeToReview: false,
  contactPiiWrites: [],
};
const prepared = buildIdentityEvents(BRAND, mintedOutcome, mintedIds);

describe('KafkaIdentityEventPublisher', () => {
  it('produces to {env}.identity.minted.v1 with partition key = brand_id', async () => {
    const { producer, sent } = fakeProducer();
    const pub = new KafkaIdentityEventPublisher(producer, 'dev', log);
    await pub.publish(BRAND, prepared, { correlationId: 'corr-1', causationId: randomUUID() });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe('dev.identity.minted.v1');
    expect(sent[0]!.messages[0]!.key).toBe(BRAND);
  });

  it('the produced envelope validates against the contract schema', async () => {
    const { producer, sent } = fakeProducer();
    const pub = new KafkaIdentityEventPublisher(producer, 'prod', log);
    await pub.publish(BRAND, prepared, { correlationId: 'corr-1' });

    const envelope = JSON.parse((sent[0]!.messages[0]!.value as Buffer).toString('utf8'));
    expect(envelope.partition_key).toBe(BRAND);
    expect(envelope.producer).toBe('stream-worker');
    expect(envelope.source).toBe('identity-resolver');
    expect(envelope.schema_name).toBe('identity.minted');
    expect(IDENTITY_EVENT_SCHEMAS['identity.minted'].safeParse(envelope).success).toBe(true);
  });

  it('event_id is deterministic across publishes (idempotent replay)', async () => {
    const a = fakeProducer();
    const b = fakeProducer();
    await new KafkaIdentityEventPublisher(a.producer, 'dev', log).publish(BRAND, prepared);
    await new KafkaIdentityEventPublisher(b.producer, 'dev', log).publish(BRAND, prepared);

    const envA = JSON.parse((a.sent[0]!.messages[0]!.value as Buffer).toString('utf8'));
    const envB = JSON.parse((b.sent[0]!.messages[0]!.value as Buffer).toString('utf8'));
    expect(envA.event_id).toBe(envB.event_id);
    expect(envA.event_id).toBe(deterministicEventId(BRAND, 'identity.minted', BRAIN_A));
  });

  it('FAIL-OPEN: a produce error does not throw (logged + continue)', async () => {
    const { producer } = fakeProducer({ fail: true });
    const errLog: IdentityPublisherLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const pub = new KafkaIdentityEventPublisher(producer, 'dev', errLog);
    await expect(pub.publish(BRAND, prepared)).resolves.toBeUndefined();
    expect(errLog.error).toHaveBeenCalled();
  });

  it('empty events → no produce', async () => {
    const { producer, send } = fakeProducer();
    await new KafkaIdentityEventPublisher(producer, 'dev', log).publish(BRAND, []);
    expect(send).not.toHaveBeenCalled();
  });
});
