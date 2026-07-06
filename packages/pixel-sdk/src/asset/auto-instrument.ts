/// <reference lib="dom" />
// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * pixel-sdk/asset/auto-instrument — zero-merchant-code auto-instrumentation of the served brain.js
 * asset: typed page views + SPA nav, cart-mutation interception (Shopify AJAX + Woo Store API),
 * form-submit classification (auth/coupon/identity bridge), download/share classification, Web
 * Share patch, exit intent, native media, click/rage/dead clicks, scroll depth, session-end on
 * unload, and the durable flush triggers.
 *
 * VERBATIM behavioral port of the hand-maintained IIFE previously inlined in
 * apps/collector/src/interfaces/rest/pixel-asset.route.ts — see runtime.ts header for the WA-03
 * equivalence contract. Do not "modernize" the ES5-ish style; listener registration ORDER and the
 * bare-global access patterns (window/document/navigator/location/history) are load-bearing.
 *
 * Checkout/thank-you pages are OUT of ScriptTag scope (a separate origin) — those need the Web
 * Pixels extension.
 */
import { SESSION_KEY, DL_EXT } from './constants.js';
import type { BrainAssetRuntime } from './runtime.js';

/**
 * Wire all auto-instrumentation onto the booted runtime. Returns trackPageView so the entry can
 * auto-fire the initial page + typed view LAST (exactly like the legacy IIFE's final line).
 */
