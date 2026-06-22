/**
 * RazorpayWebhookStrategy — per-provider Strategy for the WebhookPipeline.
 *
 * signatureVerify:
 *   Parses JSON body early to extract account_id (needed for per-connector secret lookup).
 *   Resolves webhook_secret via getSecret(accountId) then validates
 *   hex(HMAC-SHA256(rawBody, webhookSecret)) == X-Razorpay-Signature.
 *   Byte-compatible with legacy RazorpayHmac.validateWebhook().
 *
 * payloadMap:
 *   payment.captured → map-table upsert (MB-1 HARD prerequisite, throwOnSideEffectError=true).
 *   settlement.processed / refund.created / payment.failed → emit to live lane.
 *   Other events → fast-ack (skip=true).
 *
 * NOTE: the payloadMap signature dedup key = envelope.id (Razorpay opaque event ID).
 *       Age check = envelope.created_at (Unix seconds).
 */

import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { RAZORPAY_HMAC_CONFIG } from '../platform/HmacConfig.js';
import {
  mapPaymentWebhookToMapRow,
  mapSettlementItemToEvent,
  uuidV5FromRazorpayWebhook,
  SETTLEMENT_LIVE_V1_EVENT_NAME,
  type RazorpayPaymentCapturedPayload,
  type RazorpaySettlementItem,
} from '@brain/razorpay-mapper';
import { PgRazorpayOrderMapRepository } from '../../sources/payment/razorpay/infrastructure/repositories/PgRazorpayOrderMapRepository.js';

// Raw Razorpay webhook envelope shape
interface RazorpayWebhookEnvelope {
  id?: string;
  entity?: string;
  account_id?: string;
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RazorpayPaymentCapturedPayload };
    settlement?: { entity?: RazorpaySettlementItem };
  };
}

const SETTLEMENT_EVENTS = new Set(['settlement.processed', 'refund.created', 'payment.failed']);

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
    const { webhookSecret } = await getSecret(accountId);

    if (!webhookSecret || !RAZORPAY_HMAC_CONFIG.validateWebhook(rawBody, signatureHeader, webhookSecret)) {
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

    // payment.captured → map-table upsert (MB-1 HARD prerequisite).
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

    // Settlement events → emit to live lane.
    if (SETTLEMENT_EVENTS.has(eventName)) {
      const settlementEntity = envelope.payload?.settlement?.entity;
      if (!settlementEntity) {
        return { eventId: randomUUID(), eventName: SETTLEMENT_LIVE_V1_EVENT_NAME, occurredAt: new Date().toISOString(), properties: {}, ageCheckTimestampSeconds: createdAt, dedupKey: eventId, skip: true };
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

    void requestId; // logging only

    // Unknown events → fast-ack.
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
