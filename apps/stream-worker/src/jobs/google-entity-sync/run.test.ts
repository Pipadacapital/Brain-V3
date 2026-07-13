/**
 * google-entity-sync unit tests — the CONTENT-deterministic ad.entity.updated event_id (A3 / ADR-0012).
 *
 * The id must be: (1) STABLE for an UNCHANGED entity (re-pull → same id → dedup-gate drops it, no churn);
 * (2) CHANGE when ANY meaningful payload field changes (so a real change is emitted, NEVER dropped =
 * no event loss); (3) NOT depend on the date/wall-clock (a same-day change must still mint a new id);
 * (4) DISTINCT per brand/level/entity; (5) UUID-shaped (v5 layout) like the spend event_id.
 */
import { describe, it, expect } from 'vitest';
import { entityEventId, AD_ENTITY_UPDATED_EVENT_NAME } from './run.js';
import type { GoogleAdsEntityRow } from '../google-ads-spend-repull/google-ads-searchstream-client.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fully-populated campaign row so every meaningful field is exercised by the change tests. */
function campaignRow(overrides: Partial<GoogleAdsEntityRow> = {}): GoogleAdsEntityRow {
  return {
    level: 'campaign',
    entity_id: '123',
    campaign_id: '123',
    parent_id: null,
    name: 'Summer Sale',
    status: 'ENABLED',
    advertising_channel_type: 'SEARCH',
    bidding_strategy: 'MAXIMIZE_CONVERSIONS',
    advertising_channel_sub_type: 'SEARCH_MOBILE_APP',
    start_date: '2026-06-01',
    end_date: '2026-12-31',
    campaign_budget_amount_micros: '50000000',
    ad_group_type: null,
    ad_group_cpc_bid_micros: null,
    ad_type: null,
    ad_final_urls: null,
    ad_headlines: null,
    ad_descriptions: null,
    ...overrides,
  };
}

describe('entityEventId (ad.entity.updated) — CONTENT-deterministic (ADR-0012)', () => {
  it('event name literal is the SHARED canonical type', () => {
    expect(AD_ENTITY_UPDATED_EVENT_NAME).toBe('ad.entity.updated');
  });

  it('an UNCHANGED entity re-mints the SAME event_id (dedup, no churn)', () => {
    const a = entityEventId(BRAND, campaignRow());
    const b = entityEventId(BRAND, campaignRow());
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('does NOT depend on the date/wall-clock (event_id is a pure function of the row)', () => {
    // Two calls at any wall-clock time with the same row content give the same id — there is no
    // syncDate argument anymore, so nothing about "today" can perturb it.
    const before = entityEventId(BRAND, campaignRow());
    const after = entityEventId(BRAND, campaignRow());
    expect(before).toBe(after);
  });

  it('ANY change to a meaningful field CHANGES the event_id (no event loss)', () => {
    const base = entityEventId(BRAND, campaignRow());
    const changedFields: Array<Partial<GoogleAdsEntityRow>> = [
      { name: 'Summer Sale v2' },
      { status: 'PAUSED' },
      { advertising_channel_type: 'DISPLAY' },
      { bidding_strategy: 'TARGET_CPA' },
      { advertising_channel_sub_type: 'SEARCH_EXPRESS' },
      { start_date: '2026-06-02' },
      { end_date: '2027-01-01' },
      { campaign_budget_amount_micros: '60000000' },
      { campaign_id: '999' },
      { parent_id: 'p1' },
    ];
    for (const patch of changedFields) {
      expect(entityEventId(BRAND, campaignRow(patch)), `field change ${JSON.stringify(patch)} must move the id`)
        .not.toBe(base);
    }
  });

  it('ad-group (adset) field changes move the id', () => {
    const row: GoogleAdsEntityRow = {
      level: 'adset',
      entity_id: '456',
      campaign_id: '123',
      parent_id: '123',
      name: 'AG1',
      status: 'ENABLED',
      advertising_channel_type: null,
      bidding_strategy: null,
      advertising_channel_sub_type: null,
      start_date: null,
      end_date: null,
      campaign_budget_amount_micros: null,
      ad_group_type: 'SEARCH_STANDARD',
      ad_group_cpc_bid_micros: '2000000',
      ad_type: null,
      ad_final_urls: null,
      ad_headlines: null,
      ad_descriptions: null,
    };
    const base = entityEventId(BRAND, row);
    expect(entityEventId(BRAND, { ...row, ad_group_type: 'DISPLAY_STANDARD' })).not.toBe(base);
    expect(entityEventId(BRAND, { ...row, ad_group_cpc_bid_micros: '3000000' })).not.toBe(base);
    expect(entityEventId(BRAND, { ...row, status: 'PAUSED' })).not.toBe(base);
  });

  it('ad field changes (type + RSA text arrays) move the id', () => {
    const row: GoogleAdsEntityRow = {
      level: 'ad',
      entity_id: '789',
      campaign_id: '123',
      parent_id: '456',
      name: null,
      status: 'ENABLED',
      advertising_channel_type: null,
      bidding_strategy: null,
      advertising_channel_sub_type: null,
      start_date: null,
      end_date: null,
      campaign_budget_amount_micros: null,
      ad_group_type: null,
      ad_group_cpc_bid_micros: null,
      ad_type: 'RESPONSIVE_SEARCH_AD',
      ad_final_urls: ['https://a.example'],
      ad_headlines: ['Buy now'],
      ad_descriptions: ['Great deals'],
    };
    const base = entityEventId(BRAND, row);
    expect(entityEventId(BRAND, { ...row, ad_type: 'EXPANDED_TEXT_AD' })).not.toBe(base);
    expect(entityEventId(BRAND, { ...row, ad_final_urls: ['https://b.example'] })).not.toBe(base);
    expect(entityEventId(BRAND, { ...row, ad_headlines: ['Buy today'] })).not.toBe(base);
    expect(entityEventId(BRAND, { ...row, ad_descriptions: ['Even better deals'] })).not.toBe(base);
  });

  it('is distinct per level and per entity', () => {
    const camp = entityEventId(BRAND, campaignRow());
    const adset = entityEventId(BRAND, campaignRow({ level: 'adset' }));
    const ad = entityEventId(BRAND, campaignRow({ level: 'ad' }));
    const other = entityEventId(BRAND, campaignRow({ entity_id: '999', campaign_id: '999' }));
    expect(new Set([camp, adset, ad, other]).size).toBe(4);
  });

  it('is brand-scoped (different brand → different id)', () => {
    const a = entityEventId(BRAND, campaignRow());
    const b = entityEventId('22222222-2222-2222-2222-222222222222', campaignRow());
    expect(a).not.toBe(b);
  });
});
