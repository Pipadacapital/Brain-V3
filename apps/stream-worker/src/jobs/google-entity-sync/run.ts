/**
 * google-entity-sync/run.ts — Google Ads ENTITY-METADATA sync (A3, SHARED ad.entity.updated lane).
 *
 * The spend re-pull carries only campaign.name piggybacked on the spend query — ad-group/ad names
 * surface as raw IDs and any campaign without recent spend goes stale. This job is the AUTHORITATIVE
 * metadata feed: a no-metrics GAQL pass over campaign / ad_group / ad_group_ad reads the latest
 * name / status / advertising_channel_type / bidding_strategy DECOUPLED from spend volume, and emits
 * the canonical `ad.entity.updated` event that silver_campaign (and the future silver_ad_group /
 * silver_ad dims) fold into the dimension.
 *
 * Lane / isolation (IDENTICAL to spend.live.v1):
 *   - Enumerate via list_ad_connectors_for_spend_repull() (SECURITY DEFINER, NO GUC at enumerate),
 *     filtered to provider='google_ads'. brand_id is server-trusted from the fn result (MT-1),
 *     NEVER from the API. (Reuses enumerateGoogleConnectors + resolveGoogleCredentials.)
 *   - Emits on the SAME collector.event.v1 live lane (NO new topic/envelope). ad.entity.updated is
 *     connector-derived (no install_token / no consent) → it MUST ride the SERVER_TRUSTED lane,
 *     exactly like spend.live.v1, or the pixel-lane install_token join silently drops it.
 *     >>> Admission slice must add the literal "ad.entity.updated" to the SERVER_TRUSTED set in
 *         the Silver admission gate (silver_collector_event.py, ADR-0010 — Bronze is ungated
 *         append-only under the Kafka Connect sink). <<<
 *
 * Idempotency (CONTENT-deterministic event_id, ADR-0012): Google Ads exposes no per-entity
 * change-clock, so the event_id version is a CONTENT HASH over EVERY meaningful field of the entity
 * row (name/status/channel-type/bidding/budgets/dates/RSA text/...). It is NEVER a sync-DATE bucket:
 *   - an UNCHANGED re-pull re-mints the SAME event_id → the ADR-0012 dedup gate drops it (no churn);
 *   - ANY real change to ANY hashed field advances the version → a NEW event whose occurred_at lets
 *     silver_campaign's latest-by-occurred_at pick up the status/name/budget change (keep-latest via a
 *     safe drop — NEVER an event loss). A wall-clock bucket would instead have re-minted the SAME id
 *     for a real same-day change → the gate would DROP it = event loss (why the gate was skipped).
 *   - occurred_at = entity_updated_at = the sync timestamp (ordering only; NOT part of the event_id).
 *   - This event_id scheme + payload shape MUST MATCH Meta's entity-sync (the shared lane): both use a
 *     content hash over the full meaningful payload as the version, keyed by brand:platform:level:id.
 *
 * Dedup gate (ADR-0012): at the produce site we filter event_ids already ingested for the brand
 * (data_plane.ingest_dedup), produce ONLY the unseen ones, then mark-after-produce (produce-first,
 * mark-after — a crash never loses an event). Mirrors meta-spend-repull / shiprocket-shipment-repull.
 *
 * Tokens NEVER logged (I-S09). Throttle reuses the client's ADR-AD-7 two-error branch.
 */

