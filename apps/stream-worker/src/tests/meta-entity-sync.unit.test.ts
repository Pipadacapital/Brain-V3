/**
 * meta-entity-sync.unit.test.ts — the pure pieces of the A2 entity-metadata sync.
 *   1. MetaEntityClient.fetchAllEntities — pages campaigns/adsets/ads, normalizes parent/status/objective.
 *   2. emitEntities — emits ad.entity.updated on the live collector lane with the A1 contract shape
 *      and a VERSION-DETERMINISTIC event_id (unchanged state → same id; updated_time change → new id).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MetaEntityClient, type MetaAdEntity } from '../jobs/meta-entity-sync/meta-entity-client.js';
import { emitEntities, AD_ENTITY_UPDATED_EVENT_NAME } from '../jobs/meta-entity-sync/run.js';

/** Fill the ADDITIVE firehose entity-depth fields with null so test literals stay concise. */
function mkEntity(partial: Partial<MetaAdEntity> & Pick<MetaAdEntity, 'level' | 'entity_id'>): MetaAdEntity {
  return {
    campaign_id: null, parent_id: null, name: null, status: null, objective: null,
    entity_updated_at: null, buying_type: null, daily_budget_minor: null,
    lifetime_budget_minor: null, bid_strategy: null, effective_status: null, start_time: null,
    stop_time: null, optimization_goal: null, billing_event: null, bid_amount: null,
    targeting_json: null, creative_id: null, object_story_spec_json: null, title: null,
    body: null, image_url: null, video_id: null, call_to_action_type: null, link_url: null,
    subtype: null, approximate_count: null,
    ...partial,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FetchStub = (...args: any[]) => Promise<Response>;

function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MetaEntityClient.fetchAllEntities', () => {
  it('pages each edge and normalizes level/parent/status(effective)/objective', async () => {
    const fetchStub: FetchStub = async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/campaigns')) {
        return makeResponse(200, {
          data: [
            { id: 'c1', name: 'Camp 1', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', objective: 'OUTCOME_SALES', updated_time: '2026-06-20T00:00:00+0000' },
          ],
          paging: {},
        });
      }
      if (url.includes('/adsets')) {
        return makeResponse(200, {
          data: [{ id: 's1', name: 'Adset 1', status: 'ACTIVE', campaign_id: 'c1', updated_time: '2026-06-19T00:00:00+0000' }],
          paging: {},
        });
      }
      if (url.includes('/ads')) {
        return makeResponse(200, {
          data: [{ id: 'a1', name: 'Ad 1', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 's1', updated_time: '2026-06-18T00:00:00+0000' }],
          paging: {},
        });
      }
      return makeResponse(200, { data: [], paging: {} });
    };
    vi.stubGlobal('fetch', fetchStub);

    const client = new MetaEntityClient({ accessToken: 'tok', adAccountId: '123' });
    const entities = await client.fetchAllEntities();

    expect(entities).toHaveLength(3);
    const campaign = entities.find((e) => e.level === 'campaign')!;
    expect(campaign.entity_id).toBe('c1');
    expect(campaign.campaign_id).toBe('c1');      // a campaign is its own campaign_id
    expect(campaign.parent_id).toBeNull();
    expect(campaign.status).toBe('CAMPAIGN_PAUSED'); // effective_status preferred over status
    expect(campaign.objective).toBe('OUTCOME_SALES');

    const adset = entities.find((e) => e.level === 'adset')!;
    expect(adset.parent_id).toBe('c1');            // adset → campaign
    expect(adset.objective).toBeNull();            // objective is campaign-only

    const ad = entities.find((e) => e.level === 'ad')!;
    expect(ad.parent_id).toBe('s1');               // ad → adset
    expect(ad.campaign_id).toBe('c1');
  });

  it('follows paging.next across pages', async () => {
    let campaignPage = 0;
    const fetchStub: FetchStub = async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/campaigns')) {
        campaignPage += 1;
        if (campaignPage === 1) {
          return makeResponse(200, { data: [{ id: 'c1', name: 'A', updated_time: 't' }], paging: { next: 'https://graph.facebook.com/v25.0/act_123/campaigns?after=PAGE2' } });
        }
        return makeResponse(200, { data: [{ id: 'c2', name: 'B', updated_time: 't' }], paging: {} });
      }
      return makeResponse(200, { data: [], paging: {} });
    };
    vi.stubGlobal('fetch', fetchStub);
    const client = new MetaEntityClient({ accessToken: 'tok', adAccountId: 'act_123' });
    const entities = await client.fetchAllEntities();
    const campaigns = entities.filter((e) => e.level === 'campaign');
    expect(campaigns.map((c) => c.entity_id).sort()).toEqual(['c1', 'c2']);
  });
});

