/**
 * Unit tests for normalizeHostPreview — the FE cosmetic mirror of the server-authoritative
 * normalizeBrandHost. These lock the "same site three ways → one host" property on the FE
 * preview so the onboarding/Tracking Center hint matches what the server will persist.
 *
 * Pure logic, environment: node (no DOM) — uses the global WHATWG URL.
 */
import { describe, it, expect } from 'vitest';
import { normalizeHostPreview } from './normalize-host-preview';

describe('normalizeHostPreview', () => {
  it('strips scheme, path, query, and lowercases', () => {
    expect(normalizeHostPreview('https://MyStore.com/products?ref=x')).toBe('mystore.com');
  });

  it('accepts a bare host', () => {
    expect(normalizeHostPreview('mystore.com')).toBe('mystore.com');
  });

  it('strips a single leading www. and a trailing slash', () => {
    expect(normalizeHostPreview('http://www.mystore.com/')).toBe('mystore.com');
  });

  it('preserves non-www subdomains, lowercases', () => {
    expect(normalizeHostPreview('HTTPS://Shop.MyStore.CO.UK')).toBe('shop.mystore.co.uk');
  });

  it('drops a port', () => {
    expect(normalizeHostPreview('https://mystore.com:8443/')).toBe('mystore.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHostPreview('  mystore.com  ')).toBe('mystore.com');
  });

  it('returns null for empty / whitespace / null (skip-for-now)', () => {
    expect(normalizeHostPreview('')).toBeNull();
    expect(normalizeHostPreview('   ')).toBeNull();
    expect(normalizeHostPreview(null)).toBeNull();
    expect(normalizeHostPreview(undefined)).toBeNull();
  });

  it('returns null for non-http(s) schemes and garbage', () => {
    expect(normalizeHostPreview('ftp://x.com')).toBeNull();
    expect(normalizeHostPreview('mailto:a@b.com')).toBeNull();
    expect(normalizeHostPreview('javascript:alert(1)')).toBeNull();
    expect(normalizeHostPreview('not a url')).toBeNull();
  });

  it('returns null for localhost, dotless hosts, and bare IPv4', () => {
    expect(normalizeHostPreview('localhost')).toBeNull();
    expect(normalizeHostPreview('http://localhost:3000')).toBeNull();
    expect(normalizeHostPreview('https://192.168.1.1')).toBeNull();
  });

  it('is idempotent: f(x) === f(f(x)) for non-null outputs (one host, one token)', () => {
    for (const input of [
      'https://WWW.MyStore.com/path?a=1',
      'shop.mystore.co.uk',
      'http://mystore.com:8443/',
    ]) {
      const once = normalizeHostPreview(input);
      expect(once).not.toBeNull();
      expect(normalizeHostPreview(once)).toBe(once);
    }
  });
});
