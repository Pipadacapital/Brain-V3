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
 * Razorpay account-resolver). When NEITHER header is present (some merchant webhook configs
 * can't set custom headers), the injected TOKEN FALLBACK resolves the tenant from the
 * Brain-minted X-Api-Key itself; only when that also matches nothing → LOOKUP_KEY_MISSING.
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
  mapShiprocketReturn,
  uuidV5FromShipment,
  uuidV5FromReturn,
  SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
  SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME,
  type ShiprocketShipmentRecord,
} from '@brain/shiprocket-mapper';

// ── Topic constants ───────────────────────────────────────────────────────────

/**
 * Shiprocket webhook topic strings that carry FORWARD shipment-status updates (SR-3).
 *
 * Widened from the original 7 to the full spec forward + RTO lifecycle. Previously everything
 * outside the narrow set was fast-acked `skip=true` (silently dropped) — so dedicated pushes for
 * `delayed`/`exception`/`lost`/`destroyed` and most RTO sub-states were lost (only repull caught
 * them via the trailing window). These are now ADMITTED and mapped to the canonical
 * `shiprocket.shipment_status.v1` event; the status string is classified downstream by the shared
 * @brain/logistics-status authority (this allowlist gates topic→map, NOT terminal classification).
 *
 * RETURN family (`return.*`) is DELIBERATELY NOT here — returns are a SEPARATE canonical event
 * (`shiprocket.return_status.v1` + a new RETURN_* class) owned by Slice 2 (SR-4). Until that lands,
 * a `return.*` topic is NOT in this set, so it falls through to fast-ack `skip=true` (no event loss,
 * but also NOT yet mapped). Slice 2 must add a dedicated RETURN_TOPICS allowlist + return mapper and
 * must NOT route returns through SHIPMENT_TOPICS (a `return.completed` mapped as a shipment status
 * would mis-classify to DELIVERED — the false-delivery bug SR-4 fixes).
 *
 * NOTE: exact topic names must be confirmed against a live Shiprocket account (EXTERNAL BLOCKER,
 * SR-7). These are the documented Shiprocket developer-guide values + the `shipment.<state>` and
 * `tracking.update` conventions already in use. Matched case-insensitively (lower-cased before test).
 */
const SHIPMENT_TOPICS = new Set([
  // Generic / catch-all status pushes
  'shipment.update',
  'tracking.update',
  // Forward lifecycle
  'shipment.created',
  'shipment.pickup',
  'shipment.pickup_scheduled',
  'shipment.pickup_generated',
  'shipment.picked_up',
  'shipment.in_transit',
  'shipment.out_for_delivery',
  'shipment.delayed',
  'shipment.exception',
  'shipment.ndr',
  'shipment.lost',
  'shipment.destroyed',
  'shipment.delivered',
  'shipment.cancelled',
  'shipment.canceled',
  // RTO family (forward-RTO lifecycle — terminal class resolved by @brain/logistics-status)
  'shipment.rto',
  'shipment.rto_initiated',
  'shipment.rto_in_transit',
  'shipment.rto_out_for_delivery',
  'shipment.rto_ofd',
  'shipment.rto_undelivered',
  'shipment.rto_acknowledged',
  'shipment.rto_rejected',
  'shipment.rto_ndr',
  'shipment.rto_disposed',
  'shipment.rto_delivered',
]);

/**
 * SR-4: Shiprocket RETURN topics. These map to the SEPARATE canonical `shiprocket.return_status.v1`
 * event (NOT the shipment lane) via mapShiprocketReturn → classifyReturnStatus. Routing a return
 * through SHIPMENT_TOPICS would mis-classify `return.completed`/`return.delivered` as a forward
 * DELIVERED (the false-delivery / revenue-truth bug SR-4 fixes), so the two allowlists are disjoint
 * and a return topic NEVER reaches mapShiprocketShipment. Topic names are confirm-at-real-account
 * (EXTERNAL BLOCKER SR-7); matched case-insensitively.
 */
const RETURN_TOPICS = new Set([
  'return.created',
  'return.initiated',
  'return.requested',
  'return.approved',
  'return.picked_up',
  'return.pickup',
  'return.in_transit',
  'return.out_for_pickup',
  'return.delivered',
  'return.received',
  'return.completed',
  'return.closed',
  'return.refunded',
  'return.update',
]);

// ── Token-compare helper (replaces HMAC for this provider) ───────────────────

/**
 * Constant-time token comparison (equivalent to HMAC validate for the token scheme).
 * Returns false immediately if either token is empty (fail-closed).
 * Exported: the registerWebhookRoutes token-fallback resolver reuses it so BOTH compares
 * (tenant resolution AND verification) are timing-safe.
 */
