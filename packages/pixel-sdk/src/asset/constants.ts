// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-sdk/asset/constants — shared constants of the served brain.js asset. Values are
 * VERBATIM from the previously hand-maintained IIFE (apps/collector pixel-asset.route.ts);
 * the golden/live behavior must not change (see tests/fixtures/legacy-pixel-iife.ts in
 * apps/collector for the frozen reference).
 */

/** Stamped into every event's properties.collector_version + the X-Pixel-Version header. */
export const PIXEL_ASSET_VERSION = 'pixel@0.1.0';

export const ANON_KEY = '__brain_anon_id';
export const SESSION_KEY = '__brain_session';
export const QUEUE_KEY = '__brain_queue';
export const FT_KEY = '__brain_first_touch';
export const SESSION_TTL = 1800000;
export const MAX_QUEUE = 200;

// ── No-event-loss queue policy ──────────────────────────────────────────────
// CRITICAL families are conversion / money / identity / our own loss-signal — they must NEVER be
// evicted to make room for high-volume behavioural noise (scroll.depth / *.click / page.viewed).
// pixel\.identify — SPEC A.1.1 (WA-07): the identify envelope is an identity event (same family as
// the legacy bare `identify` this regex already protects).
export const CRITICAL_RE = /^(order\.|payment\.|checkout\.|cart\.|purchase|identify|pixel\.dropped|pixel\.identify)/;

// ── WA-07 identify (SPEC A.1.1) ─────────────────────────────────────────────
// sessionStorage key for the per-session identify dedupe record {sid, sent:{<hash>:1}} — ONE
// pixel.identify.v1 per identifier HASH per session (spec: "one identify per identifier value per
// session"). session-scoped on purpose: sessionStorage dies with the tab, and the record re-keys
// itself when the 30-min rolling session id changes.
export const IDENTIFY_DEDUPE_KEY = '__brain_identify_v1';

// Exponential-backoff retry (G2). 1s → 2 → 4 → 8 → 16 → 30s (cap), then idle until the next page event.
export const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

// URL click-ids: fbclid/gclid/ttclid + msclkid (Bing), gbraid/wbraid (Google iOS app↔web), dclid (Google Display).
// Cookie click-ids: _fbc/_fbp (Meta, DISTINCT — both needed for CAPI), li_fat_id (LinkedIn), _epik→epik (Pinterest).
// A click-id not read off the landing URL is lost forever; cookies persist past the landing hit. URL wins per key.
export const CLICK_URL = ['fbclid', 'gclid', 'ttclid', 'msclkid', 'gbraid', 'wbraid', 'dclid'];
export const CLICK_COOKIE: Array<[string, string]> = [
  ['_fbc', '_fbc'],
  ['_fbp', '_fbp'],
  ['li_fat_id', 'li_fat_id'],
  ['_epik', 'epik'],
];

// A link whose href resolves to a downloadable asset → file_ext. mp4 is treated as a FILE download here
// (a direct media link), distinct from an in-page <video> element.
export const DL_EXT = ['pdf', 'zip', 'dmg', 'exe', 'csv', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'rar', '7z', 'pkg', 'mp3', 'mp4'];
