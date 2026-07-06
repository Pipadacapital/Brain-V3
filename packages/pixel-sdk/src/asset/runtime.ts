/// <reference lib="dom" />
// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-sdk/asset/runtime — the served brain.js core runtime: ids/session/first-touch/attribution/
 * consent/queue/transport/emit/identify + the window.brain public API.
 *
 * VERBATIM behavioral port of the hand-maintained IIFE previously inlined in
 * apps/collector/src/interfaces/rest/pixel-asset.route.ts (WA-03 ends that divergence: the served
 * /pixel.js is now BUILT from these modules). The golden/live behavior MUST NOT change — same
 * events, same fields, same consent bootstrap, same endpoints. The frozen legacy IIFE lives at
 * apps/collector/tests/fixtures/legacy-pixel-iife.ts and equivalence is asserted by
 * apps/collector/tests/pixel-asset-equivalence.wa03.test.ts (+ the pre-existing golden parity
 * suite apps/collector/tests/pixel-asset.test.ts, which now runs against the BUILT asset).
 *
 * INVARIANTS (unchanged): shape-(a) emission (ADR-1), ONE event per POST (REC-5), event_id minted
 * once + reused on retry (R4), client-side anon-id + 30-min session (NO Set-Cookie, REC-4),
 * raw-only attribution capture, consent fail-safe-absent (I-ST05), NO raw PII / NO salt on the
 * wire (ADR-2).
 *
 * Written in deliberately ES5-ish, DOM-global style (var, bare window/document/navigator/location
 * access, try/catch fences) so the bundled output executes byte-for-byte-equivalently in the same
 * environments (including the vm-sandbox test harness) as the legacy asset. Do not "modernize".
 */
import {
  PIXEL_ASSET_VERSION,
  ANON_KEY,
  SESSION_KEY,
  QUEUE_KEY,
  FT_KEY,
  SESSION_TTL,
  MAX_QUEUE,
  CRITICAL_RE,
  RETRY_DELAYS,
  CLICK_URL,
  CLICK_COOKIE,
  IDENTIFY_DEDUPE_KEY,
} from './constants.js';
import { normalizeEmailBrowser, normalizePhoneBrowser } from './identify-normalize.js';

/** The internal seam the auto-instrumentation layer (auto-instrument.ts) is wired onto. */
export interface BrainAssetRuntime {
  emit: (name: string, extra?: any) => void;
  emitRaw: (name: string, extra?: any, sessOverride?: string) => void;
  flush: () => void;
  identify: (traits: any) => void;
  parseQuery: () => Record<string, string>;
  uaClass: () => string;
  get: (k: string) => string | null;
  // ── SPEC: A.1.1 + A.1.2 (WA-07/WA-08) — the v2 identity seam ──
  /** Emit a pixel.identify.v1 for {email?, phone?} with the given source (config/consent-gated inside). */
  identifyV2: (traits: any, source: string) => void;
  /** True ⇔ the WA-07 identity system governs (bootstrap identity.enabled) — legacy raw-email submit-bridge retired. */
  identityV2Active: boolean;
  /** True ⇔ form auto-detect may wire (identityV2Active && capture='autodetect' && autodetect flag ON). */
  identityAutodetectActive: boolean;
}

/**
 * Boot the pixel core against the real browser globals. Returns null (pixel inactive) when the
 * merchant bootstrap (window.__brain.install_token) is missing — same guard as the legacy IIFE.
 */
