/**
 * eventLabel / eventCategoryLabel — plain-language rule 3: no internal event code
 * may ever reach the DOM. Every known taxonomy member has a curated human label;
 * unknown codes are humanized (never echoed raw).
 */
import { describe, it, expect } from 'vitest';
import { eventLabel, eventCategoryLabel } from './event-labels.js';

/** The full pixel taxonomy (mirrors apps/core _pixel-events.ts + the universal capture script). */
const PIXEL_EVENT_TYPES = [
  'page.viewed', 'product.viewed', 'collection.viewed', 'search.submitted',
  'cart.item_added', 'cart.item_removed', 'cart.updated', 'cart.viewed',
  'checkout.started', 'checkout.step_viewed', 'checkout.shipping_selected',
  'payment.initiated', 'payment.succeeded', 'payment.failed',
  'coupon.applied', 'form.submitted', 'order.placed', 'purchase.completed',
  'rage.click', 'dead.click', 'element.clicked', 'scroll.depth',
  'user.logged_in', 'user.signed_up', 'identify',
  'session.started', 'session.ended', 'exit_intent', 'download', 'video', 'share',
  'pixel.dropped',
];

/** Server-trusted connector lanes (apps/core + apps/stream-worker literals). */
const CONNECTOR_EVENT_TYPES = [
  'order.live.v1', 'order.backfill.v1', 'order.created', 'order.updated',
  'checkout.abandoned.v1', 'refund.recorded.v1', 'refund.created',
  'settlement.live.v1', 'spend.live.v1', 'ad.entity.updated',
  'fulfillment.recorded.v1', 'shipment.created',
  'shiprocket.shipment_status.v1', 'shiprocket.return_status.v1',
  'gokwik.checkout_started.v1', 'gokwik.checkout_step.v1', 'gokwik.rto_predict.v1',
  'shopflo.checkout_started.v1', 'shopflo.checkout_step.v1',
  'shopflo.checkout_completed.v1', 'shopflo.checkout_abandoned.v1',
  'customer.upsert.v1', 'customer.created', 'customer.updated',
  'product.upsert.v1', 'product.created', 'product.updated',
];

describe('eventLabel', () => {
  it('gives every pixel + connector event a human label (never the raw code) and an icon', () => {
    for (const type of [...PIXEL_EVENT_TYPES, ...CONNECTOR_EVENT_TYPES]) {
      const { label, Icon, description } = eventLabel(type);
      expect(label, type).toBeTruthy();
      expect(label, type).not.toEqual(type); // the raw code never renders
      expect(Icon, type).toBeTruthy();
      expect(description, type).toMatch(/\w+/);
    }
  });

  it('maps the headline renames exactly', () => {
    expect(eventLabel('page.viewed').label).toBe('Page view');
    expect(eventLabel('cart.item_added').label).toBe('Added to cart');
    expect(eventLabel('order.live.v1').label).toBe('Purchase');
    expect(eventLabel('order.backfill.v1').label).toBe('Purchase (imported)');
    expect(eventLabel('spend.live.v1').label).toBe('Ad spend');
    expect(eventLabel('ad.entity.updated').label).toBe('Ad campaign update');
  });

  it('humanizes unknown codes safely: strips .vN, splits on ./_, Title-Cases', () => {
    expect(eventLabel('inventory.level_changed.v2').label).toBe('Inventory Level Changed');
    expect(eventLabel('some_new.thing').label).toBe('Some New Thing');
    expect(eventLabel('some_new.thing').label).not.toContain('.');
  });

  it('never throws on null/undefined/empty', () => {
    expect(eventLabel(null).label).toBe('Event');
    expect(eventLabel(undefined).label).toBe('Event');
    expect(eventLabel('').label).toBe('Event');
  });
});

describe('eventCategoryLabel', () => {
  it('labels every Silver event_category', () => {
    expect(eventCategoryLabel('behaviour')).toBe('Browsing');
    expect(eventCategoryLabel('behavior')).toBe('Browsing');
    expect(eventCategoryLabel('transaction')).toBe('Money');
    expect(eventCategoryLabel('fulfillment')).toBe('Delivery');
    expect(eventCategoryLabel('support')).toBe('Support');
    expect(eventCategoryLabel('marketing')).toBe('Marketing');
    expect(eventCategoryLabel('other')).toBe('Other');
  });

  it('falls back to Title Case for unknown categories and empty for null', () => {
    expect(eventCategoryLabel('logistics')).toBe('Logistics');
    expect(eventCategoryLabel(null)).toBe('');
  });
});
