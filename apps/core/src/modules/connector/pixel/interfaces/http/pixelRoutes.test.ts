/**
 * pixelRoutes.test.ts — first-party-host snippet + hostname validation (Phase H CNAME slice).
 *
 * Locks: isValidIngestHost accepts bare hostnames and rejects scheme/path/port/spaces (injection
 * safety — the host is interpolated into snippet HTML); buildDefaultSnippet emits the first-party
 * host (ingest_base_url + script src) when a valid custom host is given, and falls back otherwise.
 */
import { describe, it, expect } from 'vitest';
import { buildDefaultSnippet, isValidIngestHost } from './pixelRoutes.js';

describe('isValidIngestHost', () => {
  it('accepts bare multi-label hostnames', () => {
    for (const h of ['events.brand.com', 'px.shop.co.uk', 'a.b.io', 'EVENTS.Brand.com']) {
      expect(isValidIngestHost(h)).toBe(true);
    }
  });

  it('rejects scheme / path / port / spaces / single-label / empty', () => {
    for (const h of [
      'https://events.brand.com', 'events.brand.com/collect', 'events.brand.com:8080',
      'events brand.com', 'localhost', '', 'brand', '-bad.com', 'a..b.com', "x';<script>",
    ]) {
      expect(isValidIngestHost(h)).toBe(false);
    }
  });
});

describe('buildDefaultSnippet', () => {
  const TOKEN = '11111111-1111-4111-8111-111111111111';
  const BRAND = '22222222-2222-4222-8222-222222222222';
  const DEFAULT = 'https://ingest.brain.test';

  it('uses the default host when no custom host is set', () => {
    const s = buildDefaultSnippet(TOKEN, BRAND, DEFAULT);
    expect(s).toContain(`${DEFAULT}/pixel.js`);
    expect(s).not.toContain('ingest_base_url');
  });

  it('emits the first-party host (ingest_base_url + src) for a valid custom host', () => {
    const s = buildDefaultSnippet(TOKEN, BRAND, DEFAULT, 'events.brand.com');
    expect(s).toContain("ingest_base_url: 'https://events.brand.com'");
    expect(s).toContain('https://events.brand.com/pixel.js');
    expect(s).not.toContain(DEFAULT);
  });

  it('ignores an invalid custom host and falls back to the default (no injection)', () => {
    const s = buildDefaultSnippet(TOKEN, BRAND, DEFAULT, 'https://evil.com/x');
    expect(s).toContain(`${DEFAULT}/pixel.js`);
    expect(s).not.toContain('evil.com');
  });
});
