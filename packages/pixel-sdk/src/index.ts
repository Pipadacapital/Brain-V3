// @brain/pixel-sdk — the Brain Pixel (brain.js) first-party capture SDK.
// See docs/05_Brain_Implementation_Build_Plan.md §3.3, docs/12_Brain_Delivery_Artifacts.md (Sprint 0 / Workstream A),
// and Brain_Attribution_Engine_Spec.md (component #1).
//
// Public surface (built in M1, per doc 10 §7): anon-id + 30-min session management,
// click-ID/UTM capture, _fbc/_fbp handling, event queue + offline retry, consent-at-capture,
// and the cart-attribute stitch writer (brain_anon_id + first-touch click IDs + UTMs -> cart.attributes).
// Distributed as a versioned static asset loaded on the merchant storefront (over the per-tenant CNAME).
export {};
