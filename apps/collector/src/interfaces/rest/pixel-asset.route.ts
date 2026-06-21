/**
 * /pixel.js — the served brain.js browser asset (Track B).
 *
 * This is the production build of @brain/pixel-sdk emitted as a versioned, self-contained IIFE.
 * It is byte-identical in BEHAVIOUR to the tested SDK core (packages/pixel-sdk): shape-(a)
 * emission (ADR-1), ONE event per POST (REC-5), event_id minted once + reused on retry (R4),
 * client-side anon-id + 30-min session (NO Set-Cookie, REC-4), raw-only attribution capture,
 * consent fail-safe-absent (I-ST05), NO raw PII / NO salt on the wire (ADR-2).
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
  function clickIds(q){ var ids={}; ["fbclid","gclid","ttclid"].forEach(function(k){ if(q[k]) ids[k]=q[k]; }); return Object.keys(ids).length?ids:null; }
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
    try { if (NS.sendBeacon){ var blob = new Blob([body], {type:"application/json"}); if (NS.sendBeacon(COLLECT_URL, blob)){ done(true); return; } } } catch(e){}
    try {
      fetch(COLLECT_URL, { method:"POST", headers:{"Content-Type":"application/json"}, body:body, keepalive:true, credentials:"omit" })
        .then(function(r){ done(!!(r && r.ok)); })["catch"](function(){ done(false); });
    } catch(e){ done(false); }
  }

  var flushing = false;
  function flush(){
    if (flushing) return; flushing = true;
    var q = readQ();
    function step(){
      if (q.length === 0){ flushing = false; return; }
      var body = JSON.stringify(q[0]); // ONE object — never an array (REC-5)
      sendOne(body, function(ok){
        if (!ok){ writeQ(q); flushing = false; return; }
        q = q.slice(1); writeQ(q); step();
      });
    }
    step();
  }

  function emit(name, extra){ var q = readQ(); q.push(build(name, extra)); writeQ(q); flush(); }

  W.brain = {
    page: function(x){ emit("page.viewed", x); },
    cartItemAdded: function(x){ emit("cart.item_added", x); },
    cartViewed: function(x){ emit("cart.viewed", x); },
    track: function(n,x){ emit(n, x); },
    flush: flush
  };

  // ── Comprehensive auto-instrumentation (online store) ──────────────────────
  // Captures all key storefront activity with zero merchant code. Checkout/thank-you pages are
  // OUT of ScriptTag scope (a separate origin) — those need the Web Pixels extension.
  function pageType(){
    var p = location.pathname;
    if (p.indexOf("/products/") >= 0) return "product";
    if (p.indexOf("/collections/") >= 0) return "collection";
    if (p === "/cart" || p.indexOf("/cart") === 0) return "cart";
    if (p.indexOf("/search") >= 0) return "search";
    if (p === "/" || p === "") return "home";
    if (p.indexOf("/pages/") >= 0) return "page";
    if (p.indexOf("/blogs/") >= 0) return "blog";
    return "other";
  }
  function handleAfter(prefix){ var p = location.pathname, i = p.indexOf(prefix); if (i < 0) return undefined; var rest = p.slice(i + prefix.length); return rest.split("/")[0].split("?")[0].split("#")[0] || undefined; }
  function trackPageView(){
    var t = pageType();
    emit("page.viewed", { page_type: t });
    if (t === "product") emit("product.viewed", { product_handle: handleAfter("/products/") });
    else if (t === "collection") emit("collection.viewed", { collection_handle: handleAfter("/collections/") });
    else if (t === "cart") emit("cart.viewed", {});
    else if (t === "search") { var q = parseQuery(); emit("search.submitted", { query: q.q || q.query }); }
  }

  // SPA navigation (themes using the History API) → re-fire on path change.
  var lastPath = location.pathname + location.search;
  function onNav(){ var cur = location.pathname + location.search; if (cur !== lastPath){ lastPath = cur; trackPageView(); } }
  try {
    var _ps = history.pushState; history.pushState = function(){ var r = _ps.apply(this, arguments); setTimeout(onNav, 0); return r; };
    var _rs = history.replaceState; history.replaceState = function(){ var r = _rs.apply(this, arguments); setTimeout(onNav, 0); return r; };
    W.addEventListener("popstate", function(){ setTimeout(onNav, 0); });
  } catch(e){}

  // Add-to-cart interception — Shopify AJAX cart (fetch + XHR to /cart/add) + classic form submit.
  function cartAddProps(b){ var props = {}; try { if (b && typeof b === "object"){ var it = b.items && b.items[0]; props.variant_id = b.id || (it && it.id); props.quantity = b.quantity || (it && it.quantity); } } catch(e){} return props; }
  try {
    var _fetch = W.fetch;
    if (_fetch) W.fetch = function(input, init){ try { var u = (typeof input === "string") ? input : (input && input.url) || ""; if (u.indexOf("/cart/add") >= 0){ var b = null; try { b = init && init.body ? JSON.parse(init.body) : null; } catch(e2){} emit("cart.item_added", cartAddProps(b)); } } catch(e){} return _fetch.apply(this, arguments); };
  } catch(e){}
  try {
    var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u){ try { this.__bu = u; } catch(e){} return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(body){ try { if (("" + (this.__bu || "")).indexOf("/cart/add") >= 0){ var b = null; try { b = body ? JSON.parse(body) : null; } catch(e2){} emit("cart.item_added", cartAddProps(b)); } } catch(e){} return _send.apply(this, arguments); };
  } catch(e){}
  D.addEventListener("submit", function(ev){ try { var f = ev.target; if (f && f.action && f.action.indexOf("/cart/add") >= 0) emit("cart.item_added", {}); } catch(e){} }, true);

  // Click tracking (delegated) — links + buttons + opted-in elements, with context (no PII).
  D.addEventListener("click", function(ev){ try { var el = ev.target; if (!el || !el.closest) return; var a = el.closest("a,button,[role=button],[data-brain-track]"); if (!a) return; var txt = (a.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80); emit("element.clicked", { element: (a.tagName || "").toLowerCase(), text: txt || undefined, href: (a.getAttribute && a.getAttribute("href")) || undefined, el_id: a.id || undefined }); } catch(e){} }, true);

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
      const ingest = reqOrigin || process.env['PIXEL_INGEST_BASE_URL'] || '';
      const ingestField = /^https?:\/\/[a-z0-9.:/-]+$/i.test(ingest) ? `,ingest_base_url:"${ingest}"` : '';
      // Default-granted consent (merchant-accepted, flag-gated): only applied by consent() when no
      // real consent signal (window.__brainConsent / Shopify Customer Privacy) exists. See README/RB-4.
      const consentField = process.env['PIXEL_CONSENT_DEFAULT'] === 'granted' ? ',consent_default:"granted"' : '';
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
