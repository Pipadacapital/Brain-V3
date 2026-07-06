/**
 * GokwikWebhookStrategy — inbound GoKwik webhook (checkout / payments-optimisation, webhook-first).
 *
 * GoKwik is a CHECKOUT / PAYMENTS source (NOT logistics — the earlier AWB model was retired). Its
 * real-time seam is the webhook: GoKwik POSTs order / checkout / payment / risk events to our endpoint.
 * Delivery is POC-mediated (GoKwik points the webhook at our URL with a shared signing secret), so the
 * exact signature header + event naming are NOT in GoKwik's public docs. This strategy therefore:
 *
 *   - SIGNATURE: config-driven (buildGokwikHmacConfig — env GOKWIK_SIG_HEADER / GOKWIK_SIG_ENCODING),
 *     hex(HMAC-SHA256(rawBody, webhook_secret)) by default. FAIL-CLOSED: no webhook_secret on the
 *     connector bundle → reject (no spoofed events). The secret is the GoKwik-provided signing key,
 *     stored on the gokwik connector bundle as `webhook_secret`.
 *   - LOOKUP: brand resolved by gokwik_appid via resolve_gokwik_connector_by_merchant (0108). MT-1:
 *     the appid only SELECTS the connector row; brand_id comes from that row, never from the body.
 *   - MAPPING: DISCRIMINATE on the GoKwik event type → emit exactly ONE canonical Brain event via
 *     @brain/gokwik-mapper (order.live.v1 / checkout.abandoned.v1 / gokwik.checkout_started|step.v1 /
 *     payment.attempted|authorized.v1 / gokwik.rto_predict.v1). Money is bigint minor units +
 *     currency_code; raw email/phone/payment-id are hashed at the mapper boundary (raw NEVER emitted).
 *     These flow through silver_collector_event into the existing order / checkout-signal / payment marts.
 *
 * No event loss: an unknown/unmapped event type is fast-acked (skip:true) — never rejected. HMAC failure → 401.
 */

import type { FastifyRequest } from 'fastify';
import {
  mapGokwikOrder,
  mapGokwikCheckout,
  mapGokwikPayment,
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
} from '@brain/gokwik-mapper';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { buildGokwikHmacConfig } from '../platform/HmacConfig.js';

/** Header that may carry the merchant/app id (fallback when not in the body). */
const APPID_HEADER = 'x-gokwik-appid';

/** Body keys we probe for the appid lookup (POC-mediated; exact key unconfirmed → probe a few). */
const APPID_BODY_KEYS = ['appid', 'app_id', 'gokwik_appid', 'merchant_id', 'mid'] as const;

/** Keys carrying the GoKwik event type. */
const EVENT_TYPE_KEYS = ['event', 'event_type', 'type', 'topic'] as const;

/** Order id keys (probed for the RTO record, which reads order_id directly). */
const ORDER_ID_KEYS = ['moid', 'merchant_order_id', 'gokwik_order_id', 'order_id', 'oid'] as const;

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** A skipped (fast-ack) result for unknown/unmapped event types. */
function skipResult(occurredAt: string): PayloadMapResult {
  return {
    eventId: '',
    eventName: 'gokwik.unknown',
    occurredAt,
    properties: {},
    ageCheckTimestampSeconds: null,
    dedupKey: null,
    skip: true,
  };
}

export class GokwikWebhookStrategy implements IWebhookStrategy {
  readonly provider = 'gokwik';
  private readonly hmac = buildGokwikHmacConfig();

  async signatureVerify(
    rawBody: Buffer,
    headers: FastifyRequest['headers'],
    getSecret: (lookupKey: string) => Promise<{ webhookSecret: string; connectorLookupKey: string }>,
  ): Promise<SignatureVerifyResult> {
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      const err = new Error('Webhook body is not valid JSON');
      (err as NodeJS.ErrnoException & { code: string }).code = 'INVALID_JSON';
      throw err;
    }

    // appid (lookup key) from header first, then body. MT-1: it only selects the connector row; the
    // brand_id comes from the SECURITY-DEFINER resolver, never from this value directly.
    const appid =
      ((headers[APPID_HEADER] as string | undefined)?.trim()) ||
      firstString(envelope, APPID_BODY_KEYS) ||
      '';
    if (!appid) {
      const err = new Error('GoKwik appid missing (header or body)');
      (err as NodeJS.ErrnoException & { code: string }).code = 'LOOKUP_KEY_MISSING';
      throw err;
    }

