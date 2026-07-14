/// <reference lib="dom" />
// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-sdk/asset/entry — the bundle entry of the served /pixel.js brain.js asset.
 *
 * `pnpm --filter @brain/pixel-sdk build:asset` (tools/build-pixel-asset.mjs, esbuild IIFE bundle)
 * turns this entry + runtime.ts + auto-instrument.ts into the single self-contained script that
 * apps/collector serves at /pixel.js (imported as a string via ./generated/pixel-asset.built.ts).
 *
 * Boot order is VERBATIM the legacy IIFE's: bootstrap guard → core runtime (window.brain public
 * API) → auto-instrumentation listeners → auto-fire the initial page + typed view LAST. The
 * merchant snippet (or the collector's ?t=&b= templating pass) sets
 *   window.__brain = { install_token, brand_id, ingest_base_url?, consent_default? }
 * BEFORE this script runs.
 */
import { createBrainRuntime } from './runtime.js';
import { wireAutoInstrumentation } from './auto-instrument.js';
import { wireIdentifyAutodetect } from './identify-autodetect.js';

function bootBrainPixel(): void {
  var rt = createBrainRuntime();
  if (!rt) return; // no window.__brain.install_token — pixel inactive (warned in createBrainRuntime)
  var auto = wireAutoInstrumentation(rt);
  // SPEC A.1.1 (WA-07): form auto-detect — no-op unless the per-brand flag + autodetect capture
  // mode arrived in the bootstrap (rt.identityAutodetectActive; default OFF → inert).
  wireIdentifyAutodetect(rt);
  // Auto-fire the initial page + typed view.
  auto.trackPageView();
}

bootBrainPixel();
