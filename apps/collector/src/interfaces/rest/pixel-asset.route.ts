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
    var c = W.__brainConsent;
    if (c == null || typeof c !== "object") return null;
    return { analytics: c.analytics===true, marketing: c.marketing===true, personalization: c.personalization===true, ai_processing: c.ai_processing===true };
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

  // Durable retry triggers (NO Set-Cookie — stateless edge, REC-4).
  W.addEventListener("pagehide", flush);
  D.addEventListener("visibilitychange", function(){ if (D.visibilityState === "hidden") flush(); });

  // Auto-fire the initial page view.
  W.brain.page();
})();`;

export function registerPixelAssetRoute(app: FastifyInstance): void {
  const handler = (_req: FastifyRequest, reply: FastifyReply): void => {
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300') // 5 min (dev); CDN-overridable in prod
      .header('X-Pixel-Version', PIXEL_VERSION)
      // NEVER Set-Cookie on the asset (REC-4) — edge stays stateless.
      .code(200)
      .send(PIXEL_JS);
  };
  app.get('/pixel.js', handler);
  // Versioned alias for cache-busting (/pixel.v0.1.0.js).
  app.get('/pixel.v0.1.0.js', handler);
}
