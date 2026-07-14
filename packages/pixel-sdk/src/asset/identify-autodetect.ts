/// <reference lib="dom" />
// SPEC: A.1.1 (WA-07 form auto-detect)
/**
 * pixel-sdk/asset/identify-autodetect — the A.1.1 form auto-detect: a MutationObserver detector for
 * identity-bearing inputs (`input[type=email]`, `input[type=tel]`, `autocomplete="email|tel"`),
 * blur-triggered, hash-and-discard.
 *
 * GATES (all must hold, checked at wire time AND re-checked per capture inside identifyV2):
 *   • per-brand platform flag `pixel.autodetect.enabled` ON + brand identity_capture='autodetect'
 *     (both arrive via the bootstrap config → rt.identityAutodetectActive);
 *   • consent GRANTED at capture time (identifyV2 refuses source='form_autodetect' otherwise —
 *     auto-detect NEVER captures under denied/unknown consent, unlike the explicit API whose
 *     denied events the Silver AMD-04 gate drops server-side).
 *
 * PASSWORD-ADJACENCY (the spec selector rule): NEVER read a field inside a form that matches
 * `form[action*="password"]` or contains an `input[type=password]` — auth/reset forms are out of
 * bounds. Fail-CLOSED: if adjacency cannot be proven safe (DOM probe throws), do not capture.
 *
 * HASH-AND-DISCARD: the raw value is read at blur, handed straight to identifyV2 (normalize →
 * WebCrypto sha256 in-closure), and never stored, logged, or transported raw (ADR-2).
 *
 * Same ES5-ish, fence-everything style as the sibling asset modules — do not "modernize".
 */
import type { BrainAssetRuntime } from './runtime.js';

/**
 * AUD-IMPL-004 (types-only): the loose structural shape of a DOM element exactly as these EXPORTED
 * helpers probe it. They run against real browser elements but are written fence-everything (any
 * property may be absent on exotic/mocked nodes), so the type mirrors that honesty instead of `any`
 * (which disabled checking for every caller) or lib.dom `Element` (whose full surface the ES5-ish
 * bodies never assume). Annotations only — the emitted JS is unchanged (golden parity holds).
 */
export interface AutodetectElementLike {
  tagName?: string;
  type?: string;
  form?: AutodetectElementLike | null;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => AutodetectElementLike | null;
  querySelector?: (selector: string) => unknown;
}

/** Classify an element as an auto-detect candidate: 'email' | 'tel' | null. */
export function autodetectKind(el: AutodetectElementLike | null | undefined): string | null {
  try {
    if (!el || !el.tagName || ('' + el.tagName).toLowerCase() !== 'input') return null;
    var type = ('' + (el.type || (el.getAttribute && el.getAttribute('type')) || '')).toLowerCase();
    if (type === 'password' || type === 'hidden') return null;
    var ac = ('' + ((el.getAttribute && el.getAttribute('autocomplete')) || '')).toLowerCase();
    if (type === 'email' || ac.indexOf('email') >= 0) return 'email';
    // autocomplete tel family: tel, tel-national, tel-local, … ("tel" prefix per WHATWG).
    if (type === 'tel' || ac === 'tel' || ac.indexOf('tel-') === 0 || ac.indexOf(' tel') >= 0) return 'tel';
    return null;
  } catch (e) { return null; }
}

/** The spec selector rule — true ⇔ el sits in a password-adjacent form (NEVER capture). Fail-closed. */
export function isPasswordAdjacent(el: AutodetectElementLike): boolean {
  try {
    var f = el.form || (el.closest && el.closest('form'));
    if (!f) return false; // form-less input: nothing password-adjacent to it
    var action = '' + ((f.getAttribute && f.getAttribute('action')) || '');
    if (action.toLowerCase().indexOf('password') >= 0) return true; // form[action*="password"]
    if (f.querySelector && f.querySelector('input[type=password]')) return true;
    return false;
  } catch (e) { return true; } // cannot prove safe → do not capture
}

/**
 * Wire the auto-detect onto the booted runtime. No-op unless rt.identityAutodetectActive
 * (identity_capture='autodetect' AND the pixel.autodetect.enabled flag — both per-brand,
 * default OFF, delivered via the collector-templated bootstrap).
 */
export function wireIdentifyAutodetect(rt: BrainAssetRuntime): void {
  if (!rt || !rt.identityAutodetectActive) return;
  var W = window as any, D = document as any;

  function onBlur(el: any): void {
    try {
      var kind = autodetectKind(el);
      if (!kind) return;
      if (isPasswordAdjacent(el)) return; // spec selector rule
      var v = '' + (el.value || '');
      if (!v) return;
      if (kind === 'email') {
        if (v.indexOf('@') > 0) rt.identifyV2({ email: v }, 'form_autodetect');
      } else {
        // Cheap plausibility floor only — real validation is the normalizer + server re-validation.
        if (v.replace(/[^0-9]/g, '').length >= 6) rt.identifyV2({ phone: v }, 'form_autodetect');
      }
      // v goes out of scope here — hash-and-discard (identifyV2 hashes synchronously with the
      // capture; nothing raw is persisted or queued).
    } catch (e) {}
  }

  // Attach a blur listener ONCE per discovered candidate (marker property — WeakSet-free so the
  // bundle stays es2017-safe in the vm-sandbox harness).
  function attach(el: any): void {
    try {
      if (!el || el.__brainAutoId) return;
      if (!autodetectKind(el)) return;
      el.__brainAutoId = 1;
      el.addEventListener('blur', function () { onBlur(el); });
    } catch (e) {}
  }

  function scan(root: any): void {
    try {
      if (!root) return;
      attach(root); // the node itself may be a candidate input
      if (!root.querySelectorAll) return;
      var els = root.querySelectorAll('input[type=email],input[type=tel],input[autocomplete]');
      for (var i = 0; i < els.length; i++) attach(els[i]);
    } catch (e) {}
  }

  // Initial sweep + MutationObserver for late-rendered forms (SPA checkouts, modals, embeds).
  scan(D);
  try {
    if (typeof W.MutationObserver === 'function') {
      var mo = new W.MutationObserver(function (muts: any[]) {
        try {
          for (var i = 0; i < muts.length; i++) {
            var added = muts[i].addedNodes || [];
            for (var j = 0; j < added.length; j++) scan(added[j]);
          }
        } catch (e) {}
      });
      mo.observe(D.documentElement || D, { childList: true, subtree: true });
    }
  } catch (e) {}
}
