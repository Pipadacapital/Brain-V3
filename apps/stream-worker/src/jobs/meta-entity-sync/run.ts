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
 * Idempotency / versioning (ADR-0012 CONTENT-deterministic): event_id = uuidV5(brand_id, 'meta',
 * level, entity_id, version) where
 *   version = Meta `updated_time` (its real change-clock, when present)
 *             else contentHashVersion(e)  — a hash over EVERY meaningful payload field.
 * There is NO wall-clock / sync-DATE fallback. A version that changed only because the day rolled
 * over would let a real metadata change WITHIN the same day re-mint the same event_id, and dedup
 * would then COLLAPSE that change = event loss. Because the fallback is a content hash, an
 * UNCHANGED re-sync mints the SAME event_id (deduped downstream, no churn) while ANY real change
 * to a hashed field advances the version, minting a NEW event Silver keeps as latest (keep-latest via
 * a safe drop). Logical grain remains (brand_id, platform, level, entity_id).
 *
 * Dedup (ADR-0015): produce unconditionally — duplicates collapse at Bronze compaction on
 * (brand_id, event_id) with the Silver MERGE as the final backstop (the PG ingest-dedup gate is
 * removed). Mirrors meta-spend-repull / shiprocket-shipment-repull.
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

  // Money on the entity envelope (daily_budget_minor / lifetime_budget_minor / bid_amount) is MINOR
  // units — it MUST carry the account currency as its sibling (I-S07, never blended/float). Best-effort
  // fetch; default 'USD' so a currency hiccup never blocks the entity sync.
  const accountCurrency = await client.fetchAccountCurrency().catch(() => 'USD');
  const emitted = await emitEntities({ entities, brandId, ciId, producer, accountCurrency });
  log.info(`[meta-entity-sync] connector=${ciId} COMPLETED entities=${entities.length} emitted=${emitted}`);
}

interface EmitParams {
  entities: MetaAdEntity[];
  brandId: string;
  ciId: string;
  producer: Producer;
  /** Ad account ISO currency — the sibling for every MINOR-unit money field on the envelope (I-S07). */
  accountCurrency: string;
}

/**
 * CONTENT-hash version fallback (ADR-0012) for the event_id — used for EVERY grain that Meta returns
 * WITHOUT `updated_time`. It hashes EVERY meaningful field that lands in the emitted `properties` and
 * that Silver reads for the SCD, so:
 *   - an UNCHANGED entity re-mints the SAME event_id (deduped downstream — no re-sync churn),
 *   - ANY real change to ANY hashed field advances the version, minting a NEW event Silver picks as
 *     latest (keep-latest via a safe drop — NEVER an event loss).
 * It is NEVER random and NEVER a day-bucket, so it does not depend on the wall clock.
 *
 * CORRECTNESS: the field list below is the COMPLETE meaningful set of the emitted properties. It
 * mirrors the envelope's `properties` object 1:1 (minus platform/currency_code/entity_updated_at,
 * which are constant per pass / derived — see the notes at each). If a field can change but is not
 * hashed, its change would be silently dropped by the gate = EVENT LOSS — so when in doubt, INCLUDE.
 * Order is fixed and each part is JSON-encoded so adjacent values can never smear into a collision.
 */
