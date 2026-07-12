/**
 * meta-entity-sync/run.ts — Meta Ads ENTITY-METADATA sync (A2 / ADR-AD-3).
 *
 * Emits the canonical `ad.entity.updated` event (the A1/Admission event type) carrying the
 * AUTHORITATIVE campaign/adset/ad name + status + objective, DECOUPLED from spend volume — so
 * silver_campaign (and the adset/ad dims) source a fresh name/status even for a campaign that has
 * stopped spending, and the "inactive campaign received a conversion" rule can finally fire.
 *
 * Shape & invariants (identical to meta-spend-repull, deliberately):
 *   1. Enumerate via list_ad_connectors_for_spend_repull() — SECURITY DEFINER, NO GUC at enumerate
 *      (system-job-force-rls-enumeration). brand_id is the fn result, NEVER the Meta API body (MT-1).
 *   2. ONE overlap-lock cursor resource `meta.entity.sync` (FOR UPDATE SKIP LOCKED) so two ticks
 *      cannot double-pull the same connector.
 *   3. Emit `ad.entity.updated` on the SAME live collector lane (collector.event.v1) as spend.live.v1
 *      — connector-derived + server-trusted (NO install_token / consent). Until the Admission slice
 *      adds 'ad.entity.updated' to SERVER_TRUSTED, the events quarantine as tenant_unresolved
 *      (expected — this job is correct ahead of admission; see the handoff).
 *
 * Idempotency / versioning: event_id = uuidV5(brand_id, 'meta', level, entity_id, version) where
 * version = Meta `updated_time` (its change-clock), falling back to the sync DATE when absent. An
 * UNCHANGED re-sync mints the SAME event_id → Bronze MERGE dedups; a real metadata change advances
 * updated_time → a NEW event whose occurred_at lets Silver pick the latest. Logical grain remains
 * (brand_id, platform, level, entity_id).
 *
 * Tokens are NEVER logged (I-S09). Cadence: ~6h (scheduled by the verify/admission slice — see handoff).
 */
import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { createIdempotentProducer } from '../../infrastructure/kafka/idempotent-producer.js';
import { recordConnectorAuthRejected } from '../../infrastructure/observability/connector-auth-health.js';
import { incrementCounter, injectKafkaTraceContext } from '@brain/observability';
import { buildPartitionKey } from '@brain/events';
import { hashToUuidShaped } from '@brain/connector-core';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import { loadStreamWorkerConfig } from '@brain/config';
import {
  enumerateConnectors,
  resolveMetaCredentials,
} from '../meta-spend-repull/run.js';
import {
  META_AUTH_ERROR,
  META_RATE_LIMITED,
} from '../meta-spend-repull/meta-insights-client.js';
import { MetaEntityClient, type MetaAdEntity } from './meta-entity-client.js';
import { acquireCursorLock } from '../../infrastructure/pg/CursorRepository.js';
import { log } from '../../log.js';

