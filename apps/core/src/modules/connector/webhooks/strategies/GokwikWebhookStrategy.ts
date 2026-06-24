/**
 * GokwikWebhookStrategy — inbound GoKwik webhook (real-time payment / order / delivery status).
 *
 * GoKwik's real-time data seam (besides the settlement pull) is webhooks: GoKwik POSTs status events
 * to our endpoint. Delivery is POC-mediated (GoKwik's team points the webhook at our URL with a shared
 * signing secret — there is no self-serve dashboard toggle, per the connector's research note), so the
 * exact signature header + payload schema are NOT in GoKwik's public docs. This strategy is therefore:
 *
 *   - SIGNATURE: config-driven (buildGokwikHmacConfig — env GOKWIK_SIG_HEADER / GOKWIK_SIG_ENCODING),
 *     hex(HMAC-SHA256(rawBody, webhook_secret)) by default. FAIL-CLOSED: no webhook_secret on the
 *     connector bundle → reject (no spoofed events). The secret is the GoKwik-provided signing key,
 *     stored on the gokwik connector bundle as `webhook_secret`.
 *   - LOOKUP: brand resolved by gokwik_appid (the non-secret app id stored at connect, migration 0030)
 *     via resolve_gokwik_connector_by_merchant (0108). appid is read from a header or the body.
 *   - MAPPING: I-S02-safe. We do NOT blind-dump the payload (GoKwik order/payment events carry PII).
 *     We map an EXPLICIT allowlist of known-safe fields (ids / status / amount / currency / timestamps)
 *     and HASH email/phone with the per-brand salt. Everything else is dropped. A content hash of the
 *     raw body is kept for traceability (no PII). Emits `gokwik.webhook.v1` to the live lane → Bronze;
 *     Silver modelling of GoKwik status is refined once real payloads are observed.
 *
 * No event loss: unknown/extra fields are ignored, never rejected (fast-ack). HMAC failure → 401.
 */

import type { FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { hashIdentifier } from '@brain/identity-core';
import { hashToUuidShaped } from '@brain/connector-core';
import type { IWebhookStrategy, SignatureVerifyResult, PayloadMapResult, WebhookStrategyContext } from '../platform/IWebhookStrategy.js';
import { buildGokwikHmacConfig } from '../platform/HmacConfig.js';

export const GOKWIK_WEBHOOK_EVENT_NAME = 'gokwik.webhook.v1';

/** Header that may carry the merchant/app id (fallback when not in the body). */
const APPID_HEADER = 'x-gokwik-appid';

/** Body keys we probe for the appid lookup (POC-mediated; exact key unconfirmed → probe a few). */
const APPID_BODY_KEYS = ['appid', 'app_id', 'gokwik_appid', 'merchant_id', 'mid'] as const;

/** Known-safe scalar fields to carry into Bronze (NO PII). Probed across common GoKwik namings. */
const SAFE_STRING_KEYS = [
  'event', 'event_type', 'type', 'topic',
  'order_id', 'order_number', 'moid', 'merchant_order_id', 'gokwik_order_id', 'oid',
  'status', 'order_status', 'payment_status', 'financial_status', 'fulfillment_status', 'delivery_status',
  'payment_method', 'payment_mode', 'currency', 'currency_code',
  'awb', 'awb_number', 'courier', 'courier_name', 'tracking_id',
  'created_at', 'updated_at', 'timestamp', 'event_time',
] as const;

/** Amount-ish fields (kept as raw strings — units unknown until confirmed; the mapper decides minor). */
const AMOUNT_KEYS = ['amount', 'total', 'order_total', 'amount_minor', 'total_minor'] as const;

/** PII keys → hashed (never stored raw — I-S02). */
const EMAIL_KEYS = ['email', 'customer_email', 'user_email'] as const;
const PHONE_KEYS = ['phone', 'customer_phone', 'mobile', 'user_phone', 'contact'] as const;

function firstString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
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

    // I-S02: build a curated, PII-safe properties object — explicit allowlist, never a raw dump.
    const properties: Record<string, unknown> = { source: 'gokwik' };
    for (const k of SAFE_STRING_KEYS) {
      const v = firstString(body, [k]);
      if (v !== null) properties[k] = v;
    }
    const amount = firstString(body, AMOUNT_KEYS);
    if (amount !== null) properties['amount_raw'] = amount; // units unconfirmed → raw; Silver normalises

    // PII → hashed with the per-brand salt (never raw).
    const email = firstString(body, EMAIL_KEYS);
    if (email) properties['email_hash'] = hashIdentifier(email, 'email', saltHex, regionCode);
    const phone = firstString(body, PHONE_KEYS);
    if (phone) properties['phone_hash'] = hashIdentifier(phone, 'phone', saltHex, regionCode);

    // Traceability without PII: a content hash of the raw body (deterministic, reversible-proof).
    const contentHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    properties['content_hash'] = contentHash;

    const eventType = firstString(body, ['event', 'event_type', 'type', 'topic']) ?? 'unknown';
    const orderRef = firstString(body, ['order_id', 'moid', 'merchant_order_id', 'gokwik_order_id', 'oid']);
    // Deterministic event id per (brand, eventType, orderRef-or-contentHash) → idempotent re-delivery.
    const dedupBasis = `gokwik:${brandId}:${eventType}:${orderRef ?? contentHash}`;
    const eventId = hashToUuidShaped(dedupBasis);

    const occurredAt =
      firstString(body, ['event_time', 'timestamp', 'updated_at', 'created_at']) ?? new Date().toISOString();

    return {
      eventId,
      eventName: GOKWIK_WEBHOOK_EVENT_NAME,
      // occurredAt may be a non-ISO string from GoKwik; fall back to now() if it doesn't parse.
      occurredAt: Number.isNaN(Date.parse(occurredAt)) ? new Date().toISOString() : new Date(occurredAt).toISOString(),
      properties,
      ageCheckTimestampSeconds: null, // no trusted provider timestamp → rely on Redis dedup by eventId
      dedupKey: dedupBasis,
      skip: false,
    };
  }
}
