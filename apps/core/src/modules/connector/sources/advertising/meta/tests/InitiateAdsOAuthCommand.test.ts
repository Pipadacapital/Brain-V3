/**
 * Initiate OAuth command tests for the ads connectors (feat-ad-connectors Track 1).
 *
 * Proves both initiate commands:
 *   - generate a 128-bit brand-bound state nonce, store it (consumable once),
 *   - build the correct authorize URL with least-privilege scope,
 *   - request offline access (Google) so a refresh token is issued.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InitiateMetaOAuthCommand, META_GRAPH_API_VERSION } from '../application/commands/InitiateMetaOAuthCommand.js';
import { InitiateGoogleAdsOAuthCommand } from '../../google/application/commands/InitiateGoogleAdsOAuthCommand.js';
import { InProcessOAuthStateStore } from '../../../storefront/shopify/infrastructure/state/InProcessOAuthStateStore.js';

const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const META_CALLBACK = 'https://app.example.com/api/v1/connectors/meta/callback';
const GOOGLE_CALLBACK = 'https://app.example.com/api/v1/connectors/google_ads/callback';

describe('InitiateMetaOAuthCommand', () => {
  beforeEach(() => {
    process.env['META_APP_ID'] = 'test-meta-app-id';
  });

  it('builds a Meta authorize URL with ads_read scope + brand-bound state nonce', async () => {
    const store = new InProcessOAuthStateStore();
    const cmd = new InitiateMetaOAuthCommand(store);
    const result = await cmd.execute({ brandId: BRAND_ID, callbackUrl: META_CALLBACK });

    const url = new URL(result.installUrl);
    expect(url.hostname).toBe('www.facebook.com');
    expect(url.pathname).toContain(META_GRAPH_API_VERSION);
    expect(url.searchParams.get('scope')).toBe('ads_read');
    expect(url.searchParams.get('client_id')).toBe('test-meta-app-id');
    expect(url.searchParams.get('redirect_uri')).toBe(META_CALLBACK);
    expect(url.searchParams.get('state')).toBe(result.state);
    // 128-bit nonce (32 hex chars)
    expect(result.state).toMatch(/^[0-9a-f]{32}$/);

    // The nonce was stored bound to the brand and is single-use.
    const consumed = await store.consumeAndGetBrandId(result.state);
    expect(consumed?.brandId).toBe(BRAND_ID);
    const again = await store.consumeAndGetBrandId(result.state);
    expect(again).toBeNull();
  });

  it('throws when META_APP_ID is not configured', async () => {
    delete process.env['META_APP_ID'];
    const cmd = new InitiateMetaOAuthCommand(new InProcessOAuthStateStore());
    await expect(cmd.execute({ brandId: BRAND_ID, callbackUrl: META_CALLBACK })).rejects.toThrow(
      /META_APP_ID/,
    );
  });
});

describe('InitiateGoogleAdsOAuthCommand', () => {
  beforeEach(() => {
    process.env['GOOGLE_ADS_CLIENT_ID'] = 'test-google-client-id';
  });

  it('builds a Google authorize URL with the adwords scope + offline access', async () => {
    const store = new InProcessOAuthStateStore();
    const cmd = new InitiateGoogleAdsOAuthCommand(store);
    const result = await cmd.execute({ brandId: BRAND_ID, callbackUrl: GOOGLE_CALLBACK });

    const url = new URL(result.installUrl);
    expect(url.hostname).toBe('accounts.google.com');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/adwords');
    expect(url.searchParams.get('access_type')).toBe('offline'); // refresh token
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_CALLBACK);
    expect(url.searchParams.get('state')).toBe(result.state);
    expect(result.state).toMatch(/^[0-9a-f]{32}$/);

    const consumed = await store.consumeAndGetBrandId(result.state);
    expect(consumed?.brandId).toBe(BRAND_ID);
  });
});
