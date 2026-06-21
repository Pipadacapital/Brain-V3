/**
 * Brain Web Pixel — sandboxed storefront + checkout event capture (feat-pixel-production-install).
 *
 * Runs in Shopify's Web Pixel sandbox (a Web Worker — NO DOM, NO localStorage). It subscribes to
 * Shopify's standard customer events and forwards them to the Brain collector as CollectorEventV1
 * envelopes (shape-a, ADR-1) — the SAME contract the browser SDK emits — so downstream Bronze/
 * identity/journey treat web-pixel and SDK events identically.
 *
 * vs the ScriptTag path (apps/collector pixel.js): this ALSO fires on checkout + thank-you pages.
 * Tenant key: install_token (from per-merchant settings); brand_id is partition-only (server derives
 * the authoritative brand from install_token downstream — R2). Consent: Shopify's customerPrivacy
 * gates marketing/analytics; we forward what the sandbox exposes (fail-safe-absent, I-ST05).
 */
import { register } from '@shopify/web-pixels-extension';

register(({ analytics, settings, init }) => {
  const ingest = String(settings.ingest_base_url || '').replace(/\/$/, '');
  const installToken = String(settings.install_token || '');
  const brandId = String(settings.brand_id || '');
  if (!ingest || !installToken) return; // misconfigured → inert (never throw in the sandbox)

  const consent = () => {
    try {
      const c = init && init.customerPrivacy;
      if (!c) return null;
      return {
        analytics: c.analyticsProcessingAllowed === true,
        marketing: c.marketingAllowed === true,
        personalization: c.preferencesProcessingAllowed === true,
        ai_processing: false,
      };
    } catch (_e) {
      return null;
    }
  };

  const send = (eventName, properties) => {
    const ev = {
      schema_version: '1',
      event_id: (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) || `${Date.now()}-${Math.random()}`,
      brand_id: brandId,
      correlation_id: (self.crypto && self.crypto.randomUUID && self.crypto.randomUUID()) || `${Date.now()}`,
      event_name: eventName,
      occurred_at: new Date().toISOString(),
      properties: Object.assign({ install_token: installToken, source: 'shopify_web_pixel' }, properties),
    };
    const cf = consent();
    if (cf) ev.consent_flags = cf;
    try {
      // Sandbox: no sendBeacon guarantee → fetch(keepalive). ONE object per POST (REC-5), no creds.
      self.fetch(`${ingest}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ev),
        keepalive: true,
        credentials: 'omit',
      }).catch(() => {});
    } catch (_e) { /* never throw in the sandbox */ }
  };

  // Storefront + checkout coverage (the reason to use Web Pixels over a ScriptTag).
  analytics.subscribe('page_viewed', (e) => send('page.viewed', { landing_path: e?.context?.document?.location?.pathname }));
  analytics.subscribe('product_added_to_cart', (e) => send('cart.item_added', { cart: e?.data?.cartLine }));
  analytics.subscribe('checkout_started', (e) => send('checkout.started', { checkout: summarize(e?.data?.checkout) }));
  analytics.subscribe('checkout_completed', (e) => send('checkout.completed', { checkout: summarize(e?.data?.checkout) }));
});

/** Keep payloads small + PII-free (no raw email/phone on the wire — ADR-2). */
function summarize(checkout) {
  if (!checkout) return undefined;
  return {
    order_id: checkout.order && checkout.order.id,
    currency: checkout.currencyCode,
    total_minor: checkout.totalPrice && checkout.totalPrice.amount,
  };
}
