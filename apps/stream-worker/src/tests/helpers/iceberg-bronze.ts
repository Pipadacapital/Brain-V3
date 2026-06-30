/**
 * iceberg-bronze.ts — shared test helper for the Iceberg Bronze e2e suites.
 *
 * MEDALLION / Iceberg-Bronze: the stream-worker no longer writes Bronze to PostgreSQL (the PG
 * data_plane.bronze_events table was dropped — migration 0070; ProcessEventUseCase's PG write is a
 * no-op by default). The SOLE Bronze system-of-record is now the Spark Structured-Streaming sink
 * (db/iceberg/spark/bronze_materialize.py): it consumes the collector topic, applies the SAME R2/R3
 * admission gates as the app, and MERGEs into the Iceberg table `brain_bronze.collector_events`
 * (idempotent on (brand_id, event_id)). The lakehouse Bronze is read through the StarRocks external
 * catalog `brain_bronze_local`.
 *
 * So the "does an event land in Bronze?" e2e tests now: PRODUCE a raw-JSON collector envelope to the
 * Bronze-bound Kafka topic → the running Spark sink lands it in Iceberg → READ it back via StarRocks.
 *
 * Two gotchas this helper encapsulates:
 *   1. StarRocks caches Iceberg snapshot metadata (~60s background refresh). A just-sunk row is not
 *      visible until the cache refreshes — so every poll issues `REFRESH EXTERNAL TABLE` first to bust
 *      the cache (a freshly produced event then becomes readable in ~8s instead of up to ~60s).
 *   2. Tenant isolation in the lakehouse is PREDICATE-BASED at the read seam (every read filters
 *      `brand_id = ?`, mirroring metric-engine withSilverBrand / dq silver-reader), NOT PG RLS. A
 *      brand-scoped query therefore returns 0 rows for another brand's event BY CONSTRUCTION.
 *
 * REQUIRES the `lakehouse` docker profile (Redpanda + Spark sink + Iceberg REST + MinIO + StarRocks).
 * Suites self-skip via `icebergBronzeAvailable()` when it is not up.
 */
import mysql from 'mysql2/promise';
import type { Producer } from 'kafkajs';

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? process.env['STARROCKS_PORT'] ?? '9030');
const SR_USER = process.env['STARROCKS_ROOT_USER'] ?? 'root';
const SR_PASSWORD = process.env['STARROCKS_ROOT_PASSWORD'] ?? '';

const BRONZE_CATALOG = process.env['STARROCKS_BRONZE_CATALOG'] ?? 'brain_bronze_local';
export const BRONZE_TABLE = `${BRONZE_CATALOG}.brain_bronze.collector_events`;

export const COLLECTOR_TOPIC = process.env['COLLECTOR_TOPIC'] ?? 'dev.collector.event.v1';
export const KAFKA_BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

/** A mysql2 pool against StarRocks (the Iceberg external catalog is queried over the MySQL protocol). */
export function makeStarrocksPool(): mysql.Pool {
  return mysql.createPool({
    host: SR_HOST,
    port: SR_PORT,
    user: SR_USER,
    password: SR_PASSWORD,
    connectionLimit: 2,
    // StarRocks speaks the MySQL protocol but is not MySQL — keep the handshake minimal.
    enableKeepAlive: true,
  });
}

/** Is the lakehouse Bronze read path reachable? Suites SKIP_IF_NO_LAKEHOUSE when this is false. */
export async function icebergBronzeAvailable(pool: mysql.Pool): Promise<boolean> {
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
 * `topic` defaults to the helper's COLLECTOR_TOPIC; callers in a prod-prefixed stack (local-prod)
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
 * Poll Iceberg Bronze (via the StarRocks external catalog) until at least `min` rows match, forcing a
 * metadata refresh each poll so a just-sunk row is visible promptly. Returns the matching row count
 * (>= min on success, or the last count seen at timeout). A brand-scoped query returns 0 for another
 * brand's event by construction (read-seam isolation) — use that for the negative/isolation controls.
 */
export async function pollIcebergBronzeCount(
  pool: mysql.Pool,
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
    await pool.query(`REFRESH EXTERNAL TABLE ${BRONZE_TABLE}`).catch(() => undefined);
    const [rows] = await pool.query(sql, params);
    last = Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
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
  pool: mysql.Pool,
  brandId: string,
  eventId: string,
  timeoutMs = 45_000,
): Promise<boolean> {
  return (await pollIcebergBronzeCount(pool, { brandId, eventId }, { min: 1, timeoutMs })) >= 1;
}
