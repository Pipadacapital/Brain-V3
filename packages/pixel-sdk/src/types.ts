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
}

export interface Utm {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
}

/** RAW-ONLY signals (RO1) that ride properties — opaque at the edge, modeled downstream. */
export interface EventProperties {
  /** REQUIRED — the server's tenant-key derivation input (R2). */
  install_token: string;
  brain_anon_id: string;
  session_id: string;
  click_ids?: ClickIds;
  utm?: Utm;
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
  uuid(): string;
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
