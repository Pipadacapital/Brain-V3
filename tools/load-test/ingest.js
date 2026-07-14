/**
 * Brain V4 — INGEST load test (k6).
 *
 * Drives realistic CollectorEventV1 envelopes at the collector accept-before-validate
 * endpoints (POST /collect, /v1/events, /batch on :8787). The collector handler does a
 * single durable spool INSERT and ACKs (D-1 ordering: spool commit BEFORE 200) — there is
 * NO validation / Apicurio / Kafka produce in the request path, so the accept latency we
 * measure here is the spool-write tail, NOT the medallion. The drainer → Kafka → Kafka Connect
 * Iceberg sink → Bronze pipeline (ADR-0010: the Connect sink is the SOLE Bronze writer,
 * append-only, ~30s commit interval) is asynchronous; its correctness (event count, streaming
 * lag, zero-OOM) is an OUT-OF-BAND operator assertion documented in README.md (k6 cannot
 * read Connect/Trino/Prometheus directly).
 *
 * Envelope is grounded in packages/contracts/src/events/sample.collector.event.v1.ts:
 *   - brand_id (top-level) is PARTITIONING-ONLY and untrusted; the authoritative brand is
 *     DERIVED server-side from properties.install_token (R2 / resolve_brand_by_install_token).
 *   - consent_flags is a first-class optional field; ABSENT consent is QUARANTINED at ingest
 *     routing (R3) and never trusted into Bronze — so we always send it (analytics:true) to
 *     keep the soak-count assertion meaningful.
 *
 * Run:  k6 run tools/load-test/ingest.js
 * Env:  COLLECTOR_URL, BRAND_ID, INSTALL_TOKEN, VUS, DURATION, BATCH_RATIO, BATCH_SIZE
 * See   tools/load-test/README.md
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// ── Config (all env-overridable; defaults target the local dev stack) ─────────────────────────
const COLLECTOR_URL = __ENV.COLLECTOR_URL || 'http://localhost:8787';
const BRAND_ID = __ENV.BRAND_ID || '00000000-0000-0000-0000-000000000001';
// install_token is the server's tenant-key derivation input (R2). For a real soak count it MUST
// resolve to a row in pixel.pixel_installation, else the drainer quarantines and Bronze count < sent.
const INSTALL_TOKEN = __ENV.INSTALL_TOKEN || '00000000-0000-0000-0000-000000000001';
const VUS = Number(__ENV.VUS || 50);
const DURATION = __ENV.DURATION || '5m';
const BATCH_RATIO = Number(__ENV.BATCH_RATIO || 0.2); // fraction of iterations that POST /batch
const BATCH_SIZE = Math.min(Number(__ENV.BATCH_SIZE || 25), 50); // /batch caps at MAX_BATCH=50

// ── Custom metrics ────────────────────────────────────────────────────────────────────────────
// events_sent is the SOAK-COUNT denominator: after the run compare it to the Trino Bronze count
// (see README "Soak-count assertion"). 200-ACK == durably spooled, so this is the truth set.
const eventsSent = new Counter('events_sent');
const acceptLatency = new Trend('accept_latency', true);

// ── Load profile: ramp → sustained → ramp-down (a realistic pixel traffic curve) ───────────────
export const options = {
  scenarios: {
    ingest: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: VUS }, // ramp up
        { duration: DURATION, target: VUS }, // sustained soak
        { duration: '30s', target: 0 }, // ramp down (drain in-flight spool writes)
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // The accept path is a single spool INSERT; it must be fast and must (almost) never error.
    http_req_failed: ['rate<0.01'], // < 1% transport/5xx failures
    'http_req_duration{endpoint:collect}': ['p(95)<250'],
    'http_req_duration{endpoint:batch}': ['p(95)<1500'], // N spool INSERTs per request
    checks: ['rate>0.99'], // > 99% of responses ACK accepted:true
  },
  // Keep the summary lean and tag-aware so the operator can read per-endpoint p95.
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
};

// ── Envelope helpers ────────────────────────────────────────────────────────────────────────
// RFC-4122 v4 UUID. crypto.getRandomValues is provided by the k6 runtime (globalThis.crypto).
function uuidv4() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  const h = [];
  for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
  return (
    h[0] + h[1] + h[2] + h[3] + '-' + h[4] + h[5] + '-' + h[6] + h[7] + '-' + h[8] + h[9] + '-' +
    h[10] + h[11] + h[12] + h[13] + h[14] + h[15]
  );
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// A realistic event-name mix weighted toward high-volume pixel events.
const EVENT_NAMES = [
  'page.viewed', 'page.viewed', 'page.viewed', 'page.viewed',
  'product.viewed', 'product.viewed',
  'collection.viewed',
  'search.performed',
  'cart.updated',
  'checkout.started',
  'checkout.completed',
  'form.submitted',
];
const UTM_SOURCES = ['google', 'meta', 'tiktok', 'klaviyo', 'direct', '(none)'];
const CLICK_IDS = [{ gclid: () => `gcl_${uuidv4()}` }, { fbclid: () => `fb.${Date.now()}.${uuidv4()}` }, {}];

// Build one CollectorEventV1 envelope. occurred_at is ISO-8601 UTC with NO offset (z.datetime offset:false).
function buildEvent() {
  const anonId = uuidv4();
  const props = {
    install_token: INSTALL_TOKEN, // REQUIRED — server derives brand_id from this (R2)
    brain_anon_id: anonId,
    session_id: uuidv4(),
    landing_path: pick(['/', '/products/widget', '/collections/all', '/cart', '/search']),
    referrer: pick(['https://www.google.com/', 'https://l.facebook.com/', '', 'https://t.co/']),
    utm_source: pick(UTM_SOURCES),
    utm_medium: pick(['cpc', 'organic', 'email', 'social', 'referral']),
    utm_campaign: pick(['summer_sale', 'retargeting', 'brand', 'prospecting']),
    'device.type': pick(['mobile', 'desktop', 'tablet']),
    'device.os': pick(['iOS', 'Android', 'macOS', 'Windows']),
  };
  const click = pick(CLICK_IDS);
  for (const k of Object.keys(click)) props[k] = click[k]();

  return {
    schema_version: '1',
    event_id: uuidv4(),
    brand_id: BRAND_ID, // partitioning-only; untrusted (the real brand is derived from install_token)
    correlation_id: uuidv4(),
    event_name: pick(EVENT_NAMES),
    occurred_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), // strip ms → ...:SSZ, offset:false
    consent_flags: { analytics: true, marketing: true, personalization: true, ai_processing: false },
    properties: props,
  };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function () {
  const useBatch = Math.random() < BATCH_RATIO;

  if (useBatch) {
    const events = [];
    for (let i = 0; i < BATCH_SIZE; i++) events.push(buildEvent());
    const res = http.post(`${COLLECTOR_URL}/batch`, JSON.stringify({ events }), {
      headers: { ...JSON_HEADERS, 'X-Correlation-Id': uuidv4() },
      tags: { endpoint: 'batch' },
    });
    acceptLatency.add(res.timings.duration, { endpoint: 'batch' });
    const ok = check(res, {
      'batch 200': (r) => r.status === 200,
      'batch accepted all': (r) => {
        try {
          return JSON.parse(r.body).accepted === events.length;
        } catch (_e) {
          return false;
        }
      },
    });
    if (ok) eventsSent.add(events.length);
    return;
  }

  // Alternate between the two single-event aliases (/collect → 200, /v1/events → 202).
  const path = Math.random() < 0.5 ? '/collect' : '/v1/events';
  const ev = buildEvent();
  const res = http.post(`${COLLECTOR_URL}${path}`, JSON.stringify(ev), {
    headers: { ...JSON_HEADERS, 'X-Correlation-Id': ev.correlation_id },
    tags: { endpoint: 'collect', path },
  });
  acceptLatency.add(res.timings.duration, { endpoint: 'collect' });
  const ok = check(res, {
    'collect accepted (200/202)': (r) => r.status === 200 || r.status === 202,
    'collect accepted:true': (r) => {
      try {
        return JSON.parse(r.body).accepted === true;
      } catch (_e) {
        return false;
      }
    },
  });
  if (ok) eventsSent.add(1);
}

// Echo the soak-count denominator and the exact out-of-band assertion at end of run.
export function handleSummary(data) {
  const sent = data.metrics.events_sent ? data.metrics.events_sent.values.count : 0;
  const text =
    `\n  events_sent (soak-count denominator) = ${sent}\n` +
    `  OUT-OF-BAND assertion — Bronze count MUST be >= events_sent (ADR-0010: Bronze is APPEND-ONLY\n` +
    `  under the Kafka Connect sink; re-deliveries land as extra rows — dedup lives in Silver).\n` +
    `  Run in Trino:\n` +
    `    SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect_lifted\n` +
    `    WHERE brand_id = '${BRAND_ID}' AND ingested_at >= TIMESTAMP '<test-start-utc>';\n` +
    `  See tools/load-test/README.md "Operator post-run assertions".\n`;
  return {
    stdout: text,
    'load-test-ingest-summary.json': JSON.stringify(data, null, 2),
  };
}
