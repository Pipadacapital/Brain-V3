/**
 * meta-entity-client.ts — Meta (Facebook) Ads ENTITY-METADATA client (A2 / ADR-AD-3).
 *
 * Closes the review's HIGH "no `ad.entity.updated` job" gap: the spend insights row carries a
 * campaign_name that piggybacks spend volume (stale the moment a campaign stops spending) and never
 * carries `status` / `objective`, nor adset/ad NAMES (those grains are ID-only on the spend row). This
 * client pulls the AUTHORITATIVE metadata directly from the entity edges:
 *   GET /act_{id}/campaigns  fields=id,name,status,effective_status,objective,updated_time
 *   GET /act_{id}/adsets     fields=id,name,status,effective_status,campaign_id,updated_time
 *   GET /act_{id}/ads        fields=id,name,status,effective_status,campaign_id,adset_id,updated_time
 *
 * Reuses the spend client's throttle vocabulary (parseUsageHeader / isThrottleError / the
 * META_AUTH_ERROR + META_RATE_LIMITED sentinels) so backoff + auth semantics stay byte-consistent.
 * Auth: OAuth access_token (Bearer) — NEVER logged (I-S09). Graph version pinned in meta-constants.ts.
 */
import { log } from '../../log.js';
import { CircuitBreaker } from '@brain/observability';
import { GRAPH_API_BASE } from '../meta-constants.js';
import {
  parseUsageHeader,
  isThrottleError,
  META_AUTH_ERROR,
  META_RATE_LIMITED,
  type MetaApiCredentials,
} from '../meta-spend-repull/meta-insights-client.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The canonical entity grains the feed covers. FIREHOSE adds `adcreative`, `custom_audience`,
 * `saved_audience` to the campaign/adset/ad hierarchy — each landed as its own `ad.entity.updated`
 * grain (level column discriminates).
 */
export type AdEntityLevel =
  | 'campaign'
  | 'adset'
  | 'ad'
  | 'adcreative'
  | 'custom_audience'
  | 'saved_audience';

/**
 * One normalized ad entity — the shape the entity-sync job projects into an `ad.entity.updated`
 * canonical event. `status` prefers `effective_status` (the real serving state) over the configured
 * `status`. `objective` is campaign-only (Meta). `entity_updated_at` is Meta's `updated_time` (its
 * change-clock — drives version-deterministic dedup + the Silver "latest" pick).
 *
 * FIREHOSE entity-depth attributes are ADDITIVE + nullable — only the grains that carry them populate
 * them (campaign budgets/bid_strategy/objective/buying_type/times; adset optimization/billing/bid/
 * targeting; ad creative_id; adcreative story spec; audiences id/name/subtype/approximate_count).
 * PII HARD LIMIT: audiences NEVER carry members/rules — only id/name/subtype/approximate_count.
 */
export interface MetaAdEntity {
  level: AdEntityLevel;
  entity_id: string;
  campaign_id: string | null;
  parent_id: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  entity_updated_at: string | null;
  // ── FIREHOSE entity depth (all nullable; grain-specific). Budgets are MINOR-unit strings from Meta
  //    (account currency) → carried verbatim as strings (NEVER float). ─────────────────────────────
  buying_type: string | null;               // campaign
  daily_budget_minor: string | null;         // campaign/adset — MINOR units (Meta returns minor already)
  lifetime_budget_minor: string | null;      // campaign/adset — MINOR units
  bid_strategy: string | null;               // campaign
  effective_status: string | null;           // campaign/adset/ad — raw effective_status passthrough
  start_time: string | null;                 // campaign
  stop_time: string | null;                  // campaign
  optimization_goal: string | null;          // adset
  billing_event: string | null;              // adset
  bid_amount: string | null;                 // adset — MINOR units string
  targeting_json: string | null;             // adset — JSON string of the targeting spec (no PII members)
  creative_id: string | null;                // ad — the creative reference
  object_story_spec_json: string | null;     // adcreative — JSON string
  title: string | null;                      // adcreative
  body: string | null;                       // adcreative
  image_url: string | null;                  // adcreative
  video_id: string | null;                   // adcreative
  call_to_action_type: string | null;        // adcreative
  link_url: string | null;                   // adcreative
  subtype: string | null;                    // custom_audience / saved_audience
  approximate_count: string | null;          // custom_audience / saved_audience (count string, no PII)
}

