/**
 * iceberg-bronze.ts — shared test helper for the Iceberg Bronze e2e suites.
 *
 * MEDALLION / Iceberg-Bronze (ADR-0010): the stream-worker no longer writes Bronze to PostgreSQL
 * (the PG data_plane.bronze_events table was dropped — migration 0070; ProcessEventUseCase's PG
 * write is a no-op by default). The SOLE Bronze landing writer is the Kafka Connect Iceberg sink
 * (the compose `kafka-connect` service): it APPENDS the collector topic into the truly-raw
 * `brain_bronze.collector_events_connect` table (payload + kafka coords only) on a ~30s commit
 * interval. Bronze is APPEND-ONLY — NO Bronze dedup; business dedup lives in Silver
 * (silver_collector_event MERGE on brand_id/event_id). The Spark sinks (bronze_landing.py /
 * brain-bronze-sink container) are RETIRED.
 *
 * So the "does an event land in Bronze?" e2e tests: PRODUCE a raw-JSON collector envelope to the
 * Bronze-bound Kafka topic → the running Connect sink lands it in Iceberg → READ it back over TRINO
 * through the LIFT VIEW `iceberg.brain_bronze.collector_events_connect_lifted`, which exposes the
 * lifted envelope columns (event_id/brand_id/event_type/occurred_at/...) these pollers filter on.
 * Trino reads Iceberg snapshots directly — no external-table metadata cache to bust; a row is
 * visible on the first snapshot after the Connect sink's commit (POLL TIMEOUTS must tolerate the
 * ~30-60s commit latency — hence the 120s default below).
 *
 * Tenant isolation in the lakehouse is PREDICATE-BASED at the read seam (every read filters
 * `brand_id = ?`, mirroring metric-engine withTrinoBrand / dq silver-reader), NOT PG RLS. A
 * brand-scoped query therefore returns 0 rows for another brand's event BY CONSTRUCTION.
 *
 * REQUIRES the `lakehouse` docker profile (Kafka + kafka-connect + Iceberg REST + MinIO + Trino).
 * Suites self-skip via `icebergBronzeAvailable()` when it is not up.
 */
import { createTrinoPool } from '@brain/metric-engine';
import type { Producer } from 'kafkajs';

const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';

/**
 * The Bronze read target (ADR-0010, CONSTANT — the BRONZE_SOURCE cutover seam is REMOVED): the
 * Trino lift view over the Kafka Connect collector table. The three-part name resolves the view
 * directly through the iceberg catalog; it exposes the event_id/brand_id/event_type columns the
 * pollers below filter on.
 */
export const BRONZE_TABLE = 'iceberg.brain_bronze.collector_events_connect_lifted';

// The running Connect sink consumes the env-PREFIXED topic; the local-prod stack uses `prod.`
// (the kafka-connect compose service's collector connector reads prod.collector.event.v1). Default
// to that so the suites exercise the LIVE sink without a manual override; set COLLECTOR_TOPIC for
// other envs.
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

/** A minimal collector envelope (the raw-JSON shape the collector produces; the Connect sink lands
 *  it verbatim as `payload` and the lift view lifts these scalars at query time). */
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
 * pass the matching topic explicitly so the running Connect sink actually consumes it.
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
 * directly — no metadata cache-bust needed; a row is visible on the first snapshot after the
 * Connect sink's ~30s commit, so the default timeout is 120s (ADR-0010: tolerate 30-60s commit
 * latency). Returns the matching row count (>= min on success, or the last count seen at timeout).
 * A brand-scoped query returns 0 for another brand's event by construction (read-seam isolation) —
 * use that for the negative/isolation controls.
 */
export async function pollIcebergBronzeCount(
  pool: BronzePool,
  match: BronzeMatch,
  opts: { min?: number; timeoutMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const min = opts.min ?? 1;
  const interval = opts.intervalMs ?? 1500;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);

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
 * Convenience: poll until at least one (brand, eventId) row is visible. Returns true if it landed.
 * Use for "this exact event reached Bronze" assertions. NOTE (ADR-0010): Bronze is APPEND-ONLY —
 * a re-delivered event lands as an ADDITIONAL row (dedup is Silver's job), so this checks >= 1.
 */
export async function waitForBronzeEvent(
  pool: BronzePool,
  brandId: string,
  eventId: string,
  timeoutMs = 120_000,
): Promise<boolean> {
  return (await pollIcebergBronzeCount(pool, { brandId, eventId }, { min: 1, timeoutMs })) >= 1;
}
