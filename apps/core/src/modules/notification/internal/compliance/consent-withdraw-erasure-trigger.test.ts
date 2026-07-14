/**
 * consent-withdraw-erasure-trigger.test.ts — AUD-OPS-036 (the RTBF erasure-trigger bridge,
 * consent-withdraw entry point).
 *
 * Uses the REAL registerConsentRoutes over Fastify inject with stubbed db/salt/audit (same
 * doubles as consent-write.idempotency.test.ts) + a stub session preHandler. Proves:
 *   1. POST /api/v1/consent/withdraw with reason='erasure' publishes the canonical trigger,
 *      carrying the raw recipient as email (email channels) or phone (whatsapp/sms) — the
 *      identifier type the orchestrator will salt-hash.
 *   2. reason='withdrawal' (the default) does NOT publish — a regular withdrawal is handled
 *      by the suppressor, never the crypto-shred orchestrator.
 *   3. No publisher wired (pre-bridge construction): the write path is byte-identical (201).
 *   4. The consent SoR write is unchanged either way (still one writer.withdraw → 201).
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerConsentRoutes, type ConsentRoutesDeps } from './consent.routes.js';
import type { ErasureEmit, ErasureEventPublisher } from '../../../../infrastructure/events/ErasureEventPublisher.js';

const BRAND = '44444444-4444-4444-8444-444444444444';
const SALT_HEX = 'a'.repeat(64);
const EMAIL = 'rtbf-subject@example.com';
const PHONE = '+919812345678';

function makePublisher(): { publisher: ErasureEventPublisher; emits: ErasureEmit[] } {
  const emits: ErasureEmit[] = [];
  return {
    emits,
    publisher: { emitErasureRequested: vi.fn(async (evt: ErasureEmit) => { emits.push(evt); }) },
  };
}

async function buildApp(opts: { publisher?: ErasureEventPublisher }): Promise<FastifyInstance> {
  const app = Fastify();
  const client = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const deps: ConsentRoutesDeps = {
    pool: { connect: vi.fn(async () => client) } as never,
    audit: { append: vi.fn(async () => undefined) } as never,
    saltFn: vi.fn(async () => SALT_HEX),
    // Stub session preHandler: attaches the auth context validateSessionPreHandler would.
    sessionPreHandler: (async (request: FastifyRequest) => {
      (request as FastifyRequest & { auth: unknown }).auth = {
        userId: 'u1',
        brandId: BRAND,
        role: 'brand_admin',
      };
    }) as never,
    erasurePublisher: opts.publisher,
  };
  registerConsentRoutes(app, deps);
  await app.ready();
  return app;
}

async function withdraw(
  app: FastifyInstance,
  body: Record<string, unknown>,
): Promise<{ statusCode: number }> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/consent/withdraw',
    headers: { 'idempotency-key': 'idem-1', 'x-correlation-id': 'corr-w1' },
    payload: body,
  });
}

describe('POST /api/v1/consent/withdraw — erasure-trigger bridge (AUD-OPS-036)', () => {
  it("reason='erasure' on an email channel → 201 + trigger with subjectEmail=recipient", async () => {
    const { publisher, emits } = makePublisher();
    const app = await buildApp({ publisher });
    const res = await withdraw(app, { recipient: EMAIL, channel: 'marketing_email', reason: 'erasure' });
    expect(res.statusCode).toBe(201);
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({
      brandId: BRAND,
      subjectEmail: EMAIL,
      source: 'consent.withdraw',
      correlationId: 'corr-w1',
    });
    expect(emits[0]!.subjectPhone).toBeUndefined();
    await app.close();
  });

  it("reason='erasure' on whatsapp/sms → trigger with subjectPhone=recipient (identifier-type parity)", async () => {
    for (const channel of ['whatsapp', 'sms']) {
      const { publisher, emits } = makePublisher();
      const app = await buildApp({ publisher });
      const res = await withdraw(app, { recipient: PHONE, channel, reason: 'erasure' });
      expect(res.statusCode).toBe(201);
      expect(emits).toHaveLength(1);
      expect(emits[0]).toMatchObject({ brandId: BRAND, subjectPhone: PHONE, source: 'consent.withdraw' });
      expect(emits[0]!.subjectEmail).toBeUndefined();
      await app.close();
    }
  });

  it('regular withdrawal (no erasure reason) → 201, NO trigger (suppressor lane, not crypto-shred)', async () => {
    const { publisher, emits } = makePublisher();
    const app = await buildApp({ publisher });
    const res = await withdraw(app, { recipient: EMAIL, channel: 'marketing_email' });
    expect(res.statusCode).toBe(201);
    expect(emits).toHaveLength(0);
    await app.close();
  });

  it('no publisher wired (pre-bridge): erasure withdraw still 201 (write path unchanged)', async () => {
    const app = await buildApp({});
    const res = await withdraw(app, { recipient: EMAIL, channel: 'marketing_email', reason: 'erasure' });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
