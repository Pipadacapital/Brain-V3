// SPEC: WA.1.10 — golden dataset scenario builders (§1.10 scenario matrix)
//
// Every spec-listed scenario is built here, per persona, from the REAL producer shapes:
//   - pixel-lane events mirror the served /pixel.js emit() + seed-touchpoints.mjs bag,
//   - Shopify orders/refunds run through the REAL @brain/shopify-mapper (raw fixture →
//     mapOrderToEvent / mapRefundToDraft), and the raw fixture doubles as the
//     shopify.orders.raw.v1 raw-lane payload,
//   - GoKwik COD orders + checkout signals run through the REAL @brain/gokwik-mapper,
//   - Shiprocket delivered/RTO statuses run through the REAL @brain/shiprocket-mapper,
//   - Cedar (GCC / KWD scale-3) orders are built at the canonical order.live.v1 property
//     layer with CORRECT 3-decimal minor units — the shopify-mapper's decimalStringToMinor
//     is hard-coded scale-2 (would throw on "12.500"), a documented Wave-C gap (C.5.3);
//     the golden dataset must still carry correct KWD minor units for the money invariant.
//
// Scenario matrix (spec §1.10):
//   anonymous_only · anon_to_known_mid_session · multi_device · shared_device_family ·
//   cod_order (delivered + rto) · refund · gcc_kwd_order · consent_off (absent + denied) ·
//   late_identify_day7 (A.5.5 day-7 re-stitch seed)

import {
  mapOrderToEvent,
  mapRefundToDraft,
  uuidV5FromOrderLive,
  ORDER_LIVE_V1_EVENT_NAME,
  type ShopifyOrderShape,
  type ShopifyRefundShape,
} from '@brain/shopify-mapper';
import { mapGokwikOrder, mapGokwikCheckout } from '@brain/gokwik-mapper';
import { mapShiprocketShipment } from '@brain/shiprocket-mapper';
import { resolveDevSaltHex, hashIdentifier } from '@brain/identity-core';
import { Rand } from './prng.js';
import { deterministicUuid, pixelIdentifyEmailHash } from './ids.js';
import {
  CATALOG, CHANNELS, LANDINGS, personaEmail, personaPhoneIN,
  type GoldenBrand, type GoldenChannel, type GoldenProduct,
} from './fixtures.js';
import { buildPixelEvent, wrapCanonicalEvent, type ConsentMode, type GoldenEvent } from './envelopes.js';

export type ScenarioKey =
  | 'anonymous_only'
  | 'anon_to_known_mid_session'
  | 'multi_device'
  | 'shared_device_family'
  | 'cod_order'
  | 'refund'
  | 'gcc_kwd_order'
  | 'consent_off'
  | 'late_identify_day7';

export interface ScenarioBrandStats {
  personas: number;
  events: number;
  orders: number;
  purchasers: number;
  identifiedPurchasers: number;
  /** First few persona ids — the scenario→customer coverage map. */
  samplePersonaIds: string[];
  sampleAnonIds: string[];
  sampleOrderIds: string[];
}

export interface BrandBuildResult {
  events: GoldenEvent[];
  rawShopifyOrders: Array<Record<string, unknown>>;
  stats: Partial<Record<ScenarioKey, ScenarioBrandStats>>;
}

const DAY_MS = 86_400_000;

interface Persona {
  readonly personaId: string;
  readonly ordinal: number;
  readonly email: string;
  readonly anonIds: readonly string[];
}

/** Per-brand deterministic builder. All randomness comes from forked substreams. */
export class BrandScenarioBuilder {
  private readonly salt: string;
  private readonly events: GoldenEvent[] = [];
  private readonly rawShopifyOrders: Array<Record<string, unknown>> = [];
  private readonly stats: Partial<Record<ScenarioKey, ScenarioBrandStats>> = {};
  private orderSeq = 0;
  private personaOrdinal = 0;

  constructor(
    private readonly brand: GoldenBrand,
    private readonly rand: Rand,
    private readonly epochMs: number,
    private readonly spanDays: number,
  ) {
    this.salt = resolveDevSaltHex(brand.id);
  }

  build(counts: Partial<Record<ScenarioKey, number>>): BrandBuildResult {
    for (const [key, n] of Object.entries(counts) as Array<[ScenarioKey, number]>) {
      if (!n) continue;
      const r = this.rand.fork(key);
      for (let i = 0; i < n; i++) this.runScenario(key, i, r.fork(String(i)));
    }
    return { events: this.events, rawShopifyOrders: this.rawShopifyOrders, stats: this.stats };
  }

