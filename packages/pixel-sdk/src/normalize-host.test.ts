// normalize-host.test.ts — the §1 edge-case matrix + the idempotence property.
//
// These tests ARE the "same site typed three ways → one canonical host → one token"
// proof. The idempotence property (f(x) === f(f(x))) is asserted for every non-null
// output: this is what guarantees a brand can never mint two tokens for one site.

import { describe, it, expect } from 'vitest';
import { normalizeBrandHost } from './normalize-host.js';

describe('normalizeBrandHost — §1 edge-case matrix', () => {
  const cases: Array<[string | null | undefined, string | null, string]> = [
    ['https://MyStore.com/products?ref=x', 'mystore.com', 'scheme+path+query+case stripped'],
    ['mystore.com', 'mystore.com', 'bare host gets scheme prepended then parsed'],
    ['http://www.mystore.com/', 'mystore.com', 'www stripped, trailing slash gone'],
    ['HTTPS://Shop.MyStore.CO.UK', 'shop.mystore.co.uk', 'subdomain preserved (only leading www stripped)'],
    ['münchen.de', 'xn--mnchen-3ya.de', 'IDN → punycode via URL.hostname'],
    ['https://mystore.com:8443/', 'mystore.com', 'port dropped'],
    ['  mystore.com  ', 'mystore.com', 'trimmed'],
    ['', null, 'empty → skip-for-now'],
    ['   ', null, 'whitespace → skip-for-now'],
    [null, null, 'null → skip-for-now'],
    [undefined, null, 'undefined → skip-for-now'],
    ['not a url with spaces', null, 'unparseable → invalid'],
    ['ftp://x.com', null, 'ftp scheme rejected'],
    ['javascript:alert(1)', null, 'javascript scheme rejected'],
    ['mailto:a@b.com', null, 'mailto scheme rejected'],
    ['data:text/html,x', null, 'data scheme rejected'],
    ['localhost', null, 'localhost not registrable'],
    ['http://localhost:3000', null, 'localhost with port not registrable'],
    ['https://192.168.1.1', null, 'bare IPv4 rejected (M1)'],
    ['nodothost', null, 'dotless host rejected'],
  ];

  for (const [input, expected, note] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)} (${note})`, () => {
      expect(normalizeBrandHost(input)).toBe(expected);
    });
  }
});

describe('normalizeBrandHost — idempotence property (same site → one host)', () => {
  const sameSiteThreeWays = [
    'mystore.com',
    'https://www.MyStore.com/',
    'HTTP://MyStore.COM:80/products?ref=abc#top',
  ];

  it('the same site typed three ways collapses to one canonical host', () => {
    const hosts = sameSiteThreeWays.map((v) => normalizeBrandHost(v));
    expect(new Set(hosts).size).toBe(1);
    expect(hosts[0]).toBe('mystore.com');
  });

  it('f(x) === f(f(x)) for every non-null output (idempotent)', () => {
    const probes = [
      'https://MyStore.com/products?ref=x',
      'mystore.com',
      'http://www.shop.example.co.uk/',
      'münchen.de',
      'https://mystore.com:8443/',
    ];
    for (const p of probes) {
      const once = normalizeBrandHost(p);
      expect(once).not.toBeNull();
      const twice = normalizeBrandHost(once);
      expect(twice).toBe(once);
    }
  });
});