export function timingSafeTokenEqual(received: string, stored: string): boolean {
  if (!received || !stored) return false;
  const a = Buffer.from(received, 'utf8');
  const b = Buffer.from(stored, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * TENANT-ROUTING FALLBACK (SR polish, 2026-07-12): resolve the connector lookup key from the
 * presented X-Api-Key token alone. Shiprocket's webhook UI lets some merchants configure ONLY a
 * URL + token — they cannot attach the custom x-shiprocket-channel-id header — which previously
 * hard-failed every delivery with LOOKUP_KEY_MISSING. Because the token is Brain-MINTED
 * (high-entropy, unique per connector — SR-2 provisionGeneratedSecrets), it uniquely identifies
 * the tenant: the resolver timing-safe-compares it against each connected Shiprocket connector's
 * stored webhook_secret and returns that connector's routing key (channel_id, else account_key),
 * or null when nothing matches (→ fail-closed LOOKUP_KEY_MISSING as before).
 */
export type ShiprocketTokenLookupFallback = (receivedToken: string) => Promise<string | null>;

// ── Strategy ──────────────────────────────────────────────────────────────────

export class ShiprocketWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'shiprocket';

  constructor(
    /** Optional header-less tenant resolution by minted token (see ShiprocketTokenLookupFallback). */
    private readonly resolveLookupKeyByToken?: ShiprocketTokenLookupFallback,
  ) {}

  /**
   * STEP 1 (NN-4): Extract the channel-id lookup key from headers and verify
   * the X-Api-Key token against the stored webhook_secret.
   *
   * Lookup key extraction order:
   *   1. x-shiprocket-channel-id header (preferred — set per-channel in Shiprocket dashboard)
   *   2. x-shiprocket-account-id header (fallback for account-level webhook configs)
   *   3. TOKEN FALLBACK: when neither header is present (the merchant's webhook config can't
   *      set custom headers), resolve the tenant from the Brain-minted X-Api-Key itself via the
   *      injected resolver. The resolved key still flows through the SAME getSecret + timing-safe
   *      compare below — the fallback only ROUTES, it never skips verification.
   *
   * Throws LOOKUP_KEY_MISSING if no header is present and the token resolves no connector.
   * Throws HMAC_INVALID if the token check fails or the stored webhook_secret is unset.
   */
  async signatureVerify(
    _rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    // Received token from X-Api-Key header (lowercased by Fastify).
    const receivedToken = (headers['x-api-key'] as string | undefined) ?? '';

    // Extract lookup key from headers — used to resolve the connector row.
    let channelId =
      (headers['x-shiprocket-channel-id'] as string | undefined)?.trim() ||
      (headers['x-shiprocket-account-id'] as string | undefined)?.trim() ||
      '';

    // Header-less delivery → resolve the tenant from the minted token (fail-closed on no match).
    if (!channelId && receivedToken && this.resolveLookupKeyByToken) {
      channelId = (await this.resolveLookupKeyByToken(receivedToken))?.trim() ?? '';
    }

    if (!channelId) {
      const err = new Error(
        'x-shiprocket-channel-id / x-shiprocket-account-id header missing and the X-Api-Key token matched no connector',
      );
      (err as NodeJS.ErrnoException & { code: string }).code = 'LOOKUP_KEY_MISSING';
      throw err;
    }

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
    const { parsedBody, brandId, saltHex, regionCode } = ctx;

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
    const lowerTopic = topic.toLowerCase();
    const isReturn = RETURN_TOPICS.has(lowerTopic);
    const isShipment = SHIPMENT_TOPICS.has(lowerTopic);

    // Fast-ack any topic that is neither a known shipment NOR a known return topic — no event loss.
    if (topic && !isShipment && !isReturn) {
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

    // Extract the shipment/return data — Shiprocket may nest it under 'shipment', 'return' or 'data'.
    const shipmentData: Record<string, unknown> =
      (body['return'] as Record<string, unknown> | undefined) ??
      (body['shipment'] as Record<string, unknown> | undefined) ??
      (body['data'] as Record<string, unknown> | undefined) ??
      body;

    // For a return push, the body may carry no explicit status — derive it from the topic suffix
    // (e.g. 'return.picked_up' → 'picked_up') so classifyReturnStatus can still resolve the stage.
    const returnTopicStatus = isReturn ? lowerTopic.replace(/^return\./, '') : null;

    const record: ShiprocketShipmentRecord = {
      awb: (shipmentData['awb'] as string | null | undefined) ??
           (shipmentData['awb_code'] as string | null | undefined) ??
           null,
      // channel_order_id FIRST — the merchant/channel (Shopify) order id joins to the order/revenue marts;
      // Shiprocket's own order_id ("SLW…") is an internal ref that joins to nothing. Preferring order_id
      // stranded shipment outcomes off the order spine. Matches the repull client field-map fix + line-27 contract.
      order_id: (shipmentData['channel_order_id'] as string | null | undefined) ??
                (shipmentData['order_id'] as string | null | undefined) ??
                null,
      status: (shipmentData['current_status'] as string | null | undefined) ??
              (shipmentData['status'] as string | null | undefined) ??
              returnTopicStatus ??
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
      // SR-6: raw phone/email captured here → hashed at the mapper boundary, raw DROPPED.
      customer_phone: (shipmentData['customer_phone'] as string | null | undefined) ??
                      (shipmentData['phone'] as string | null | undefined) ?? null,
      customer_email: (shipmentData['customer_email'] as string | null | undefined) ??
                      (shipmentData['email'] as string | null | undefined) ?? null,
    };

    // Require order_id — it is the ledger spine key.
    if (!record.order_id) {
      const err = new Error('Shiprocket webhook payload missing order_id (ledger spine key)');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_PAYLOAD';
      throw err;
    }

    const awb = String(record.awb ?? '').trim() || 'unknown';

    // ── SR-4 RETURN lane: map to the SEPARATE canonical shiprocket.return_status.v1 event. ──────────
    if (isReturn) {
      const mappedReturn = mapShiprocketReturn(record, brandId, saltHex, 'real', regionCode);
      const status = mappedReturn.properties.status;
      const statusChangedAt = mappedReturn.properties.status_changed_at;
      const eventId = uuidV5FromReturn(brandId, awb, status, statusChangedAt);
      return {
        eventId,
        eventName: SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME,
        occurredAt: mappedReturn.occurred_at,
        properties: mappedReturn.properties as unknown as Record<string, unknown>,
        ageCheckTimestampSeconds: Math.floor(new Date(statusChangedAt).getTime() / 1000),
        dedupKey: eventId,
        skip: false,
      };
    }

    // ── Forward shipment lane: canonical shiprocket.shipment_status.v1 (AWB hashed — I-S02). ────────
    const mapped = mapShiprocketShipment(record, brandId, saltHex, 'real', regionCode);
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
