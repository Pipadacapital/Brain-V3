/**
 * entity-routing.test.ts — the event_type → entity → topic map (Phase C, DB-free).
 */
import { describe, it, expect } from 'vitest';
import { entityForEventType, topicForEventType, allEntityTopics, ENTITY_TOPICS } from './entity-routing.js';

describe('entity routing', () => {
  it('routes every known event_type to its business entity', () => {
    const cases: Array<[string, string]> = [
      ['order.live.v1', 'orders'],
      ['order.backfill.v1', 'orders'],
      ['settlement.live.v1', 'payments'],
      ['gokwik.rto_predict.v1', 'payments'],
      ['shopflo.checkout_abandoned.v1', 'payments'],
      ['gokwik.awb_status.v1', 'shipments'],
      ['shiprocket.shipment_status.v1', 'shipments'],
      ['spend.live.v1', 'ads'],
      ['page.viewed', 'sessions'],
      ['cart.item_added', 'sessions'],
    ];
    for (const [evt, entity] of cases) expect(entityForEventType(evt)).toBe(entity);
  });

  it('returns null for an unrouted event_type (caller keeps it on the firehose)', () => {
    expect(entityForEventType('totally.unknown.v9')).toBeNull();
    expect(topicForEventType('totally.unknown.v9')).toBeNull();
  });

  it('builds the spec topic name, with optional env prefix', () => {
    expect(topicForEventType('order.live.v1')).toBe('brain.orders');
    expect(topicForEventType('spend.live.v1', 'dev')).toBe('dev.brain.ads');
  });

  it('exposes all 6 entity topics for admin/creation', () => {
    expect(allEntityTopics().sort()).toEqual(
      ['brain.ads', 'brain.customers', 'brain.orders', 'brain.payments', 'brain.sessions', 'brain.shipments'].sort(),
    );
    expect(Object.keys(ENTITY_TOPICS)).toHaveLength(6);
  });
});
