/**
 * ingest-40k — deterministic synthetic CollectorEventV1 generation (doc-18 PR 0.1).
 *
 * Everything here is DETERMINISTIC given (--seed, --start-ts): event_ids are
 * UUIDv7-style ids whose random bits come from a per-sequence PRNG seeded from
 * (seed, seq), so the exact sent-id SET can be regenerated offline for the P1
 * zero-loss assertion (sent ids vs landed Bronze rows) without trusting the
 * manifest file. The envelope shape mirrors
 * packages/contracts/src/events/sample.collector.event.v1.ts (the SoT for the
 * collector accept path) and packages/pixel-sdk/src/capture.ts:
 *   - brand_id (top-level) is PARTITIONING-ONLY / untrusted; the authoritative
 *     brand derives server-side from properties.install_token (R2) — but the
 *     ADR-0015 accept path does NO validation, so Bronze lands these regardless
 *     (R2/R3 gating happens at Silver admission).
 *   - consent_flags.analytics=true always, so rows survive the Silver consent
 *     gate and the end-to-end counts stay meaningful.
 *   - occurred_at is ISO-8601 UTC without offset (z.datetime({ offset:false })),
 *     ms-stripped to match the pixel SDK/k6 precedent.
 */

/** FNV-1a 32-bit string hash → PRNG seed material. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 — tiny deterministic PRNG; returns a uint32-yielding function. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const HEX = Array.from({ length: 256 }, (_, i) => (i + 0x100).toString(16).slice(1));

function bytesToUuid(b) {
  return (
    HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + '-' +
    HEX[b[4]] + HEX[b[5]] + '-' + HEX[b[6]] + HEX[b[7]] + '-' +
    HEX[b[8]] + HEX[b[9]] + '-' +
    HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
  );
}

function fillRandBytes(b, from, to, rand) {
  for (let i = from; i < to; i += 4) {
    const r = rand();
    for (let j = 0; j < 4 && i + j < to; j++) b[i + j] = (r >>> (8 * j)) & 0xff;
  }
}

/**
 * UUIDv7-style id: 48-bit unix-ms timestamp | ver=7 | rand_a | var=10 | rand_b.
 * `rand` supplies the 74 random bits — pass a seeded PRNG for determinism.
 */
export function uuidv7At(tsMs, rand) {
  const b = new Uint8Array(16);
  let ts = Math.max(0, Math.floor(tsMs));
  for (let i = 5; i >= 0; i--) {
    b[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  fillRandBytes(b, 6, 16, rand);
  b[6] = 0x70 | (b[6] & 0x0f); // version 7
  b[8] = 0x80 | (b[8] & 0x3f); // variant 10
  return bytesToUuid(b);
}

/** Deterministic RFC-4122-v4-style uuid from a seeded PRNG (brand/session/anon ids). */
export function uuidv4From(rand) {
  const b = new Uint8Array(16);
  fillRandBytes(b, 0, 16, rand);
  b[6] = 0x40 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  return bytesToUuid(b);
}

/** N deterministic brand uuids derived from the seed (stable across runs). */
export function deriveBrandIds(n, seed) {
  const rand = mulberry32(fnv1a(`${seed}:brands`));
  return Array.from({ length: n }, () => uuidv4From(rand));
}

/**
 * Deterministic event_id for (seed, startTsMs, seq) — a DEDICATED per-seq PRNG
 * (independent of the envelope-noise PRNG) so the id set is reproducible from
 * the three summary-recorded inputs alone.
 */
export function eventIdFor(seedHash, startTsMs, seq) {
  const idRand = mulberry32((seedHash ^ Math.imul(seq + 1, 0x9e3779b1)) >>> 0);
  return uuidv7At(startTsMs, idRand);
}

// Realistic high-volume pixel mix (weighted toward page.viewed, like tools/load-test/ingest.js).
const EVENT_NAMES = [
  'page.viewed', 'page.viewed', 'page.viewed', 'page.viewed',
  'product.viewed', 'product.viewed',
  'collection.viewed', 'search.performed', 'cart.updated',
  'checkout.started', 'checkout.completed', 'form.submitted',
];
const UTM_SOURCES = ['google', 'meta', 'tiktok', 'klaviyo', 'direct', '(none)'];
const UTM_MEDIUMS = ['cpc', 'organic', 'email', 'social', 'referral'];
const UTM_CAMPAIGNS = ['summer_sale', 'retargeting', 'brand', 'prospecting'];
const PATHS = ['/', '/products/widget', '/collections/all', '/cart', '/search'];
const REFERRERS = ['https://www.google.com/', 'https://l.facebook.com/', '', 'https://t.co/'];
const DEVICE_TYPES = ['mobile', 'desktop', 'tablet'];
const DEVICE_OS = ['iOS', 'Android', 'macOS', 'Windows'];

function pick(arr, rand) {
  return arr[rand() % arr.length];
}

/** ISO-8601 UTC, ms stripped (matches z.datetime({ offset:false }) + SDK precedent). */
function isoNoMs(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Envelope factory. `next(seq)` builds one CollectorEventV1; ids/noise are
 * deterministic in (seed, startTsMs, seq); occurred_at is wall-clock (realistic,
 * irrelevant to the loss/dupe assertions which key on event_id).
 */
export function makeEventFactory({ seed, startTsMs, brandIds, installToken }) {
  const seedHash = fnv1a(seed);
  const noise = mulberry32(fnv1a(`${seed}:noise`));
  return {
    next(seq) {
      const brandId = brandIds[seq % brandIds.length];
      const properties = {
        install_token: installToken,
        brain_anon_id: uuidv4From(noise),
        session_id: uuidv4From(noise),
        landing_path: pick(PATHS, noise),
        referrer: pick(REFERRERS, noise),
        utm_source: pick(UTM_SOURCES, noise),
        utm_medium: pick(UTM_MEDIUMS, noise),
        utm_campaign: pick(UTM_CAMPAIGNS, noise),
        'device.type': pick(DEVICE_TYPES, noise),
        'device.os': pick(DEVICE_OS, noise),
      };
      const clickRoll = noise() % 3;
      if (clickRoll === 0) properties.gclid = `gcl_${uuidv4From(noise)}`;
      else if (clickRoll === 1) properties.fbclid = `fb.${startTsMs}.${uuidv4From(noise)}`;

      return {
        schema_version: '1',
        event_id: eventIdFor(seedHash, startTsMs, seq),
        brand_id: brandId,
        correlation_id: uuidv4From(noise),
        event_name: pick(EVENT_NAMES, noise),
        occurred_at: isoNoMs(Date.now()),
        consent_flags: { analytics: true, marketing: true, personalization: true, ai_processing: false },
        properties,
      };
    },
  };
}