const cfg = loadStreamWorkerConfig();
const DB_URL = cfg.BRAIN_APP_DATABASE_URL;
const BROKERS = cfg.KAFKA_BROKERS.split(',');
// intentional raw: NODE_ENV-derived Kafka topic-prefix selection (must precede config load).
const ENV = process.env['NODE_ENV'] === 'production' ? 'prod' : 'dev';
const LIVE_TOPIC = `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

/** Canonical event_name for the metadata feed (the A1/Admission event type). */
export const AD_ENTITY_UPDATED_EVENT_NAME = 'ad.entity.updated' as const;
/** Overlap-lock cursor resource for the entity sync (distinct from meta.insights / .backfill). */
const ENTITY_CURSOR_RESOURCE = 'meta.entity.sync' as const;

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'meta-entity-sync', brokers: BROKERS, retry: { retries: 5 } });
  const producer = createIdempotentProducer(kafka);

  try {
    await producer.connect();
    log.info(`[meta-entity-sync] starting — topic=${LIVE_TOPIC} brokers=${BROKERS.join(',')}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      log.info('[meta-entity-sync] no connected meta connectors found — exiting');
      return;
    }
    log.info(`[meta-entity-sync] found ${connectors.length} connector(s)`);

    for (const connector of connectors) {
      await syncConnector({ connector, pool, producer });
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

interface SyncParams {
  connector: { connector_instance_id: string; brand_id: string; secret_ref: string; ad_account_id: string | null };
  pool: Pool;
  producer: Producer;
}

async function syncConnector(params: SyncParams): Promise<void> {
  const { connector, pool, producer } = params;
  const { connector_instance_id: ciId, brand_id: brandId, secret_ref: secretRef } = connector;

  const creds = await resolveMetaCredentials(secretRef, connector.ad_account_id);
  if (!creds) {
    log.error(`[meta-entity-sync] connector=${ciId} — credentials not found (RECONNECT_REQUIRED), skipping`);
    recordConnectorAuthRejected('meta');
    return;
  }

  // Overlap-lock (its own resource → never blocks spend repull/backfill).
  const lockAcquired = await acquireCursorLock(pool, brandId, ciId, ENTITY_CURSOR_RESOURCE);
  if (!lockAcquired) {
    log.info(`[meta-entity-sync] connector=${ciId} — locked by another worker, skipping`);
    return;
  }

  const client = new MetaEntityClient(creds);
  let entities: MetaAdEntity[];
  try {
    entities = await client.fetchAllEntities();
  } catch (err) {
    if (String(err).includes(META_AUTH_ERROR)) {
      recordConnectorAuthRejected('meta');
      log.error(`[meta-entity-sync] connector=${ciId} auth error — RECONNECT_REQUIRED`);
      return;
    }
    if (String(err).includes(META_RATE_LIMITED)) {
      log.error(`[meta-entity-sync] connector=${ciId} RateLimited — retry next run`);
      return;
    }
    log.error(`[meta-entity-sync] connector=${ciId} entity fetch failed`, { err });
    return;
  }

  const emitted = await emitEntities({ entities, brandId, ciId, producer });
  log.info(`[meta-entity-sync] connector=${ciId} COMPLETED entities=${entities.length} emitted=${emitted}`);
}

interface EmitParams {
  entities: MetaAdEntity[];
  brandId: string;
  ciId: string;
  producer: Producer;
}

/** ISO date (YYYY-MM-DD) version fallback when Meta omits updated_time. */
function syncDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * FIREHOSE (§2.D): a STABLE content-hash version for grains Meta returns WITHOUT updated_time
 * (adcreatives / custom_audiences / saved_audiences). Hashing the projected content fields means an
 * UNCHANGED entity re-mints the SAME event_id (dedup — no re-sync churn), while a real content change
 * advances the version → a new event Silver picks as latest. Never random, never a day-bucket.
 */
function contentHashVersion(e: MetaAdEntity): string {
  const parts = [
    e.name,
    e.status,
    e.subtype,
    e.approximate_count,
    e.title,
    e.body,
    e.image_url,
    e.video_id,
    e.call_to_action_type,
    e.link_url,
    e.object_story_spec_json,
  ].map((v) => v ?? '');
  return hashToUuidShaped(`meta:entity-content:${e.level}:${e.entity_id}:${parts.join('')}`);
}

/** Normalize Meta's updated_time to a valid UTC ISO (offset:false) for occurred_at, or null. */
function toUtcIso(s: string | null): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export async function emitEntities(p: EmitParams): Promise<number> {
  if (p.entities.length === 0) return 0;

  const messages = [];
  for (const e of p.entities) {
    // version-deterministic event_id: same metadata state → same id (dedup); a real change advances
    // Meta's updated_time → a new version → a new event Silver can pick as latest.
    // FIREHOSE (§2.D): adcreatives/audiences lack updated_time → derive a STABLE content-hash version
    // from the projected fields (NOT random / NOT syncDate churn), so an unchanged creative/audience
    // re-mints the SAME id (dedup) and a real content change advances it. Hierarchy grains keep
    // updated_time (falling back to syncDate only when Meta omits it).
    const version =
      e.entity_updated_at ??
      (e.level === 'adcreative' || e.level === 'custom_audience' || e.level === 'saved_audience'
        ? contentHashVersion(e)
        : syncDate());
    const eventId = hashToUuidShaped(
      `${p.brandId}:meta:${e.level}:${e.entity_id}:${version}:ad.entity.updated`,
    );
    const occurredAt = toUtcIso(e.entity_updated_at) ?? new Date().toISOString();

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: p.brandId,        // from fn result (MT-1) — never from API response
      correlation_id: `meta-entity-sync:${p.ciId}:${eventId}`,
      event_name: AD_ENTITY_UPDATED_EVENT_NAME,
      occurred_at: occurredAt,
      ingested_at: new Date().toISOString(),
      properties: {
        platform: 'meta',
        level: e.level,
        entity_id: e.entity_id,
        campaign_id: e.campaign_id,
        parent_id: e.parent_id,
        name: e.name,
        status: e.status,
        objective: e.objective,
        advertising_channel_type: null, // Meta has no channel-type concept (Google-only)
        bidding_strategy: null,          // not pulled for Meta (optional per the A1 contract)
        entity_updated_at: e.entity_updated_at,
        // ── FIREHOSE entity depth (all additive + nullable; grain-specific). Budgets/bid are MINOR-unit
        //    strings in the account currency (NEVER float). Audiences carry NO member PII. ────────────
        buying_type: e.buying_type,
        daily_budget_minor: e.daily_budget_minor,
        lifetime_budget_minor: e.lifetime_budget_minor,
        bid_strategy: e.bid_strategy,
        effective_status: e.effective_status,
        start_time: e.start_time,
        stop_time: e.stop_time,
        optimization_goal: e.optimization_goal,
        billing_event: e.billing_event,
        bid_amount: e.bid_amount,
        targeting_json: e.targeting_json,
        creative_id: e.creative_id,
        object_story_spec_json: e.object_story_spec_json,
        title: e.title,
        body: e.body,
        image_url: e.image_url,
        video_id: e.video_id,
        call_to_action_type: e.call_to_action_type,
        link_url: e.link_url,
        subtype: e.subtype,
        approximate_count: e.approximate_count,
      },
    });

    messages.push({
      key: buildPartitionKey(p.brandId, eventId),
      value: Buffer.from(JSON.stringify(envelope)),
    });
    incrementCounter('meta_entity_sync_total', { level: e.level });
  }

  // OTel trace-context propagation (OBS-1/OBS-2) — same as the spend repull.
  const traceHeaders: Record<string, Buffer | string> = {};
  injectKafkaTraceContext(traceHeaders);
  await p.producer.send({
    topic: LIVE_TOPIC,
    messages: messages.map((m) => ({ ...m, headers: traceHeaders })),
  });
  log.info(`[meta-entity-sync] connector=${p.ciId} emitted=${messages.length}`);
  return messages.length;
}

// Path-specific entrypoint guard (mirrors meta-spend-repull): match the full directory-qualified
// path so an IMPORT of this module never cross-fires the CLI.
if (process.argv[1]?.endsWith('meta-entity-sync/run.ts') || process.argv[1]?.endsWith('meta-entity-sync/run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    log.error('[meta-entity-sync] fatal', { err });
    process.exit(1);
  });
}
