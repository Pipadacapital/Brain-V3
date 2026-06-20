/**
 * CapiPassbackService — Phase 6 conversion passback orchestration BEHIND can_contact().
 *
 * The CAPI analogue of the email send methods in notification.service.impl.ts. For each
 * finalized realized-revenue order with match data, it:
 *
 *   (a) gates on can_contact(subjectHash, 'capi_meta', 'advertising') FIRST;
 *   (b) on a BLOCK → writes capi_passback_log status `blocked_no_consent` and RETURNS.
 *       The adapter is UNREACHABLE — the structural I-ST05 guarantee + the SLO=0 gate
 *       (non_consented_sends = 0): a non-consented subject NEVER reaches `send`.
 *   (c) on ALLOW → computes the Meta-format match payload (UNSALTED metaMatchHash of the
 *       transiently-read raw PII), builds the deterministic event_id, calls the adapter,
 *       and writes capi_passback_log status `sent` | `would_send_dev`.
 *
 * DETERMINISTIC (cost-routing tier 1): gate eval + sha256 + idempotent INSERT. No model.
 *
 * PII (I-S02): raw email/phone is read transiently from the contact_pii vault (the
 *   MatchPiiPort), hashed via metaMatchHash, and DISCARDED. It is NEVER stored, logged,
 *   or persisted. capi_passback_log stores only the internal salted subject_hash + the
 *   match_key_count (a quality proxy) — never the Meta-format hashes, never raw PII.
 *
 * Money (I-S07): value_minor is BIGINT minor + currency_code in the DB. The minor→major
 *   float conversion happens ONLY in the adapter at the wire boundary.
 *
 * Idempotency (D-4): event_id = sha256(brand‖order‖'Purchase'‖ledger_event_id). The log
 *   PK is (brand_id, event_id) → ON CONFLICT DO NOTHING. 3× replay → one row, one send.
 */

import { createHash } from 'node:crypto';
import type { DbClient, QueryContext } from '@brain/db';
import { isValidCurrency, minorToMajorNumber } from '@brain/money';
import { metaMatchHash } from '@brain/identity-core';
import type { CanContactEngine } from './compliance/can-contact.engine.js';
import type { CapiAdapter, CapiUserData } from './capi-adapter.js';

/**
 * Raw PII for a subject, read transiently from the contact_pii vault (send_service
 * role) at send time and discarded. NEVER stored/logged by this service.
 */
export interface MatchPii {
  email?: string;
  phone?: string;
  /** Brand region for E.164 phone normalization (default 'IN'). */
  regionCode?: string;
}

/**
 * The contact_pii vault read seam. Returns the raw PII for a subject_hash, or null
 * when the subject has no vaulted PII (match falls back to click-ids only). The raw
 * value is used ONLY to compute the Meta-format hash and is never returned to a log.
 */
export interface MatchPiiPort {
  getMatchPii(args: { brandId: string; subjectHash: string }): Promise<MatchPii | null>;
}

/**
 * One finalized conversion to pass back. Produced by capi-source.query.ts (Track A):
 * realized_revenue_ledger (finalized) ⋈ identity (subject_hash) ⋈ silver.touchpoint
 * (click-ids). Money is BIGINT minor + currency_code. NO raw PII on this DTO — the raw
 * PII is fetched transiently via the MatchPiiPort, keyed on subjectHash.
 */
export interface CapiConversion {
  brandId: string;
  orderId: string;
  ledgerEventId: string;
  /** The internal salted hash — the consent key + the contact_pii vault key. */
  subjectHash: string;
  valueMinor: bigint;
  currencyCode: string;
  /** Order event-time (unix-derived event_time + occurred_at TIMESTAMPTZ). */
  occurredAt: Date;
  /** Meta click id (_fbc) from silver.touchpoint — not PII; may be absent. */
  fbc?: string | null;
  /** Meta browser id (_fbp) from silver.touchpoint — not PII; may be absent. */
  fbp?: string | null;
  correlationId: string;
}

export type CapiPassbackStatus =
  | 'sent'
  | 'blocked_no_consent'
  | 'would_send_dev'
  | 'blocked_unsupported_currency'
  | 'failed';

export interface CapiPassbackOutcome {
  status: CapiPassbackStatus;
  eventId: string;
  subjectHash: string;
  matchKeyCount: number;
  blockReason?: string;
  fbtraceId?: string;
}

export interface CapiPassbackDeps {
  engine: CanContactEngine;
  adapter: CapiAdapter;
  pii: MatchPiiPort;
  db: DbClient;
}

/**
 * Deterministic Meta dedup key. Replay produces the SAME id → Meta dedups AND the
 * capi_passback_log PK (brand_id, event_id) dedups. Mirrors realized_revenue_ledger's
 * deterministic ledger_event_id.
 */
export function computeCapiEventId(
  brandId: string,
  orderId: string,
  ledgerEventId: string,
): string {
  return createHash('sha256')
    .update(`${brandId}‖${orderId}‖Purchase‖${ledgerEventId}`, 'utf8')
    .digest('hex');
}

export class CapiPassbackService {
  constructor(private readonly deps: CapiPassbackDeps) {}

