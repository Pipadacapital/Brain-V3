/**
 * iceberg-bronze.ts — shared test helper for the Iceberg Bronze e2e suites.
 *
 * MEDALLION / Iceberg-Bronze: the stream-worker no longer writes Bronze to PostgreSQL (the PG
 * data_plane.bronze_events table was dropped — migration 0070; ProcessEventUseCase's PG write is a
 * no-op by default). The SOLE Bronze system-of-record is the Spark Structured-Streaming sink: the
 * unified landing job (db/iceberg/spark/bronze_landing.py) consumes the collector + backfill + raw
 * connector topics and MERGEs into the Iceberg table `brain_bronze.events` (idempotent on dedup_key
 * = evt:{brand_id}:{event_id} for collector rows). The legacy split sinks wrote
 * `brain_bronze.collector_events` — selectable via BRONZE_SOURCE until Phase-8 decommission.
 *
 * So the "does an event land in Bronze?" e2e tests: PRODUCE a raw-JSON collector envelope to the
 * Bronze-bound Kafka topic → the running Spark sink lands it in Iceberg → READ it back over TRINO
 * (BRAIN V4: StarRocks is REMOVED; Trino-over-Iceberg is the sole serving engine — this helper
 * reads the three-part `iceberg.brain_bronze.*` name through the same Trino REST adapter the app
 * uses). Trino reads Iceberg snapshots directly, so unlike the old StarRocks reader there is NO
 * external-table metadata cache to bust (no REFRESH EXTERNAL TABLE) — a freshly MERGEd row is
 * visible on the next snapshot.
 *
 * Tenant isolation in the lakehouse is PREDICATE-BASED at the read seam (every read filters
 * `brand_id = ?`, mirroring metric-engine withTrinoBrand / dq silver-reader), NOT PG RLS. A
 * brand-scoped query therefore returns 0 rows for another brand's event BY CONSTRUCTION.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka + Spark sink + Iceberg REST + MinIO + Trino).
 * Suites self-skip via `icebergBronzeAvailable()` when it is not up.
 */
import { createTrinoPool } from '@brain/metric-engine';
import type { Producer } from 'kafkajs';

const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';

/**
 * BRONZE_SOURCE cutover seam (unified-bronze-landing): 'events' = the unified
 * brain_bronze.events table written by bronze_landing.py (the DEPLOYED default);
 * 'legacy' = the pre-unified brain_bronze.collector_events written by the split sinks.
 * Three-part names resolve the raw Bronze tables directly through the iceberg catalog.
 */
const BRONZE_SOURCE = process.env['BRONZE_SOURCE'] ?? 'events';
export const BRONZE_TABLE =
  BRONZE_SOURCE === 'legacy'
    ? 'iceberg.brain_bronze.collector_events'
    : 'iceberg.brain_bronze.events';

// The running Spark sink consumes the env-PREFIXED topic; the local-prod stack uses `prod.`
// (verified: brain-bronze-sink COLLECTOR_TOPIC=prod.collector.event.v1). Default to that so the
// suites exercise the LIVE sink without a manual override; set COLLECTOR_TOPIC for other envs.
export const COLLECTOR_TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'prod.collector.event.v1';
export const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

/**
 * The Bronze read-back seam: a thin pool over the Trino REST adapter. `end()` is a no-op
 * (stateless HTTP — kept so suites' afterAll teardown stays uniform with real pools).
 */
export interface BronzePool {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  end(): Promise<void>;
}

/** A Trino pool against the iceberg catalog (Bronze is read over Trino — StarRocks is gone). */
export function makeBronzeTrinoPool(): BronzePool {
  const trino = createTrinoPool({ baseUrl: TRINO_URL, user: TRINO_USER, catalog: 'iceberg' });
  return {
    query: (sql, params) => trino.query(sql, params),
    end: async () => undefined,
  };
}

/** Is the lakehouse Bronze read path reachable? Suites SKIP_IF_NO_LAKEHOUSE when this is false. */
export async function icebergBronzeAvailable(pool: BronzePool): Promise<boolean> {
  try {
    await pool.query(`SELECT 1 FROM ${BRONZE_TABLE} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

/** A minimal collector envelope (the raw-JSON shape the collector produces + the Spark sink parses). */
export interface CollectorEnvelope {
  schema_version: string;
  event_id: string;
  brand_id: string;
  correlation_id: string;
  event_name: string;
  occurred_at: string;
  ingested_at: string;
  properties?: Record<string, unknown>;
  consent_flags?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Produce a raw-JSON collector envelope to the Bronze-bound Kafka topic (keyed by brand_id).
 * `topic` defaults to the helper's COLLECTOR_TOPIC; callers in a differently-prefixed stack
 * pass the matching topic explicitly so the running Spark sink actually consumes it.
 */
export async function produceCollectorEvent(
  producer: Producer,
  env: CollectorEnvelope,
  topic: string = COLLECTOR_TOPIC,
): Promise<void> {
  await producer.send({
    topic,
    messages: [
      {
        key: env.brand_id,
        value: Buffer.from(JSON.stringify(env)),
        headers: { event_name: Buffer.from(env.event_name) },
      },
    ],
  });
}

export interface BronzeMatch {
  brandId: string;
  eventId?: string;
  /** Match any of these event_ids (IN-list) — use to count a specific produced batch, ignoring
   *  pre-existing rows of the same brand/type from earlier runs. */
  eventIds?: string[];
  eventType?: string;
}

/**
 * Poll Iceberg Bronze (over Trino) until at least `min` rows match. Trino reads Iceberg snapshots
 * directly — no metadata cache-bust needed; a just-MERGEd row is visible on the next poll. Returns
 * the matching row count (>= min on success, or the last count seen at timeout). A brand-scoped
 * query returns 0 for another brand's event by construction (read-seam isolation) — use that for
 * the negative/isolation controls.
 */
export async function pollIcebergBronzeCount(
  pool: BronzePool,
  match: BronzeMatch,
  opts: { min?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const min = opts.min ?? 1;
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);

  const where: string[] = ['brand_id = ?'];
  const params: unknown[] = [match.brandId];
  if (match.eventId) {
    where.push('event_id = ?');
    params.push(match.eventId);
  }
  if (match.eventIds && match.eventIds.length > 0) {
    where.push(`event_id IN (${match.eventIds.map(() => '?').join(',')})`);
    params.push(...match.eventIds);
  }
  if (match.eventType) {
    where.push('event_type = ?');
    params.push(match.eventType);
  }
  const sql = `SELECT COUNT(*) AS c FROM ${BRONZE_TABLE} WHERE ${where.join(' AND ')}`;

  let last = 0;
  // First iteration runs immediately; loop until the deadline.
  for (;;) {
    const rows = await pool.query<{ c: number | string }>(sql, params);
    last = Number(rows[0]?.c ?? 0);
    if (last >= min) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Convenience: poll until a single (brand, eventId) row is visible. Returns true if it landed.
 * Use for "this exact event reached Bronze" assertions (dedup-safe: Spark MERGE collapses re-delivery).
 */
export async function waitForBronzeEvent(
  pool: BronzePool,
  brandId: string,
  eventId: string,
  timeoutMs = 45_000,
): Promise<boolean> {
  return (await pollIcebergBronzeCount(pool, { brandId, eventId }, { min: 1, timeoutMs })) >= 1;
}