describe('emitEntities (ad.entity.updated)', () => {
  const BRAND = 'a3b70001-0a11-4a11-8a11-00000000aa01';

  function fakeProducer() {
    const sent: { topic: string; messages: { value: Buffer }[] }[] = [];
    return {
      sent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: async (rec: any) => { sent.push(rec); },
    };
  }

  it('emits one ad.entity.updated per entity with the A1 contract property shape', async () => {
    const producer = fakeProducer();
    const n = await emitEntities({
      brandId: BRAND,
      ciId: 'ci-1',
      accountCurrency: 'INR',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      producer: producer as any,
      entities: [
        mkEntity({ level: 'campaign', entity_id: 'c1', campaign_id: 'c1', parent_id: null, name: 'Camp', status: 'ACTIVE', objective: 'OUTCOME_SALES', entity_updated_at: '2026-06-20T00:00:00.000Z' }),
      ],
    });
    expect(n).toBe(1);
    const env = JSON.parse(producer.sent[0]!.messages[0]!.value.toString());
    expect(env.event_name).toBe(AD_ENTITY_UPDATED_EVENT_NAME);
    expect(env.brand_id).toBe(BRAND);
    expect(env.properties.platform).toBe('meta');
    expect(env.properties.level).toBe('campaign');
    expect(env.properties.entity_id).toBe('c1');
    expect(env.properties.campaign_id).toBe('c1');
    expect(env.properties.status).toBe('ACTIVE');
    expect(env.properties.objective).toBe('OUTCOME_SALES');
    expect(env.properties.advertising_channel_type).toBeNull(); // Meta has no channel type
    expect(env.properties.entity_updated_at).toBe('2026-06-20T00:00:00.000Z');
    // I-S07: every MINOR-unit money field on the envelope carries its account currency sibling.
    expect(env.properties.currency_code).toBe('INR');
  });

  it('event_id is VERSION-deterministic: unchanged state → same id; updated_time change → new id', async () => {
    const base = mkEntity({ level: 'campaign', entity_id: 'c1', campaign_id: 'c1', parent_id: null, name: 'Camp', status: 'ACTIVE', objective: 'X' });

    const p1 = fakeProducer();
    await emitEntities({ brandId: BRAND, ciId: 'ci-1', accountCurrency: 'INR', producer: p1 as any, entities: [{ ...base, entity_updated_at: '2026-06-20T00:00:00+0000' }] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const p2 = fakeProducer();
    await emitEntities({ brandId: BRAND, ciId: 'ci-1', accountCurrency: 'INR', producer: p2 as any, entities: [{ ...base, entity_updated_at: '2026-06-20T00:00:00+0000' }] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const p3 = fakeProducer();
    await emitEntities({ brandId: BRAND, ciId: 'ci-1', accountCurrency: 'INR', producer: p3 as any, entities: [{ ...base, entity_updated_at: '2026-06-25T00:00:00+0000' }] }); // eslint-disable-line @typescript-eslint/no-explicit-any

    const id1 = JSON.parse(p1.sent[0]!.messages[0]!.value.toString()).event_id;
    const id2 = JSON.parse(p2.sent[0]!.messages[0]!.value.toString()).event_id;
    const id3 = JSON.parse(p3.sent[0]!.messages[0]!.value.toString()).event_id;

    expect(id1).toBe(id2);     // identical updated_time → idempotent dedup
    expect(id1).not.toBe(id3); // changed updated_time → new version
  });

  it('returns 0 and sends nothing for an empty entity list', async () => {
    const producer = fakeProducer();
    const n = await emitEntities({ brandId: BRAND, ciId: 'ci-1', accountCurrency: 'INR', producer: producer as any, entities: [] }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(n).toBe(0);
    expect(producer.sent).toHaveLength(0);
  });
});
