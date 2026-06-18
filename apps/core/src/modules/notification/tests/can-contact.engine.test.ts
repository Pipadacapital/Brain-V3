/**
 * can_contact() compliance engine — default-closed proof (D13, Track B).
 *
 * These are PURE unit tests against the engine with in-memory fakes for the
 * SuppressionQuery / DLT / NCPR / Salt ports and an injected clock. They prove the
 * acceptance contract's default-closed invariant WITHOUT a DB:
 *
 *   - transactional purpose → ALWAYS allow (TCCCPR carve-out), no hashing.
 *   - no consent row → block (consent_absent)            [fail-closed default]
 *   - withdrawn / tombstoned → block (consent_withdrawn) [retroactive suppression]
 *   - granted + in-window (email) → allow
 *   - granted + out-of-window (email) → queue_pending_window (next 09:00 IST), not dropped
 *   - phone + DLT stub (false) → block (dlt_unregistered)
 *   - phone + DLT approved + NCPR unknown → block (unknown)  [NCPR fail-closed]
 *   - unparseable clock → block (unknown)                [fail-closed window]
 *   - salt fetch failure → HARD CRASH (throws), never a silent allow.
 *
 * The DB-backed suppression query + RLS isolation (NON-INERT under brain_app) are
 * proved by the live consumer e2e (Track A) — these unit tests prove the engine's
 * branching logic deterministically.
 */

import { describe, it, expect } from 'vitest';
import { CanContactEngine } from '../internal/compliance/can-contact.engine.js';
import type {
  SuppressionQuery,
  SuppressionResult,
} from '@brain/contracts';
import type {
  DltRegistryPort,
  NcprRegistryPort,
  SaltPort,
  DndStatus,
} from '../internal/compliance/ports.js';
import { evaluateSendWindow } from '../internal/compliance/policies/send-window.policy.js';

// 32-byte (64-hex) salt — a valid identity-core salt for hashing.
const VALID_SALT = 'a'.repeat(64);
const BRAND = '11111111-1111-1111-1111-111111111111';

// ── In-memory fakes ──────────────────────────────────────────────────────────
function saltOk(): SaltPort {
  return { saltHexForBrand: async () => VALID_SALT };
}
function saltCrash(): SaltPort {
  return {
    saltHexForBrand: async () => {
      throw new Error('[identity-bridge] salt fetch failed (D-2)');
    },
  };
}
function suppression(result: SuppressionResult): SuppressionQuery {
  return { isSuppressed: async () => result };
}
function dlt(approved: boolean): DltRegistryPort {
  return { isTemplateApproved: async () => approved };
}
function ncpr(status: DndStatus): NcprRegistryPort {
  return { dndStatus: async () => status };
}

// Fixed clocks (UTC). IST = UTC + 5:30.
//   12:00 UTC = 17:30 IST → IN window.
//   00:00 UTC = 05:30 IST → OUT of window (before 09:00 IST).
const IN_WINDOW = () => new Date('2026-06-18T12:00:00.000Z');
const OUT_OF_WINDOW = () => new Date('2026-06-18T00:00:00.000Z');

function engine(opts: {
  salt?: SaltPort;
  supp?: SuppressionResult;
  dltApproved?: boolean;
  dndStatus?: DndStatus;
  now?: () => Date;
}): CanContactEngine {
  return new CanContactEngine({
    salt: opts.salt ?? saltOk(),
    suppression: suppression(
      opts.supp ?? { suppressed: false, reason: null },
    ),
    dlt: dlt(opts.dltApproved ?? false),
    ncpr: ncpr(opts.dndStatus ?? 'unknown'),
    now: opts.now ?? IN_WINDOW,
  });
}

describe('can_contact engine — transactional carve-out', () => {
  it('transactional purpose → allow (transactional_exempt), no subject hash', async () => {
    const e = engine({});
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'transactional_email',
      purpose: 'transactional',
    });
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('transactional_exempt');
    expect(d.subjectHash).toBeNull();
  });

  it('transactional carve-out applies even with no consent on file', async () => {
    const e = engine({ supp: { suppressed: true, reason: 'no_consent' } });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'transactional_email',
      purpose: 'transactional',
    });
    expect(d.decision).toBe('allow');
  });
});