const CAMPAIGN_FIELDS =
  'id,name,status,effective_status,objective,buying_type,daily_budget,lifetime_budget,bid_strategy,start_time,stop_time,updated_time';
const ADSET_FIELDS =
  'id,name,status,effective_status,campaign_id,optimization_goal,billing_event,bid_amount,daily_budget,lifetime_budget,targeting,updated_time';
const AD_FIELDS = 'id,name,status,effective_status,campaign_id,adset_id,creative,updated_time';
// FIREHOSE creative depth (no PII): the story spec + rendered creative fields.
const ADCREATIVE_FIELDS =
  'id,name,object_story_spec,title,body,image_url,video_id,call_to_action_type,link_url';
// FIREHOSE audience depth — HARD PII LIMIT: id/name/subtype/approximate_count ONLY. NEVER members/rule.
const AUDIENCE_FIELDS = 'id,name,subtype,approximate_count';
const PAGE_LIMIT = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAccountId(adAccountId: string): string {
  const id = adAccountId.trim();
  return id.startsWith('act_') ? id : `act_${id}`;
}

function str(v: unknown): string | null {
  return v != null && String(v).trim() !== '' ? String(v) : null;
}

interface RawEntity {
  id?: string | number | null;
  name?: string | null;
  status?: string | null;
  effective_status?: string | null;
  objective?: string | null;
  campaign_id?: string | number | null;
  adset_id?: string | number | null;
  updated_time?: string | null;
  // ── FIREHOSE entity-depth raw fields (grain-specific; all optional). ────────────────────────────
  buying_type?: string | null;
  daily_budget?: string | number | null;      // MINOR units (Meta account currency)
  lifetime_budget?: string | number | null;   // MINOR units
  bid_strategy?: string | null;
  start_time?: string | null;
  stop_time?: string | null;
  optimization_goal?: string | null;
  billing_event?: string | null;
  bid_amount?: string | number | null;        // MINOR units
  targeting?: unknown;                          // targeting spec object (no PII members)
  creative?: { id?: string | number | null } | null;
  object_story_spec?: unknown;
  title?: string | null;
  body?: string | null;
  image_url?: string | null;
  video_id?: string | number | null;
  call_to_action_type?: string | null;
  link_url?: string | null;
  subtype?: string | null;
  approximate_count?: string | number | null;
  [k: string]: unknown;
}

export class MetaEntityClient {
  private readonly accessToken: string;
  private readonly actId: string;
  private readonly maxBackoffRetries: number;
  private readonly breaker: CircuitBreaker;

  constructor(creds: MetaApiCredentials, maxBackoffRetries = 5) {
    this.accessToken = creds.accessToken; // in memory only; NEVER logged (I-S09)
    this.actId = normalizeAccountId(creds.adAccountId);
    this.maxBackoffRetries = maxBackoffRetries;
    this.breaker = new CircuitBreaker({ name: 'meta-entity', failureThreshold: 5, openMs: 60_000 });
  }

  /**
   * Fetch + normalize ALL entity grains for the account (each edge fully paged). FIREHOSE covers the
   * campaign/adset/ad hierarchy PLUS adcreatives + custom_audiences + saved_audiences (id/name/subtype/
   * approximate_count ONLY — NO member PII, enforced by AUDIENCE_FIELDS + normalize()).
   */
  async fetchAllEntities(): Promise<MetaAdEntity[]> {
    const campaigns = await this.fetchEdge('campaigns', CAMPAIGN_FIELDS, 'campaign');
    const adsets = await this.fetchEdge('adsets', ADSET_FIELDS, 'adset');
    const ads = await this.fetchEdge('ads', AD_FIELDS, 'ad');
    const adcreatives = await this.fetchEdge('adcreatives', ADCREATIVE_FIELDS, 'adcreative');
    const customAudiences = await this.fetchEdge('customaudiences', AUDIENCE_FIELDS, 'custom_audience');
    const savedAudiences = await this.fetchEdge('saved_audiences', AUDIENCE_FIELDS, 'saved_audience');
    return [...campaigns, ...adsets, ...ads, ...adcreatives, ...customAudiences, ...savedAudiences];
  }

