/**
 * dispatch.test.ts — the repull-dispatch registry guard (re-platform Phase B, DB/infra-free).
 *
 * Locks REPULL_DISPATCH so a provider's scheduled re-pull can't silently disappear (the audit's
 * "forget the case → connector polls zero times" bottleneck), and confirms loadRun() returns null
 * for an unknown provider (the caller logs + skips). We assert the provider SET only (not the lazy
 * loaders) so the test never eager-imports the repull modules / Kafka.
 */
import { describe, it, expect } from 'vitest';
import { REPULL_PROVIDERS, loadRun } from './run.js';

describe('repull dispatch registry (Phase B)', () => {
  it('dispatches exactly the known re-pull providers', () => {
    expect([...REPULL_PROVIDERS].sort()).toEqual(
      // GoKwik is webhook-first (no scheduled re-pull) — intentionally absent (mirrors shopflo).
      ['ga4', 'google_ads', 'meta', 'razorpay', 'shiprocket', 'shopify', 'woocommerce'].sort(),
    );
  });

  it('every dispatched provider is unique', () => {
    expect(new Set(REPULL_PROVIDERS).size).toBe(REPULL_PROVIDERS.length);
  });

  it('loadRun returns null for an unknown provider (caller logs + skips, no throw)', async () => {
    expect(await loadRun('definitely_not_a_provider')).toBeNull();
  });
});
