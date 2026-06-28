/**
 * pixel-sdk/types — the shape-(a) wire envelope (ADR-1) + the injectable browser env.
 *
 * The SDK is written against an INJECTED environment (BrowserEnv) rather than the ambient
 * browser globals, so the core is unit-testable under a Node/ES2022 lib (no jsdom). The
 * thin brain.js entry (./browser-entry.ts) binds the real window/localStorage/navigator/
 * document/fetch; tests inject a fake env.
 */

// ── Shape (a) wire envelope (matches @brain/contracts CollectorEventV1Schema) ──
// NOTE: kept structurally identical to the live Zod contract. We do NOT import the Zod
// schema into the browser bundle (it would bloat the asset); the envelope-conformance
// CI test (sdk-envelope.gate.test.ts) parses an emitted event with the REAL Zod schema.

export interface ConsentFlags {
  analytics: boolean;
  marketing: boolean;
  personalization: boolean;
  ai_processing: boolean;
}

export interface ClickIds {
  fbclid?: string;
  gclid?: string;
  ttclid?: string;
  /** Microsoft/Bing Ads click id — without it, Bing paid traffic is misclassified as `direct`. */
  msclkid?: string;
  /** Google iOS app→web click id (replaces gclid in that flow). */
  gbraid?: string;
  /** Google web→app click id (iOS). */
  wbraid?: string;
  /** Google Display/DV360 click id. */
  dclid?: string;
  /** Meta browser-id cookie (`_fbp`) — first-party, NOT the same as the `_fbc`/fbclid click id.
   *  Required for Meta CAPI match-quality; captured DISTINCT from fbclid (downstream `click_ids._fbp`). */
  _fbp?: string;
  /** Meta click-id cookie (`_fbc`) — kept DISTINCT from `fbclid` so CAPI can pass the formatted
   *  `fb.1.<ts>.<fbclid>` cookie value verbatim (downstream `click_ids._fbc`). */
  _fbc?: string;
  /** LinkedIn first-party ad cookie (`li_fat_id`) — LinkedIn Conversions API match key. */
  li_fat_id?: string;
  /** Pinterest click id cookie (`_epik` / `epik`) — Pinterest Conversions API match key. */
  epik?: string;
}

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/**
 * FIRST-TOUCH snapshot (real attribution gap fix). Captured ONCE on the first event ever, persisted
 * to localStorage (`__brain_first_touch`), and attached to `properties.first_touch` on EVERY event
 * thereafter — so first-touch attribution survives past the landing page (utm/click_ids are re-read
 * from the current URL each event and otherwise lost after the landing hit). NEVER overwritten.
 */
export interface FirstTouch {
  utm?: Utm;
  click_ids?: ClickIds;
  landing_path?: string;
  referrer?: string;
  /** ISO-8601 UTC time of the first event ever. */
  ts: string;
}

/** RAW-ONLY signals (RO1) that ride properties — opaque at the edge, modeled downstream. */
export interface EventProperties {
  /** REQUIRED — the server's tenant-key derivation input (R2). */
  install_token: string;
  brain_anon_id: string;
  session_id: string;
  click_ids?: ClickIds;
  utm?: Utm;
  /** Persisted first-touch snapshot — attached to every event (see FirstTouch). */
  first_touch?: FirstTouch;
  referrer?: string;
  landing_path?: string;
  device?: { ua_class: 'mobile' | 'desktop'; viewport: string };
  [key: string]: unknown;
}

/** Shape (a) — the JSON object POSTed to /collect (ONE event per POST). */
export interface CollectorEventV1 {
  schema_version: '1';
  event_id: string;
  /** Sent for PARTITIONING ONLY — the server DERIVES the authoritative brand from install_token. */
  brand_id: string;
  correlation_id: string;
  /** dot.lowercase — page.viewed | cart.item_added | cart.viewed. */
  event_name: string;
  occurred_at: string; // ISO-8601 UTC 'Z'
  consent_flags?: ConsentFlags;
  properties: EventProperties;
}

// ── window.__brain bootstrap (set by buildDefaultSnippet, pixelRoutes.ts) ──────
export interface BrainBootstrap {
  install_token: string;
  brand_id: string;
  /** Optional collector ingest base (defaults to the script origin). */
  ingest_base_url?: string;
}

// ── Injectable browser environment ────────────────────────────────────────────
export interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserEnv {
  bootstrap: BrainBootstrap;
  storage: MinimalStorage;
  now(): number;
  /** ISO-8601 now (UTC, 'Z'). */
  nowIso(): string;
  /** A v4 uuid — used for correlation_id (and as the v7 fallback when crypto is unavailable). */
  uuid(): string;
  /** A UUIDv7 (48-bit ms timestamp + 74 random bits) — used for the time-ordered event_id. */
  uuidv7(): string;
  /** Current URL (href). */
  href(): string;
  /** document.referrer. */
  referrer(): string;
  /** Pathname for landing_path. */
  pathname(): string;
  /** A coarse mobile|desktop class from the UA (no raw UA stored — RO1/PII-safe). */
  uaClass(): 'mobile' | 'desktop';
  /** Viewport WxH string. */
  viewport(): string;
  /** Cookie read (for _fbc/_fbp etc.) — returns '' when none. */
  cookie(name: string): string;
  /** navigator.sendBeacon — returns false when unavailable / queued failed. */
  sendBeacon?(url: string, body: string): boolean;
  /** fetch with keepalive — the durable fallback. */
  fetchKeepalive(url: string, body: string): Promise<boolean>;
  /** Register a flush trigger (pagehide / visibilitychange). */
  onFlushTrigger(cb: () => void): void;
}
