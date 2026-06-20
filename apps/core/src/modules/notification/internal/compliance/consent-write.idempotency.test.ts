/**
 * consent-write.idempotency.test.ts — T2-7 / I-ST04.
 *
 * Proves the operator/API consent write records the client-supplied Idempotency-Key on the audit
 * entry's FIRST-CLASS idempotency_key field (not buried in payload), for both grant and withdraw.
 * That is what lets a retried grant/withdraw tie back to one logical action (the DB writes are
 * already idempotent via ON CONFLICT DO NOTHING). Pure unit test — db/salt/audit are stubbed.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AuditEntry } from '@brain/audit';
import { ConsentWriter } from './consent-write.js';

const BRAND = '550e8400-e29b-41d4-a716-446655440000';
const SALT_HEX = 'a'.repeat(64); // valid 64-hex per SaltPort contract

function makeWriter() {
  const appended: AuditEntry[] = [];
  const db = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const salt = { saltHexForBrand: vi.fn(async () => SALT_HEX) };
  const audit = { append: vi.fn(async (e: AuditEntry) => { appended.push(e); }) };
  // The writer only uses db.query / salt.saltHexForBrand / audit.append.
  const writer = new ConsentWriter({
    db: db as never,
    salt: salt as never,
    audit: audit as never,
  });
  return { writer, appended };
}

describe('ConsentWriter idempotency key on audit (T2-7)', () => {
  it('grant records the idempotency key on the audit entry', async () => {
    const { writer, appended } = makeWriter();
    await writer.grant({
      brandId: BRAND,
      recipient: 'shopper@example.com',
      channel: 'marketing_email',
      category: 'marketing',
      source: 'operator',
      actorId: 'user-1',
      actorRole: 'operator',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-grant-abc',
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.action).toBe('consent.granted');
    expect(appended[0]!.idempotency_key).toBe('idem-grant-abc');
  });

  it('withdraw records the idempotency key on the audit entry', async () => {
    const { writer, appended } = makeWriter();
    await writer.withdraw({
      brandId: BRAND,
      recipient: 'shopper@example.com',
      channel: 'marketing_email',
      category: 'marketing',
      reason: 'withdrawal',
      source: 'operator',
      actorId: 'user-1',
      actorRole: 'operator',
      correlationId: 'corr-1',
      idempotencyKey: 'idem-withdraw-xyz',
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]!.action).toBe('consent.withdrawn');
    expect(appended[0]!.idempotency_key).toBe('idem-withdraw-xyz');
  });
});
