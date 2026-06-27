/**
 * ProcessEventUseCase — server-trusted bypass on the pixel (enforceTenantDerivation=true) lane.
 *
 * Regression for the `tenant_unresolved` quarantine bug: connector/worker-emitted server-trusted
 * lane events (order.live.v1, spend.live.v1, the logistics/checkout bridge events) carry a
 * server-derived brand_id and NO install_token, and land in Bronze via their OWN bridges. The pixel
 * consumer must SKIP them — applying the install_token gate quarantined them as tenant_unresolved
 * (the live symptom: thousands of repull order.live.v1 events in the .quarantine topic). Browser pixel
 * events (page.viewed, …) with no resolvable install_token MUST still quarantine.
 */
import { describe, it, expect } from 'vitest';
import { ProcessEventUseCase, SERVER_TRUSTED_EVENT_NAMES } from './ProcessEventUseCase.js';
import type { RedisDedupAdapter } from '../infrastructure/redis/RedisDedupAdapter.js';
import type { BronzeRepository } from '../infrastructure/pg/BronzeRepository.js';

function envelope(eventName: string, withInstallToken = false): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema_version: '1',
      event_id: '11111111-1111-1111-1111-111111111111',
      brand_id: '22222222-2222-2222-2222-222222222222',
      correlation_id: 'repull:ci:evt',
      event_name: eventName,
      occurred_at: '2026-06-27T12:00:00.000Z',
      properties: withInstallToken ? { install_token: 'tok' } : {},
    }),
  );
}

// dedup is never reached on the skip/quarantine paths; bronze.resolveBrandByInstallToken returns null
// (no pixel install) so a genuine pixel event quarantines as tenant_unresolved.
const dedup = {} as unknown as RedisDedupAdapter;
const bronze = {
  resolveBrandByInstallToken: async () => null,
} as unknown as BronzeRepository;

// The pixel lane: enforceTenantDerivation = true.
const uc = new ProcessEventUseCase(dedup, bronze, undefined, true);

describe('ProcessEventUseCase — server-trusted bypass (pixel lane)', () => {
  it('SKIPS order.live.v1 (server-trusted) instead of quarantining as tenant_unresolved', async () => {
    const r = await uc.execute(envelope('order.live.v1'), '2026-06-27T12:00:00.000Z');
    expect(r.outcome).toBe('skipped');
    expect(r.reason).toBe('server_trusted_lane');
  });

  it('SKIPS every server-trusted lane event name', async () => {
    for (const name of SERVER_TRUSTED_EVENT_NAMES) {
      const r = await uc.execute(envelope(name), '2026-06-27T12:00:00.000Z');
      expect(r.outcome, `${name} should skip`).toBe('skipped');
    }
  });

  it('still QUARANTINES a browser pixel event with no resolvable install_token (gate intact)', async () => {
    const r = await uc.execute(envelope('page.viewed'), '2026-06-27T12:00:00.000Z');
    expect(r.outcome).toBe('quarantined');
    expect(r.reason).toBe('tenant_unresolved');
  });
});
