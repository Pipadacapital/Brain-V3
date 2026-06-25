/**
 * /pixel.js — the served brain.js browser asset (Track B).
 *
 * This is a hand-maintained IIFE that is CONTRACT-equivalent to @brain/pixel-sdk (NOT yet a
 * literal build artifact of it — full build-unification is deferred; see notes). It enforces the
 * same INVARIANTS the tested SDK core does, asserted by apps/collector/tests/pixel-asset.test.ts
 * + packages/pixel-sdk parity tests: shape-(a) emission (ADR-1), ONE event per POST (REC-5),
 * event_id minted once + reused on retry (R4), client-side anon-id + 30-min session (NO Set-Cookie,
 * REC-4), raw-only attribution capture, consent fail-safe-absent (I-ST05), NO raw PII / NO salt on
 * the wire (ADR-2).
 *
 * It additionally carries zero-merchant-code auto-instrumentation (SPA nav, cart-add/remove/update,
 * checkout step, login/signup, clicks, scroll-depth) that the injectable SDK core deliberately does
 * NOT (the core is env-injected + unit-testable). Click-id + behavioral-event COVERAGE is kept in
 * lock-step between the two: URL ids (fbclid/gclid/ttclid/msclkid/gbraid/wbraid/dclid) + cookie ids
 * (_fbc/_fbp DISTINCT, li_fat_id, _epik→epik), and the cart/checkout/account event set.
 *
 * The merchant snippet (buildDefaultSnippet, pixelRoutes.ts:136) sets
 *   window.__brain = { install_token, brand_id }
 * BEFORE this asset loads, then `<script src="…/pixel.js" defer>`.
 *
 * Served with long cache + a strong validator; versioned at /pixel.v{N}.js. collector_version
 * is stamped into every event's properties for forensic provenance.
 *
 * Asset-parity test: apps/collector/tests/pixel-asset.test.ts evals this asset against a fake
 * window and asserts the emitted event parses with the REAL CollectorEventV1Schema.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadCollectorConfig } from '@brain/config';

export const PIXEL_VERSION = 'pixel@0.1.0';

/** The self-contained brain.js IIFE (production build of @brain/pixel-sdk). */
export const PIXEL_JS = `(function(){
  "use strict";
  var W = window, D = document, NS = navigator, LS;
  try { LS = W.localStorage; } catch (e) { LS = null; }
  var boot = W.__brain;
  if (!boot || !boot.install_token) { try { console.warn("[brain.js] window.__brain.install_token missing — pixel inactive"); } catch(e){} return; }
  var INSTALL_TOKEN = boot.install_token, BRAND_ID = boot.brand_id;
  var INGEST = (boot.ingest_base_url || (location.protocol + "//" + location.host)).replace(/\\/$/, "");
  var COLLECT_URL = INGEST + "/collect";
  var VERSION = ${JSON.stringify(PIXEL_VERSION)};
  var ANON_KEY = "__brain_anon_id", SESSION_KEY = "__brain_session", QUEUE_KEY = "__brain_queue";
  var SESSION_TTL = 1800000, MAX_QUEUE = 200;

  function get(k){ try { return LS ? LS.getItem(k) : null; } catch(e){ return null; } }
  function set(k,v){ try { if (LS) LS.setItem(k,v); } catch(e){} }
  function uuid(){
    if (W.crypto && typeof W.crypto.randomUUID === "function") return W.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){ var r=Math.random()*16|0, v=c==="x"?r:(r&0x3)|0x8; return v.toString(16); });
  }
  function anonId(){ var a = get(ANON_KEY); if (a) return a; a = uuid(); set(ANON_KEY, a); return a; }
  function sessionId(){
    var now = Date.now(), raw = get(SESSION_KEY);
    if (raw){ try { var s = JSON.parse(raw); if (s && s.id && typeof s.last==="number" && (now - s.last) < SESSION_TTL){ set(SESSION_KEY, JSON.stringify({id:s.id,last:now})); return s.id; } } catch(e){} }
    var id = uuid(); set(SESSION_KEY, JSON.stringify({id:id,last:now})); return id;
  }
  function parseQuery(){
    var out = {}, q = location.search.replace(/^\\?/, "");
    if (!q) return out;
    q.split("&").forEach(function(p){ if(!p) return; var i=p.indexOf("="), k=i<0?p:p.slice(0,i), v=i<0?"":p.slice(i+1); try{ out[decodeURIComponent(k)]=decodeURIComponent(v); }catch(e){ out[k]=v; } });
    return out;
  }
  function cookie(name){ try { var m = (" "+(D.cookie||"")).match(new RegExp("[; ]"+name.replace(/[.$?*|{}()\\[\\]\\\\\\/+^]/g,"\\\\$&")+"=([^;]*)")); return m ? decodeURIComponent(m[1]) : ""; } catch(e){ return ""; } }
  // URL click-ids: fbclid/gclid/ttclid + msclkid (Bing), gbraid/wbraid (Google iOS app↔web), dclid (Google Display).
  // Cookie click-ids: _fbc/_fbp (Meta, DISTINCT — both needed for CAPI), li_fat_id (LinkedIn), _epik→epik (Pinterest).
  // A click-id not read off the landing URL is lost forever; cookies persist past the landing hit. URL wins per key.
  var CLICK_URL = ["fbclid","gclid","ttclid","msclkid","gbraid","wbraid","dclid"];
  var CLICK_COOKIE = [["_fbc","_fbc"],["_fbp","_fbp"],["li_fat_id","li_fat_id"],["_epik","epik"]];
  function clickIds(q){
    var ids={};
    CLICK_URL.forEach(function(k){ if(q[k]) ids[k]=q[k]; });
    CLICK_COOKIE.forEach(function(p){ if(ids[p[1]]) return; var c=cookie(p[0]); if(c) ids[p[1]]=c; });
    return Object.keys(ids).length?ids:null;
  }
  function utm(q){ var u={}; ["source","medium","campaign","term","content"].forEach(function(k){ if(q["utm_"+k]) u[k]=q["utm_"+k]; }); return Object.keys(u).length?u:null; }
  function consent(){
    // 1. Explicit override: window.__brainConsent (host page sets it).
    var c = W.__brainConsent;
    if (c != null && typeof c === "object") return { analytics: c.analytics===true, marketing: c.marketing===true, personalization: c.personalization===true, ai_processing: c.ai_processing===true };
    // 2. Shopify Customer Privacy API — the storefront's REAL consent state. Returning a PRESENT
    //    consent_flags object (whatever the values) is what lets the event pass the R3 gate into
    //    Bronze; the values then gate downstream marketing/CAPI use. Absent API → null (R3 drops).
    try {
      var sp = W.Shopify && W.Shopify.customerPrivacy;
      if (sp && typeof sp.analyticsProcessingAllowed === "function") {
        return {
          analytics: sp.analyticsProcessingAllowed() === true,
          marketing: typeof sp.marketingAllowed === "function" ? sp.marketingAllowed() === true : false,
          personalization: typeof sp.preferencesProcessingAllowed === "function" ? sp.preferencesProcessingAllowed() === true : false,
          ai_processing: false
        };
      }
    } catch(e){}
    // 3. Default-granted fallback (PIXEL_CONSENT_DEFAULT=granted) — ONLY when no real signal exists
    //    (no CMP on the store). Explicit, merchant-accepted, flag-gated. A real signal above wins.
    if (boot.consent_default === "granted") return { analytics: true, marketing: true, personalization: true, ai_processing: false };
    return null;
  }
  function uaClass(){ return /Mobi|Android|iPhone|iPad/i.test(NS.userAgent) ? "mobile" : "desktop"; }

  function build(name, extra){
    var q = parseQuery();
    var props = { install_token: INSTALL_TOKEN, brain_anon_id: anonId(), session_id: sessionId(),
      referrer: D.referrer || undefined, landing_path: location.pathname,
      device: { ua_class: uaClass(), viewport: (W.innerWidth + "x" + W.innerHeight) }, collector_version: VERSION };
    var ci = clickIds(q); if (ci) props.click_ids = ci;
    var um = utm(q); if (um) props.utm = um;
    if (extra) for (var key in extra){ if (Object.prototype.hasOwnProperty.call(extra,key)) props[key]=extra[key]; }
    var ev = { schema_version: "1", event_id: uuid(), brand_id: BRAND_ID, correlation_id: uuid(),
      event_name: name, occurred_at: new Date().toISOString(), properties: props };
    var cf = consent(); if (cf) ev.consent_flags = cf;
    return ev;
  }

  function readQ(){ var raw = get(QUEUE_KEY); if(!raw) return []; try{ var a=JSON.parse(raw); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
  function writeQ(q){ if (q.length > MAX_QUEUE) q = q.slice(q.length - MAX_QUEUE); set(QUEUE_KEY, JSON.stringify(q)); }

  function sendOne(body, done){
    // sendBeacon (survives unload) → fetch(keepalive) fallback. ONE object per POST, NO credentials.
    // CONTENT-TYPE = text/plain (NOT application/json): text/plain is a CORS-"simple" content-type, so a
    // cross-origin POST needs NO preflight. application/json forces an OPTIONS preflight — and a
    // PREFLIGHTED sendBeacon is silently DROPPED by browsers (beacon returns true, the POST never sends),
    // so events vanish. The body is still JSON text; the collector parses text/plain as JSON.
    try { if (NS.sendBeacon){ var blob = new Blob([body], {type:"text/plain;charset=UTF-8"}); if (NS.sendBeacon(COLLECT_URL, blob)){ done(true); return; } } } catch(e){}
    try {
      fetch(COLLECT_URL, { method:"POST", headers:{"Content-Type":"text/plain;charset=UTF-8"}, body:body, keepalive:true, credentials:"omit" })
        .then(function(r){ done(!!(r && r.ok)); })["catch"](function(){ done(false); });
    } catch(e){ done(false); }
  }

  var flushing = false;
  function flush(){
    if (flushing) return; flushing = true;
    // STORAGE-AUTHORITATIVE drain: re-read the queue on every step so events enqueued WHILE a flush
    // is in flight (e.g. the auto-fire emits page.viewed + product.viewed/checkout.step_viewed back
    // to back) are not clobbered by a stale in-memory slice. Send the head, then persist the tail.
    function step(){
      var q = readQ();
      if (q.length === 0){ flushing = false; return; }
      var body = JSON.stringify(q[0]); // ONE object — never an array (REC-5)
      sendOne(body, function(ok){
        if (!ok){ flushing = false; return; } // leave the queue intact for the next trigger
        writeQ(readQ().slice(1)); // drop ONLY the head we just sent; keep anything appended meanwhile
        step();
      });
    }
    step();
  }

  function emit(name, extra){ var q = readQ(); q.push(build(name, extra)); writeQ(q); flush(); }

  // ── Identity capture (the anon→customer BRIDGE) ────────────────────────────
  // PRIVACY (ADR-2: NO raw PII / NO salt on the wire): the email is hashed CLIENT-SIDE with plain,
  // UNSALTED SHA-256 of the normalized (trim+lowercase) value — the SAME format Shopify/Woo put in an
  // order's hashed_customer_email. The resolver's pre_hashed_email path links it, so the anonymous
  // journey (brain_anon_id on this event) and the order (carrying the SAME pre_hashed_email) resolve to
  // ONE brain_id → the journey becomes a known-customer journey. No raw email ever leaves the page.
  function sha256Hex(str, cb){
    try {
      if (W.crypto && W.crypto.subtle && W.TextEncoder){
        W.crypto.subtle.digest("SHA-256", new W.TextEncoder().encode(str)).then(function(buf){
          var b = new Uint8Array(buf), h = ""; for (var i=0;i<b.length;i++){ h += ("0"+b[i].toString(16)).slice(-2); } cb(h);
        })["catch"](function(){ cb(null); });
      } else { cb(null); }
    } catch(e){ cb(null); }
  }
  var _identified = {};
  function identify(traits){
    if (!traits) return;
    var email = traits.email;
    if (email && ("" + email).indexOf("@") > 0){
      var norm = ("" + email).trim().toLowerCase();
      if (_identified[norm]) return; // once per email per page (no spam)
      _identified[norm] = 1;
      sha256Hex(norm, function(h){ if (h) emit("identify", { hashed_customer_email: h }); });
    }
  }

  W.brain = {
    page: function(x){ emit("page.viewed", x); },
    cartItemAdded: function(x){ emit("cart.item_added", x); },
    cartItemRemoved: function(x){ emit("cart.item_removed", x); },
    cartUpdated: function(x){ emit("cart.updated", x); },
    cartViewed: function(x){ emit("cart.viewed", x); },
    checkoutStarted: function(x){ emit("checkout.started", x); },
    checkoutStep: function(x){ emit("checkout.step_viewed", x); },
    // Checkout / payment-page signals — call these from a script pasted on the payment-provider /
    // thank-you screens (which a storefront ScriptTag cannot reach). Behavioral journey signals only;
    // revenue + payment truth still come deterministically from the order/payment connectors.
    shippingSelected: function(x){ emit("checkout.shipping_selected", x); },
    paymentInitiated: function(x){ emit("payment.initiated", x); },
    paymentSucceeded: function(x){ emit("payment.succeeded", x); },
    paymentFailed: function(x){ emit("payment.failed", x); },
    orderPlaced: function(x){ emit("order.placed", x); },
    couponApplied: function(x){ emit("coupon.applied", x); },
    login: function(x){ emit("user.logged_in", x); },
    signup: function(x){ emit("user.signed_up", x); },
    identify: function(t){ identify(t); },
    track: function(n,x){ emit(n, x); },
    flush: flush
  };

  // ── Comprehensive auto-instrumentation (online store) ──────────────────────
  // Captures all key storefront activity with zero merchant code. Checkout/thank-you pages are
  // OUT of ScriptTag scope (a separate origin) — those need the Web Pixels extension.
  function pageType(){
    var p = location.pathname, q = location.search;
    // Shopify: /products/<h>, /collections/<h>.  WooCommerce: /product/<h>, /product-category/<h>, /shop.
    if (p.indexOf("/products/") >= 0 || p.indexOf("/product/") >= 0) return "product";
    if (p.indexOf("/collections/") >= 0 || p.indexOf("/product-category/") >= 0 || p.indexOf("/product-tag/") >= 0 || p === "/shop" || p.indexOf("/shop/") === 0) return "collection";
    if (p === "/cart" || p.indexOf("/cart") === 0) return "cart";
    // Order confirmation / thank-you. Shopify: /thank_you, /thank-you, /orders/<id>. Woo: /order-received/.
    if (p.indexOf("/thank_you") >= 0 || p.indexOf("/thank-you") >= 0 || p.indexOf("/order-received") >= 0 || /\\/orders\\/[0-9]/.test(p)) return "order_confirmation";
    if (p.indexOf("/checkout") >= 0) return "checkout";
    if (p.indexOf("/search") >= 0 || /[?&]s=/.test(q)) return "search"; // Woo search = ?s=
    // Account: Shopify /account*, WooCommerce /my-account*.
    if (p.indexOf("/account/register") >= 0) return "account_register";
    if (p.indexOf("/account/login") >= 0) return "account_login";
    if (p.indexOf("/account") >= 0 || p.indexOf("/my-account") >= 0) return "account";
    if (p === "/" || p === "") return "home";
    if (p.indexOf("/pages/") >= 0) return "page";
    if (p.indexOf("/blogs/") >= 0 || p.indexOf("/blog/") >= 0) return "blog";
    return "other";
  }
  function handleAfter(prefix){ var p = location.pathname, i = p.indexOf(prefix); if (i < 0) return undefined; var rest = p.slice(i + prefix.length); return rest.split("/")[0].split("?")[0].split("#")[0] || undefined; }
  function trackPageView(){
    var t = pageType();
    emit("page.viewed", { page_type: t });
    if (t === "product") emit("product.viewed", { product_handle: handleAfter("/products/") || handleAfter("/product/") });
    else if (t === "collection") emit("collection.viewed", { collection_handle: handleAfter("/collections/") || handleAfter("/product-category/") || handleAfter("/product-tag/") });
    else if (t === "cart") emit("cart.viewed", {});
    else if (t === "checkout") { var qc = parseQuery(); emit("checkout.step_viewed", { step: qc.step || handleAfter("/checkout/") || undefined }); }
    else if (t === "search") { var q = parseQuery(); emit("search.submitted", { query: q.q || q.query }); }
    // Order confirmation — a BEHAVIORAL funnel-completion marker (NOT revenue: revenue truth comes
    // from the order connectors, never the pixel). order_id (if present in the URL) helps stitch.
    else if (t === "order_confirmation") { emit("order.placed", { order_id: handleAfter("/orders/") || handleAfter("/order-received/") || undefined }); }
  }

  // SPA navigation (themes using the History API) → re-fire on path change.
  var lastPath = location.pathname + location.search;
  function onNav(){ var cur = location.pathname + location.search; if (cur !== lastPath){ lastPath = cur; trackPageView(); } }
  try {
    var _ps = history.pushState; history.pushState = function(){ var r = _ps.apply(this, arguments); setTimeout(onNav, 0); return r; };
    var _rs = history.replaceState; history.replaceState = function(){ var r = _rs.apply(this, arguments); setTimeout(onNav, 0); return r; };
    W.addEventListener("popstate", function(){ setTimeout(onNav, 0); });
  } catch(e){}

  // Cart-mutation interception — Shopify AJAX cart endpoints. Classify the cart op from the URL +
  // body: /cart/add → cart.item_added; /cart/change|/cart/update with quantity 0 → cart.item_removed
  // (remove_from_cart); other /cart/change|/cart/update → cart.updated (cart_update). Same logic for
  // fetch + XHR + classic form submit.
  function cartAddProps(b){ var props = {}; try { if (b && typeof b === "object"){ var it = b.items && b.items[0]; props.variant_id = b.id || (it && it.id); props.quantity = b.quantity || (it && it.quantity); } } catch(e){} return props; }
  // Returns the event_name for a Shopify cart URL+body, or null when it is not a cart mutation.
  function cartEvent(u, b){
    // Shopify AJAX cart.
    if (u.indexOf("/cart/add") >= 0) return "cart.item_added";
    if (u.indexOf("/cart/change") >= 0 || u.indexOf("/cart/update") >= 0){
      var qty; try { if (b && typeof b === "object"){ qty = (b.quantity != null) ? b.quantity : (b.updates ? null : undefined); } } catch(e){}
      return (qty === 0 || qty === "0") ? "cart.item_removed" : "cart.updated";
    }
    // WooCommerce: legacy AJAX (?wc-ajax=add_to_cart / ?add-to-cart=<id>) + the Store API (Blocks).
    if (u.indexOf("wc-ajax=add_to_cart") >= 0 || u.indexOf("add-to-cart=") >= 0 || u.indexOf("/wc/store/v1/cart/add-item") >= 0 || u.indexOf("/cart/add-item") >= 0) return "cart.item_added";
    if (u.indexOf("wc-ajax=remove_from_cart") >= 0 || u.indexOf("/wc/store/v1/cart/remove-item") >= 0) return "cart.item_removed";
    if (u.indexOf("wc-ajax=update_cart") >= 0 || u.indexOf("/wc/store/v1/cart/update-item") >= 0 || u.indexOf("/wc/store/v1/batch") >= 0) return "cart.updated";
    return null;
  }
  function emitCart(u, b){ var n = cartEvent(u, b); if (n) emit(n, n === "cart.item_added" ? cartAddProps(b) : (cartAddProps(b))); }
  try {
    var _fetch = W.fetch;
    if (_fetch) W.fetch = function(input, init){ try { var u = (typeof input === "string") ? input : (input && input.url) || ""; var b = null; try { b = init && init.body ? JSON.parse(init.body) : null; } catch(e2){} emitCart(u, b); } catch(e){} return _fetch.apply(this, arguments); };
  } catch(e){}
  try {
    var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){ try { this.__bu = u; } catch(e){} return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body){ try { var b = null; try { b = body ? JSON.parse(body) : null; } catch(e2){} emitCart("" + (this.__bu || ""), b); } catch(e){} return _send.apply(this, arguments); };
  } catch(e){}
  D.addEventListener("submit", function(ev){ try { var f = ev.target; if (!f) return; var a = "" + (f.action || "");
    var qs = f.querySelector ? function(s){ try { return f.querySelector(s); } catch(e){ return null; } } : function(){ return null; };
    var classified = true;
    if (a.indexOf("/cart/add") >= 0 || a.indexOf("add-to-cart") >= 0) emit("cart.item_added", {});
    else if (a.indexOf("/cart/change") >= 0 || a.indexOf("/cart/update") >= 0) emit("cart.updated", {});
    // Account auth — Shopify (/account*) + WooCommerce (.woocommerce-form-login / -register).
    else if (a.indexOf("/account/login") >= 0 || qs(".woocommerce-form-login,[name=login]")) emit("user.logged_in", {});
    else if ((a.indexOf("/account") >= 0 && (a.indexOf("register") >= 0 || a.indexOf("/account#") >= 0 || f.id === "create_customer")) || qs(".woocommerce-form-register,[name=register]")) emit("user.signed_up", {});
    else classified = false;
    // Coupon / discount-code usage (Shopify "discount", Woo "coupon_code"). A discount code is not PII.
    var cp = qs('input[name*="coupon" i],input[id*="coupon" i],input[name*="discount" i],input[id*="discount" i],input[name*="promo" i]');
    if (cp && cp.value) emit("coupon.applied", { code: ("" + cp.value).trim().slice(0, 64) });
    // Generic form submission (newsletter / contact / etc.) not already classified above.
    if (!classified) emit("form.submitted", { form_id: f.id || undefined, form_name: (f.getAttribute && f.getAttribute("name")) || undefined });
    // Identity BRIDGE: any submit carrying an email (login / register / newsletter / checkout) → hash
    // it client-side (no raw PII on the wire) → links the anon journey to the known customer.
    var em = qs('input[type=email],input[name*="email" i],input[id*="email" i]');
    if (em && em.value) identify({ email: em.value });
  } catch(e){} }, true);

  // Click tracking + frustration signals — links/buttons (element.clicked), plus rage clicks and
  // dead clicks. The latter two are UX-friction signals that power "checkout bottleneck" /
  // "conversion drop" insights. No PII.
  var _clicks = [], _lastRage = 0;
  D.addEventListener("click", function(ev){ try {
    var el = ev.target; if (!el) return;
    var now = Date.now(), x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
    // Rage: >=3 clicks within 1s inside a ~40px box → ONE rage.click per burst (1.5s debounce).
    _clicks.push({ t: now, x: x, y: y }); if (_clicks.length > 8) _clicks.shift();
    var near = 0; for (var i = 0; i < _clicks.length; i++){ var c = _clicks[i]; if ((now - c.t) < 1000 && Math.abs(c.x - x) < 40 && Math.abs(c.y - y) < 40) near++; }
    if (near >= 3 && (now - _lastRage) > 1500){ _lastRage = now; emit("rage.click", { count: near, x: x, y: y }); }
    var a = el.closest ? el.closest("a,button,input,select,textarea,label,[role=button],[onclick],[data-brain-track],[contenteditable]") : null;
    if (a){
      var txt = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80);
      emit("element.clicked", { element: (a.tagName || "").toLowerCase(), text: txt || undefined, href: (a.getAttribute && a.getAttribute("href")) || undefined, el_id: a.id || undefined });
    } else {
      // Dead click: the element LOOKS clickable (cursor:pointer) but resolves to NO interactive
      // ancestor — the user expected something to happen and nothing did. Precise (not every stray click).
      var looksClickable = false;
      try { var cs = W.getComputedStyle ? W.getComputedStyle(el) : null; looksClickable = !!(cs && cs.cursor === "pointer"); } catch(e2){}
      if (looksClickable) emit("dead.click", { element: (el.tagName || "").toLowerCase(), x: x, y: y });
    }
  } catch(e){} }, true);

  // Scroll-depth milestones (25/50/75/100%), once each.
  var sm = {};
  W.addEventListener("scroll", function(){ try { var h = D.documentElement; var pct = Math.round((((W.scrollY || h.scrollTop) + W.innerHeight) / (h.scrollHeight || 1)) * 100); var ms = [25,50,75,100]; for (var k = 0; k < ms.length; k++){ if (pct >= ms[k] && !sm[ms[k]]){ sm[ms[k]] = 1; emit("scroll.depth", { percent: ms[k] }); } } } catch(e){} }, { passive: true });

  // Durable retry triggers (NO Set-Cookie — stateless edge, REC-4).
  W.addEventListener("pagehide", flush);
  D.addEventListener("visibilitychange", function(){ if (D.visibilityState === "hidden") flush(); });

  // Auto-fire the initial page + typed view.
  trackPageView();
})();`;

