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
export { normalizeBrandHost } from './normalize-host.js';
export { uuidV7 } from './uuid.js';
export { getOrCreateAnonId, getOrRollSession, rollSession, endSessionRecord } from './identity.js';
export type { SessionRoll } from './identity.js';
export {
  captureClickIds,
  captureUtm,
  getOrCreateFirstTouch,
  parseQuery,
  CLICK_ID_URL_KEYS,
  CLICK_ID_COOKIE_KEYS,
  FIRST_TOUCH_KEY,
} from './attribution.js';
export type { ClickIdCaptureOptions } from './attribution.js';
export { resolveConsent, defaultConsentReader } from './consent.js';
export type { ConsentReader } from './consent.js';
export { Transport } from './transport.js';
export { COLLECTOR_VERSION } from './browser-entry.js';
// SPEC: A.1.1 (WA-03 pixel build unification) — the BUILT served /pixel.js asset (esbuild IIFE
// bundle of src/asset/*; regenerate via `pnpm --filter @brain/pixel-sdk build:asset`). The
// collector serves THIS string; the hand-maintained IIFE divergence is over.
export { PIXEL_ASSET_JS } from './asset/generated/pixel-asset.built.js';
export { PIXEL_ASSET_VERSION } from './asset/constants.js';
export type {
  CollectorEventV1,
  ConsentFlags,
  ClickIds,
  Utm,
  FirstTouch,
  EventProperties,
  BrowserEnv,
  BrainBootstrap,
  BrainIdentityBootstrap,
  MinimalStorage,
} from './types.js';
// SPEC: A.1.1 (WA-07) — browser normalizers for pixel.identify.v1 (parity-tested vs
// @brain/identity-normalization; phone is the documented minimal E.164 with Silver re-validation).
export {
  normalizeEmailBrowser,
  normalizePhoneBrowser,
  stripEdgeWhitespaceBrowser,
  PHONE_COUNTRY_CC,
} from './asset/identify-normalize.js';
export { autodetectKind, isPasswordAdjacent } from './asset/identify-autodetect.js';
// AUD-IMPL-004: the typed seam + helper element shape (types-only — no runtime surface change).
export type { AutodetectElementLike } from './asset/identify-autodetect.js';
export type { BrainAssetRuntime } from './asset/runtime.js';