  /**
   * The ad account's ISO currency code — the sibling required by every MINOR-unit money field on the
   * entity envelope (daily_budget_minor / lifetime_budget_minor / bid_amount). Money is never carried
   * without its currency (I-S07). Mirrors the insights lane's fetchAccountMeta(). Defaults to 'USD' if
   * Meta omits it (best-effort; never blocks the entity sync).
   */
  async fetchAccountCurrency(): Promise<string> {
    const url = `${GRAPH_API_BASE}/${this.actId}?fields=currency`;
    const body = (await this.getJson(url)) as { currency?: string };
    return (body.currency ?? 'USD').trim().toUpperCase();
  }

  private async fetchEdge(
    edge:
      | 'campaigns'
      | 'adsets'
      | 'ads'
      | 'adcreatives'
      | 'customaudiences'
      | 'saved_audiences',
    fields: string,
    level: AdEntityLevel,
  ): Promise<MetaAdEntity[]> {
    const out: MetaAdEntity[] = [];
    let url: string | null =
      `${GRAPH_API_BASE}/${this.actId}/${edge}?fields=${fields}&limit=${PAGE_LIMIT}`;

    while (url) {
      const body = (await this.getJson(url)) as { data?: RawEntity[]; paging?: { next?: string } };
      for (const raw of body.data ?? []) {
        const entity = this.normalize(raw, level);
        if (entity) out.push(entity);
      }
      url = body.paging?.next ?? null;
    }
    return out;
  }

  private normalize(raw: RawEntity, level: AdEntityLevel): MetaAdEntity | null {
    const entityId = str(raw.id);
    if (!entityId) return null; // an entity with no id is unusable as a dimension key

    // campaign_id / parent_id only apply to the ad hierarchy (audiences/creatives are account-scoped).
    const inHierarchy = level === 'campaign' || level === 'adset' || level === 'ad';
    const campaignId = level === 'campaign' ? entityId : inHierarchy ? str(raw.campaign_id) : null;
    const parentId =
      level === 'campaign'
        ? null
        : level === 'adset'
        ? campaignId
        : level === 'ad'
        ? str(raw.adset_id) ?? campaignId // ad → adset (fallback campaign)
        : null; // adcreative/audiences are account-scoped (no hierarchy parent)

    // FIREHOSE: serialize the nested spec objects to JSON strings (targeting/object_story_spec) —
    // additive, nullable, and PII-safe (targeting is audience *definition*, not member lists).
    const targetingJson =
      raw.targeting != null ? JSON.stringify(raw.targeting) : null;
    const objectStorySpecJson =
      raw.object_story_spec != null ? JSON.stringify(raw.object_story_spec) : null;

    return {
      level,
      entity_id: entityId,
      campaign_id: campaignId,
      parent_id: parentId,
      name: str(raw.name),
      // effective_status reflects the REAL serving state (e.g. CAMPAIGN_PAUSED) — prefer it.
      status: str(raw.effective_status) ?? str(raw.status),
      objective: level === 'campaign' ? str(raw.objective) : null,
      entity_updated_at: str(raw.updated_time),
      // ── FIREHOSE entity depth (grain-specific; nullable elsewhere) ────────────────────────────────
      buying_type: level === 'campaign' ? str(raw.buying_type) : null,
      daily_budget_minor: str(raw.daily_budget),
      lifetime_budget_minor: str(raw.lifetime_budget),
      bid_strategy: level === 'campaign' ? str(raw.bid_strategy) : null,
      effective_status: str(raw.effective_status),
      start_time: level === 'campaign' ? str(raw.start_time) : null,
      stop_time: level === 'campaign' ? str(raw.stop_time) : null,
      optimization_goal: level === 'adset' ? str(raw.optimization_goal) : null,
      billing_event: level === 'adset' ? str(raw.billing_event) : null,
      bid_amount: level === 'adset' ? str(raw.bid_amount) : null,
      targeting_json: level === 'adset' ? targetingJson : null,
      creative_id: level === 'ad' ? str(raw.creative?.id) : null,
      object_story_spec_json: level === 'adcreative' ? objectStorySpecJson : null,
      title: level === 'adcreative' ? str(raw.title) : null,
      body: level === 'adcreative' ? str(raw.body) : null,
      image_url: level === 'adcreative' ? str(raw.image_url) : null,
      video_id: level === 'adcreative' ? str(raw.video_id) : null,
      call_to_action_type: level === 'adcreative' ? str(raw.call_to_action_type) : null,
      link_url: level === 'adcreative' ? str(raw.link_url) : null,
      // Audiences: id/name/subtype/approximate_count ONLY (NO members/rule — PII hard limit).
      subtype:
        level === 'custom_audience' || level === 'saved_audience' ? str(raw.subtype) : null,
      approximate_count:
        level === 'custom_audience' || level === 'saved_audience'
          ? str(raw.approximate_count)
          : null,
    };
  }

