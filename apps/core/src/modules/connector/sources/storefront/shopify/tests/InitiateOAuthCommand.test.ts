/**
 * InitiateOAuthCommand.test.ts — the Shopify OAuth install URL builder.
 *
 * Focus (HIGH fix): the install URL must request the DEFAULT OFFLINE token — i.e. it must NOT carry
 * grant_options[]=per-user (which issues an ONLINE, user-bound, ~24h-expiry token). Brain's
 * background workers (repull/backfill/webhook delivery) run with no user session, so an online token
 * silently 401s ~24h after connect. Removing grant_options[] is what keeps the connector alive.
 */

import { describe, it, expect } from 'vitest';
import { InitiateOAuthCommand } from '../application/commands/InitiateOAuthCommand.js';
import type { IOAuthStateStore } from '../infrastructure/state/IOAuthStateStore.js';
import type { ISecretsManager } from '@brain/connector-secrets';

class FakeStateStore implements IOAuthStateStore {
  public lastSet: { brandId: string; state: string; ttl: number } | null = null;
  async set(brandId: string, state: string, ttlSeconds: number): Promise<void> {
    this.lastSet = { brandId, state, ttl: ttlSeconds };
  }
  async consumeAndGetBrandId(): Promise<{ brandId: string } | null> {
    return null;
  }
  async peekBrandId(): Promise<{ brandId: string } | null> {
    return null;
  }
}

// secretsManager is unused by execute() (only constructed) — a bare stub satisfies the type.
const fakeSecrets = {} as unknown as ISecretsManager;

const BRAND_ID = 'c07ec701-0a00-4a00-8a00-000000000001';

function build(): { cmd: InitiateOAuthCommand; store: FakeStateStore } {
  const store = new FakeStateStore();
  return { cmd: new InitiateOAuthCommand(fakeSecrets, store), store };
}

describe('InitiateOAuthCommand — offline token (no grant_options[]=per-user)', () => {
  it('install URL omits grant_options[] so Shopify issues the default OFFLINE token', async () => {
    const { cmd } = build();
    const { installUrl } = await cmd.execute({
      brandId: BRAND_ID,
      shopDomain: 'boddactive-com.myshopify.com',
      callbackUrl: 'https://app.example.com/api/v1/connectors/shopify/callback',
      clientId: 'test-client-id',
    });

    const url = new URL(installUrl);
    // The defining assertion: NO online-token request.
    expect(url.searchParams.has('grant_options[]')).toBe(false);
    expect(installUrl).not.toContain('per-user');
  });

  it('install URL still carries the required client_id, scope, redirect_uri, and state', async () => {
    const { cmd, store } = build();
    const { installUrl, state } = await cmd.execute({
      brandId: BRAND_ID,
      shopDomain: 'boddactive-com.myshopify.com',
      callbackUrl: 'https://app.example.com/cb',
      clientId: 'test-client-id',
    });

    const url = new URL(installUrl);
    expect(url.hostname).toBe('boddactive-com.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toContain('read_orders');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(url.searchParams.get('state')).toBe(state);
    // state nonce was persisted server-side, brand-bound (NN-4 / MED-CALLBACK-01).
    expect(store.lastSet?.brandId).toBe(BRAND_ID);
    expect(store.lastSet?.state).toBe(state);
  });
});
