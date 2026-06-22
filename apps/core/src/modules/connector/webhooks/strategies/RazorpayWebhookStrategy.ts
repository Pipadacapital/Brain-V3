/**
 * RazorpayWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Parses JSON body early to extract account_id (needed for per-connector secret lookup).
 *   Resolves webhook_secret via getSecret(accountId) then validates
 *   hex(HMAC-SHA256(rawBody, webhookSecret)) == X-Razorpay-Signature.
 *   Byte-compatible with legacy RazorpayHmac.validateWebhook().
 *
 *   OLD-SECRET GRACE WINDOW (rotation safety):
 *   After a webhook_secret rotation (via RotateWebhookSecretCommand / Wave-A rotate route),
 *   Razorpay may still deliver events signed with the previous secret for up to TTL seconds
 *   (GRACE_WINDOW_SECONDS = 300 s / 5 min). The credential bundle may optionally carry:
 *     previous_webhook_secret:            string  — the rotated-away secret
 *     previous_webhook_secret_expires_at: string  — ISO-8601 UTC expiry of the grace window
 *   If the primary HMAC fails but a non-expired previous_webhook_secret exists and its HMAC
 *   validates, the request is accepted. This ensures zero event loss during rotation.
 *
 * payloadMap:
 *   payment.captured → map-table upsert (MB-1 HARD prerequisite, throwOnSideEffectError=true).
 *   settlement.processed / refund.created / payment.failed → emit to live lane (existing settlement lane).
 *   refund.processed / refund.failed → emit to live lane with entity_type='refund'.
 *   payment.dispute.created / payment.dispute.under_review / payment.dispute.won →
 *     emit to live lane with entity_type='dispute'; dispute.lost is a REVENUE REVERSAL (dispute_direction=debit).
 *   payment.dispute.lost → emit to live lane with entity_type='dispute', dispute_direction='debit' (REVENUE REVERSAL).
 *   order.paid → emit to live lane with entity_type='order_paid'.
 *   payment.authorized → emit to live lane with entity_type='payment_authorized'.
 *   Other events → fast-ack (skip=true).
 *
 * NOTE: the payloadMap signature dedup key = envelope.id (Razorpay opaque event ID).
 *       Age check = envelope.created_at (Unix seconds).
 * NOTE: dispute.lost carries dispute_direction='debit' — consumers MUST apply negative sign to amount_minor.
 */

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { RAZORPAY_HMAC_CONFIG } from '../platform/HmacConfig.js';
import {
  mapPaymentWebhookToMapRow,
  mapSettlementItemToEvent,
  mapRefundWebhookToEvent,
  mapDisputeWebhookToEvent,
  mapOrderPaidWebhookToEvent,
  mapPaymentAuthorizedToEvent,
  uuidV5FromRazorpayWebhook,
  uuidV5FromRazorpayWebhookWithType,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
  type RazorpayPaymentCapturedPayload,
  type RazorpaySettlementItem,
  type RazorpayRefundEntity,
  type RazorpayDisputeEntity,
  type DisputeLifecycleType,
  type RazorpayOrderEntity,
  type RazorpayPaymentAuthorizedEntity,
} from '@brain/razorpay-mapper';
import { PgRazorpayOrderMapRepository } from '../../sources/payment/razorpay/infrastructure/repositories/PgRazorpayOrderMapRepository.js';

// ── Grace window constant ─────────────────────────────────────────────────────

/**
 * Grace window for old-secret acceptance after rotation (seconds).
 * Matches the 5-minute replay window to prevent event loss during secret rotation.
 */
const GRACE_WINDOW_SECONDS = 300;

// Raw Razorpay webhook envelope shape
interface RazorpayWebhookEnvelope {
  id?: string;
  entity?: string;
  account_id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RazorpayPaymentCapturedPayload & RazorpayPaymentAuthorizedEntity };
    settlement?: { entity?: RazorpaySettlementItem };
    refund?: { entity?: RazorpayRefundEntity };
    dispute?: { entity?: RazorpayDisputeEntity };
    order?: { entity?: RazorpayOrderEntity };
  };
}

// Settled events that route through the settlement mapper (existing behaviour).
const LEGACY_SETTLEMENT_EVENTS = new Set([
  'settlement.processed',
  'refund.created',
  'payment.failed',
]);

