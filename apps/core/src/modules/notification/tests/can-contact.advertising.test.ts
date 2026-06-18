/**
 * can-contact.advertising.test.ts — the `advertising` purpose gate (Phase 6, Track B).
 *
 * PURE unit tests against can_contact() for the NEW `advertising` purpose / `capi_meta`
 * channel — the CAPI conversion-passback consent decision. In-memory fakes for the
 * SuppressionQuery / Salt ports + an injected clock; NO DB (the DB-backed RLS path is
 * the SLO live test). These prove the DEFAULT-CLOSED contract for advertising:
 *
 *   (i)   no consent_record (advertising) → block (consent_absent)        [default-closed]
 *   (ii)  withdrawn advertising → block (consent_withdrawn)               [retroactive]
 *   (iii) tombstoned advertising → block (consent_withdrawn)             [erasure]
 *   (iv)  granted advertising → allow                                     [the only allow]
 *
 * AND the ONE documented semantic divergence (architecture §1.3.2): a CAPI passback is a
 * server-to-server MEASUREMENT signal, not a commercial communication to a person, so the
 * 9–9 IST send-window does NOT apply — once consent clears, advertising is ALLOWED even
 * out-of-window (NOT queued). Marketing's window behaviour stays byte-identical.
 *
 * The gating category is selected by purpose: advertising → the `advertising` consent
 * category (distinct lawful basis from marketing — DPDP purpose-limitation).
 */

import { describe, it, expect } from 'vitest';
import { CanContactEngine } from '../internal/compliance/can-contact.engine.js';
import { gatingCategoryForPurpose } from '../internal/compliance/contact-types.js';
import type { SuppressionQuery, SuppressionResult } from '@brain/contracts';
import type {
  DltRegistryPort,
  NcprRegistryPort,
  SaltPort,
} from '../internal/compliance/ports.js';

const VALID_SALT = 'a'.repeat(64);
const BRAND = '11111111-1111-1111-1111-111111111111';
// A valid 64-hex identity-core subject hash (the precomputed consent key for capi_meta).
const SUBJECT = 'b'.repeat(64);

// Out-of-window clock: 00:00 UTC = 05:30 IST (before 09:00 IST) → marketing would queue.
const OUT_OF_WINDOW = () => new Date('2026-06-18T00:00:00.000Z');

function saltOk(): SaltPort {
  return { saltHexForBrand: async () => VALID_SALT };
}
function suppression(result: SuppressionResult): SuppressionQuery {
  // Assert the engine asks for the advertising category on the advertising path.
  return {
    isSuppressed: async (args) => {
      // The category passed to the query must be 'advertising' for purpose=advertising.
      // (We capture it via a closure-side assertion in the dedicated test below; here
      // we just return the configured result.)
      void args;
      return result;
    },
  };
}
function dltBlock(): DltRegistryPort {
  return { isTemplateApproved: async () => false };
}
function ncprBlock(): NcprRegistryPort {
  return { dndStatus: async () => 'unknown' };
}

function advertisingEngine(supp: SuppressionResult, now = OUT_OF_WINDOW): CanContactEngine {
  return new CanContactEngine({
    salt: saltOk(),
    suppression: suppression(supp),
    dlt: dltBlock(),
    ncpr: ncprBlock(),
    now,
  });
}

async function evalAdvertising(e: CanContactEngine) {
  return e.evaluate({
    brandId: BRAND,
    recipient: SUBJECT, // non-PII placeholder; the precomputed hash is the real key
    channel: 'capi_meta',
    purpose: 'advertising',
    precomputedSubjectHash: SUBJECT,
  });
}

describe('gatingCategoryForPurpose — advertising selects the advertising category', () => {
  it('advertising → advertising; marketing → marketing; transactional → marketing', () => {
    expect(gatingCategoryForPurpose('advertising')).toBe('advertising');
    expect(gatingCategoryForPurpose('marketing')).toBe('marketing');
    // transactional never reaches the category select (Step 1 exempts it), but the pure
    // function defaults non-advertising to marketing.
    expect(gatingCategoryForPurpose('transactional')).toBe('marketing');
  });
});

describe('can_contact(advertising) — DEFAULT-CLOSED', () => {
  it('(i) no advertising consent row → block (consent_absent)', async () => {
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: true, reason: 'no_consent' }),
    );
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_absent');
    expect(d.subjectHash).toBe(SUBJECT);
  });

  it('(ii) withdrawn advertising consent → block (consent_withdrawn)', async () => {
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: true, reason: 'withdrawn' }),
    );
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_withdrawn');
  });

  it('(iii) tombstoned advertising consent → block (consent_withdrawn)', async () => {
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: true, reason: 'tombstoned' }),
    );
    expect(d.decision).toBe('block');
    expect(d.reason).toBe('consent_withdrawn');
  });

  it('(iv) granted advertising consent → allow', async () => {
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: false, reason: null }),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('allowed');
  });
});

describe('can_contact(advertising) — the engine reads the advertising category', () => {
  it('the suppression query is asked for category=advertising (not marketing)', async () => {
    let askedCategory: string | undefined;
    const e = new CanContactEngine({
      salt: saltOk(),
      suppression: {
        isSuppressed: async (args) => {
          askedCategory = args.category;
          return { suppressed: false, reason: null };
        },
      },
      dlt: dltBlock(),
      ncpr: ncprBlock(),
      now: OUT_OF_WINDOW,
    });
    await evalAdvertising(e);
    expect(askedCategory).toBe('advertising');
  });
});

describe('can_contact(advertising) — window short-circuit (the ONE documented divergence)', () => {
  it('granted advertising OUT-OF-WINDOW → allow (NOT queued — measurement signal, no 9–9 window)', async () => {
    // Same out-of-window clock that queues a marketing email allows an advertising passback.
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: false, reason: null }, OUT_OF_WINDOW),
    );
    expect(d.decision).toBe('allow');
    expect(d.reason).toBe('allowed');
    expect(d.releaseAfter).toBeUndefined(); // never queued
  });

  it('contrast: a marketing email on the SAME out-of-window clock IS queued (window applies)', async () => {
    const e = advertisingEngine({ suppressed: false, reason: null }, OUT_OF_WINDOW);
    const d = await e.evaluate({
      brandId: BRAND,
      recipient: 'user@example.com',
      channel: 'marketing_email',
      purpose: 'marketing',
    });
    expect(d.decision).toBe('queue_pending_window');
    expect(d.reason).toBe('out_of_window');
  });
});

describe('can_contact(advertising) — capi_meta is NOT a telecom channel (DLT/NCPR skipped)', () => {
  it('granted advertising → allow even though DLT/NCPR stubs are fail-closed (phone-only)', async () => {
    // DLT/NCPR ports are default-closed (block) but MUST be skipped for capi_meta;
    // a non-phone channel never consults them, so the decision is allow on consent alone.
    const d = await evalAdvertising(
      advertisingEngine({ suppressed: false, reason: null }),
    );
    expect(d.decision).toBe('allow');
  });
});
