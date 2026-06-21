/**
 * entity-routing.ts — event_type → business ENTITY → per-entity topic (re-platform Phase C).
 *
 * The lakehouse spec routes the event backbone by BUSINESS ENTITY (connector-agnostic), not by a
 * single firehose: brain.orders / brain.customers / brain.shipments / brain.payments / brain.sessions
 * / brain.ads. This is the single source of truth for that mapping — the producer dual-produces an
 * event to its entity topic (alongside the legacy firehose) using topicForEventType(). A new connector
 * for an existing entity needs NO change here (its mapper emits an existing event_type); a genuinely
 * new entity is one map entry.
 */
export type BrainEntity = 'orders' | 'customers' | 'shipments' | 'payments' | 'sessions' | 'ads';

/** All entity topics (brand-agnostic names per the spec). */
export const ENTITY_TOPICS: Record<BrainEntity, string> = {
  orders: 'brain.orders',
  customers: 'brain.customers',
  shipments: 'brain.shipments',
  payments: 'brain.payments',
  sessions: 'brain.sessions',
  ads: 'brain.ads',
};

/** event_type → entity. The connector-agnostic routing table. */
const EVENT_TYPE_ENTITY: Readonly<Record<string, BrainEntity>> = {
  // orders (storefront order lifecycle — Shopify/WooCommerce/…)
  'order.live.v1': 'orders',
  'order.backfill.v1': 'orders',
  // payments (settlement + checkout/risk signals — Razorpay/GoKwik/Shopflo)
  'settlement.live.v1': 'payments',
  'gokwik.rto_predict.v1': 'payments',
  'shopflo.checkout_abandoned.v1': 'payments',
  // shipments (logistics lifecycle — GoKwik AWB / Shiprocket / …)
  'gokwik.awb_status.v1': 'shipments',
  'shiprocket.shipment_status.v1': 'shipments',
  // ads (spend — Meta / Google)
  'spend.live.v1': 'ads',
  // sessions (pixel / behavioral journey)
  'page.viewed': 'sessions',
  'product.viewed': 'sessions',
  'collection.viewed': 'sessions',
  'cart.viewed': 'sessions',
  'cart.item_added': 'sessions',
  'search.submitted': 'sessions',
  // customers: derived (identity) — reserved; identify.v1 etc. map here when the pixel lands them.
};

/** Map an event_type to its business entity, or null if unrouted. */
export function entityForEventType(eventType: string): BrainEntity | null {
  return EVENT_TYPE_ENTITY[eventType] ?? null;
}

/**
 * Map an event_type to its per-entity topic, or null if unrouted (caller keeps it on the firehose).
 * Optional env prefix (e.g. 'dev') yields 'dev.brain.orders' for shared-cluster isolation; default is
 * the bare spec name 'brain.orders'.
 */
export function topicForEventType(eventType: string, envPrefix?: string): string | null {
  const entity = entityForEventType(eventType);
  if (!entity) return null;
  const base = ENTITY_TOPICS[entity];
  return envPrefix ? `${envPrefix}.${base}` : base;
}

/** All entity topic names (optionally env-prefixed) — for topic creation / admin. */
export function allEntityTopics(envPrefix?: string): string[] {
  return Object.values(ENTITY_TOPICS).map((t) => (envPrefix ? `${envPrefix}.${t}` : t));
}