  // ── scenario dispatch ────────────────────────────────────────────────────────

  private runScenario(key: ScenarioKey, idx: number, r: Rand): void {
    switch (key) {
      case 'anonymous_only': return this.anonymousOnly(key, idx, r);
      case 'anon_to_known_mid_session': return this.anonToKnown(key, idx, r);
      case 'multi_device': return this.multiDevice(key, idx, r);
      case 'shared_device_family': return this.sharedDeviceFamily(key, idx, r);
      case 'cod_order': return this.codOrder(key, idx, r);
      case 'refund': return this.refund(key, idx, r);
      case 'gcc_kwd_order': return this.gccKwdOrder(key, idx, r);
      case 'consent_off': return this.consentOff(key, idx, r);
      case 'late_identify_day7': return this.lateIdentifyDay7(key, idx, r);
    }
  }

  // ── scenarios ────────────────────────────────────────────────────────────────

  /** Sessions that never identify and never purchase. */
  private anonymousOnly(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const sessions = r.int(1, 3);
    let n = 0;
    for (let s = 0; s < sessions; s++) {
      n += this.browseSession(p, 0, s, r.fork(`s${s}`), 'granted');
    }
    this.record(key, p, n, { orders: 0, purchaser: false, identified: false });
  }

  /** Anonymous browsing, then identify MID-SESSION, then order in the same session. */
  private anonToKnown(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    let n = this.browseSession(p, 0, 0, r.fork('warmup'), 'granted');
    n += this.conversionSession(p, 0, 1, r.fork('convert'), { identifyMidSession: true });
    this.record(key, p, n, { orders: 1, purchaser: true, identified: true });
  }

  /** Same customer on 2–3 devices (distinct anon ids), identified on each, buys on the last. */
  private multiDevice(key: ScenarioKey, idx: number, r: Rand): void {
    const devices = r.int(2, 3);
    const p = this.newPersona(key, idx, devices);
    let n = 0;
    for (let d = 0; d < devices - 1; d++) {
      n += this.browseSession(p, d, d, r.fork(`d${d}`), 'granted', { identify: true });
    }
    n += this.conversionSession(p, devices - 1, devices, r.fork('convert'), { identifyMidSession: true });
    this.record(key, p, n, { orders: 1, purchaser: true, identified: true });
  }

  /** ONE shared device (one anon id), TWO family members identify with different emails. */
  private sharedDeviceFamily(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const emailA = personaEmail(this.brand, `${p.personaId}-member-a`);
    const emailB = personaEmail(this.brand, `${p.personaId}-member-b`);
    let n = this.browseSession(p, 0, 0, r.fork('a'), 'granted', { identifyEmail: emailA });
    n += this.browseSession(p, 0, 1, r.fork('b'), 'granted', { identifyEmail: emailB });
    this.record(key, p, n, { orders: 0, purchaser: false, identified: false });
  }