describe('can_contact engine — consent (DEFAULT-CLOSED)', () => {
  it('no consent row → block (consent_absent) — fail-closed default', async () => {
    const e = engine({ supp: { suppressed: true, reason: 'no_consent' } });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_absent');
    expect(d.subjectHash).toMatch(/^[0-9a-f]{64}$/); // hashed, never raw
  });

  it('withdrawn consent → block (consent_withdrawn)', async () => {
    const e = engine({ supp: { suppressed: true, reason: 'withdrawn' } });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_withdrawn');
  });

  it('tombstoned consent → block (consent_withdrawn)', async () => {
    const e = engine({ supp: { suppressed: true, reason: 'tombstoned' } });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_withdrawn');
  });
});

describe('can_contact engine — send window (9–9 IST)', () => {
  it('granted + in-window (email) → allow', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      now: IN_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('allowed');
  });

  it('granted + out-of-window (email) → queue_pending_window (not dropped, not late)', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      now: OUT_OF_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('queue_pending_window');
    expect(d.reason).toBe('out_of_window');
    expect(d.releaseAfter).toBeTruthy();
    // releaseAfter is the next 09:00 IST == 03:30 UTC the same day.
    expect(d.releaseAfter).toBe('2026-06-18T03:30:00.000Z');
  });

  it('unparseable clock → block (unknown) — fail-closed window', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      now: () => new Date('not-a-date'),
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('unknown');
  });
});

describe('can_contact engine — phone channels: DLT + NCPR (DEFAULT-CLOSED)', () => {
  it('phone + DLT stub not approved → block (dlt_unregistered)', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      dltApproved: false,
      now: IN_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: '+919876543210',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('dlt_unregistered');
  });

  it('phone + DLT approved + NCPR unknown → block (unknown) — NCPR fail-closed', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      dltApproved: true,
      dndStatus: 'unknown',
      now: IN_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: '+919876543210',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('unknown');
  });

  it('phone + DLT approved + on DND → block (ncpr_dnd)', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      dltApproved: true,
      dndStatus: 'on_dnd',
      now: IN_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: '+919876543210',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('ncpr_dnd');
  });

  it('phone + DLT approved + not on DND + in-window → allow', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      dltApproved: true,
      dndStatus: 'not_on_dnd',
      now: IN_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: '+919876543210',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('allowed');
  });

  it('phone + DLT approved + not on DND + out-of-window → queue_pending_window', async () => {
    const e = engine({
      supp: { suppressed: false, reason: null },
      dltApproved: true,
      dndStatus: 'not_on_dnd',
      now: OUT_OF_WINDOW,
    });
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: '+919876543210',
      channel: 'whatsapp',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('queue_pending_window');
    expect(d.reason).toBe('out_of_window');
  });
});

describe('can_contact engine — salt failure is a HARD CRASH (never silent allow)', () => {
  it('salt fetch throws → evaluate rejects (process-level fail, not allow)', async () => {
    const e = engine({ salt: saltCrash(), supp: { suppressed: false, reason: null } });
    await expect(
      e.evaluate({
        brandId: BRAND,
        recipient: 'user@example.com',
        channel: 'marketing_email',
        purpose: 'marketing',
      }),
    ).rejects.toThrow(/salt fetch failed/);
  });
});

describe('send-window policy — IST boundaries (unit)', () => {
  it('exactly 09:00 IST is IN window (inclusive open)', () => {
    // 09:00 IST == 03:30 UTC
    const w = evaluateSendWindow(new Date('2026-06-18T03:30:00.000Z'));
    expect(w.inWindow).toBe(true);
  });

  it('exactly 21:00 IST is OUT of window (exclusive close)', () => {
    // 21:00 IST == 15:30 UTC
    const w = evaluateSendWindow(new Date('2026-06-18T15:30:00.000Z'));
    expect(w.inWindow).toBe(false);
    expect(w.releaseAfter).toBe('2026-06-19T03:30:00.000Z'); // next day 09:00 IST
  });

  it('20:59 IST is IN window', () => {
    // 20:59 IST == 15:29 UTC
    const w = evaluateSendWindow(new Date('2026-06-18T15:29:00.000Z'));
    expect(w.inWindow).toBe(true);
  });

  it('before 09:00 IST → releaseAfter is the SAME IST day 09:00', () => {
    // 05:30 IST == 00:00 UTC → next open is today 09:00 IST == 03:30 UTC
    const w = evaluateSendWindow(new Date('2026-06-18T00:00:00.000Z'));
    expect(w.inWindow).toBe(false);
    expect(w.releaseAfter).toBe('2026-06-18T03:30:00.000Z');
  });
});