import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { hashToUuidShaped } from '@brain/connector-core';
import { microsToMinorString } from '@brain/ad-spend-mapper';
import { buildPartitionKey } from '@brain/events';
import { injectKafkaTraceContext, incrementCounter } from '@brain/observability';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { updateConnectorInstanceHealth } from '../../infrastructure/pg/ConnectorInstanceHealthRepository.js';
import { filterUnseenEventIds, markEventIdsSeen } from '../../infrastructure/pg/IngestDedupRepository.js';
import {
  GoogleAdsSearchStreamClient,
  GOOGLE_AUTH_ERROR,
  GOOGLE_ACCOUNT_DISABLED,
  GOOGLE_RESOURCE_EXHAUSTED,
  GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED,
  type GoogleAdsEntityRow,
} from '../google-ads-spend-repull/google-ads-searchstream-client.js';
import {
  enumerateGoogleConnectors,
  resolveGoogleCredentials,
} from '../google-ads-spend-repull/run.js';
import { log } from '../../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Canonical SHARED entity-metadata event (Meta + Google). Admission must admit this literal. */
export const AD_ENTITY_UPDATED_EVENT_NAME = 'ad.entity.updated' as const;
const PLATFORM = 'google_ads' as const;
const ENTITY_LEVELS: Array<'campaign' | 'adset' | 'ad'> = ['campaign', 'adset', 'ad'];

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'google-entity-sync', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);

  try {
    await producer.connect();
    log.info(`starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateGoogleConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('no connected/activated google_ads connectors — exiting');
      return;
    }
    log.info(`found ${connectors.length} connector(s) for entity sync`);

    for (const connector of connectors) {
      await syncConnector({ connector, pool, producer });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

interface SyncParams {
  connector: {
    connector_instance_id: string;
    brand_id: string;
    secret_ref: string;
    ad_account_id: string | null;
  };
  pool: Pool;
  producer: Producer;
}

async function syncConnector(params: SyncParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  log.info(`entity-sync connector=${ciId} brand=${brandId}`);

  const creds = await resolveGoogleCredentials(secretRef, connector.ad_account_id);
  if (!creds) {
    log.error(`entity-sync connector=${ciId} — credentials missing (RECONNECT_REQUIRED)`);
    recordConnectorAuthRejected('google_ads');
    return;
  }

  const client = new GoogleAdsSearchStreamClient(creds);
  try {
    await client.authenticate();
  } catch (err) {
    if (String(err).includes(GOOGLE_AUTH_ERROR)) {
      recordConnectorAuthRejected('google_ads');
      await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
      return;
    }
    log.error(`entity-sync connector=${ciId} auth failed`, { err });
    return;
  }

  // occurred_at/entity_updated_at is the sync timestamp — it orders Silver's latest-by-occurred_at
  // pick, but it is NEVER part of the CONTENT-deterministic event_id (which depends only on payload).
  const syncIso = new Date().toISOString();

  let totalEmitted = 0;

  for (const level of ENTITY_LEVELS) {
    let rows: GoogleAdsEntityRow[];
    try {
      rows = await client.streamEntities(level);
    } catch (err) {
      const s = String(err);
      if (s.includes(GOOGLE_RESOURCE_EXHAUSTED) || s.includes(GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED)) {
        log.info(`entity-sync connector=${ciId} RateLimited — aborting (retry next run)`);
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'rate_limited');
        return;
      }
      if (s.includes(GOOGLE_AUTH_ERROR)) {
        recordConnectorAuthRejected('google_ads');
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'token_expired');
        return;
      }
      if (s.includes(GOOGLE_ACCOUNT_DISABLED)) {
        await updateConnectorInstanceHealth(pool, brandId, ciId, 'account_disabled');
        return;
      }
      log.error(`entity-sync connector=${ciId} level=${level} stream error`, { err });
      continue; // non-fatal per level
    }

    totalEmitted += await emitEntities({ rows, brandId, ciId, producer, pool, syncIso });
  }

  // entity sync is a metadata feed — it deliberately does NOT touch connector_sync_status (the spend
  // re-pull owns that tile); stomping it here could mask a real spend error with a stale 'connected'.
  log.info(`entity-sync connector=${ciId} COMPLETED totalEmitted=${totalEmitted}`);
}

interface EmitEntityParams {
  rows: GoogleAdsEntityRow[];
  brandId: string;
  ciId: string;
  producer: Producer;
  pool: Pool;
  syncIso: string;
}

/**
 * Build the canonical `properties` payload for one Google Ads entity row. Factored out so the content
 * hash (entityEventId) and the emitted envelope read from ONE source of truth — the hash provably
 * covers exactly the meaningful fields that land in the payload (no field can change unhashed).
 * `entity_updated_at` (= syncIso) is added by the caller: it is ordering-only, NOT part of the hash.
 */
function buildEntityProperties(row: GoogleAdsEntityRow): Record<string, unknown> {
  return {
    platform: PLATFORM,
    level: row.level,
    entity_id: row.entity_id,
    campaign_id: row.campaign_id,
    parent_id: row.parent_id,
    name: row.name,
    status: row.status,
    objective: null, // Meta-only attribute; null for Google
    advertising_channel_type: row.advertising_channel_type,
    bidding_strategy: row.bidding_strategy,
    // ── FIREHOSE entity depth (additive/nullable; only the fields present at this level are set).
    //    campaign_budget/cpc_bid are MICROS → minor via the shared money port (I-S07, no float). ──
    advertising_channel_sub_type: row.advertising_channel_sub_type,
    bidding_strategy_type: row.bidding_strategy, // alias for canonical entity col naming
    campaign_status: row.level === 'campaign' ? row.status : null,
    campaign_start_date: row.start_date,
    campaign_end_date: row.end_date,
    campaign_budget_amount_minor:
      row.campaign_budget_amount_micros != null
        ? microsToMinorString(row.campaign_budget_amount_micros)
        : null,
    ad_group_type: row.ad_group_type,
    ad_group_status: row.level === 'adset' ? row.status : null,
    ad_group_cpc_bid_minor:
      row.ad_group_cpc_bid_micros != null ? microsToMinorString(row.ad_group_cpc_bid_micros) : null,
    ad_type: row.ad_type,
    ad_final_urls: row.ad_final_urls != null ? JSON.stringify(row.ad_final_urls) : null,
    ad_headlines: row.ad_headlines != null ? JSON.stringify(row.ad_headlines) : null,
    ad_descriptions: row.ad_descriptions != null ? JSON.stringify(row.ad_descriptions) : null,
  };
}

async function emitEntities(p: EmitEntityParams): Promise<number> {
  if (p.rows.length === 0) return 0;

  const messages: Array<{ eventId: string; key: string; value: Buffer }> = [];
  for (const row of p.rows) {
    if (!row.entity_id) continue;

    // CONTENT-deterministic event_id (ADR-0012): hash the full meaningful payload — NOT a sync date.
    const eventId = entityEventId(p.brandId, row);

    // Payload shape MUST MATCH Meta's entity-sync (the shared ad.entity.updated lane). silver_campaign
    // reads: platform, level, entity_id, campaign_id, parent_id, name, status, advertising_channel_type
    // (Google) / objective (Meta), plus entity_updated_at.
    const properties: Record<string, unknown> = {
      ...buildEntityProperties(row),
      entity_updated_at: p.syncIso, // ordering only (occurred_at) — deliberately NOT in the event_id
    };

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: p.brandId, // MT-1 — never from API response
      correlation_id: `google-entity-sync:${p.ciId}:${eventId}`,
      event_name: AD_ENTITY_UPDATED_EVENT_NAME,
      occurred_at: p.syncIso,
      ingested_at: new Date().toISOString(),
      properties,
    });

    messages.push({
      eventId,
      key: buildPartitionKey(p.brandId, eventId),
      value: Buffer.from(JSON.stringify(envelope)),
    });
  }

  if (messages.length === 0) return 0;

  // ADR-0012 ingest dedup gate: drop event_ids already ingested for this brand BEFORE producing, so an
  // unchanged re-pull never re-floods Bronze (Silver dedup is now only a backstop). Because the version
  // is content-deterministic, a real change mints a NEW id and is NEVER dropped here (no event loss).
  // brand GUC set on a short pooled client, then filter+mark. ORDER IS CRITICAL: produce FIRST, mark
  // AFTER (a crash between at worst re-produces a dup on retry, which Silver backstops).
  const dedupClient = await p.pool.connect();
  let emitted = 0;
  try {
    await dedupClient.query(`SELECT set_config('app.current_brand_id', $1, true)`, [p.brandId]);
    const unseen = await filterUnseenEventIds(dedupClient, p.brandId, messages.map((m) => m.eventId));

    const toSend = messages.filter((m) => unseen.has(m.eventId));
    const dropped = messages.length - toSend.length;
    if (dropped > 0) {
      incrementCounter('ingest_dedup_dropped_total', { provider: 'google_ads' });
      log.info(`entity-sync connector=${p.ciId} dedup: dropped ${dropped} already-ingested events`);
    }

    if (toSend.length > 0) {
      const traceHeaders: Record<string, Buffer | string> = {};
      injectKafkaTraceContext(traceHeaders);
      await p.producer.send({
        topic: LIVE_TOPIC,
        messages: toSend.map((m) => ({ key: m.key, value: m.value, headers: traceHeaders })),
      });
      await markEventIdsSeen(dedupClient, p.brandId, toSend.map((m) => m.eventId));
      emitted = toSend.length;
    }
  } finally {
    dedupClient.release();
  }

  log.info(`entity-sync connector=${p.ciId} emitted=${emitted}`);
  return emitted;
}

/**
 * CONTENT-hash version for a Google Ads entity (ADR-0012). Google Ads has no per-entity change-clock,
 * so the version is a hash over EVERY meaningful field that lands in the emitted `properties` — built
 * from the SAME buildEntityProperties() the envelope uses, so the hash provably covers the full payload
 * (no field can change unhashed = no event loss). `entity_updated_at`/occurred_at is EXCLUDED (it is the
 * wall-clock sync timestamp — hashing it would defeat dedup). platform/level/entity_id are re-keyed in
 * the prefix. Same philosophy as Meta's contentHashVersion (the shared lane).
 */
function contentHashVersion(row: GoogleAdsEntityRow): string {
  // Deterministic canonical JSON over the payload keys in a FIXED sorted order (order-independent of
  // object literal ordering), each value JSON-encoded so null/''/values can never smear together.
  const props = buildEntityProperties(row);
  const canonical = Object.keys(props)
    .sort()
    .map((k) => `${k}=${JSON.stringify(props[k] ?? null)}`)
    .join('|');
  return hashToUuidShaped(`google:entity-content:${row.level}:${row.entity_id}:${canonical}`);
}

/**
 * Deterministic ad.entity.updated event_id (A3), CONTENT-deterministic (ADR-0012). The version is a
 * content hash over the full meaningful payload (NOT a date), so an unchanged re-pull re-mints the same
 * id (gate drops it) and any real change mints a new one (silver picks it up — no event loss). Provably
 * non-colliding with spend.live.v1 (':ad.entity.updated' discriminator appears in no spend seed). MUST
 * MATCH Meta's scheme (both key brand:platform:level:id and use a full-payload content hash version).
 */
export function entityEventId(brandId: string, row: GoogleAdsEntityRow): string {
  const version = contentHashVersion(row);
  return hashToUuidShaped(`${brandId}:${PLATFORM}:${row.level}:${row.entity_id ?? ''}:${version}:ad.entity.updated`);
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('fatal', { err });
    process.exit(1);
  });
}
