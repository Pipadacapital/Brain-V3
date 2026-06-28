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

/** The canonical hierarchy levels the entity feed covers (campaign required; adset/ad optional). */
export type AdEntityLevel = 'campaign' | 'adset' | 'ad';

/**
 * One normalized ad entity — the shape the entity-sync job projects into an `ad.entity.updated`
 * canonical event. `status` prefers `effective_status` (the real serving state) over the configured
 * `status`. `objective` is campaign-only (Meta). `entity_updated_at` is Meta's `updated_time` (its
 * change-clock — drives version-deterministic dedup + the Silver "latest" pick).
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
}

const CAMPAIGN_FIELDS = 'id,name,status,effective_status,objective,updated_time';
const ADSET_FIELDS = 'id,name,status,effective_status,campaign_id,updated_time';
const AD_FIELDS = 'id,name,status,effective_status,campaign_id,adset_id,updated_time';
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

  /** Fetch + normalize ALL campaign/adset/ad entities for the account (each edge fully paged). */
  async fetchAllEntities(): Promise<MetaAdEntity[]> {
    const campaigns = await this.fetchEdge('campaigns', CAMPAIGN_FIELDS, 'campaign');
    const adsets = await this.fetchEdge('adsets', ADSET_FIELDS, 'adset');
    const ads = await this.fetchEdge('ads', AD_FIELDS, 'ad');
    return [...campaigns, ...adsets, ...ads];
  }

  private async fetchEdge(
    edge: 'campaigns' | 'adsets' | 'ads',
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

    const campaignId = level === 'campaign' ? entityId : str(raw.campaign_id);
    const parentId =
      level === 'campaign'
        ? null
        : level === 'adset'
        ? campaignId
        : str(raw.adset_id) ?? campaignId; // ad → adset (fallback campaign)

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