  /** GoKwik COD order: pixel funnel → gokwik checkout signals → order.live.v1 (cod) → shiprocket delivered|rto. */
  private codOrder(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const day = r.int(0, this.spanDays - 8);
    let n = this.browseSession(p, 0, 0, r.fork('browse'), 'granted', { day });

    const product = r.pick(CATALOG[this.brand.key]);
    const orderId = this.nextOrderId();
    const phone = personaPhoneIN(p.ordinal);
    const orderAtMs = this.dayTimeMs(day, r.fork('t-order'));
    const checkoutAtMs = orderAtMs - r.int(120, 600) * 1000;

    const checkoutRecord: Record<string, unknown> = {
      checkout_id: `gkchk_${orderId}`,
      order_id: orderId,
      total: product.price,
      currency: 'INR',
      payment_method: 'cod',
      phone,
      email: p.email,
      customer_id: `gkcust_${p.ordinal}`,
      created_at: new Date(checkoutAtMs).toISOString(),
      pincode: String(560000 + (p.ordinal % 100)),
    };
    for (const kind of ['started', 'step'] as const) {
      const mapped = mapGokwikCheckout(
        { ...checkoutRecord, created_at: new Date(checkoutAtMs + (kind === 'step' ? 45_000 : 0)).toISOString(), ...(kind === 'step' ? { step: 'address' } : {}) },
        this.brand.id, this.salt, this.brand.regionCode, kind, 'synthetic',
      );
      this.push(wrapCanonicalEvent({
        brand: this.brand, eventName: mapped.event_name, eventId: mapped.event_id,
        occurredAtIso: mapped.occurred_at, properties: mapped.properties as unknown as Record<string, unknown>,
      }));
      n += 1;
    }

    const orderRecord: Record<string, unknown> = {
      order_id: orderId,
      total: product.price,
      currency: 'INR',
      payment_method: 'cod',
      financial_status: 'pending',
      phone,
      email: p.email,
      customer_id: `gkcust_${p.ordinal}`,
      created_at: new Date(orderAtMs).toISOString(),
      updated_at: new Date(orderAtMs).toISOString(),
    };
    const order = mapGokwikOrder(orderRecord, this.brand.id, this.salt, this.brand.regionCode, 'synthetic');
    this.push(wrapCanonicalEvent({
      brand: this.brand, eventName: order.event_name, eventId: order.event_id,
      occurredAtIso: order.occurred_at, properties: order.properties as unknown as Record<string, unknown>,
    }));
    n += 1;

    // Forward logistics: In Transit (+1d) then terminal Delivered (75%) or RTO Delivered (25%).
    const isRto = r.chance(0.25);
    const transitMs = orderAtMs + DAY_MS;
    const terminalMs = orderAtMs + r.int(3, 6) * DAY_MS;
    n += this.shipmentStatus(orderId, 'In Transit', transitMs, phone, p.email);
    n += this.shipmentStatus(orderId, isRto ? 'RTO Delivered' : 'Delivered', terminalMs, phone, p.email);

    this.record(key, p, n, { orders: 1, purchaser: true, identified: true, orderId });
  }

  /** Prepaid Shopify order later refunded: order.live.v1 (paid) → refund.recorded.v1 + order.live.v1 (refunded). */
  private refund(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    let n = this.conversionSession(p, 0, 0, r.fork('convert'), { identifyMidSession: true });
    const lastOrder = this.lastShopifyOrder();
    const refundAtMs = Date.parse(String(lastOrder['updated_at'])) + r.int(2, 5) * DAY_MS;
    const refundId = 7_000_000_000 + this.orderSeq;
    const amount = String(
      (lastOrder['current_total_price'] as string),
    );

    const refundShape: ShopifyRefundShape = {
      id: refundId,
      order_id: Number(lastOrder['id']),
      processed_at: new Date(refundAtMs).toISOString(),
      created_at: new Date(refundAtMs).toISOString(),
      note: 'golden: size exchange failed',
      transactions: [{ kind: 'refund', status: 'success', amount }],
    } as unknown as ShopifyRefundShape;

    const record = mapRefundToDraft(refundShape, this.brand.id, this.brand.currencyCode);
    for (const draft of record.events) {
      this.push(wrapCanonicalEvent({
        brand: this.brand,
        eventName: draft.event_name,
        eventId: deterministicUuid('refund', this.brand.id, record.providerId, draft.event_name),
        occurredAtIso: draft.occurred_at,
        properties: draft.properties as unknown as Record<string, unknown>,
      }));
      n += 1;
    }

    // The orders/updated webhook that accompanies a refund (financial_status flips).
    const updatedRaw: ShopifyOrderShape = {
      ...(lastOrder as unknown as ShopifyOrderShape),
      financial_status: 'refunded',
      updated_at: new Date(refundAtMs + 30_000).toISOString(),
    };
    n += this.pushShopifyOrderLive(updatedRaw, /* alsoRawLane */ false);
    this.record(key, p, n, { orders: 1, purchaser: true, identified: true, orderId: String(lastOrder['id']) });
  }

