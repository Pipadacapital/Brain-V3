/**
 * ShiprocketWebhookStrategy — per-provider Strategy for the WebhookPipeline (Wave-C).
 *
 * VERIFICATION PRIMITIVE: x-api-key shared-token compare (not HMAC).
 * Shiprocket's tracking-webhook does not sign the body; it passes a static API key
 * in the X-Api-Key header. We call this the "token-compare" scheme:
 *   timingSafeEqual(Buffer.from(receivedToken), Buffer.from(storedToken))
 * The stored token is the `webhook_secret` field in the connector's secret bundle.
 *
 * FAIL-CLOSED: if the stored webhook_secret is unset (null / empty string), verification
 * ALWAYS fails — no spoofed events can enter the pipeline. This is the correct behavior
 * for a brand that has not yet configured their Shiprocket webhook token.
 *
 * LOOKUP KEY: Shiprocket does not carry a shop-domain or merchant-id header in the
 * tracking webhook. We use the `x-shiprocket-channel-id` header (if present), falling
 * back to `x-shiprocket-account-id`. The connector row is resolved by
 * resolve_shiprocket_connector_by_channel (SECURITY DEFINER DB fn — analogous to the
 * Razorpay account-resolver). Callers that don't set either header get LOOKUP_KEY_MISSING.
 *
 * PAYLOAD MAP: reuses packages/shiprocket-mapper for the canonical shape. The strategy
 * maps ONLY tracking/shipment-status update topics (shipment.update, shipment.delivered,
 * etc.). Non-shipment topics are fast-acked (skip=true).
 *
 * COMPLEMENTS POLL PATH: this receiver handles push events from Shiprocket's webhook
 * delivery; the existing repull job handles the trailing-window pull. The two paths
 * produce deterministic uuidV5 event_ids so Bronze dedup (ON CONFLICT DO NOTHING) prevents
 * duplicate records.
 *
 * EXTERNAL BLOCKER: The x-api-key value must be configured by the merchant in Shiprocket
 * → stored as `webhook_secret` in the connector's credential bundle. Until this is set,
 * verification fails closed (correct behavior — no fabricated data).
 */

import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type {
  IWebhookStrategy,
  SignatureVerifyResult,
  PayloadMapResult,
  WebhookStrategyContext,
} from '../platform/IWebhookStrategy.js';
import {
  mapShiprocketShipment,
  uuidV5FromShipment,
  SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
  type ShiprocketShipmentRecord,
} from '@brain/shiprocket-mapper';

// ── Topic constants ───────────────────────────────────────────────────────────

/**
 * Shiprocket webhook topic strings that carry shipment-status updates.
 * NOTE: The exact topic names must be confirmed against a live Shiprocket account
 * (EXTERNAL BLOCKER — see module-level doc). These are the documented values from
 * Shiprocket's developer guide (2024). Adjust on first live delivery.
 */
const SHIPMENT_TOPICS = new Set([
  'shipment.update',
  'shipment.delivered',
  'shipment.rto_initiated',
  'shipment.rto_delivered',
  'shipment.cancelled',
  'shipment.out_for_delivery',
  'tracking.update',   // alternative key used by some webhook configs
]);

// ── Token-compare helper (replaces HMAC for this provider) ───────────────────

/**
 * Constant-time token comparison (equivalent to HMAC validate for the token scheme).
 * Returns false immediately if either token is empty (fail-closed).
 */
