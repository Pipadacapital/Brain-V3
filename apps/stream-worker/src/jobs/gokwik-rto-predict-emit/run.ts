/**
 * gokwik-rto-predict-emit/run.ts — emit GoKwik RTO-Predict risk events (DEV-HONEST source).
 *
 * RTO-Predict is a SYNCHRONOUS at-checkout call (research finding 1): a write-path enrichment,
 * not a periodic read. In production Brain captures risk_flag + reason + request_id as the
 * prediction is emitted (order-keyed). In DEV there is no live at-checkout call to observe, so
 * these arrive as LABELLED SYNTHETIC FIXTURES emitted to the live lane as gokwik.rto_predict.v1.
 *
 * The mapper + Silver shape are REAL and production-shaped; only the SOURCE is synthetic until
 * partner credentials exist. Every event carries data_source='synthetic' + the Bronze envelope
 * carries processing_flags._synthetic=true. The risk_flag is CATEGORICAL (High/Med/Low/Control)
 * recorded VERBATIM — a numeric score is NEVER fabricated.
 *
 * Enumeration uses the same SECURITY DEFINER fn as the AWB job (list_gokwik_connectors_for_awb_repull),
 * GUC set AFTER enumerate (MT-1). brand_id ALWAYS from the fn result, never from the fixture.
 *
 * Dev trigger (MB-6): pass connector_instance_id as argv[2].
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Pool } from 'pg';
import { Kafka, type Producer } from 'kafkajs';
import { buildPartitionKey } from '@brain/events';
import { CollectorEventV1Schema, COLLECTOR_EVENT_V1_TOPIC_SUFFIX } from '@brain/contracts';
import {
  mapGokwikRtoPredict,
  uuidV5FromRtoPredict,
  GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
  type GokwikRtoPredictRecord,
} from '@brain/gokwik-mapper';

const DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const BROKERS = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');
const ENV = process.env['APP_ENV'] ?? 'dev';
const LIVE_TOPIC = process.env['COLLECTOR_TOPIC'] ?? `${ENV}.${COLLECTOR_EVENT_V1_TOPIC_SUFFIX}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, '..', '_fixtures', 'gokwik-shopflo', 'gokwik-rto-predict.json');

interface GokwikConnectorRow {
  connector_instance_id: string;
  brand_id: string;
}

interface RtoFixtureFile {
  _synthetic?: boolean;
  records: GokwikRtoPredictRecord[];
}

function loadFixture(): GokwikRtoPredictRecord[] {
  try {
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    const parsed = JSON.parse(raw) as RtoFixtureFile;
    return Array.isArray(parsed.records) ? parsed.records : [];
  } catch (err) {
    console.warn(`[gokwik-rto-predict-emit] could not read fixture — empty source: ${String(err)}`);
    return [];
  }
}

export async function run(targetConnectorInstanceId?: string): Promise<void> {
  const pool = new Pool({ connectionString: DB_URL, max: 5 });
  const kafka = new Kafka({ clientId: 'gokwik-rto-predict-emit', brokers: BROKERS, retry: { retries: 5 } });
  const producer = kafka.producer();

  try {
    await producer.connect();
    console.info(`[gokwik-rto-predict-emit] starting — topic=${LIVE_TOPIC}`);

    const connectors = await enumerateConnectors(pool, targetConnectorInstanceId);
    if (connectors.length === 0) {
      console.info('[gokwik-rto-predict-emit] no connected GoKwik connectors — exiting');
      return;
    }

    const records = loadFixture();
    for (const connector of connectors) {
      await emitForConnector(connector, records, producer);
    }
  } finally {
    await producer.disconnect();
    await pool.end();
  }
}

async function enumerateConnectors(
  pool: Pool,
  targetConnectorInstanceId?: string,
): Promise<GokwikConnectorRow[]> {
  if (targetConnectorInstanceId) {
    const result = await pool.query<GokwikConnectorRow>(
      `SELECT connector_instance_id, brand_id
       FROM list_gokwik_connectors_for_awb_repull()
       WHERE connector_instance_id = $1`,
      [targetConnectorInstanceId],
    );
    return result.rows;
  }
  const result = await pool.query<GokwikConnectorRow>(
    `SELECT connector_instance_id, brand_id FROM list_gokwik_connectors_for_awb_repull()`,
  );
  return result.rows;
}

async function emitForConnector(
  connector: GokwikConnectorRow,
  records: GokwikRtoPredictRecord[],
  producer: Producer,
): Promise<void> {
  const { connector_instance_id: ciId, brand_id: brandId } = connector;
  const messages = [];
  for (const record of records) {
    const orderId = record.order_id ? String(record.order_id) : '';
    const requestId = record.request_id ? String(record.request_id) : '';
    if (!orderId) continue;

    // SYNTHETIC source in dev — data_source stamped for the UI badge.
    const mapped = mapGokwikRtoPredict(record, brandId, 'synthetic');
    const eventId = uuidV5FromRtoPredict(brandId, orderId, requestId);

    const envelope = CollectorEventV1Schema.parse({
      schema_version: '1',
      event_id: eventId,
      brand_id: brandId,                  // from fn result (MT-1) — never from fixture
      correlation_id: `gokwik-rto-predict-emit:${ciId}:${eventId}`,
      event_name: GOKWIK_RTO_PREDICT_V1_EVENT_NAME,
      occurred_at: mapped.occurred_at,
      ingested_at: new Date().toISOString(),
      properties: {
        ...(mapped.properties as unknown as Record<string, unknown>),
        processing_flags: { _synthetic: true },
      },
    });

    messages.push({
      key: buildPartitionKey(brandId, eventId),
      value: Buffer.from(JSON.stringify(envelope)),
    });
  }

  if (messages.length > 0) {
    await producer.send({ topic: LIVE_TOPIC, messages });
  }
  console.info(`[gokwik-rto-predict-emit] connector=${ciId} brand=${brandId} emitted=${messages.length} (synthetic)`);
}

if (process.argv[1]?.endsWith('run.ts') || process.argv[1]?.endsWith('run.js')) {
  const ciArg = process.argv[2];
  run(ciArg).catch((err) => {
    console.error('[gokwik-rto-predict-emit] fatal', err);
    process.exit(1);
  });
}

export { enumerateConnectors };