    const signatureHeader = (headers[this.hmac.header] as string | undefined) ?? '';
    const { webhookSecret } = await getSecret(appid);
    // FAIL-CLOSED: empty secret (not configured) or bad signature → reject. No spoofed events.
    if (!webhookSecret || !this.hmac.validateWebhook(rawBody, signatureHeader, webhookSecret)) {
      const err = new Error('GoKwik webhook HMAC validation failed');
      (err as NodeJS.ErrnoException & { code: string }).code = 'HMAC_INVALID';
      throw err;
    }

    return { lookupKey: appid, parsedPayload: envelope };
  }

  async payloadMap(ctx: WebhookStrategyContext): Promise<PayloadMapResult> {
    const { parsedBody, brandId, saltHex, regionCode } = ctx;
    const body = (parsedBody ?? {}) as Record<string, unknown>;
    // SPEC: A.1.4 (WA-09) — connector.identity_fields flag (pipeline-resolved, fail-closed OFF).
    const identityFields = { emitInteropIdentifiers: ctx.identityFieldsEnabled === true };

    const rawType = firstString(body, EVENT_TYPE_KEYS) ?? '';
    const t = rawType.toLowerCase().replace(/\s+/g, '_');
    const nowIso = new Date().toISOString();

    // ── Order lifecycle → order.live.v1 (state via financial_status + cancelled_at + refunds) ──────
    if (t.startsWith('order')) {
      const mapped = mapGokwikOrder({ ...body, event_type: rawType }, brandId, saltHex, regionCode, 'real', identityFields);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── RTO-Predict risk → gokwik.rto_predict.v1 (categorical, verbatim risk_flag_raw) ─────────────
    if (t.includes('risk') || t.includes('rto')) {
      const orderId = firstString(body, ORDER_ID_KEYS);
      const requestId = firstString(body, ['request_id', 'req_id', 'prediction_id']);
      if (!orderId) return skipResult(nowIso);
      const mapped = mapGokwikRtoPredict({ ...body, order_id: orderId, request_id: requestId }, brandId);
      const eventId = uuidV5FromRtoPredict(brandId, orderId, requestId ?? mapped.occurred_at);
      return this.toResult(eventId, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── Checkout funnel → checkout.abandoned.v1 / gokwik.checkout_started|step.v1 ───────────────────
    if (t.includes('checkout')) {
      let kind: 'abandoned' | 'started' | 'step' | null = null;
      if (t.includes('abandon')) kind = 'abandoned';
      else if (t.includes('step')) kind = 'step';
      else if (t.includes('start') || t.includes('init') || t.includes('creat')) kind = 'started';
      if (kind === null) return skipResult(nowIso);
      const mapped = mapGokwikCheckout(body, brandId, saltHex, regionCode, kind, 'real', identityFields);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // ── Payment funnel → payment.attempted.v1 / payment.authorized.v1 ──────────────────────────────
    if (t.includes('payment') || t.includes('transaction')) {
      const authorized =
        t.includes('authoriz') || t.includes('captur') || t.includes('success') || t.includes('paid');
      const kind = authorized ? 'authorized' : 'attempted';
      const mapped = mapGokwikPayment(body, brandId, saltHex, regionCode, kind);
      return this.toResult(mapped.event_id, mapped.event_name, mapped.occurred_at, mapped.properties);
    }

    // Unknown / unmapped → fast-ack 200, no Kafka produce (no event loss, no junk in Bronze).
    return skipResult(nowIso);
  }

  /** Build a PayloadMapResult from a canonical mapped event. Dedup keys off the deterministic eventId. */
  private toResult(
    eventId: string,
    eventName: string,
    occurredAt: string,
    properties: object,
  ): PayloadMapResult {
    return {
      eventId,
      eventName,
      occurredAt,
      properties: properties as Record<string, unknown>,
      // No trusted provider timestamp guarantee → skip the age gate; the deterministic eventId
      // (per-state) is the dedup key (dedupKey null → pipeline uses eventId).
      ageCheckTimestampSeconds: null,
      dedupKey: null,
      skip: false,
    };
  }
}