// Dispute lifecycle events keyed by Razorpay event name.
const DISPUTE_LIFECYCLE_MAP: Record<string, DisputeLifecycleType> = {
  'payment.dispute.created':      'dispute.created',
  'payment.dispute.under_review': 'dispute.under_review',
  'payment.dispute.won':          'dispute.won',
  'payment.dispute.lost':         'dispute.lost',
};

export class RazorpayWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'razorpay';

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    // Parse body early to extract account_id for per-connector secret lookup.
    // No write occurs between parse and HMAC validation.
    let envelope: RazorpayWebhookEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookEnvelope;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    const accountId = envelope.account_id ?? '';
    if (!accountId) {
      const err = new Error('account_id missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    const signatureHeader = (headers[RAZORPAY_HMAC_CONFIG.header] as string | undefined) ?? '';

    // Fetch the credential bundle. The callback is typed as returning { webhookSecret,
    // connectorLookupKey }, but the actual implementation may carry additional optional
    // fields from the composite secret bundle (structural typing allows this).
    const secretResult = await getSecret(accountId);
    const { webhookSecret } = secretResult;

    // ── Primary HMAC validation ──────────────────────────────────────────────
    const primaryValid = !!webhookSecret &&
      RAZORPAY_HMAC_CONFIG.validateWebhook(rawBody, signatureHeader, webhookSecret);

    if (!primaryValid) {
      // ── OLD-SECRET GRACE WINDOW ────────────────────────────────────────────
      // Check for a non-expired previous_webhook_secret in the bundle.
      // This handles the race window between secret rotation and in-flight events.
      const extendedResult = secretResult as unknown as Record<string, unknown>;
      const prevSecret = typeof extendedResult['previousWebhookSecret'] === 'string'
        ? extendedResult['previousWebhookSecret']
        : null;
      const prevExpiresAt = typeof extendedResult['previousWebhookSecretExpiresAt'] === 'string'
        ? extendedResult['previousWebhookSecretExpiresAt']
        : null;

      if (prevSecret && prevExpiresAt) {
        const expiresAtMs = Date.parse(prevExpiresAt);
        const isGraceWindowActive = !isNaN(expiresAtMs) && Date.now() < expiresAtMs;

        if (isGraceWindowActive && RAZORPAY_HMAC_CONFIG.validateWebhook(rawBody, signatureHeader, prevSecret)) {
          // Accepted via grace window — event was signed with the old secret
          // during the rotation transition period.
          return { lookupKey: accountId, parsedPayload: envelope };
        }
      }

      // Primary failed and no valid grace window — reject.
      const err = new Error('HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: accountId, parsedPayload: envelope };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { parsedBody, brandId, saltHex, requestId } = ctx;
    const envelope = parsedBody as RazorpayWebhookEnvelope;

    const eventName = envelope.event ?? '';
    const eventId = envelope.id ?? '';
    const createdAt = envelope.created_at ?? null;

    if (!eventId) {
      const err = new Error('Event id missing');
      (err as NodeJS.ErrnoException & { code: string }).code = 'REPLAY_REJECTED';
      throw err;
    }

    // ── payment.captured → map-table upsert (MB-1 HARD prerequisite) ─────────
    if (eventName === 'payment.captured') {
      const paymentEntity = envelope.payload?.payment?.entity;
      return {
        eventId,
        eventName: 'payment.captured',
        occurredAt: new Date().toISOString(),
        properties: {},
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
        sideEffect: paymentEntity
          ? async (_brandId: string, rawPgPool: pg.Pool, _reqId: string): Promise<void> => {
              const mapRow = mapPaymentWebhookToMapRow(_brandId, paymentEntity);
              if (!mapRow) return;
              const repo = new PgRazorpayOrderMapRepository(rawPgPool);
              await repo.upsert({
                brand_id: mapRow.brand_id,
                razorpay_order_id: mapRow.razorpay_order_id,
                shopify_order_id: mapRow.shopify_order_id,
                razorpay_payment_id: mapRow.razorpay_payment_id,
              });
            }
          : undefined,
        throwOnSideEffectError: true, // MB-1 HARD prerequisite — 500 so Razorpay retries
      };
    }

    // ── Legacy settlement events → existing settlement.live.v1 lane ──────────
    if (LEGACY_SETTLEMENT_EVENTS.has(eventName)) {
      const settlementEntity = envelope.payload?.settlement?.entity;
      if (!settlementEntity) {
        return {
          eventId: randomUUID(),
          eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
          occurredAt: new Date().toISOString(),
          properties: {},
          ageCheckTimestampSeconds: createdAt,
          dedupKey: eventId,
          skip: true,
        };
      }

      const mapped = mapSettlementItemToEvent(settlementEntity, brandId, saltHex);
      const bronzeEventId = uuidV5FromRazorpayWebhook(brandId, eventId);

      return {
        eventId: bronzeEventId,
        eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
      };
    }

    // ── refund.processed / refund.failed → settlement.live.v1 lane with entity_type='refund' ─
    if (eventName === 'refund.processed' || eventName === 'refund.failed') {
      const refundEntity = envelope.payload?.refund?.entity;
      if (!refundEntity) {
        return {
          eventId: randomUUID(),
          eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
          occurredAt: new Date().toISOString(),
          properties: {},
          ageCheckTimestampSeconds: createdAt,
          dedupKey: eventId,
          skip: true,
        };
      }

      const mapped = mapRefundWebhookToEvent(refundEntity, brandId, saltHex);
      // Use entity_type discriminator: refund.processed and refund.failed have distinct event names
      // so the same refund_id can appear in both without collision; eventId already differs.
      const bronzeEventId = uuidV5FromRazorpayWebhookWithType(brandId, eventId, eventName);

      return {
        eventId: bronzeEventId,
        eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
      };
    }

    // ── payment.dispute.* lifecycle → settlement.live.v1 lane with entity_type='dispute' ─
    const disputeLifecycle = DISPUTE_LIFECYCLE_MAP[eventName];
    if (disputeLifecycle !== undefined) {
      const disputeEntity = envelope.payload?.dispute?.entity;
      if (!disputeEntity) {
        return {
          eventId: randomUUID(),
          eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
          occurredAt: new Date().toISOString(),
          properties: {},
          ageCheckTimestampSeconds: createdAt,
          dedupKey: eventId,
          skip: true,
        };
      }

      const mapped = mapDisputeWebhookToEvent(disputeEntity, disputeLifecycle, brandId, saltHex);
      // Use eventName as discriminator so dispute.created and dispute.lost for the same
      // dispute_id produce DISTINCT Bronze rows (they carry different revenue semantics).
      const bronzeEventId = uuidV5FromRazorpayWebhookWithType(brandId, eventId, eventName);

      return {
        eventId: bronzeEventId,
        eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
      };
    }

    // ── order.paid → settlement.live.v1 lane with entity_type='order_paid' ───
    if (eventName === 'order.paid') {
      const orderEntity = envelope.payload?.order?.entity;
      if (!orderEntity) {
        return {
          eventId: randomUUID(),
          eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
          occurredAt: new Date().toISOString(),
          properties: {},
          ageCheckTimestampSeconds: createdAt,
          dedupKey: eventId,
          skip: true,
        };
      }

      const mapped = mapOrderPaidWebhookToEvent(orderEntity, brandId, saltHex);
      const bronzeEventId = uuidV5FromRazorpayWebhookWithType(brandId, eventId, 'order.paid');

      return {
        eventId: bronzeEventId,
        eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
      };
    }

    // ── payment.authorized → settlement.live.v1 lane with entity_type='payment_authorized' ─
    if (eventName === 'payment.authorized') {
      const paymentEntity = envelope.payload?.payment?.entity;
      if (!paymentEntity) {
        return {
          eventId: randomUUID(),
          eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
          occurredAt: new Date().toISOString(),
          properties: {},
          ageCheckTimestampSeconds: createdAt,
          dedupKey: eventId,
          skip: true,
        };
      }

      const mapped = mapPaymentAuthorizedToEvent(paymentEntity, brandId, saltHex);
      const bronzeEventId = uuidV5FromRazorpayWebhookWithType(brandId, eventId, 'payment.authorized');

      return {
        eventId: bronzeEventId,
        eventName: SETTLEMENT_LIVE_V1_EVENT_NAME,
        occurredAt: mapped.occurred_at,
        properties: mapped.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: createdAt,
        dedupKey: eventId,
        skip: false,
      };
    }

    void requestId; // logging only

    // Unknown events → fast-ack (no processing, no event loss).
    return {
      eventId,
      eventName,
      occurredAt: new Date().toISOString(),
      properties: {},
      ageCheckTimestampSeconds: null,
      dedupKey: null,
      skip: true,
    };
  }
}

// ── Re-export grace window constant for tests ─────────────────────────────────
export { GRACE_WINDOW_SECONDS };
