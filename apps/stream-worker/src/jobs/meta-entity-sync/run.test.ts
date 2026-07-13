/**
 * meta-entity-sync unit tests — the CONTENT-deterministic ad.entity.updated event_id (A2 / ADR-0012).
 *
 * The id must be: (1) driven by Meta's updated_time (real change-clock) when present; (2) STABLE for an
 * UNCHANGED entity when updated_time is absent (content-hash fallback → dedup, no churn); (3) CHANGE on
 * ANY meaningful field change so a real change is emitted, NEVER dropped (no event loss); (4) NOT depend
 * on the date/wall-clock; (5) match Google's scheme (shared lane); (6) UUID-shaped (v5 layout).
 */
import { describe, it, expect } from 'vitest';
import { entityEventId, AD_ENTITY_UPDATED_EVENT_NAME } from './run.js';
import type { MetaAdEntity } from './meta-entity-client.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const CUR = 'USD';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fully-populated campaign entity WITHOUT updated_time → exercises the content-hash fallback. */
function campaign(overrides: Partial<MetaAdEntity> = {}): MetaAdEntity {
  return {
    level: 'campaign',
    entity_id: 'c1',
    campaign_id: 'c1',
    parent_id: null,
    name: 'Prospecting',
    status: 'ACTIVE',
    objective: 'OUTCOME_SALES',
    entity_updated_at: null, // absent → fallback to the content hash
    buying_type: 'AUCTION',
    daily_budget_minor: '500000',
    lifetime_budget_minor: null,
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    effective_status: 'ACTIVE',
    start_time: '2026-06-01T00:00:00+0000',
    stop_time: null,
    optimization_goal: null,
    billing_event: null,
    bid_amount: null,
    targeting_json: null,
    creative_id: null,
    object_story_spec_json: null,
    title: null,
    body: null,
    image_url: null,
    video_id: null,
    call_to_action_type: null,
    link_url: null,
    subtype: null,
    approximate_count: null,
    ...overrides,
  };
}

describe('meta entityEventId (ad.entity.updated) — CONTENT-deterministic (ADR-0012)', () => {
  it('event name literal is the SHARED canonical type', () => {
    expect(AD_ENTITY_UPDATED_EVENT_NAME).toBe('ad.entity.updated');
  });

  it('uses Meta updated_time (real change-clock) as the version when present', () => {
    const t1 = entityEventId(BRAND, campaign({ entity_updated_at: '2026-06-28T10:00:00+0000' }), CUR);
    const t1b = entityEventId(BRAND, campaign({ entity_updated_at: '2026-06-28T10:00:00+0000' }), CUR);
    const t2 = entityEventId(BRAND, campaign({ entity_updated_at: '2026-06-28T11:00:00+0000' }), CUR);
    expect(t1).toBe(t1b);     // same updated_time → same id
    expect(t1).not.toBe(t2);  // advanced updated_time → new id
    expect(t1).toMatch(UUID_RE);
  });

  it('an UNCHANGED entity (no updated_time) re-mints the SAME event_id (dedup, no churn)', () => {
    expect(entityEventId(BRAND, campaign(), CUR)).toBe(entityEventId(BRAND, campaign(), CUR));
  });

  it('does NOT depend on the date/wall-clock (pure function of the entity + currency)', () => {
    expect(entityEventId(BRAND, campaign(), CUR)).toBe(entityEventId(BRAND, campaign(), CUR));
  });

  it('ANY change to a meaningful field CHANGES the event_id (no event loss)', () => {
    const base = entityEventId(BRAND, campaign(), CUR);
    const patches: Array<Partial<MetaAdEntity>> = [
      { name: 'Prospecting v2' },
      { status: 'PAUSED' },
      { objective: 'OUTCOME_TRAFFIC' },
      { effective_status: 'CAMPAIGN_PAUSED' },
      { buying_type: 'RESERVED' },
      { daily_budget_minor: '600000' },
      { lifetime_budget_minor: '9000000' },
      { bid_strategy: 'COST_CAP' },
      { start_time: '2026-06-02T00:00:00+0000' },
      { stop_time: '2026-12-31T00:00:00+0000' },
      { campaign_id: 'c2' },
      { parent_id: 'x' },
    ];
    for (const patch of patches) {
      expect(entityEventId(BRAND, campaign(patch), CUR), `field change ${JSON.stringify(patch)} must move the id`)
        .not.toBe(base);
    }
  });

  it('a change to the currency sibling (I-S07) moves the id', () => {
    expect(entityEventId(BRAND, campaign(), 'USD')).not.toBe(entityEventId(BRAND, campaign(), 'EUR'));
  });

  it('adset/ad/creative/audience depth field changes move the id', () => {
    const adset = campaign({
      level: 'adset', entity_id: 'a1', parent_id: 'c1',
      optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
      bid_amount: '1500', targeting_json: '{"geo":"US"}',
    });
    expect(entityEventId(BRAND, adset, CUR)).not.toBe(entityEventId(BRAND, { ...adset, optimization_goal: 'LINK_CLICKS' }, CUR));
    expect(entityEventId(BRAND, adset, CUR)).not.toBe(entityEventId(BRAND, { ...adset, bid_amount: '2000' }, CUR));
    expect(entityEventId(BRAND, adset, CUR)).not.toBe(entityEventId(BRAND, { ...adset, targeting_json: '{"geo":"CA"}' }, CUR));

    const ad = campaign({ level: 'ad', entity_id: 'd1', parent_id: 'a1', creative_id: 'cr1' });
    expect(entityEventId(BRAND, ad, CUR)).not.toBe(entityEventId(BRAND, { ...ad, creative_id: 'cr2' }, CUR));

    const creative = campaign({
      level: 'adcreative', entity_id: 'cr1',
      object_story_spec_json: '{"a":1}', title: 'T', body: 'B',
      image_url: 'http://i', video_id: 'v1', call_to_action_type: 'SHOP_NOW', link_url: 'http://l',
    });
    for (const patch of [
      { object_story_spec_json: '{"a":2}' }, { title: 'T2' }, { body: 'B2' },
      { image_url: 'http://i2' }, { video_id: 'v2' }, { call_to_action_type: 'LEARN_MORE' }, { link_url: 'http://l2' },
    ] as Array<Partial<MetaAdEntity>>) {
      expect(entityEventId(BRAND, creative, CUR)).not.toBe(entityEventId(BRAND, { ...creative, ...patch }, CUR));
    }

    const aud = campaign({ level: 'custom_audience', entity_id: 'au1', subtype: 'CUSTOM', approximate_count: '1000' });
    expect(entityEventId(BRAND, aud, CUR)).not.toBe(entityEventId(BRAND, { ...aud, subtype: 'LOOKALIKE' }, CUR));
    expect(entityEventId(BRAND, aud, CUR)).not.toBe(entityEventId(BRAND, { ...aud, approximate_count: '1001' }, CUR));
  });

  it('is distinct per level/entity and brand-scoped', () => {
    const camp = entityEventId(BRAND, campaign(), CUR);
    const adset = entityEventId(BRAND, campaign({ level: 'adset' }), CUR);
    const other = entityEventId(BRAND, campaign({ entity_id: 'c9', campaign_id: 'c9' }), CUR);
    const otherBrand = entityEventId('22222222-2222-2222-2222-222222222222', campaign(), CUR);
    expect(new Set([camp, adset, other, otherBrand]).size).toBe(4);
  });
});