  async passback(conv: CapiConversion): Promise<CapiPassbackOutcome> {
    const eventId = computeCapiEventId(conv.brandId, conv.orderId, conv.ledgerEventId);

    // ── Gate FIRST (I-ST05). The adapter is unreachable on a block. ──────────
    // recipient is unused for the advertising/capi_meta path (the engine keys the
    // consent decision on the order's already-resolved subjectHash); we pass the
    // subjectHash itself so no raw PII enters the gate. The engine re-hashes it via
    // identity-core, but the consent lookup is keyed on the resolved subjectHash
    // supplied by the caller — see capi-passback.service docs.
    const decision = await this.deps.engine.evaluate({
      brandId: conv.brandId,
      recipient: conv.subjectHash,
      channel: 'capi_meta',
      purpose: 'advertising',
      precomputedSubjectHash: conv.subjectHash,
    });

    if (decision.decision !== 'allow') {
      // BLOCKED — no consent / withdrawn / tombstoned. The adapter is NOT called.
      // This is the non_consented_sends = 0 guarantee made structural.
      await this.writeLog(conv, {
        eventId,
        status: 'blocked_no_consent',
        matchKeyCount: 0,
        blockReason: decision.reason,
      });
      return {
        status: 'blocked_no_consent',
        eventId,
        subjectHash: conv.subjectHash,
        matchKeyCount: 0,
        blockReason: decision.reason,
      };
    }

    // ── Fail-closed currency guard (#68). A conversion whose currency Brain does not model in
    // minor units cannot be converted to Meta's major-unit value without risking a 100x/10x error
    // (0-/3-decimal currencies). Revenue-truth-over-platform-truth + fail-safe: BLOCK it (terminal)
    // rather than send Meta a fabricated number. Unreachable for in-scope currencies (all 2dp today).
    if (!isValidCurrency(conv.currencyCode)) {
      await this.writeLog(conv, {
        eventId,
        status: 'blocked_unsupported_currency',
        matchKeyCount: 0,
        blockReason: `unsupported_currency:${conv.currencyCode}`,
      });
      return {
        status: 'blocked_unsupported_currency',
        eventId,
        subjectHash: conv.subjectHash,
        matchKeyCount: 0,
        blockReason: `unsupported_currency:${conv.currencyCode}`,
      };
    }

    // ── ALLOW — build the Meta match payload from transiently-read raw PII ────
    const userData = await this.buildUserData(conv);
    const matchKeyCount =
      (userData.em ? 1 : 0) +
      (userData.ph ? 1 : 0) +
      (userData.fbc ? 1 : 0) +
      (userData.fbp ? 1 : 0);

    let result: { status: 'sent' | 'would_send_dev'; fbtraceId?: string };
    try {
      result = await this.deps.adapter.send({
        pixelId: '', // resolved inside the adapter's prod construction; dev ignores.
        eventName: 'Purchase',
        eventId,
        eventTime: Math.floor(conv.occurredAt.getTime() / 1000),
        actionSource: 'website',
        userData,
        // minor→major float ONLY at the wire boundary (Meta CAPI wants a major-unit number).
        // The exponent is currency-aware (@brain/money MINOR_UNITS) — never a hardcoded /100, so a
        // 0-decimal (JPY) or 3-decimal (KWD) value is never sent 100×/10× off. The currency is
        // guaranteed valid here (the fail-closed guard above blocked anything @brain/money can't model).
        customData: {
          value: minorToMajorNumber(conv.valueMinor, conv.currencyCode),
          currency: conv.currencyCode,
        },
        correlationId: conv.correlationId,
      });
    } catch (err) {
      await this.writeLog(conv, {
        eventId,
        status: 'failed',
        matchKeyCount,
        blockReason: err instanceof Error ? err.message : 'send_error',
      });
      return {
        status: 'failed',
        eventId,
        subjectHash: conv.subjectHash,
        matchKeyCount,
      };
    }

    await this.writeLog(conv, {
      eventId,
      status: result.status,
      matchKeyCount,
      fbtraceId: result.fbtraceId,
    });

    return {
      status: result.status,
      eventId,
      subjectHash: conv.subjectHash,
      matchKeyCount,
      fbtraceId: result.fbtraceId,
    };
  }

  /**
   * Build Meta userData. Raw PII is read transiently, hashed (UNSALTED metaMatchHash),
   * and discarded — it is NEVER stored or logged. Click-ids (not PII) ride as-is.
   */
  private async buildUserData(conv: CapiConversion): Promise<CapiUserData> {
    const userData: CapiUserData = {};
    const pii = await this.deps.pii.getMatchPii({
      brandId: conv.brandId,
      subjectHash: conv.subjectHash,
    });
    if (pii?.email) {
      userData.em = [metaMatchHash(pii.email, 'email')];
    }
    if (pii?.phone) {
      userData.ph = [metaMatchHash(pii.phone, 'phone', pii.regionCode ?? 'IN')];
    }
    if (conv.fbc) userData.fbc = conv.fbc;
    if (conv.fbp) userData.fbp = conv.fbp;
    return userData;
  }

  /** Append-only INSERT into capi_passback_log, ON CONFLICT DO NOTHING (idempotent). */
  private async writeLog(
    conv: CapiConversion,
    row: {
      eventId: string;
      status: CapiPassbackStatus;
      matchKeyCount: number;
      blockReason?: string;
      fbtraceId?: string;
    },
  ): Promise<void> {
    const ctx: QueryContext = {
      brandId: conv.brandId,
      correlationId: conv.correlationId,
    };
    await this.deps.db.query(
      ctx,
      `INSERT INTO capi_passback_log
         (brand_id, event_id, platform, order_id, subject_hash, ledger_event_id,
          status, block_reason, match_key_count, value_minor, currency_code,
          fbtrace_id, correlation_id, occurred_at)
       VALUES ($1, $2, 'meta', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (brand_id, event_id) DO NOTHING`,
      [
        conv.brandId,
        row.eventId,
        conv.orderId,
        conv.subjectHash,
        conv.ledgerEventId,
        row.status,
        row.blockReason ?? null,
        row.matchKeyCount,
        conv.valueMinor.toString(),
        conv.currencyCode,
        row.fbtraceId ?? null,
        conv.correlationId,
        conv.occurredAt.toISOString(),
      ],
    );
  }
}
