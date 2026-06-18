/**
 * capi-adapter.test.ts — the CAPI channel adapter is DEFAULT-CLOSED by construction
 * (Phase 6, Track B). Mirrors the ses-adapter shape (iface + Dev impl + factory).
 *
 * These prove, WITHOUT a network and WITHOUT real Meta creds:
 *   - DevCapiAdapter.send() returns `would_send_dev` and NEVER fakes `sent`.
 *   - DevCapiAdapter.delete() returns `would_delete_dev` and NEVER fakes `deleted`.
 *   - createCapiAdapter() returns the Dev (default-closed) stub in EVERY case except
 *     env ∈ {production,staging} AND creds resolved AND an access token present.
 *   - The factory NEVER returns a sending adapter when creds/token are absent — the
 *     construction-time analogue of the gate's default-closed posture.
 *
 * NO test here calls graph.facebook.com — the MetaCapiAdapter prod path is exercised
 * only behind real creds (a platform follow-up); the grep-gate test asserts the Meta
 * Graph host appears ONLY in capi-adapter.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  DevCapiAdapter,
  createCapiAdapter,
  type CapiEventPayload,
  type CapiDeletionPayload,
} from '../internal/capi-adapter.js';
import type { CapiCreds } from '../internal/compliance/ports.js';

const EVENT: CapiEventPayload = {
  pixelId: '',
  eventName: 'Purchase',
  eventId: 'c'.repeat(64),
  eventTime: 1718000000,
  actionSource: 'website',
  userData: { em: ['d'.repeat(64)], ph: ['e'.repeat(64)] },
  customData: { value: 1234.56, currency: 'INR' },
  correlationId: 'corr-1',
};

const DELETION: CapiDeletionPayload = {
  pixelId: '',
  userData: { em: ['d'.repeat(64)] },
  correlationId: 'corr-del-1',
};

const CREDS: CapiCreds = {
  pixelId: '1234567890',
  accessTokenRef: 'arn:aws:secretsmanager:ap-south-1:0:secret:meta-capi-token',
};

describe('DevCapiAdapter — default-closed stub (no network, never fakes a send)', () => {
  it('send() returns would_send_dev, never sent', async () => {
    const r = await new DevCapiAdapter().send(EVENT);
    expect(r.status).toBe('would_send_dev');
    // never a real Meta trace id (nothing was sent).
    expect(r.fbtraceId).toBeUndefined();
  });

  it('delete() returns would_delete_dev, never deleted', async () => {
    const r = await new DevCapiAdapter().delete(DELETION);
    expect(r.status).toBe('would_delete_dev');
    expect(r.fbtraceId).toBeUndefined();
  });
});

describe('createCapiAdapter — default-closed by construction', () => {
  it('dev env + no creds → Dev stub (would_send_dev)', async () => {
    const a = createCapiAdapter('development', null);
    expect(await a.send(EVENT)).toMatchObject({ status: 'would_send_dev' });
  });

  it('dev env + creds present → STILL Dev stub (never sends outside prod)', async () => {
    const a = createCapiAdapter('development', CREDS, 'token-value');
    expect(await a.send(EVENT)).toMatchObject({ status: 'would_send_dev' });
  });

  it('production env + NO creds → Dev stub (unknown creds = default-closed)', async () => {
    const a = createCapiAdapter('production', null);
    expect(await a.send(EVENT)).toMatchObject({ status: 'would_send_dev' });
  });

  it('production env + creds but NO access token → Dev stub (token absent = default-closed)', async () => {
    const a = createCapiAdapter('production', CREDS /* no accessToken */);
    expect(await a.send(EVENT)).toMatchObject({ status: 'would_send_dev' });
  });

  it('production env + creds + access token → the sending (Meta) adapter is constructed', async () => {
    // We do NOT call send() (no network in CI) — we only assert the factory selected a
    // DIFFERENT adapter than the Dev stub when, and ONLY when, ALL prod conditions hold.
    const prod = createCapiAdapter('production', CREDS, 'token-value');
    const dev = new DevCapiAdapter();
    expect(prod.constructor.name).not.toBe(dev.constructor.name);
    expect(prod.constructor.name).toBe('MetaCapiAdapter');
  });

  it('staging env + creds + access token → the sending adapter (same prod-like rule)', async () => {
    const a = createCapiAdapter('staging', CREDS, 'token-value');
    expect(a.constructor.name).toBe('MetaCapiAdapter');
  });
});
