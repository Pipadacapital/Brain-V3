// SPEC: A.4
import { describe, it, expect } from 'vitest';
import { touchpointCacheKey } from './index.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN = '22222222-2222-2222-2222-222222222222';

describe('SPEC A.4 — touchpointCacheKey', () => {
  it('is brand-first: `{brand_id}:tp:{brain_id}` (§0.5)', () => {
    expect(touchpointCacheKey({ brandId: BRAND, brainId: BRAIN })).toBe(`${BRAND}:tp:${BRAIN}`);
  });

  it('requires both segments', () => {
    expect(() => touchpointCacheKey({ brandId: '', brainId: BRAIN })).toThrow(/brandId is required/);
    expect(() => touchpointCacheKey({ brandId: BRAND, brainId: '' })).toThrow(/brainId is required/);
  });

  it('rejects ":" separator injection in either segment', () => {
    expect(() => touchpointCacheKey({ brandId: 'a:b', brainId: BRAIN })).toThrow(/must not contain ":"/);
    expect(() => touchpointCacheKey({ brandId: BRAND, brainId: 'x:y' })).toThrow(/must not contain ":"/);
  });
});
