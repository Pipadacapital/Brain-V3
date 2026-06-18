#!/usr/bin/env node
/**
 * pixel-fixture/send-event.mjs — shape-(a) browser-origin event fixture (Track B).
 *
 * Emits the LIVE shape-(a) CollectorEventV1 (ADR-1) — the SAME envelope the brain.js SDK
 * (packages/pixel-sdk) and the served /pixel.js produce: event_name dot.lowercase, ISO
 * occurred_at, a properties bag carrying install_token / brain_anon_id / session_id /
 * click-ids / utm, and a top-level consent_flags. ONE event per POST (REC-5).
 *
 * The install_token is the server's tenant-key derivation input (R2): the stream-worker
 * DERIVES the authoritative brand_id from it. Set INSTALL_TOKEN to a real pixel_installation
 * token to land a Bronze row under that brand; otherwise the event quarantines (correct).
 *
 * FAILS-CLOSED (architecture Track A/B): unlike the old Sprint-0 stub, this exits NON-ZERO
 * when the collector is unreachable (the inert exit-0-offline probe is REJECTED). Pass
 * ALLOW_OFFLINE=1 to opt back into the soft-exit for a no-Docker local smoke.
 *
 * Usage:
 *   INSTALL_TOKEN=<uuid> node tools/pixel-fixture/send-event.mjs
 *   COLLECTOR_URL=http://localhost:3001 INSTALL_TOKEN=<uuid> node tools/pixel-fixture/send-event.mjs
 *
 * Exit codes: 0 — accepted (2xx) · 1 — error / unreachable (fails closed)
 */

import { randomUUID } from 'crypto';

const COLLECTOR_URL = process.env['COLLECTOR_URL'] ?? 'http://localhost:3001';
const BRAND_ID = process.env['BRAND_ID'] ?? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INSTALL_TOKEN = process.env['INSTALL_TOKEN'] ?? randomUUID(); // unresolved → quarantines (correct)
const ALLOW_OFFLINE = process.env['ALLOW_OFFLINE'] === '1';
const EVENT_NAME = process.env['EVENT_NAME'] ?? 'page.viewed';

const eventId = randomUUID();
const correlationId = randomUUID();
const occurredAt = new Date().toISOString();

// ── Shape (a) envelope (ADR-1) — NO raw PII, NO salt (ADR-2) ──────────────────
const syntheticEvent = {
  schema_version: '1',
  event_id: eventId,
  brand_id: BRAND_ID, // PARTITIONING ONLY — server derives the authoritative brand from install_token
  correlation_id: correlationId,
  event_name: EVENT_NAME,
  occurred_at: occurredAt,
  consent_flags: { analytics: true, marketing: false, personalization: false, ai_processing: false },
  properties: {
    install_token: INSTALL_TOKEN, // R2 tenant-key derivation input
    brain_anon_id: randomUUID(),
    session_id: randomUUID(),
    landing_path: '/',
    referrer: 'direct',
    utm: { source: 'pixel-fixture', medium: 'smoke' },
    device: { ua_class: 'desktop', viewport: '1920x1080' },
    collector_version: 'pixel-fixture@1',
  },
};

console.log('[pixel-fixture] Sending shape-(a) event:');
console.log(`  event_name:    ${EVENT_NAME}`);
console.log(`  event_id:      ${eventId}`);
console.log(`  install_token: ${INSTALL_TOKEN}`);
console.log(`  target:        ${COLLECTOR_URL}/collect`);

async function sendEvent() {
  try {
    const response = await fetch(`${COLLECTOR_URL}/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-ID': correlationId,
      },
      body: JSON.stringify(syntheticEvent), // ONE object — never a batched array (REC-5)
    });

    const status = response.status;
    const body = await response.text().catch(() => '(no body)');

    if (status >= 200 && status < 300) {
      console.log(`[pixel-fixture] SUCCESS — HTTP ${status}: ${body}`);
      console.log('[pixel-fixture] path: pixel → collector → Redpanda → stream-worker → Bronze');
      process.exit(0);
    }
    console.error(`[pixel-fixture] FAIL — HTTP ${status}: ${body}`);
    process.exit(1);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.error(
        `[pixel-fixture] Collector unreachable at ${COLLECTOR_URL}. ` +
        'Start with: docker compose --profile ingest up -d && pnpm dev:ingest',
      );
      if (ALLOW_OFFLINE) {
        console.warn('[pixel-fixture] ALLOW_OFFLINE=1 → soft-exit 0 (local no-Docker smoke).');
        process.exit(0);
      }
      // FAILS CLOSED — the inert exit-0-offline probe is rejected (architecture Track A/B).
      process.exit(1);
    }
    console.error(`[pixel-fixture] UNEXPECTED ERROR: ${err.message}`);
    process.exit(1);
  }
}

sendEvent();
