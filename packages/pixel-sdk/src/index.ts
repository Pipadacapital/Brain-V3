// @brain/pixel-sdk — the Brain Pixel (brain.js) first-party capture SDK.
// See docs/05_Brain_Implementation_Build_Plan.md §3.3, docs/12_Brain_Delivery_Artifacts.md (Sprint 0 / Workstream A),
// and Brain_Attribution_Engine_Spec.md (component #1).
//
// ── REQUIREMENT SPLIT (IMPORTANT) ────────────────────────────────────────────
// This package (brain.js full SDK) is the M1-DATA-SPINE deliverable, NOT M1-app-foundation.
//
// M1-app-foundation pixel scope (Track 2, apps/core/src/modules/connector/pixel/):
//   - migration 006 (pixel_installation + pixel_status tables with RLS)
//   - GET /api/v1/pixel/installation → snippet + install_token
//   - POST /api/v1/pixel/verify → real HTTP HEAD/GET presence check → writes pixel_status
//   - GET /api/v1/pixel/health → returns actual pixel_status for dashboard widget
//   - Events: pixel.installed + pixel.verified
//
// M1-data-spine pixel scope (THIS package — separate pipeline run):
//   - anon-id + 30-min session management
//   - click-ID/UTM capture, _fbc/_fbp handling
//   - event queue + offline retry
//   - consent-at-capture
//   - cart-attribute stitch writer (brain_anon_id + first-touch click IDs + UTMs → cart.attributes)
//   - Distributed as a versioned static asset loaded on the merchant storefront (over the per-tenant CNAME)
//
// DO NOT build the SDK features above in M1-app-foundation. See 03-architecture-plan.md §2.
// ──────────────────────────────────────────────────────────────────────────────
export {};