  /** GCC brand order in KWD — CORRECT scale-3 minor units at the canonical layer. */
  private gccKwdOrder(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const guest = r.chance(0.15); // some purchasers stay anonymous (rate must still clear 40%)
    let n = this.conversionSession(p, 0, 0, r.fork('convert'), {
      identifyMidSession: !guest,
      skipConnectorOrder: true, // canonical KWD order is built below, not via shopify-mapper
    });

    const product = r.pick(CATALOG[this.brand.key]);
    const qty = r.int(1, 2);
    const amountMinor = BigInt(Math.round(parseFloat(product.price) * 1000)) * BigInt(qty); // scale-3 (KWD fils)
    const orderId = this.nextOrderId();
    const orderAtMs = this.lastEventMs() + 60_000;
    const occurredAtIso = new Date(orderAtMs).toISOString();

    const properties: Record<string, unknown> = {
      source: 'shopflo',
      order_id: orderId,
      amount_minor: amountMinor.toString(),
      currency_code: 'KWD',
      payment_method: 'prepaid',
      financial_status: 'paid',
      fulfillment_status: null,
      cancelled_at: null,
      stitched_anon_id: p.anonIds[0],
      ...(guest ? {} : {
        hashed_customer_email: hashIdentifier(p.email, 'email', this.salt, this.brand.regionCode),
        storefront_customer_id: `cedar_${p.ordinal}`,
      }),
    };
    this.push(wrapCanonicalEvent({
      brand: this.brand,
      eventName: ORDER_LIVE_V1_EVENT_NAME,
      eventId: uuidV5FromOrderLive(this.brand.id, orderId, orderAtMs),
      occurredAtIso,
      properties,
    }));
    n += 1;
    this.record(key, p, n, { orders: 1, purchaser: true, identified: !guest, orderId });
  }

  /** Consent-off traffic: half ABSENT consent_flags (R3 → silver_consent_rejected), half analytics:false (passes today — AMD-04 reality). */
  private consentOff(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const mode: ConsentMode = idx % 2 === 0 ? 'absent' : 'denied_analytics';
    const n = this.browseSession(p, 0, 0, r.fork('s'), mode);
    this.record(key, p, n, { orders: 0, purchaser: false, identified: false });
  }

  /** Anonymous for six days, identifies + orders on day 7 (A.5.5 re-stitch seed). */
  private lateIdentifyDay7(key: ScenarioKey, idx: number, r: Rand): void {
    const p = this.newPersona(key, idx, 1);
    const startDay = r.int(0, this.spanDays - 9);
    let n = 0;
    for (let d = 0; d < 6; d++) {
      n += this.browseSession(p, 0, d, r.fork(`d${d}`), 'granted', { day: startDay + d, short: true });
    }
    n += this.conversionSession(p, 0, 6, r.fork('convert'), { identifyMidSession: true, day: startDay + 6 });
    this.record(key, p, n, { orders: 1, purchaser: true, identified: true });
  }

  // ── session primitives ───────────────────────────────────────────────────────

  /** A browse session: page views + optional cart activity (+ optional identify). Returns event count. */
  private browseSession(
    p: Persona, deviceIdx: number, sessionIdx: number, r: Rand, consent: ConsentMode,
    opts: { day?: number; short?: boolean; identify?: boolean; identifyEmail?: string } = {},
  ): number {
    const day = opts.day ?? r.int(0, this.spanDays - 1);
    const channel = r.pick(CHANNELS);
    const landing = r.pick(LANDINGS);
    const uaClass = deviceIdx % 2 === 0 ? 'desktop' as const : 'mobile' as const;
    const anonId = p.anonIds[deviceIdx] as string;
    const sessionId = deterministicUuid('sess', p.personaId, String(deviceIdx), String(sessionIdx), String(day));
    const clickId = this.clickIdFor(channel, sessionId);
    let tMs = this.dayTimeMs(day, r);
    let count = 0;

    const emit = (eventName: string, extra?: Record<string, unknown>): void => {
      this.push(buildPixelEvent({
        brand: this.brand, eventName, occurredAtMs: tMs, anonId, sessionId,
        channel, landingPath: landing, uaClass, consent, clickId, extra,
      }));
      tMs += r.int(8, 110) * 1000;
      count += 1;
    };

    emit('page.viewed', { page_type: 'home' });
    const pages = opts.short ? r.int(1, 2) : r.int(2, 5);
    for (let i = 0; i < pages; i++) {
      const product = r.pick(CATALOG[this.brand.key]);
      emit('page.viewed', { page_type: 'product', product_handle: product.handle });
    }
    if (!opts.short && r.chance(0.35)) {
      const product = r.pick(CATALOG[this.brand.key]);
      emit('cart.item_added', { product_handle: product.handle, quantity: 1 });
      if (r.chance(0.5)) emit('cart.viewed', {});
    }
    if (opts.identify || opts.identifyEmail) {
      const email = opts.identifyEmail ?? p.email;
      emit('identify', { hashed_customer_email: pixelIdentifyEmailHash(email) });
    }
    return count;
  }

