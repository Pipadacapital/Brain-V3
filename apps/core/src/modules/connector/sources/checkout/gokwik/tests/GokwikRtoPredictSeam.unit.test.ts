/**
 * GoKwik RTO-Predict seam unit tests — honest 'not connected' guard + interface contract.
 *
 * GK-1: NotConnectedRtoPredictClient always throws RtoPredictNotConnectedError
 * GK-2: CaptureRtoPredictCommand returns { connected: false } when connector not configured
 * GK-3: RtoPredictNotConnectedError carries the correct code and brand_id in message
 * GK-4: CaptureRtoPredictCommand calls producer.send on successful prediction (mock client)
 * GK-5: CaptureRtoPredictCommand — risk_flag is categorical; numeric score NEVER appears
 * GK-6: CaptureRtoPredictCommand propagates unexpected errors (not swallowed as 'not connected')
 *
 * All tests use fixtures/mocks only — no live GoKwik API calls.
 * GoKwik partner credentials are an EXTERNAL BLOCKER; this seam is the interface boundary.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Producer } from 'kafkajs';
import type { IRtoPredictClient, RtoPredictRequest, RtoPredictResponse } from '../domain/IRtoPredictClient.js';
import { RtoPredictNotConnectedError } from '../domain/IRtoPredictClient.js';
import { NotConnectedRtoPredictClient } from '../infrastructure/NotConnectedRtoPredictClient.js';
import { CaptureRtoPredictCommand } from '../application/commands/CaptureRtoPredictCommand.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const BRAND_A = 'bbbb0000-0000-4000-8000-000000000001';

// ── Producer mock ─────────────────────────────────────────────────────────────

function makeMockProducer() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as Producer;
}

// ── Stub live client (fixture — simulates a connected GoKwik response) ─────────

function makeConnectedClient(riskFlag: string = 'High Risk'): IRtoPredictClient {
  return {
    async predict(req: RtoPredictRequest): Promise<RtoPredictResponse> {
      return {
        requestId: req.requestId,
        riskFlag: 'high',
        riskFlagRaw: riskFlag,
        riskReason: 'high-RTO pincode cluster',
        occurredAt: new Date().toISOString(),
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GK-1 / GK-3: NotConnectedRtoPredictClient guard
// ─────────────────────────────────────────────────────────────────────────────

describe('GK: NotConnectedRtoPredictClient — honest guard (never fabricates data)', () => {

  it('GK-1: always throws RtoPredictNotConnectedError — never returns a fabricated prediction', async () => {
    const client = new NotConnectedRtoPredictClient();
    await expect(
      client.predict({ brandId: BRAND_A, orderId: 'ORD-001', requestId: 'req-001' }),
    ).rejects.toBeInstanceOf(RtoPredictNotConnectedError);
  });

  it('GK-3: error carries code=RTO_PREDICT_NOT_CONNECTED and brand_id in message', async () => {
    const client = new NotConnectedRtoPredictClient();
    let caught: unknown;
    try {
      await client.predict({ brandId: BRAND_A, orderId: 'ORD-001', requestId: 'req-001' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RtoPredictNotConnectedError);
    const e = caught as RtoPredictNotConnectedError;
    expect(e.code).toBe('RTO_PREDICT_NOT_CONNECTED');
    expect(e.message).toContain(BRAND_A);
    expect(e.name).toBe('RtoPredictNotConnectedError');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GK-2: CaptureRtoPredictCommand returns { connected: false } when not configured
// ─────────────────────────────────────────────────────────────────────────────

describe('GK: CaptureRtoPredictCommand — not-connected path', () => {

  it('GK-2: returns { connected: false } when connector not configured — never fabricates data', async () => {
    const producer = makeMockProducer();
    const command = new CaptureRtoPredictCommand(
      new NotConnectedRtoPredictClient(),
      producer,
      'collector.live.v1',
    );

    const result = await command.execute({
      brandId: BRAND_A,
      orderId: 'ORD-002',
      correlationId: 'corr-001',
    });

    expect(result.connected).toBe(false);
    if (!result.connected) {
      expect(result.reason).toContain(BRAND_A);
    }

    // Producer MUST NOT be called — no event emitted for a not-connected prediction
    expect(producer.send).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GK-4 / GK-5: CaptureRtoPredictCommand — connected path (fixture client)
// ─────────────────────────────────────────────────────────────────────────────

describe('GK: CaptureRtoPredictCommand — connected path (fixture client)', () => {

  it('GK-4: produces a Kafka event on successful prediction, returns { connected: true, eventId }', async () => {
    const producer = makeMockProducer();
    const command = new CaptureRtoPredictCommand(
      makeConnectedClient('High Risk'),
      producer,
      'collector.live.v1',
    );

    const result = await command.execute({
      brandId: BRAND_A,
      orderId: 'ORD-003',
      correlationId: 'corr-002',
    });

    expect(result.connected).toBe(true);
    if (result.connected) {
      expect(result.eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(result.riskFlag).toBe('high');
    }

    expect(producer.send).toHaveBeenCalledOnce();
    const sendCall = ((producer.send as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown])[0] as {
      messages: Array<{ key: string; value: Buffer; headers: Record<string, Buffer> }>;
    };
    expect(sendCall.messages[0]?.key).toBe(BRAND_A);
  });

  it('GK-5: risk_flag is categorical; no numeric score in the emitted event payload', async () => {
    const producer = makeMockProducer();
    const command = new CaptureRtoPredictCommand(
      makeConnectedClient('Medium'),
      producer,
      'collector.live.v1',
    );

    await command.execute({
      brandId: BRAND_A,
      orderId: 'ORD-004',
      correlationId: 'corr-003',
    });

    const sendCall = ((producer.send as ReturnType<typeof vi.fn>).mock.calls[0] as [unknown])[0] as {
      messages: Array<{ value: Buffer }>;
    };
    const eventJson = sendCall.messages[0]?.value?.toString('utf8') ?? '';

    // No numeric score field anywhere in the event — GoKwik is categorical
    expect(eventJson).not.toMatch(/"(score|probability|risk_score)"\s*:/);
    // risk_flag is a string (categorical closed set)
    const envelope = JSON.parse(eventJson) as { properties: Record<string, unknown> };
    expect(typeof envelope.properties['risk_flag']).toBe('string');
    expect(['high', 'medium', 'low', 'control', 'unknown']).toContain(
      envelope.properties['risk_flag'],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GK-6: Unexpected errors are NOT swallowed as 'not connected'
// ─────────────────────────────────────────────────────────────────────────────

describe('GK: CaptureRtoPredictCommand — unexpected errors propagated', () => {

  it('GK-6: network error from live client is NOT caught as RtoPredictNotConnectedError', async () => {
    const producer = makeMockProducer();
    const networkErrorClient: IRtoPredictClient = {
      async predict(_req: RtoPredictRequest): Promise<RtoPredictResponse> {
        throw new Error('ETIMEDOUT: GoKwik RTO-Predict API unreachable');
      },
    };

    const command = new CaptureRtoPredictCommand(
      networkErrorClient,
      producer,
      'collector.live.v1',
    );

    await expect(
      command.execute({ brandId: BRAND_A, orderId: 'ORD-005', correlationId: 'corr-004' }),
    ).rejects.toThrow('ETIMEDOUT');

    expect(producer.send).not.toHaveBeenCalled();
  });
});