function contentHashVersion(e: MetaAdEntity, accountCurrency: string): string {
  // The full meaningful field set (cross-checked field-by-field against the emitted `properties`):
  //  - identity/hierarchy: level, entity_id, campaign_id, parent_id (all part of the payload)
  //  - core SCD: name, status, objective, effective_status
  //  - money (MINOR-unit strings + the currency sibling, never float): daily_budget_minor,
  //    lifetime_budget_minor, bid_amount, currency_code
  //  - config: buying_type, bid_strategy, start_time, stop_time, optimization_goal, billing_event,
  //    targeting_json, creative_id
  //  - creative depth: object_story_spec_json, title, body, image_url, video_id,
  //    call_to_action_type, link_url
  //  - audience depth (no PII members): subtype, approximate_count
  // OMITTED (and WHY it is safe): platform (constant 'meta'), advertising_channel_type /
  //  bidding_strategy (always null for Meta — Google-only), entity_updated_at (this fallback ONLY
  //  runs when it is null, so it carries no signal here).
  const parts = [
    e.level,
    e.entity_id,
    e.campaign_id,
    e.parent_id,
    e.name,
    e.status,
    e.objective,
    e.effective_status,
    e.buying_type,
    e.daily_budget_minor,
    e.lifetime_budget_minor,
    accountCurrency, // I-S07: money's currency sibling is part of the meaningful state
    e.bid_strategy,
    e.start_time,
    e.stop_time,
    e.optimization_goal,
    e.billing_event,
    e.bid_amount,
    e.targeting_json,
    e.creative_id,
    e.object_story_spec_json,
    e.title,
    e.body,
    e.image_url,
    e.video_id,
    e.call_to_action_type,
    e.link_url,
    e.subtype,
    e.approximate_count,
  ];
  // JSON.stringify(part ?? null) makes '' vs null vs 'null' unambiguous and delimits fields.
  const canonical = parts.map((v) => JSON.stringify(v ?? null)).join('|');
  return hashToUuidShaped(`meta:entity-content:${e.level}:${e.entity_id}:${canonical}`);
}

/** Normalize Meta's updated_time to a valid UTC ISO (offset:false) for occurred_at, or null. */
function toUtcIso(s: string | null): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * The CONTENT-deterministic event_id for one entity (exported for tests).
 * version = Meta updated_time (real change-clock) when present, else the full content hash. NEVER a
 * date/wall-clock value — so a same-day metadata change always mints a NEW id (no ADR-0012 event loss).
 */
export function entityEventId(brandId: string, e: MetaAdEntity, accountCurrency: string): string {
  const version = e.entity_updated_at ?? contentHashVersion(e, accountCurrency);
  return hashToUuidShaped(`${brandId}:meta:${e.level}:${e.entity_id}:${version}:ad.entity.updated`);
}

export async function emitEntities(p: EmitParams): Promise<number> {
  if (p.entities.length === 0) return 0;

  const messages: Array<{ eventId: string; key: string; value: Buffer }> = [];
  for (const e of p.entities) {
    // CONTENT-deterministic event_id (ADR-0012): version = Meta updated_time (real change-clock) when
    // present, else a hash over EVERY meaningful payload field (contentHashVersion). NEVER a sync-DATE:
    // a same-day metadata change must mint a NEW id, or dedup would collapse it (event loss).
    const eventId = entityEventId(p.brandId, e, p.accountCurrency);
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
        currency_code: p.accountCurrency, // I-S07 sibling for daily_budget_minor/lifetime_budget_minor/bid_amount
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
      eventId,
      key: buildPartitionKey(p.brandId, eventId),
      value: Buffer.from(JSON.stringify(envelope)),
    });
    incrementCounter('meta_entity_sync_total', { level: e.level });
  }

  // ADR-0015: produce unconditionally — the PG ingest-dedup gate is removed. The event_id is
  // CONTENT-deterministic (entityEventId: updated_time or a payload content-hash), so an unchanged
  // re-sync re-mints the SAME (brand_id, event_id) and is collapsed by Bronze compaction dedup +
  // the Silver MERGE, while a real change mints a NEW id and always lands (no event loss).
  // OTel trace-context propagation (OBS-1/OBS-2) — same as the spend repull.
  const traceHeaders: Record<string, Buffer | string> = {};
  injectKafkaTraceContext(traceHeaders);
  await p.producer.send({
    topic: LIVE_TOPIC,
    messages: messages.map((m) => ({ key: m.key, value: m.value, headers: traceHeaders })),
  });
  const emitted = messages.length;

  log.info(`[meta-entity-sync] connector=${p.ciId} emitted=${emitted}`);
  return emitted;
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