export function wireAutoInstrumentation(rt: BrainAssetRuntime): { trackPageView: () => void } {
  var W = window as any, D = document as any, NS = navigator as any;
  var emit = rt.emit, emitRaw = rt.emitRaw, flush = rt.flush, identify = rt.identify,
      parseQuery = rt.parseQuery, uaClass = rt.uaClass, get = rt.get;

  // ── Comprehensive auto-instrumentation (online store) ──────────────────────
  function pageType(){
    var p = location.pathname, q = location.search;
    // Shopify: /products/<h>, /collections/<h>.  WooCommerce: /product/<h>, /product-category/<h>, /shop.
    if (p.indexOf("/products/") >= 0 || p.indexOf("/product/") >= 0) return "product";
    if (p.indexOf("/collections/") >= 0 || p.indexOf("/product-category/") >= 0 || p.indexOf("/product-tag/") >= 0 || p === "/shop" || p.indexOf("/shop/") === 0) return "collection";
    if (p === "/cart" || p.indexOf("/cart") === 0) return "cart";
    // Order confirmation / thank-you. Shopify: /thank_you, /thank-you, /orders/<id>. Woo: /order-received/.
    if (p.indexOf("/thank_you") >= 0 || p.indexOf("/thank-you") >= 0 || p.indexOf("/order-received") >= 0 || /\/orders\/[0-9]/.test(p)) return "order_confirmation";
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
  function handleAfter(prefix: string): string | undefined { var p = location.pathname, i = p.indexOf(prefix); if (i < 0) return undefined; var rest = p.slice(i + prefix.length); return rest.split("/")[0]!.split("?")[0]!.split("#")[0] || undefined; }
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
    var _ps = history.pushState; history.pushState = function(this: any){ var r = _ps.apply(this, arguments as any); setTimeout(onNav, 0); return r; };
    var _rs = history.replaceState; history.replaceState = function(this: any){ var r = _rs.apply(this, arguments as any); setTimeout(onNav, 0); return r; };
    W.addEventListener("popstate", function(){ setTimeout(onNav, 0); });
  } catch(e){}

  // Cart-mutation interception — Shopify AJAX cart endpoints. Classify the cart op from the URL +
  // body: /cart/add → cart.item_added; /cart/change|/cart/update with quantity 0 → cart.item_removed
  // (remove_from_cart); other /cart/change|/cart/update → cart.updated (cart_update). Same logic for
  // fetch + XHR + classic form submit.
  function cartAddProps(b: any): any { var props: any = {}; try { if (b && typeof b === "object"){ var it = b.items && b.items[0]; props.variant_id = b.id || (it && it.id); props.quantity = b.quantity || (it && it.quantity); } } catch(e){} return props; }
  // Returns the event_name for a Shopify cart URL+body, or null when it is not a cart mutation.
  function cartEvent(u: string, b: any): string | null {
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
  function emitCart(u: string, b: any){ var n = cartEvent(u, b); if (n) emit(n, n === "cart.item_added" ? cartAddProps(b) : (cartAddProps(b))); }
  try {
    var _fetch = W.fetch;
    if (_fetch) W.fetch = function(this: any, input: any, init: any){ try { var u = (typeof input === "string") ? input : (input && input.url) || ""; var b = null; try { b = init && init.body ? JSON.parse(init.body) : null; } catch(e2){} emitCart(u, b); } catch(e){} return _fetch.apply(this, arguments as any); };
  } catch(e){}
  try {
    var _open = XMLHttpRequest.prototype.open, _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(this: any, m: any, u: any){ try { this.__bu = u; } catch(e){} return _open.apply(this, arguments as any); };
    XMLHttpRequest.prototype.send = function(this: any, body: any){ try { var b = null; try { b = body ? JSON.parse(body) : null; } catch(e2){} emitCart("" + (this.__bu || ""), b); } catch(e){} return _send.apply(this, arguments as any); };
  } catch(e){}
  D.addEventListener("submit", function(ev: any){ try { var f = ev.target; if (!f) return; var a = "" + (f.action || "");
    var qs = f.querySelector ? function(s: string){ try { return f.querySelector(s); } catch(e){ return null; } } : function(){ return null; };
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
    // SPEC A.1.1 (WA-07): RETIRED whenever the v2 identity config governs — this legacy bridge reads
    // email fields on ANY submit, password-adjacent auth forms included, which the A.1.1 selector
    // rule forbids. Under v2, field capture is identify-autodetect.ts (MutationObserver + blur,
    // password-adjacency-safe, consent + flag gated). Legacy (flag OFF) behavior is unchanged.
    var em = qs('input[type=email],input[name*="email" i],input[id*="email" i]');
    if (em && em.value && !rt.identityV2Active) identify({ email: em.value });
  } catch(e){} }, true);

  // ── Content-engagement helpers (download / share classification) ───────────
  function downloadExt(href: any): string | null {
    if (!href) return null;
    var clean = ("" + href).split("?")[0]!.split("#")[0]!;
    var dot = clean.lastIndexOf("."); if (dot < 0) return null;
    var e = clean.slice(dot + 1).toLowerCase();
    for (var i = 0; i < DL_EXT.length; i++){ if (DL_EXT[i] === e) return e; }
    return null;
  }
  // Known social-share sharer URLs → the share method/network. navigator.share() is handled separately.
  function shareMethod(href: any): string | null {
    if (!href) return null;
    var h = ("" + href).toLowerCase();
    if (h.indexOf("facebook.com/sharer") >= 0 || h.indexOf("facebook.com/share.php") >= 0) return "facebook";
    if (h.indexOf("twitter.com/intent") >= 0 || h.indexOf("x.com/intent") >= 0) return "twitter";
    if (h.indexOf("linkedin.com/sharing") >= 0 || h.indexOf("linkedin.com/sharearticle") >= 0) return "linkedin";
    if (h.indexOf("api.whatsapp.com/send") >= 0 || h.indexOf("wa.me/") >= 0) return "whatsapp";
    if (h.indexOf("t.me/share") >= 0 || h.indexOf("telegram.me/share") >= 0) return "telegram";
    return null;
  }

  // Web Share API — monkey-patch navigator.share so a native share invocation is captured (method=web_share).
  try {
    if (NS.share && !NS.__brainShareWrapped){
      var _origShare = NS.share; NS.__brainShareWrapped = 1;
      NS.share = function(){ try { emit("share", { method: "web_share" }); } catch(e){} return _origShare.apply(NS, arguments as any); };
    }
  } catch(e){}

  // Exit intent (DESKTOP only) — the cursor leaves through the TOP edge of the viewport (clientY<=0) with no
  // relatedTarget (it left the document). A strong "about to bounce" signal for exit-offer / abandonment logic.
  // Throttled to avoid spamming when the user repeatedly grazes the top chrome.
  if (uaClass() === "desktop"){
    var _lastExit = 0;
    D.addEventListener("mouseout", function(ev: any){ try {
      var y = (ev && ev.clientY != null) ? ev.clientY : 1;
      if (y <= 0 && !(ev && ev.relatedTarget)){ var now = Date.now(); if ((now - _lastExit) > 3000){ _lastExit = now; emit("exit_intent", {}); } }
    } catch(e){} }, true);
  }

  // Native media engagement — <video>/<audio> play/pause/ended. Media events do NOT bubble, so we listen in the
  // CAPTURE phase on the document (where they DO pass). position_seconds = the playhead at the moment.
  function mediaListener(action: string){
    return function(ev: any){ try {
      var el = ev && ev.target; if (!el) return; var tn = ("" + (el.tagName || "")).toLowerCase();
      if (tn !== "video" && tn !== "audio") return;
      emit("video", { action: action, src: el.currentSrc || el.src || undefined, position_seconds: typeof el.currentTime === "number" ? Math.round(el.currentTime) : undefined });
    } catch(e){} };
  }
  try {
    D.addEventListener("play", mediaListener("play"), true);
    D.addEventListener("pause", mediaListener("pause"), true);
    D.addEventListener("ended", mediaListener("ended"), true);
  } catch(e){}

  // Click tracking + frustration signals — links/buttons (element.clicked), plus rage clicks and
  // dead clicks. The latter two are UX-friction signals that power "checkout bottleneck" /
  // "conversion drop" insights. No PII.
  var _clicks: any[] = [], _lastRage = 0;
  D.addEventListener("click", function(ev: any){ try {
    var el = ev.target; if (!el) return;
    var now = Date.now(), x = (ev && ev.clientX) || 0, y = (ev && ev.clientY) || 0;
    // Rage: >=3 clicks within 1s inside a ~40px box → ONE rage.click per burst (1.5s debounce).
    _clicks.push({ t: now, x: x, y: y }); if (_clicks.length > 8) _clicks.shift();
    var near = 0; for (var i = 0; i < _clicks.length; i++){ var c = _clicks[i]; if ((now - c.t) < 1000 && Math.abs(c.x - x) < 40 && Math.abs(c.y - y) < 40) near++; }
    if (near >= 3 && (now - _lastRage) > 1500){ _lastRage = now; emit("rage.click", { count: near, x: x, y: y }); }
    var a = el.closest ? el.closest("a,button,input,select,textarea,label,[role=button],[onclick],[data-brain-track],[contenteditable]") : null;
    if (a){
      var txt = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80);
      var hrefV = (a.getAttribute && a.getAttribute("href")) || undefined;
      emit("element.clicked", { element: (a.tagName || "").toLowerCase(), text: txt || undefined, href: hrefV, el_id: a.id || undefined });
      // File download — a link to a downloadable asset (pdf/zip/csv/…); the click is the only signal we get
      // (the actual GET is a browser navigation we never see). Behavioral content-engagement, no PII.
      var dext = downloadExt(hrefV); if (dext) emit("download", { href: hrefV, file_ext: dext });
      // Social share via a known sharer link (the Web Share API path is monkey-patched separately).
      var smeth = shareMethod(hrefV); if (smeth) emit("share", { method: smeth });
    } else {
      // Dead click: the element LOOKS clickable (cursor:pointer) but resolves to NO interactive
      // ancestor — the user expected something to happen and nothing did. Precise (not every stray click).
      var looksClickable = false;
      try { var cs = W.getComputedStyle ? W.getComputedStyle(el) : null; looksClickable = !!(cs && cs.cursor === "pointer"); } catch(e2){}
      if (looksClickable) emit("dead.click", { element: (el.tagName || "").toLowerCase(), x: x, y: y });
    }
  } catch(e){} }, true);

  // Scroll-depth milestones (25/50/75/100%), once each.
  var sm: any = {};
  W.addEventListener("scroll", function(){ try { var h = D.documentElement; var pct = Math.round((((W.scrollY || h.scrollTop) + W.innerHeight) / (h.scrollHeight || 1)) * 100); var ms = [25,50,75,100]; for (var k = 0; k < ms.length; k++){ if (pct >= ms[k]! && !sm[ms[k]!]){ sm[ms[k]!] = 1; emit("scroll.depth", { percent: ms[k] }); } } } catch(e){} }, { passive: true });

  // session.ended on unload — when a session exists, close it out with its elapsed duration. Guarded to fire
  // at most once per page load (a pagehide can fire more than once across bfcache transitions). Carries the
  // current session id so the ended marker is attributed to the right session.
  var _endedOnUnload = false;
  function endSessionOnUnload(){
    if (_endedOnUnload) return;
    var raw = get(SESSION_KEY); if (!raw) return;
    try { var s = JSON.parse(raw); if (s && s.id){ _endedOnUnload = true; emitRaw("session.ended", { session_duration_ms: Date.now() - (s.started || s.last || Date.now()) }, s.id); } } catch(e){}
  }

  // Durable retry triggers (NO Set-Cookie — stateless edge, REC-4).
  W.addEventListener("pagehide", function(){ endSessionOnUnload(); flush(); });
  D.addEventListener("visibilitychange", function(){ if (D.visibilityState === "hidden") flush(); });

  return { trackPageView: trackPageView };
}