function timingSafeTokenEqual(received: string, stored: string): boolean {
  if (!received || !stored) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Strategy ──────────────────────────────────────────────────────────────────

export class ShiprocketWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'shiprocket';

  /**
   * STEP 1 (NN-4): Extract the channel-id lookup key from headers and verify
   * the X-Api-Key token against the stored webhook_secret.
   *
   * Lookup key extraction order:
   *   1. x-shiprocket-channel-id header (preferred — set per-channel in Shiprocket dashboard)
   *   2. x-shiprocket-account-id header (fallback for account-level webhook configs)
   *
   * Throws LOOKUP_KEY_MISSING if neither header is present.
   * Throws HMAC_INVALID if the token check fails or the stored webhook_secret is unset.
   */
  async signatureVerify(
    _rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    // Extract lookup key from headers — used to resolve the connector row.
    const channelId =
      (headers['x-shiprocket-channel-id'] as string | undefined)?.trim() ||
      (headers['x-shiprocket-account-id'] as string | undefined)?.trim() ||
      '';

    if (!channelId) {
      const err = new Error(
        'x-shiprocket-channel-id / x-shiprocket-account-id header missing',
      );
      (err as NodeJS.ErrnoException & { code: string }).code = 'LOOKUP_KEY_MISSING';
      throw err;
    }

    // Received token from X-Api-Key header (lowercased by Fastify).
    const receivedToken = (headers['x-api-key'] as string | undefined) ?? '';

    // Fetch the stored webhook_secret for this channel.
    const { webhookSecret } = await getSecret(channelId);

    // FAIL-CLOSED: empty/unset webhook_secret → reject immediately.
    // This correctly surfaces 'not connected / needs credentials' for brands that have
    // not yet stored their Shiprocket API key. No spoofed events enter.
    if (!webhookSecret) {
      const err = new Error(
        'Shiprocket webhook_secret not configured — connector needs credentials',
      );
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    if (!timingSafeTokenEqual(receivedToken, webhookSecret)) {
      const err = new Error('X-Api-Key token validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    // Parse the body early so payloadMap doesn't double-parse.
    let parsedPayload: unknown = null;
    try {
      parsedPayload = JSON.parse(_rawBody.toString('utf8'));
    } catch {
      const err = new Error('Shiprocket webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    return { lookupKey: channelId, parsedPayload };
  }

  /**
   * STEP 2: Map the verified Shiprocket payload to a CollectorEventV1-ready shape.
   *
   * Supports tracking/shipment-status update topics. Non-shipment topics → fast-ack (skip=true).
   * AWB is hashed at the boundary (I-S02). order_id is NOT PII and passes through.
   */
  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { parsedBody, brandId, saltHex } = ctx;

    const body = parsedBody as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      const err = new Error('Shiprocket webhook payload is not a JSON object');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_PAYLOAD';
      throw err;
    }

    // Resolve the topic — Shiprocket may send it under different keys.
    const topic =
      (body['event'] as string | undefined) ??
      (body['topic'] as string | undefined) ??
      (body['webhook_type'] as string | undefined) ??
      '';

    // Fast-ack non-shipment topics — no event loss.
    if (topic && !SHIPMENT_TOPICS.has(topic.toLowerCase())) {
      return {
        eventId: '',
        eventName: '',
        occurredAt: '',
        properties: {},
        ageCheckTimestampSeconds: null,
        dedupKey: null,
        skip: true,
      };
    }

    // Extract the shipment data — Shiprocket may nest it under 'shipment' or 'data'.
    const shipmentData: Record<string, unknown> =
      (body['shipment'] as Record<string, unknown> | undefined) ??
      (body['data'] as Record<string, unknown> | undefined) ??
      body;

    const record: ShiprocketShipmentRecord = {
      awb: (shipmentData['awb'] as string | null | undefined) ??
           (shipmentData['awb_code'] as string | null | undefined) ??
           null,
      order_id: (shipmentData['order_id'] as string | null | undefined) ??
                (shipmentData['channel_order_id'] as string | null | undefined) ??
                null,
      status: (shipmentData['current_status'] as string | null | undefined) ??
              (shipmentData['status'] as string | null | undefined) ??
              null,
      status_changed_at: (shipmentData['status_date'] as string | null | undefined) ??
                         (shipmentData['status_changed_at'] as string | null | undefined) ??
                         new Date().toISOString(),
      payment_method: (shipmentData['payment_method'] as string | null | undefined) ?? null,
      pincode: (shipmentData['pincode'] as string | null | undefined) ??
               (shipmentData['pickup_pincode'] as string | null | undefined) ??
               null,
      courier: (shipmentData['courier_name'] as string | null | undefined) ??
               (shipmentData['courier'] as string | null | undefined) ??
               null,
    };

    // Require order_id — it is the ledger spine key.
    if (!record.order_id) {
      const err = new Error('Shiprocket webhook payload missing order_id (ledger spine key)');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_PAYLOAD';
      throw err;
    }

    // Map to canonical shipment event (AWB hashed at boundary — I-S02).
    const mapped = mapShiprocketShipment(record, brandId, saltHex, 'real');

    const awb = String(record.awb ?? '').trim() || 'unknown';
    const status = mapped.properties.status;
    const statusChangedAt = mapped.properties.status_changed_at;

    const eventId = uuidV5FromShipment(brandId, awb, status, statusChangedAt);
    const ageCheckTimestampSeconds = Math.floor(
      new Date(statusChangedAt).getTime() / 1000,
    );

    return {
      eventId,
      eventName: SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
      occurredAt: mapped.occurred_at,
      properties: mapped.properties as unknown as Record<string, unknown>,
      ageCheckTimestampSeconds,
      dedupKey: eventId,
      skip: false,
    };
  }
}