/** UUID guard — only inject query-derived values that are real UUIDs (no JS-injection via the asset). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPixelAssetRoute(app: FastifyInstance): void {
  const handler = (
    req: FastifyRequest<{ Querystring: { t?: string; b?: string } }>,
    reply: FastifyReply,
  ): void => {
    // Production install path (ScriptTag-injected): the src carries ?t=<install_token>&b=<brand_id>.
    // A ScriptTag cannot set window.__brain first (and document.currentScript is null for async
    // injected scripts), so the collector PREPENDS the bootstrap when valid UUIDs are present.
    // The manual-snippet path sets window.__brain itself → serve the plain asset.
    let body = PIXEL_JS;
    const t = req.query?.t;
    const b = req.query?.b;
    if (t && b && UUID_RE.test(t) && UUID_RE.test(b)) {
      // CRITICAL: also pin ingest_base_url, else pixel.js falls back to location.host (the STOREFRONT)
      // and POSTs events to the store's own domain instead of the collector. Use the origin this asset
      // was loaded from (the public CNAME/tunnel) — proto+host from the forwarding headers — so events
      // post back to us. PIXEL_INGEST_BASE_URL is the fallback.
      const rawHost = String(req.headers['host'] ?? '');
      const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || 'https';
      const reqOrigin =
        /^[a-z0-9.-]+(:[0-9]+)?$/i.test(rawHost) && /^https?$/.test(proto) ? `${proto}://${rawHost}` : '';
      const ingest = reqOrigin || loadCollectorConfig().PIXEL_INGEST_BASE_URL || '';
      const ingestField = /^https?:\/\/[a-z0-9.:/-]+$/i.test(ingest) ? `,ingest_base_url:"${ingest}"` : '';
      // Default-granted consent (merchant-accepted, flag-gated): only applied by consent() when no
      // real consent signal (window.__brainConsent / Shopify Customer Privacy) exists. See README/RB-4.
      const consentField = loadCollectorConfig().PIXEL_CONSENT_DEFAULT === 'granted' ? ',consent_default:"granted"' : '';
      body = `window.__brain={install_token:"${t}",brand_id:"${b}"${ingestField}${consentField}};\n${PIXEL_JS}`;
    }
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300') // 5 min (dev); CDN-overridable in prod
      .header('X-Pixel-Version', PIXEL_VERSION)
      // NEVER Set-Cookie on the ASSET (REC-4) — first-party cookie is set on /collect (the event POST).
      .code(200)
      .send(body);
  };
  app.get('/pixel.js', handler);
  // Versioned alias for cache-busting (/pixel.v0.1.0.js).
  app.get('/pixel.v0.1.0.js', handler);
}
