#!/usr/bin/env node
/**
 * pixel-fixture/seed-touchpoints.mjs — batch journey/touchpoint seed (dev only).
 *
 * Emits many realistic shape-(a) CollectorEventV1 journey events (page.viewed / cart.viewed /
 * cart.item_added) through the REAL ingest path: POST /collect → spool → Redpanda → stream-worker
 * (pixel lane, R2 derives brand from install_token + R3 consent gate) → Postgres bronze_events, AND
 * the Spark materializer → Iceberg. So both Bronze sinks get touchpoints and the journey/touchpoint
 * dbt mart has data to build + parity-check (ADR-0002 Slice 4b).
 *
 * The install_token MUST be a real pixel_installation token so R2 resolves the brand (else quarantine).
 * consent_flags MUST be present (R3) else quarantine.
 *
 * Usage (dev):
 *   COLLECTOR_URL=http://localhost:8787 \
 *   BRAND_ID=124e6af5-e6c5-4b85-bf43-7b36fa528101 \
 *   INSTALL_TOKEN=a79bb928-0dc2-421e-98be-e60fca49fe70 \
 *   VISITORS=12 DAYS=10 node tools/pixel-fixture/seed-touchpoints.mjs
 */
import { randomUUID } from 'crypto';

const COLLECTOR_URL = process.env['COLLECTOR_URL'] ?? 'http://localhost:8787';
const BRAND_ID = process.env['BRAND_ID'] ?? '124e6af5-e6c5-4b85-bf43-7b36fa528101';
const INSTALL_TOKEN = process.env['INSTALL_TOKEN'] ?? 'a79bb928-0dc2-421e-98be-e60fca49fe70';
const VISITORS = parseInt(process.env['VISITORS'] ?? '12', 10);
const DAYS = parseInt(process.env['DAYS'] ?? '10', 10);

// A few acquisition channels, so the mart's channel/utm derivation has variety.
const CHANNELS = [
  { utm: { source: 'google', medium: 'cpc', campaign: 'search-brand' }, click: { gclid: () => `gcl_${randomUUID().slice(0, 12)}` }, referrer: 'https://www.google.com/' },
  { utm: { source: 'facebook', medium: 'paid_social', campaign: 'prospecting' }, click: { fbclid: () => `fb_${randomUUID().slice(0, 12)}` }, referrer: 'https://l.facebook.com/' },
  { utm: { source: 'tiktok', medium: 'paid_social', campaign: 'ugc-aug' }, click: { ttclid: () => `tt_${randomUUID().slice(0, 12)}` }, referrer: 'https://www.tiktok.com/' },
  { utm: { source: 'newsletter', medium: 'email', campaign: 'weekly-drop' }, click: {}, referrer: 'direct' },
  { utm: {}, click: {}, referrer: 'direct' }, // organic/direct
];
const LANDINGS = ['/', '/collections/new', '/products/ceramic-kettle', '/products/single-origin-beans', '/blogs/brewing'];

function isoDaysAgo(daysAgo, withinDayMs) {
  // Build a UTC timestamp `daysAgo` days back, offset by withinDayMs within that day.
  const base = Date.now() - daysAgo * 86_400_000;
  return new Date(base + withinDayMs).toISOString(); // ISO with 'Z' (offset:false → valid)
}

function buildEvent(eventName, brandAnonId, sessionId, channel, landing, occurredAt) {
  const clickIds = Object.fromEntries(Object.entries(channel.click).map(([k, gen]) => [k, gen()]));
  return {
    schema_version: '1',
    event_id: randomUUID(),
    brand_id: BRAND_ID, // PARTITIONING ONLY — server derives the authoritative brand from install_token
    correlation_id: randomUUID(),
    event_name: eventName,
    occurred_at: occurredAt,
    consent_flags: { analytics: true, marketing: true, personalization: true, ai_processing: true },
    properties: {
      install_token: INSTALL_TOKEN, // R2 tenant-key derivation input
      brain_anon_id: brandAnonId,
      session_id: sessionId,
      landing_path: landing,
      referrer: channel.referrer,
      utm: channel.utm,
      click_ids: clickIds,
      device: { ua_class: 'desktop', viewport: '1440x900' },
      collector_version: 'seed-touchpoints@1',
    },
  };
}

async function post(event) {
  const res = await fetch(`${COLLECTOR_URL}/collect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Correlation-ID': event.correlation_id },
    body: JSON.stringify(event),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
}

async function main() {
  // A visitor's session walks landing → product → cart-view → cart-add (a funnel), with realistic drop-off.
  const FUNNEL = ['page.viewed', 'page.viewed', 'cart.viewed', 'cart.item_added'];
  const events = [];
  for (let v = 0; v < VISITORS; v++) {
    const brandAnonId = randomUUID();
    const channel = CHANNELS[v % CHANNELS.length];
    const sessions = 1 + (v % 2); // 1-2 sessions per visitor
    for (let s = 0; s < sessions; s++) {
      const sessionId = randomUUID();
      const daysAgo = (v + s) % DAYS;                 // spread across days() partitions
      const landing = LANDINGS[(v + s) % LANDINGS.length];
      const depth = 1 + ((v + s) % FUNNEL.length);    // how far down the funnel this session got
      for (let step = 0; step < depth; step++) {
        const occurredAt = isoDaysAgo(daysAgo, 9 * 3_600_000 + step * 90_000); // ~09:00 + 90s/step
        events.push(buildEvent(FUNNEL[step], brandAnonId, sessionId, channel, landing, occurredAt));
      }
    }
  }

  console.log(`[seed-touchpoints] posting ${events.length} events → ${COLLECTOR_URL}/collect (brand ${BRAND_ID})`);
  let ok = 0;
  for (const e of events) {
    try { await post(e); ok++; } catch (err) { console.error(`  FAIL ${e.event_name}: ${err.message}`); }
  }
  console.log(`[seed-touchpoints] DONE — ${ok}/${events.length} accepted`);
  const byType = events.reduce((m, e) => ((m[e.event_name] = (m[e.event_name] ?? 0) + 1), m), {});
  console.log(`[seed-touchpoints] mix: ${JSON.stringify(byType)}`);
  if (ok === 0) process.exit(1);
}

main();
