# Enable the Shopify Checkout Pixel

The storefront pixel Brain installs today is a **ScriptTag** — it runs only on the online-store origin,
**not on Shopify checkout** (a separate origin). So it can never capture `checkout_started` /
`checkout_completed`, which is why the funnel checkout/purchase stages are 0 and the journey→order
stitch has no bridge. Checkout events require the **Web Pixels API** (sandboxed; runs on checkout +
thank-you, on checkout-extensibility).

## What's already wired in Brain (code — merged)
- **Extension**: `extensions/brain-web-pixel/src/index.js` subscribes to page/product/collection/search/
  cart **+ `checkout_started` + `checkout_completed`**, and stamps Shopify's stable `clientId` as
  `brain_anon_id` on every event (so storefront→checkout is one continuous journey and the order
  stitches by the same key). PII-free; posts CollectorEventV1 envelopes to `/collect`.
- **OAuth scopes**: `write_pixels, read_customer_events` are in `InitiateOAuthCommand` (SHOPIFY_SCOPES).
- **Registration**: `InstallPixelCommand` now calls `ShopifyAdminClient.webPixelCreate({install_token,
  brand_id, ingest_base_url})` on install — **best-effort + non-fatal** (logs + keeps the ScriptTag if
  the extension isn't deployed or the scope isn't granted).
- **Ingest**: the collector `/collect` endpoint accepts the Web Pixel POST.

So the only thing left is the **Shopify-side activation** (one of the two paths below) — it cannot run
from this repo's CI (needs the Partner app / merchant action).

---

## Path A — App Web Pixel (production, all merchants) ⭐
1. **Deploy the extension** to the Brain Shopify app (needs the Partner app + Shopify CLI auth):
   ```bash
   shopify app deploy   # registers/updates the brain-web-pixel web_pixel_extension
   ```
2. **Reconnect Shopify** for the brand (Settings → Connectors → Shopify → Reconnect) so the merchant
   grants the new `write_pixels` + `read_customer_events` scopes. Connections made before these scopes
   were added MUST reconnect.
3. **Trigger install/sync** (Reconnect already does, or Settings → Brain Pixel → re-install) — Brain
   calls `webPixelCreate` and the sandboxed pixel goes live on storefront **and checkout**.

## Path B — Custom Pixel (no app deploy; merchant self-serve)
Shopify Admin → **Settings → Customer events → Add custom pixel** → paste the snippet below (replace the
two placeholders), set permission to "Not required" or per your consent posture, **Save**, **Connect**.
Runs in the same sandbox as the app pixel — captures checkout events with no deploy.

```js
// Brain Custom Pixel — paste into Settings → Customer events. Captures storefront + CHECKOUT events.
const INGEST = "https://<YOUR_BRAIN_INGEST_HOST>";   // e.g. your CNAME or tunnel (no trailing slash)
const INSTALL_TOKEN = "<BRAND_INSTALL_TOKEN>";       // from Brain → Settings → Brain Pixel
function send(name, e, props) {
  const clientId = (e && e.clientId) || (init && init.data && init.data.clientId) || undefined;
  const ev = { schema_version: "1", event_id: (self.crypto && crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    brand_id: "", correlation_id: String(Date.now()), event_name: name, occurred_at: new Date().toISOString(),
    properties: Object.assign({ install_token: INSTALL_TOKEN, source: "shopify_custom_pixel", brain_anon_id: clientId, session_id: clientId }, props || {}) };
  try { self.fetch(INGEST + "/collect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ev), keepalive: true, credentials: "omit" }).catch(()=>{}); } catch (_) {}
}
analytics.subscribe("page_viewed", e => send("page.viewed", e, { landing_path: e?.context?.document?.location?.pathname }));
analytics.subscribe("product_viewed", e => send("product.viewed", e, {}));
analytics.subscribe("product_added_to_cart", e => send("cart.item_added", e, { cart: e?.data?.cartLine }));
analytics.subscribe("checkout_started", e => send("checkout.started", e, {}));
analytics.subscribe("checkout_completed", e => send("checkout.completed", e, { order_id: e?.data?.checkout?.order?.id }));
```

---

## Prerequisite
Checkout events fire only on **checkout-extensibility** (Shopify Plus, or a checkout upgraded off
checkout.liquid). On legacy `checkout.liquid` the sandbox doesn't run on checkout.

## Verify (after enabling)
```bash
B=<BRAND_UUID>
# checkout.started now arriving in Bronze
docker exec brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N -e \
 "SELECT count(*) FROM brain_bronze_local.brain_bronze.collector_events WHERE brand_id='$B' AND event_type='checkout.started';"
make insights-pipeline   # rebuild funnel
# funnel now has a non-zero checkout stage; the journey→order stitch (clientId) populates:
tools/backfill/backfill-journey-stitch-map.sh $B   # once checkout_completed carries order_id + clientId
docker exec brainv3-starrocks-1 mysql -P9030 -h127.0.0.1 -uroot -N -e \
 "SELECT count(*) FROM brain_gold.gold_attribution_paths WHERE brand_id='$B';"
```

## What it unlocks
- **Funnel checkout + purchase stages** (real conversion, not 0%).
- **Journey→order stitch** → `gold_attribution_paths` → multi-touch / channel-ROAS-by-path.
- **Identity bridge** (the checkout/order ties the anonymous journey to the resolved customer).

> Note: the journey/funnel switch to the Web Pixel's `clientId` spine. Once it's live, retire the
> ScriptTag (or keep both — events dedupe on `event_id`) to avoid double-counting storefront sessions.