  /**
   * A conversion session: funnel to order.placed (pixel) + the connector order.live.v1
   * (real shopify-mapper for Shopify brands). identify fires MID-SESSION when asked.
   */
  private conversionSession(
    p: Persona, deviceIdx: number, sessionIdx: number, r: Rand,
    opts: { identifyMidSession?: boolean; day?: number; skipConnectorOrder?: boolean } = {},
  ): number {
    const day = opts.day ?? r.int(0, this.spanDays - 8);
    const channel = r.pick(CHANNELS);
    const landing = r.pick(LANDINGS);
    const uaClass = deviceIdx % 2 === 0 ? 'desktop' as const : 'mobile' as const;
    const anonId = p.anonIds[deviceIdx] as string;
    const sessionId = deterministicUuid('sess', p.personaId, String(deviceIdx), String(sessionIdx), String(day));
    const clickId = this.clickIdFor(channel, sessionId);
    const product = r.pick(CATALOG[this.brand.key]);
    let tMs = this.dayTimeMs(day, r);
    let count = 0;

    const emit = (eventName: string, extra?: Record<string, unknown>): void => {
      this.push(buildPixelEvent({
        brand: this.brand, eventName, occurredAtMs: tMs, anonId, sessionId,
        channel, landingPath: landing, uaClass, consent: 'granted', clickId, extra,
      }));
      tMs += r.int(10, 90) * 1000;
      count += 1;
    };

    emit('page.viewed', { page_type: 'home' });
    emit('page.viewed', { page_type: 'product', product_handle: product.handle });
    emit('cart.item_added', { product_handle: product.handle, quantity: 1 });
    emit('cart.viewed', {});
    emit('checkout.started', {});
    if (opts.identifyMidSession) {
      emit('identify', { hashed_customer_email: pixelIdentifyEmailHash(p.email) });
    }
    emit('checkout.step_viewed', { step: 'address' });
    emit('checkout.step_viewed', { step: 'payment' });
    emit('payment.initiated', {});
    emit('payment.succeeded', {});

    let orderId: string | null = null;
    if (!opts.skipConnectorOrder && this.brand.orderSource === 'shopify') {
      orderId = this.nextOrderId();
      const raw = this.buildRawShopifyOrder(p, orderId, product, tMs, channel, anonId);
      count += this.pushShopifyOrderLive(raw, /* alsoRawLane */ true);
    }
    emit('order.placed', orderId ? { order_id: orderId } : {});
    return count;
  }

  // ── connector primitives ─────────────────────────────────────────────────────

  /** Raw Shopify order fixture — the exact shape the raw lane lands and the mapper consumes. */
  private buildRawShopifyOrder(
    p: Persona, orderId: string, product: GoldenProduct, atMs: number,
    channel: GoldenChannel, anonId: string,
  ): ShopifyOrderShape {
    const iso = new Date(atMs).toISOString();
    const noteAttributes: Array<{ name: string; value: string }> = [
      { name: 'brain_anon_id', value: anonId },
    ];
    for (const [k, v] of Object.entries(channel.utm)) {
      noteAttributes.push({ name: `utm_${k}`, value: v });
    }
    const raw = {
      id: Number(orderId),
      currency: this.brand.currencyCode,
      current_total_price: product.price,
      total_price: product.price,
      financial_status: 'paid',
      fulfillment_status: null,
      gateway: 'razorpay',
      payment_gateway_names: ['razorpay'],
      created_at: iso,
      processed_at: iso,
      updated_at: iso,
      cancelled_at: null,
      customer: {
        id: 5_000_000_000 + p.ordinal,
        email: p.email, // raw-lane reality: raw PII lands in Bronze raw; the mapper hashes + drops it
        phone: this.brand.regionCode === 'IN' ? personaPhoneIN(p.ordinal) : null,
      },
      note_attributes: noteAttributes,
      line_items: [
        { id: 1, sku: product.sku, title: product.handle, quantity: 1, price: product.price },
      ],
    };
    return raw as unknown as ShopifyOrderShape;
  }

