/**
 * _pixel-events — the canonical PIXEL event taxonomy for the Tracking Center surfaces.
 *
 * These are the events we receive THROUGH the pixel (browser-originated, via the collector /collect
 * endpoint). The Tracking Center (Event Explorer + health tiles + ingestion chart) is a PIXEL surface,
 * so every read here is constrained to these event types and NEVER counts server-trusted connector
 * events (order.live.v1, spend.live.v1, gokwik.*, shopflo.*, shiprocket.*, settlement.*).
 *
 * Mirrors the pixel SDK (packages/pixel-sdk/src/capture.ts) + the universal capture script
 * (apps/collector/src/interfaces/rest/pixel-asset.route.ts). NB: the pixel's client-side `order.placed`
 * is intentionally distinct from the connector's server-trusted `order.live.v1`.
 */
export const PIXEL_EVENT_TYPES = [
  'page.viewed', 'product.viewed', 'collection.viewed', 'search.submitted',
  'cart.item_added', 'cart.item_removed', 'cart.updated', 'cart.viewed',
  'checkout.started', 'checkout.step_viewed', 'checkout.shipping_selected',
  'payment.initiated', 'payment.succeeded', 'payment.failed',
  'coupon.applied', 'form.submitted', 'order.placed',
  'rage.click', 'dead.click', 'element.clicked', 'scroll.depth',
  'user.logged_in', 'user.signed_up', 'identify',
] as const;

/**
 * SQL IN-list of the pixel event types. The values are static, code-defined string literals (never
 * user input), so this is safe to interpolate directly into a query.
 */
export const PIXEL_EVENT_IN = PIXEL_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
