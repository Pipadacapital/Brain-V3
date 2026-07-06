// SPEC: WA.1.10 — golden dataset event envelopes, grounded in the LIVE shapes (§1.10)
//
// ONE envelope for everything on the collector lane: CollectorEventV1
// (packages/contracts/src/events/sample.collector.event.v1.ts) — the same shape the
// served /pixel.js, tools/pixel-fixture/*.mjs, and the connector WebhookPipeline
// (apps/core .../platform/WebhookPipeline.ts:414–423) produce.
//
//  - PIXEL lane events carry properties.install_token (R2 tenant derivation) +
//    top-level consent_flags (R3) — exactly like seed-touchpoints.mjs.
//  - SERVER-TRUSTED connector canonicals (order.live.v1, refund.recorded.v1,
//    shiprocket.shipment_status.v1, gokwik.*) carry NO install_token / consent —
//    the Silver gate trusts the claimed brand_id (silver_collector_event.py lane split).

import type { CollectorEventV1 } from '@brain/contracts';
import { deterministicUuid } from './ids.js';
import type { GoldenBrand, GoldenChannel } from './fixtures.js';

/** R3 consent posture for a pixel event. */
export type ConsentMode = 'granted' | 'absent' | 'denied_analytics';

export const CONSENT_GRANTED = {
  analytics: true,
  marketing: true,
  personalization: true,
  ai_processing: true,
} as const;

/** `analytics:false` — passes today's presence-only R3 gate (documented reality, AMD-04). */
export const CONSENT_DENIED_ANALYTICS = {
  analytics: false,
  marketing: false,
  personalization: false,
  ai_processing: false,
} as const;

export interface GoldenEvent {
  /** Logical lane → JSONL file / Kafka topic suffix. */
  readonly lane: 'collector.event.v1' | 'shopify.orders.raw.v1';
  readonly occurredAtMs: number;
  readonly eventId: string;
  readonly value: Record<string, unknown>;
}

export interface PixelEventInput {
  readonly brand: GoldenBrand;
  readonly eventName: string;
  readonly occurredAtMs: number;
  readonly anonId: string;
  readonly sessionId: string;
  readonly channel: GoldenChannel;
  readonly landingPath: string;
  readonly uaClass: 'desktop' | 'mobile';
  readonly consent: ConsentMode;
  /** Event-specific extras merged into the properties bag (page_type, product_handle, order_id, hashed_customer_email …). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Deterministic click-id value when the channel carries one. */
  readonly clickId?: string;
}

/** Build a PIXEL-lane CollectorEventV1 — same bag layout seed-touchpoints.mjs lands live. */
export function buildPixelEvent(input: PixelEventInput): GoldenEvent {
  const {
    brand, eventName, occurredAtMs, anonId, sessionId, channel, landingPath, uaClass, consent, extra, clickId,
  } = input;
  const eventId = deterministicUuid('pixel-event', brand.id, anonId, sessionId, eventName, String(occurredAtMs));
  const clickIds: Record<string, string> = {};
  if (channel.clickIdKey && clickId) clickIds[channel.clickIdKey] = clickId;

  const envelope: CollectorEventV1 = {
    schema_version: '1',
    event_id: eventId,
    brand_id: brand.id, // PARTITIONING ONLY — Silver R2 derives the authoritative brand from install_token
    correlation_id: deterministicUuid('corr', eventId),
    event_name: eventName,
    occurred_at: new Date(occurredAtMs).toISOString(),
    ...(consent === 'granted' ? { consent_flags: { ...CONSENT_GRANTED } } : {}),
    ...(consent === 'denied_analytics' ? { consent_flags: { ...CONSENT_DENIED_ANALYTICS } } : {}),
    // consent === 'absent' → NO consent_flags key: R3 routes the event to silver_consent_rejected.
    properties: {
      install_token: brand.installToken, // R2 tenant-key derivation input
      brain_anon_id: anonId,
      session_id: sessionId,
      landing_path: landingPath,
      referrer: channel.referrer,
      utm: { ...channel.utm },
      click_ids: clickIds,
      device: { ua_class: uaClass, viewport: uaClass === 'desktop' ? '1440x900' : '390x844' },
      collector_version: 'testing-golden@1',
      ...(extra ?? {}),
    },
  };
  return { lane: 'collector.event.v1', occurredAtMs, eventId, value: envelope as unknown as Record<string, unknown> };
}

export interface CanonicalEventInput {
  readonly brand: GoldenBrand;
  readonly eventName: string;
  readonly eventId: string;
  readonly occurredAtIso: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/**
 * Wrap a connector-mapped canonical event ({event_name, occurred_at, properties})
 * into the CollectorEventV1 envelope exactly like WebhookPipeline does (brand_id from
 * the connector row — server-trusted lane; no install_token, no consent_flags).
 * ingested_at is intentionally OMITTED (volatile — set by the real pipeline at ingest).
 */
export function wrapCanonicalEvent(input: CanonicalEventInput): GoldenEvent {
  const occurredAtMs = Date.parse(input.occurredAtIso);
  const envelope: CollectorEventV1 = {
    schema_version: '1',
    event_id: input.eventId,
    brand_id: input.brand.id, // server-derived (MT-1) — trusted by the Silver gate
    correlation_id: deterministicUuid('corr', input.eventId),
    event_name: input.eventName,
    occurred_at: new Date(occurredAtMs).toISOString(),
    properties: { ...input.properties },
  };
  return { lane: 'collector.event.v1', occurredAtMs, eventId: input.eventId, value: envelope as unknown as Record<string, unknown> };
}