  // ── HTTP (bounded backoff on throttle; mirrors meta-insights-client.getJson) ──
  private async getJson(url: string): Promise<unknown> {
    return this.breaker.fire(async () => {
      for (let attempt = 0; attempt <= this.maxBackoffRetries; attempt++) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.accessToken}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (res.status === 401) {
          throw new Error(`${META_AUTH_ERROR}: 401 Unauthorized from Meta entity edge`);
        }

        const throttled = await this.handleThrottle(res, attempt);
        if (throttled === 'retry') continue;
        if (throttled === 'exhausted') {
          throw new Error(`${META_RATE_LIMITED}: persistent throttle on entity GET`);
        }

        if (!res.ok) {
          throw new Error(`[meta-entity-client] HTTP ${res.status} from Meta entity edge`);
        }
        return res.json();
      }
      throw new Error(`${META_RATE_LIMITED}: exceeded backoff retries on entity GET`);
    });
  }

  private async handleThrottle(res: Response, attempt: number): Promise<'retry' | 'exhausted' | null> {
    const buc = parseUsageHeader(res.headers.get('X-Business-Use-Case-Usage'), 'X-Business-Use-Case-Usage');
    const app = parseUsageHeader(res.headers.get('X-App-Usage'), 'X-App-Usage');
    const headerThrottle = buc.type === 'THROTTLED' ? buc : app;

    if (headerThrottle.type === 'THROTTLED') {
      if (attempt >= this.maxBackoffRetries) return 'exhausted';
      const backoffMs = headerThrottle.backoffMs > 0 ? headerThrottle.backoffMs : Math.min(30_000, 1000 * 2 ** attempt);
      log.info(`[meta-entity-client] header-throttle call_count=${headerThrottle.callCountPct}% — backoff ${backoffMs}ms`);
      await sleep(backoffMs);
      return 'retry';
    }

    if (res.status === 429) {
      if (attempt >= this.maxBackoffRetries) return 'exhausted';
      const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
      await sleep(backoffMs);
      return 'retry';
    }

    if (res.status === 400) {
      let errBody: Record<string, unknown> = {};
      try {
        errBody = (await res.clone().json()) as Record<string, unknown>;
      } catch { /* malformed — non-throttle 400 */ }
      const err = (errBody as { error?: { code?: number; error_subcode?: number } }).error;
      if (isThrottleError(err?.code, err?.error_subcode)) {
        if (attempt >= this.maxBackoffRetries) return 'exhausted';
        const backoffMs = Math.min(30_000, 1000 * 2 ** attempt);
        await sleep(backoffMs);
        return 'retry';
      }
      throw new Error(`[meta-entity-client] HTTP 400 (non-throttle code=${err?.code}) from Meta entity edge`);
    }

    return null;
  }
}
