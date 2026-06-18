// @brain/pixel-sdk — the Brain Pixel (brain.js) first-party capture SDK (Phase 1b / Track B).
//
// Emits the LIVE shape-(a) CollectorEventV1 (ADR-1): event_name dot.lowercase, ISO occurred_at,
// a raw-only properties bag carrying install_token / brain_anon_id / session_id / click-ids /
// utm / referrer / landing / device, and a top-level capture-only consent_flags. ONE event per
// POST (REC-5); event_id minted once + reused on retry (R4); client-side anon-id, NO Set-Cookie
// (REC-4); NO raw PII + NO salt on the wire (ADR-2).
//
// The browser asset (/pixel.js) is built from ./browser-entry.ts (served by the collector).
// The CORE (createPixel) is written against an injectable BrowserEnv so it is unit-testable
// under a Node/ES2022 lib without jsdom.

export { createPixel, originOf } from './capture.js';
export type { Pixel, PixelOptions, EventName } from './capture.js';
export { getOrCreateAnonId, getOrRollSession } from './identity.js';
export { captureClickIds, captureUtm, parseQuery } from './attribution.js';
export { resolveConsent, defaultConsentReader } from './consent.js';
export type { ConsentReader } from './consent.js';
export { Transport } from './transport.js';
export { COLLECTOR_VERSION } from './browser-entry.js';
export type {
  CollectorEventV1,
  ConsentFlags,
  ClickIds,
  Utm,
  EventProperties,
  BrowserEnv,
  BrainBootstrap,
  MinimalStorage,
} from './types.js';
