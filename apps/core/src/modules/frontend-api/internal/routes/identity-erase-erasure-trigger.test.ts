/**
 * identity-erase-erasure-trigger.test.ts — AUD-OPS-036/039 (the RTBF erasure-trigger bridge,
 * identity erase-route entry point).
 *
 * Uses the REAL registerIdentityRoutes over Fastify inject with a stub session preHandler +
 * a fake IdentityReader (same style as admin-flags.routes.test.ts). Proves:
 *   1. POST /api/v1/identity/customer/erase publishes the canonical trigger on a REAL erase,
 *      addressed by brain_id (the synchronous path hard-deletes contact_pii, so no raw
 *      email/phone exists to carry) with brand from SESSION (D-1).
 *   2. erased=false (brain_id not found for this brand / cross-brand probe) → NO trigger
 *      (nothing to shred; never a dead event).
 *   3. No publisher wired (pre-bridge construction): response byte-identical, no throw.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { registerIdentityRoutes } from './identity.routes.js';
import type { BffDeps } from './_shared.js';
import type { ErasureEmit, ErasureEventPublisher } from '../../../../infrastructure/events/ErasureEventPublisher.js';

const BRAND = '55555555-5555-4555-8555-555555555555';
const BRAIN_ID = '66666666-6666-4666-8666-666666666666';

function makePublisher(): { publisher: ErasureEventPublisher; emits: ErasureEmit[] } {
  const emits: ErasureEmit[] = [];
  return {
    emits,
    publisher: { emitErasureRequested: vi.fn(async (evt: ErasureEmit) => { emits.push(evt); }) },
  };
}

async function buildApp(opts: {
  publisher?: ErasureEventPublisher;
  erased?: boolean;
}): Promise<{ app: FastifyInstance; eraseCalls: Array<{ brandId: string; brainId: string }> }> {
  const app = Fastify();
  const eraseCalls: Array<{ brandId: string; brainId: string }> = [];
  const identityReader = {
    eraseCustomer: vi.fn(async (brandId: string, brainId: string) => {
      eraseCalls.push({ brandId, brainId });
      return {
        erased: opts.erased ?? true,
        contact_pii_deleted: opts.erased === false ? 0 : 1,
        links_tombstoned: opts.erased === false ? 0 : 1,
      };
    }),
  };
  const deps = {
    // Stub session preHandler: attaches the auth context bffProtectedPreHandler would.
    bffProtectedPreHandler: async (request: FastifyRequest) => {
      (request as FastifyRequest & { auth: unknown }).auth = {
        userId: 'u1',
        jti: 'j1',
        brandId: BRAND,
        workspaceId: 'w1',
        role: 'brand_admin',
      };
    },
    identityReader,
    erasureEventPublisher: opts.publisher,
  } as unknown as BffDeps;
  registerIdentityRoutes(app, deps);
  await app.ready();
  return { app, eraseCalls };
}

async function erase(app: FastifyInstance, brainId: string): Promise<{ statusCode: number }> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/identity/customer/erase',
    payload: { brain_id: brainId },
  });
}

describe('POST /api/v1/identity/customer/erase — erasure-trigger bridge (AUD-OPS-036)', () => {
  it('real erase → synchronous partial erase runs AND the trigger fires, brain_id-addressed, brand from session', async () => {
    const { publisher, emits } = makePublisher();
    const { app, eraseCalls } = await buildApp({ publisher, erased: true });

    const res = await erase(app, BRAIN_ID);
    expect(res.statusCode).toBe(200);

    // Unchanged synchronous partial erase (AUD-OPS-039: keep for immediate UX).
    expect(eraseCalls).toEqual([{ brandId: BRAND, brainId: BRAIN_ID }]);

    // The bridge: one canonical trigger — brain_id only (raw subject already hard-deleted).
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ brandId: BRAND, brainId: BRAIN_ID, source: 'identity.erase' });
    expect(emits[0]!.subjectEmail).toBeUndefined();
    expect(emits[0]!.subjectPhone).toBeUndefined();
    await app.close();
  });

  it('erased=false (unknown/cross-brand brain_id) → 200 but NO trigger (nothing to shred)', async () => {
    const { publisher, emits } = makePublisher();
    const { app } = await buildApp({ publisher, erased: false });

    const res = await erase(app, BRAIN_ID);
    expect(res.statusCode).toBe(200);
    expect(emits).toHaveLength(0);
    await app.close();
  });

  it('no publisher wired (pre-bridge): erase still 200 (response unchanged, no throw)', async () => {
    const { app, eraseCalls } = await buildApp({ erased: true });
    const res = await erase(app, BRAIN_ID);
    expect(res.statusCode).toBe(200);
    expect(eraseCalls).toHaveLength(1);
    await app.close();
  });
});