  /** Map a raw Shopify order through the REAL mapper → order.live.v1 on the collector lane (+ optional raw lane). */
  private pushShopifyOrderLive(raw: ShopifyOrderShape, alsoRawLane: boolean): number {
    const mapped = mapOrderToEvent(raw, this.salt, this.brand.regionCode, ORDER_LIVE_V1_EVENT_NAME);
    const rawRecord = raw as unknown as Record<string, unknown>;
    const orderId = String(rawRecord['id']);
    const occurredMs = Date.parse(mapped.occurred_at);
    this.push(wrapCanonicalEvent({
      brand: this.brand,
      eventName: mapped.event_name,
      eventId: uuidV5FromOrderLive(this.brand.id, orderId, occurredMs),
      occurredAtIso: mapped.occurred_at,
      properties: mapped.properties as unknown as Record<string, unknown>,
    }));
    let count = 1;
    if (alsoRawLane) {
      this.rawShopifyOrders.push(rawRecord);
      this.push({
        lane: 'shopify.orders.raw.v1',
        occurredAtMs: occurredMs,
        eventId: deterministicUuid('raw-order', this.brand.id, orderId, mapped.occurred_at),
        value: rawRecord,
      });
      count += 1;
    }
    return count;
  }

  /** Shiprocket forward-shipment status through the REAL mapper. */
  private shipmentStatus(orderId: string, status: string, atMs: number, phone: string, email: string): number {
    const record = {
      awb: `AWB${orderId}`,
      order_id: orderId,
      status,
      status_changed_at: new Date(atMs).toISOString(),
      payment_method: 'cod',
      pincode: '560001',
      courier: 'Golden Express',
      customer_phone: phone,
      customer_email: email,
    };
    const mapped = mapShiprocketShipment(record, this.brand.id, this.salt, 'synthetic', this.brand.regionCode);
    this.push(wrapCanonicalEvent({
      brand: this.brand,
      eventName: mapped.event_name,
      eventId: deterministicUuid('shiprocket', this.brand.id, orderId, status, mapped.occurred_at),
      occurredAtIso: mapped.occurred_at,
      properties: mapped.properties as unknown as Record<string, unknown>,
    }));
    return 1;
  }

  // ── bookkeeping ──────────────────────────────────────────────────────────────

  private newPersona(scenario: ScenarioKey, idx: number, devices: number): Persona {
    this.personaOrdinal += 1;
    const personaId = `${this.brand.key}-${scenario.replace(/_/g, '-')}-${String(idx + 1).padStart(4, '0')}`;
    const anonIds = Array.from({ length: devices }, (_, d) => deterministicUuid('anon', personaId, String(d)));
    return { personaId, ordinal: this.personaOrdinal, email: personaEmail(this.brand, personaId), anonIds };
  }

  private nextOrderId(): string {
    this.orderSeq += 1;
    const brandBase = { aurora: 9_100_000_000, bazaar: 9_200_000_000, cedar: 9_300_000_000 }[this.brand.key];
    return String(brandBase + this.orderSeq);
  }

  private dayTimeMs(day: number, r: Rand): number {
    return this.epochMs + day * DAY_MS + r.int(6 * 3600, 22 * 3600) * 1000;
  }

  private clickIdFor(channel: GoldenChannel, sessionId: string): string | undefined {
    if (!channel.clickIdKey) return undefined;
    return `${channel.clickIdKey.slice(0, 2)}_${deterministicUuid('click', sessionId).replace(/-/g, '').slice(0, 16)}`;
  }

  private push(ev: GoldenEvent): void {
    this.events.push(ev);
  }

  private lastEventMs(): number {
    const last = this.events[this.events.length - 1];
    return last ? last.occurredAtMs : this.epochMs;
  }

  private lastShopifyOrder(): Record<string, unknown> {
    const last = this.rawShopifyOrders[this.rawShopifyOrders.length - 1];
    if (!last) throw new Error('lastShopifyOrder: no raw order emitted yet');
    return last;
  }

  private record(
    key: ScenarioKey, p: Persona, eventCount: number,
    outcome: { orders: number; purchaser: boolean; identified: boolean; orderId?: string },
  ): void {
    const s = (this.stats[key] ??= {
      personas: 0, events: 0, orders: 0, purchasers: 0, identifiedPurchasers: 0,
      samplePersonaIds: [], sampleAnonIds: [], sampleOrderIds: [],
    });
    s.personas += 1;
    s.events += eventCount;
    s.orders += outcome.orders;
    if (outcome.purchaser) s.purchasers += 1;
    if (outcome.purchaser && outcome.identified) s.identifiedPurchasers += 1;
    if (s.samplePersonaIds.length < 3) {
      s.samplePersonaIds.push(p.personaId);
      s.sampleAnonIds.push(p.anonIds[0] as string);
      if (outcome.orderId) s.sampleOrderIds.push(outcome.orderId);
    }
  }
}