export function createBrainRuntime(): BrainAssetRuntime | null {
  var W = window as any, D = document as any, NS = navigator as any, LS: any;
  try { LS = W.localStorage; } catch (e) { LS = null; }
  var boot = W.__brain;
  if (!boot || !boot.install_token) { try { console.warn("[brain.js] window.__brain.install_token missing — pixel inactive"); } catch(e){} return null; }
  var INSTALL_TOKEN = boot.install_token, BRAND_ID = boot.brand_id;
  var INGEST = (boot.ingest_base_url || (location.protocol + "//" + location.host)).replace(/\/$/, "");
  var COLLECT_URL = INGEST + "/collect";
  var VERSION = PIXEL_ASSET_VERSION;

  function isCritical(ev: any){ return !!(ev && ev.event_name && CRITICAL_RE.test(ev.event_name)); }
  var _droppedSinceReport = 0;            // client-side drops not yet reported to the collector
  var _retryAttempt = 0, _retryTimer: any = null;  // exp-backoff flush retry state

  function get(k: string): string | null { try { return LS ? LS.getItem(k) : null; } catch(e){ return null; } }
  function set(k: string, v: string){ try { if (LS) LS.setItem(k,v); } catch(e){} }
  function uuid(): string {
    if (W.crypto && typeof W.crypto.randomUUID === "function") return W.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){ var r=Math.random()*16|0, v=c==="x"?r:(r&0x3)|0x8; return v.toString(16); });
  }
  // UUIDv7 (RFC 9562): 48-bit big-endian Unix-ms timestamp + 74 random bits, version nibble 0x7, RFC-4122
  // variant. Time-ordered ids keep event_id monotonic-ish (better Bronze locality + dedup) while staying a
  // valid uuid for CollectorEventV1Schema. event_id is minted ONCE per event in build() and reused on retry
  // (the queued object is resent unchanged, R4). Falls back to the v4 uuid() ONLY when crypto is unavailable.
  function uuidv7(): string {
    try {
      if (!(W.crypto && typeof W.crypto.getRandomValues === "function")) return uuid();
      var rnd = new W.Uint8Array(16); W.crypto.getRandomValues(rnd);
      var ms = Date.now(), b = new Array(16);
      // 48-bit ms timestamp, big-endian (use division/modulo — bitwise ops truncate to 32 bits in JS).
      b[0] = Math.floor(ms / 0x10000000000) % 256;
      b[1] = Math.floor(ms / 0x100000000) % 256;
      b[2] = Math.floor(ms / 0x1000000) % 256;
      b[3] = Math.floor(ms / 0x10000) % 256;
      b[4] = Math.floor(ms / 0x100) % 256;
      b[5] = ms % 256;
      for (var i = 6; i < 16; i++) b[i] = rnd[i];
      b[6] = (b[6] & 0x0f) | 0x70; // version 7
      b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant (10xxxxxx)
      var h = []; for (var j = 0; j < 16; j++) h.push(("0" + (b[j] & 0xff).toString(16)).slice(-2));
      return h.slice(0,4).join("") + "-" + h.slice(4,6).join("") + "-" + h.slice(6,8).join("") + "-" + h.slice(8,10).join("") + "-" + h.slice(10,16).join("");
    } catch(e){ return uuid(); }
  }
  function anonId(){ var a = get(ANON_KEY); if (a) return a; a = uuid(); set(ANON_KEY, a); return a; }
  function sessionId(){
    var now = Date.now(), raw = get(SESSION_KEY);
    if (raw){ try { var s = JSON.parse(raw); if (s && s.id && typeof s.last==="number" && (now - s.last) < SESSION_TTL){ set(SESSION_KEY, JSON.stringify({id:s.id,last:now,started:s.started||s.last})); return s.id; } } catch(e){} }
    var id = uuid(); set(SESSION_KEY, JSON.stringify({id:id,last:now,started:now})); return id;
  }
  // Session lifecycle detection — computed BEFORE build() rotates the session (read-only here). Returns the
  // session.started / session.ended events that should accompany the triggering event:
  //   - no stored session            → { started:true }                       (brand-new session begins)
  //   - stored session idle > 30 min → { ended:{ms}, started:true }           (old session ends, new begins)
  //   - active session               → null                                   (nothing to emit)
  function sessionLifecycle(): any {
    var now = Date.now(), raw = get(SESSION_KEY);
    if (!raw) return { started: true };
    try { var s = JSON.parse(raw);
      if (s && s.id && typeof s.last === "number"){
        if ((now - s.last) >= SESSION_TTL) return { ended: { id: s.id, ms: (s.last - (s.started || s.last)) }, started: true };
        return null;
      }
    } catch(e){}
    return { started: true };
  }
  // First-touch persistence (real attribution gap): capture the VERY FIRST landing context once and pin it to
  // localStorage, then ride properties.first_touch on EVERY event thereafter. utm/click_ids are re-read
  // from the CURRENT url each event and are gone the moment the visitor leaves the landing page — so post-
  // landing events lose their acquisition source. NEVER overwrite an existing first-touch (first wins).
  function firstTouch(q: any): any {
    var raw = get(FT_KEY);
    if (raw){ try { var f = JSON.parse(raw); if (f && typeof f === "object") return f; } catch(e){} }
    var ft: any = { landing_path: location.pathname, referrer: D.referrer || undefined, ts: new Date().toISOString() };
    var ci = clickIds(q); if (ci) ft.click_ids = ci;
    var um = utm(q); if (um) ft.utm = um;
    set(FT_KEY, JSON.stringify(ft));
    return ft;
  }
  function parseQuery(): Record<string, string> {
    var out: Record<string, string> = {}, q = location.search.replace(/^\?/, "");
    if (!q) return out;
    q.split("&").forEach(function(p){ if(!p) return; var i=p.indexOf("="), k=i<0?p:p.slice(0,i), v=i<0?"":p.slice(i+1); try{ out[decodeURIComponent(k)]=decodeURIComponent(v); }catch(e){ out[k]=v; } });
    return out;
  }
  function cookie(name: string): string { try { var m = (" "+(D.cookie||"")).match(new RegExp("[; ]"+name.replace(/[.$?*|{}()\[\]\\\/+^]/g,"\\$&")+"=([^;]*)")); return m ? decodeURIComponent(m[1]!) : ""; } catch(e){ return ""; } }
  function clickIds(q: any): any {
    var ids: any = {};
    CLICK_URL.forEach(function(k){ if(q[k]) ids[k]=q[k]; });
    CLICK_COOKIE.forEach(function(p){ if(ids[p[1]]) return; var c=cookie(p[0]); if(c) ids[p[1]]=c; });
    return Object.keys(ids).length?ids:null;
  }
  function utm(q: any): any { var u: any = {}; ["source","medium","campaign","term","content"].forEach(function(k){ if(q["utm_"+k]) u[k]=q["utm_"+k]; }); return Object.keys(u).length?u:null; }
  function consent(): any {
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
    //    (AMD-04: the per-brand consent config lands in WA-08; this bootstrap seam is unchanged.)
    if (boot.consent_default === "granted") return { analytics: true, marketing: true, personalization: true, ai_processing: false };
    return null;
  }
  function uaClass(){ return /Mobi|Android|iPhone|iPad/i.test(NS.userAgent) ? "mobile" : "desktop"; }

  function build(name: string, extra?: any, sessOverride?: string): any {
    var q = parseQuery();
    var props: any = { install_token: INSTALL_TOKEN, brain_anon_id: anonId(), session_id: sessOverride || sessionId(),
      referrer: D.referrer || undefined, landing_path: location.pathname,
      device: { ua_class: uaClass(), viewport: (W.innerWidth + "x" + W.innerHeight) }, collector_version: VERSION };
    props.first_touch = firstTouch(q); // pinned acquisition context, survives past the landing page
    var ci = clickIds(q); if (ci) props.click_ids = ci;
    var um = utm(q); if (um) props.utm = um;
    if (extra) for (var key in extra){ if (Object.prototype.hasOwnProperty.call(extra,key)) props[key]=extra[key]; }
    // event_id = UUIDv7 (time-ordered, was v4); correlation_id stays v4. Minted ONCE here, reused on retry (R4).
    var ev: any = { schema_version: "1", event_id: uuidv7(), brand_id: BRAND_ID, correlation_id: uuid(),
      event_name: name, occurred_at: new Date().toISOString(), properties: props };
    var cf = consent(); if (cf) ev.consent_flags = cf;
    return ev;
  }

  function readQ(): any[] { var raw = get(QUEUE_KEY); if(!raw) return []; try{ var a=JSON.parse(raw); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
  // Keep-critical eviction (G1). The old policy 'q.slice(q.length - MAX_QUEUE)' blindly dropped the OLDEST
  // events — a flood of scroll.depth/rage.click could evict a queued order.placed/payment.* (the one true
  // event-loss hole). Now: walk oldest→newest, drop oldest NON-critical first until within cap; only if the
  // queue is still over (all-critical) drop oldest critical as a last resort. Count drops for pixel.dropped.
  function writeQ(q: any[]){
    if (q.length > MAX_QUEUE){
      var over = q.length - MAX_QUEUE, kept = [], i;
      for (i = 0; i < q.length; i++){
        if (over > 0 && !isCritical(q[i])){ over--; _droppedSinceReport++; continue; }
        kept.push(q[i]);
      }
      if (kept.length > MAX_QUEUE){ var extra = kept.length - MAX_QUEUE; _droppedSinceReport += extra; kept = kept.slice(extra); }
      q = kept;
    }
    set(QUEUE_KEY, JSON.stringify(q));
  }

  function sendOne(body: string, done: (ok: boolean) => void){
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

  // Exponential-backoff retry (G2). 1s → 2 → 4 → 8 → 16 → 30s (cap), then idle until the next page event.
  // Without this a single failed flush stranded the whole queue until some later trigger fired — on a
  // one-page session (the common abandoned-cart case) the queued events were simply lost.
  function scheduleRetry(){
    if (_retryTimer || _retryAttempt >= RETRY_DELAYS.length) return;
    var d = RETRY_DELAYS[_retryAttempt]; _retryAttempt++;
    try { _retryTimer = W.setTimeout(function(){ _retryTimer = null; flush(); }, d); } catch(e){}
  }
  function resetRetry(){ _retryAttempt = 0; if (_retryTimer){ try { W.clearTimeout(_retryTimer); } catch(e){} _retryTimer = null; } }

  var flushing = false;
  function flush(){
    if (flushing) return; flushing = true;
    // STORAGE-AUTHORITATIVE drain: re-read the queue on every step so events enqueued WHILE a flush
    // is in flight (e.g. the auto-fire emits page.viewed + product.viewed/checkout.step_viewed back
    // to back) are not clobbered by a stale in-memory slice. Send the head, then persist the tail.
    function step(){
      var q = readQ();
      if (q.length === 0){ flushing = false; resetRetry(); return; }
      var body = JSON.stringify(q[0]); // ONE object — never an array (REC-5)
      sendOne(body, function(ok){
        if (!ok){ flushing = false; scheduleRetry(); return; } // keep the queue; retry with backoff
        resetRetry();             // a good send means we're online again — clear the backoff
        writeQ(readQ().slice(1)); // drop ONLY the head we just sent; keep anything appended meanwhile
        step();
      });
    }
    step();
  }

  function emitRaw(name: string, extra?: any, sessOverride?: string){
    var q = readQ();
    q.push(build(name, extra, sessOverride));
    // Piggyback a CRITICAL pixel.dropped marker so the collector learns about any client-side loss
    // (No-event-loss observability). Done HERE (not inside writeQ) so eviction never re-enters emit.
    if (_droppedSinceReport > 0 && name !== "pixel.dropped"){
      var n = _droppedSinceReport; _droppedSinceReport = 0;
      q.push(build("pixel.dropped", { dropped_count: n, reason: "queue_overflow" }));
    }
    writeQ(q); flush();
  }
  // ── SPEC: A.1.4 (WA-09) — checkout_session_id capture on checkout.* events ──────────────────
  // The provider checkout overlays (GoKwik / Shopflo) and native Shopify checkout each expose
  // their checkout-session id as a documented JS global. When present, checkout events carry it
  // as properties.checkout_session_id — the high-value India-COD join key that lets the stitch
  // join this anonymous session to the connector's order/checkout events (which carry the SAME
  // id per A.1.4). Read-only probe, fail-safe null; NEVER overrides a caller-supplied value.
  function checkoutSessionId(): string | null {
    try {
      var v: any = null;
      var gk: any = (W as any).gokwik;                      // GoKwik checkout global
      if (gk && typeof gk === "object") v = gk.checkout_session_id || gk.checkoutId || gk.checkout_id || gk.cart_id || gk.cartId;
      if (!v) v = (W as any).gwkCheckoutId;                 // GoKwik alt global
      if (!v){
        var sf: any = (W as any).shopflo || (W as any).__shopflo;   // Shopflo checkout global
        if (sf && typeof sf === "object") v = sf.checkout_session_id || sf.checkoutId || sf.checkout_id || sf.cart_token;
      }
      if (!v){
        var fc: any = (W as any).floCheckout;               // Shopflo overlay object
        if (fc && typeof fc === "object") v = fc.id || fc.checkout_id;
      }
      if (!v){
        var sh: any = (W as any).Shopify;                   // Shopify native checkout token
        if (sh && sh.checkout && sh.checkout.token) v = sh.checkout.token;
      }
      return (typeof v === "string" && v.length > 0) ? v.slice(0, 128) : null;
    } catch(e){ return null; }
  }
  // Public emit. Session lifecycle is detected BEFORE build() rotates the session, but the session.started /
  // session.ended markers are queued AFTER the triggering event — so the first synchronous POST stays the
  // triggering event (REC-5: still ONE event per POST). session.ended carries the EXPIRED session's id +
  // duration; session.started carries the freshly-minted session id. session.* events skip re-detection.
  function emit(name: string, extra?: any){
    // SPEC: A.1.4 — attach checkout_session_id to checkout.* events when a provider global carries it.
    if (name.indexOf("checkout.") === 0){
      var csid = checkoutSessionId();
      if (csid && !(extra && extra.checkout_session_id)){ extra = extra || {}; extra.checkout_session_id = csid; }
    }
    var lc = (name.indexOf("session.") !== 0) ? sessionLifecycle() : null;
    emitRaw(name, extra);
    if (lc){
      if (lc.ended) emitRaw("session.ended", { session_duration_ms: lc.ended.ms }, lc.ended.id);
      if (lc.started) emitRaw("session.started", {});
    }
  }

  // ── Identity capture (the anon→customer BRIDGE) ────────────────────────────
  // PRIVACY (ADR-2: NO raw PII / NO salt on the wire): the email is hashed CLIENT-SIDE with plain,
  // UNSALTED SHA-256 of the normalized (trim+lowercase) value — the SAME format Shopify/Woo put in an
  // order's hashed_customer_email. The resolver's pre_hashed_email path links it, so the anonymous
  // journey (brain_anon_id on this event) and the order (carrying the SAME pre_hashed_email) resolve to
  // ONE brain_id → the journey becomes a known-customer journey. No raw email ever leaves the page.
  function sha256Hex(str: string, cb: (h: string | null) => void){
    try {
      if (W.crypto && W.crypto.subtle && W.TextEncoder){
        W.crypto.subtle.digest("SHA-256", new W.TextEncoder().encode(str)).then(function(buf: ArrayBuffer){
          var b = new Uint8Array(buf), h = ""; for (var i=0;i<b.length;i++){ h += ("0"+b[i]!.toString(16)).slice(-2); } cb(h);
        })["catch"](function(){ cb(null); });
      } else { cb(null); }
    } catch(e){ cb(null); }
  }
  var _identified: Record<string, 1> = {};
  function identify(traits: any){
    if (!traits) return;
    var email = traits.email;
    if (email && ("" + email).indexOf("@") > 0){
      var norm = ("" + email).trim().toLowerCase();
      if (_identified[norm]) return; // once per email per page (no spam)
      _identified[norm] = 1;
      sha256Hex(norm, function(h){ if (h) emit("identify", { hashed_customer_email: h }); });
    }
  }

  // ── SPEC: A.1.1 + A.1.2 (WA-07/WA-08) — pixel.identify.v1 (flag-gated per-brand identity capture) ──
  // The collector's templating pass injects window.__brain.identity ONLY when the per-brand
  // `pixel.identify` platform flag is ON (default OFF). identity ABSENT ⇒ everything below is inert
  // and the asset behaves byte-for-byte as before WA-07 (golden/flags-OFF regression posture).
  //
  // When it governs (IDC.enabled):
  //   • brain.identify({email?, phone?}) → identifyV2(source='explicit_api'): normalize
  //     (identify-normalize.ts — email = identity-normalization parity; phone = minimal browser
  //     E.164 for IDC.phone_country, Silver re-validates) → plain sha256 (WebCrypto, INTEROP space
  //     per AMD-01) → ONE pixel.identify.v1 carrying {identifiers:{email_sha256?,phone_sha256?},
  //     source, consent_state} (+ hashed_customer_email/phone interop aliases: the live
  //     stream-worker identity extractor consumes those as the pre_hashed strong tier, so the
  //     anon→known bridge keeps working — now for phone too).
  //   • Session-scoped dedupe: ONE identify per identifier HASH per session (sessionStorage record
  //     keyed to the rolling session id; page-memory fallback when sessionStorage is unavailable).
  //   • consent_state (A.1.2): assume_granted → 'granted'; cmp_signal → window.brainConsent
  //     boolean, else the __brainConsent/analytics object signal, else the cached IAB TCF
  //     __tcfapi purpose-1 verdict; NO signal → 'denied'. Explicit-API identifies are still SENT
  //     when denied — carrying consent_state='denied' — because the Silver gate is the enforcement
  //     chokepoint (AMD-04 denied-VALUE drop, tested); form autodetect NEVER captures without
  //     granted consent (see identify-autodetect.ts).
  //   • capture='off' → identifyV2 no-ops entirely; AND the legacy raw-email submit-bridge is
  //     retired whenever v2 governs (auto-instrument.ts checks identityV2Active) — the delta-plan
  //     WA-07 item (4): the old bridge read email fields on ANY submit, password-adjacent forms
  //     included, which the A.1.1 selector rule forbids.
  var IDC = boot.identity;
  var V2_GOVERNS = !!(IDC && IDC.enabled === true);
  var AUTODETECT_ACTIVE = !!(V2_GOVERNS && IDC.capture === "autodetect" && IDC.autodetect === true);

  // IAB TCF (cmp_signal mode): subscribe once, cache the purpose-1 verdict. Callback-based API, so
  // identify() reads the CACHE — no signal received (yet) reads as null → 'denied' (fail-closed).
  var _tcfConsent: boolean | null = null;
  if (V2_GOVERNS && IDC.consent_source === "cmp_signal"){
    try {
      if (typeof W.__tcfapi === "function"){
        W.__tcfapi("addEventListener", 2, function(tcData: any, success: any){
          try {
            if (!success || !tcData) return;
            if (tcData.gdprApplies === false){ _tcfConsent = true; return; } // TCF present, GDPR n/a
            var p = tcData.purpose && tcData.purpose.consents;
            _tcfConsent = !!(p && p[1] === true); // purpose 1 = store/access info on device
          } catch(e){}
        });
      }
    } catch(e){}
  }
  function consentStateV2(): string {
    if (!IDC) return "denied";
    if (IDC.consent_source === "assume_granted") return "granted"; // AMD-04 grandfathered posture
    // cmp_signal — explicit page-level boolean wins, then the object signal, then TCF; else denied.
    try {
      if (W.brainConsent === true) return "granted";
      if (W.brainConsent === false) return "denied";
      var c = W.__brainConsent;
      if (c != null && typeof c === "object" && typeof c.analytics === "boolean") return c.analytics === true ? "granted" : "denied";
      if (_tcfConsent === true) return "granted";
    } catch(e){}
    return "denied"; // no signal → denied (A.1.2)
  }

  // Session-scoped dedupe: true ⇔ this identifier HASH was already identified THIS session (and
  // marks it sent otherwise). sessionStorage record {sid, sent:{hash:1}}; re-keys when the rolling
  // session id changes; falls back to page-memory when sessionStorage is unavailable (still no spam).
  var _identifiedV2: Record<string, 1> = {};
  function identifySentThisSession(sess: string, hash: string): boolean {
    var SS: any = null;
    try { SS = W.sessionStorage; } catch(e){ SS = null; }
    if (!SS){ if (_identifiedV2[sess + ":" + hash]) return true; _identifiedV2[sess + ":" + hash] = 1; return false; }
    try {
      var rec: any = null;
      var raw = SS.getItem(IDENTIFY_DEDUPE_KEY);
      if (raw){ try { rec = JSON.parse(raw); } catch(e2){ rec = null; } }
      if (!rec || rec.sid !== sess || !rec.sent || typeof rec.sent !== "object") rec = { sid: sess, sent: {} };
      if (rec.sent[hash]) return true;
      rec.sent[hash] = 1;
      SS.setItem(IDENTIFY_DEDUPE_KEY, JSON.stringify(rec));
      return false;
    } catch(e){ return false; } // storage failure → send (no-event-loss beats duplicate suppression)
  }

  function identifyV2(traits: any, source: string){
    if (!traits || !V2_GOVERNS || !IDC) return;
    if (IDC.capture !== "explicit_only" && IDC.capture !== "autodetect") return; // 'off' (or garbage) → no capture
    if (source === "form_autodetect" && !AUTODETECT_ACTIVE) return;              // autodetect needs its own flag + mode
    var consentState = consentStateV2();
    // Autodetect NEVER captures without granted consent (A.1.1). The explicit API still emits with
    // consent_state='denied' — hash-only, and the Silver AMD-04 gate drops it into the auditable
    // silver_consent_rejected ledger (server-side enforcement is the chokepoint, A.1.2).
    if (source === "form_autodetect" && consentState !== "granted") return;
    var normEmail = normalizeEmailBrowser(traits.email);
    var normPhone = normalizePhoneBrowser(traits.phone, (IDC.phone_country || "IN"));
    if (!normEmail && !normPhone) return;
    var sess = sessionId();
    var identifiers: any = {};
    var pending = 0, finished = false;
    function doneOne(){
      pending--;
      if (pending > 0 || finished) return;
      finished = true;
      if (!identifiers.email_sha256 && !identifiers.phone_sha256) return; // all deduped/failed → nothing to say
      var props: any = { identifiers: identifiers, source: source, consent_state: consentState };
      // Interop back-compat aliases (AMD-01/AMD-02): the live identity extractor reads
      // properties.hashed_customer_email/phone as the pre_hashed strong tier.
      if (identifiers.email_sha256) props.hashed_customer_email = identifiers.email_sha256;
      if (identifiers.phone_sha256) props.hashed_customer_phone = identifiers.phone_sha256;
      emit("pixel.identify.v1", props);
    }
    // hash-and-discard: the normalized raws live only in this closure; nothing is persisted or
    // transported un-hashed (ADR-2: no raw PII on the wire).
    if (normEmail){ pending++; }
    if (normPhone){ pending++; }
    if (normEmail){
      sha256Hex(normEmail, function(h){ if (h && !identifySentThisSession(sess, h)) identifiers.email_sha256 = h; doneOne(); });
    }
    if (normPhone){
      sha256Hex(normPhone, function(h){ if (h && !identifySentThisSession(sess, h)) identifiers.phone_sha256 = h; doneOne(); });
    }
  }

  W.brain = {
    page: function(x?: any){ emit("page.viewed", x); },
    cartItemAdded: function(x?: any){ emit("cart.item_added", x); },
    cartItemRemoved: function(x?: any){ emit("cart.item_removed", x); },
    cartUpdated: function(x?: any){ emit("cart.updated", x); },
    cartViewed: function(x?: any){ emit("cart.viewed", x); },
    checkoutStarted: function(x?: any){ emit("checkout.started", x); },
    checkoutStep: function(x?: any){ emit("checkout.step_viewed", x); },
    // Checkout / payment-page signals — call these from a script pasted on the payment-provider /
    // thank-you screens (which a storefront ScriptTag cannot reach). Behavioral journey signals only;
    // revenue + payment truth still come deterministically from the order/payment connectors.
    shippingSelected: function(x?: any){ emit("checkout.shipping_selected", x); },
    paymentInitiated: function(x?: any){ emit("payment.initiated", x); },
    paymentSucceeded: function(x?: any){ emit("payment.succeeded", x); },
    paymentFailed: function(x?: any){ emit("payment.failed", x); },
    orderPlaced: function(x?: any){ emit("order.placed", x); },
    couponApplied: function(x?: any){ emit("coupon.applied", x); },
    login: function(x?: any){ emit("user.logged_in", x); },
    signup: function(x?: any){ emit("user.signed_up", x); },
    // SPEC A.1.1 (WA-07): the PUBLIC explicit API — brain.identify({email?, phone?}). When the
    // per-brand identity config governs it routes to identifyV2 (pixel.identify.v1, source
    // 'explicit_api'); otherwise byte-for-byte the legacy email-only identify (flags-OFF posture).
    identify: function(t?: any){ if (V2_GOVERNS) identifyV2(t, "explicit_api"); else identify(t); },
    track: function(n: string, x?: any){ emit(n, x); },
    flush: flush
  };

  return {
    emit: emit, emitRaw: emitRaw, flush: flush, identify: identify, parseQuery: parseQuery,
    uaClass: uaClass, get: get,
    identifyV2: identifyV2, identityV2Active: V2_GOVERNS, identityAutodetectActive: AUTODETECT_ACTIVE
  };
}
