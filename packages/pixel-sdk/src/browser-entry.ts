/// <reference lib="dom" />
/**
 * pixel-sdk/browser-entry — the thin brain.js IIFE entry. Binds the REAL browser globals to
 * the injectable BrowserEnv and auto-fires page.viewed on load.
 *
 * Loaded as the built /pixel.js asset (served by the collector, see apps/collector). The
 * merchant snippet sets window.__brain = { install_token, brand_id } (buildDefaultSnippet,
 * pixelRoutes.ts:136) BEFORE this script runs.
 *
 * NO Set-Cookie, NO credentials on /collect (REC-4 — edge stays stateless; anon-id is
 * client-side localStorage). collector_version is stamped for forensic provenance.
 */
import type { BrainBootstrap, BrowserEnv, MinimalStorage } from './types.js';
import { createPixel, type Pixel } from './capture.js';
import { uuidV7 } from './uuid.js';

export const COLLECTOR_VERSION = 'pixel@0.1.0';

declare global {
  interface Window {
    __brain?: BrainBootstrap;
    __brainConsent?: unknown;
    brain?: Pixel;
  }
}

function readCookie(name: string): string {
  const prefix = `${name}=`;
  const parts = document.cookie ? document.cookie.split('; ') : [];
  for (const part of parts) {
    if (part.indexOf(prefix) === 0) return part.slice(prefix.length);
  }
  return '';
}

function buildBrowserEnv(bootstrap: BrainBootstrap): BrowserEnv {
  const storage: MinimalStorage = {
    getItem: (k) => {
      try {
        return window.localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        window.localStorage.setItem(k, v);
      } catch {
        /* storage disabled — degrade to memoryless (events still send, no dedup persistence) */
      }
    },
    removeItem: (k) => {
      try {
        window.localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };

  const uuid = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // RFC4122-ish fallback (no crypto.randomUUID) — sufficient for an opaque client id.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  const hasCryptoRandom =
    typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';

  const uuidv7 = (): string => {
    // Keep a v4 fallback ONLY if crypto is unavailable (per the shared contract).
    if (!hasCryptoRandom) return uuid();
    const rnd = new Uint8Array(10);
    crypto.getRandomValues(rnd);
    return uuidV7(Date.now(), rnd);
  };

  return {
    bootstrap,
    storage,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    uuid,
    uuidv7,
    href: () => window.location.href,
    referrer: () => document.referrer,
    pathname: () => window.location.pathname,
    uaClass: () => (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'mobile' : 'desktop'),
    viewport: () => `${window.innerWidth}x${window.innerHeight}`,
    cookie: readCookie,
    sendBeacon: (url, body) => {
      if (typeof navigator.sendBeacon !== 'function') return false;
      const blob = new Blob([body], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    },
    fetchKeepalive: async (url, body) => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true,
          credentials: 'omit', // REC-4: never send cookies/credentials to the edge
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    onFlushTrigger: (cb) => {
      window.addEventListener('pagehide', cb);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') cb();
      });
    },
  };
}

// Downloadable file extensions (mirrors the served pixel) — a click on an <a> whose href ends in one
// of these is a `download`. mp4 counts only as a FILE link (an anchor href), not inline playback.
const DOWNLOAD_EXTS = new Set([
  'pdf', 'zip', 'dmg', 'exe', 'csv', 'xlsx', 'doc', 'docx', 'ppt', 'pptx', 'rar', '7z', 'pkg',
  'mp3', 'mp4',
]);

function fileExt(href: string): string | undefined {
  const clean = href.split('#')[0]!.split('?')[0]!;
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Map a known social-share link to its `method`, or undefined when it is not a share link. */
function shareMethodFor(href: string): string | undefined {
  const h = href.toLowerCase();
  if (h.includes('facebook.com/sharer') || h.includes('facebook.com/share')) return 'facebook';
  if (h.includes('twitter.com/intent') || h.includes('x.com/intent')) return 'twitter';
  if (h.includes('linkedin.com/sharing') || h.includes('linkedin.com/share')) return 'linkedin';
  if (h.includes('wa.me') || h.includes('whatsapp.com/send')) return 'whatsapp';
  if (h.includes('t.me/share') || h.includes('telegram.me/share') || h.includes('telegram.me/?url'))
    return 'telegram';
  return undefined;
}

/**
 * Zero-merchant-code behavioural auto-instrumentation (mirrors the served pixel). Uses the REAL DOM
 * globals directly — the env-injected createPixel core stays DOM-free + unit-testable; these handlers
 * just call the public pixel API (track / endSession).
 */
function wireAutoInstrumentation(pixel: Pixel, isDesktop: boolean): void {
  // exit_intent — desktop only: the cursor leaves through the TOP of the viewport (clientY<=0).
  if (isDesktop) {
    let lastExit = 0;
    document.addEventListener('mouseout', (e) => {
      const me = e as MouseEvent;
      if (me.clientY <= 0 && !me.relatedTarget) {
        const now = Date.now();
        if (now - lastExit > 3000) {
          lastExit = now; // debounce — ONE exit_intent per few seconds
          void pixel.track('exit_intent', {});
        }
      }
    });
  }

  // download + social share — a single capturing click listener classifies the anchor.
  document.addEventListener(
    'click',
    (e) => {
      try {
        const target = e.target as Element | null;
        const a = target && target.closest ? target.closest('a[href]') : null;
        if (!a) return;
        const href = a.getAttribute('href') || '';
        const ext = fileExt(href);
        if (ext && DOWNLOAD_EXTS.has(ext)) {
          void pixel.track('download', { href, file_ext: ext });
          return;
        }
        const method = shareMethodFor(href);
        if (method) void pixel.track('share', { method });
      } catch {
        /* never let instrumentation break the page */
      }
    },
    true,
  );

  // video — native <video>/<audio> play|pause|ended. These media events do NOT bubble, so listen in
  // the CAPTURE phase on the document.
  (['play', 'pause', 'ended'] as const).forEach((action) => {
    document.addEventListener(
      action,
      (e) => {
        const t = e.target as HTMLMediaElement | null;
        const tag = t && t.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO') {
          void pixel.track('video', {
            action,
            src: t!.currentSrc || t!.src || undefined,
            position_seconds: Math.round(t!.currentTime || 0),
          });
        }
      },
      true,
    );
  });

  // share — Web Share API: monkey-patch navigator.share to observe invocations.
  try {
    const ns = navigator as Navigator & { share?: (data?: unknown) => Promise<void> };
    if (typeof ns.share === 'function') {
      const orig = ns.share.bind(ns);
      ns.share = (data?: unknown): Promise<void> => {
        try {
          void pixel.track('share', { method: 'web_share_api' });
        } catch {
          /* ignore */
        }
        return orig(data as never);
      };
    }
  } catch {
    /* navigator.share not assignable — ignore */
  }

  // session.ended — end the session on pagehide (the durable retry flush also fires; see Transport).
  window.addEventListener('pagehide', () => {
    void pixel.endSession();
  });
}

function boot(): Pixel | undefined {
  const bootstrap = window.__brain;
  if (!bootstrap || !bootstrap.install_token) {
    // No snippet bootstrap — nothing to do (do not throw in the page context).
    console.warn('[brain.js] window.__brain.install_token missing — pixel inactive');
    return undefined;
  }
  const env = buildBrowserEnv(bootstrap);
  const pixel = createPixel(env, {
    getWindowConsent: () => window.__brainConsent,
  });
  window.brain = pixel;
  wireAutoInstrumentation(pixel, env.uaClass() === 'desktop');
  // Auto-fire the initial page view (the first emit also emits session.started).
  void pixel.page({ collector_version: COLLECTOR_VERSION });
  return pixel;
}

// Auto-boot when loaded as /pixel.js in a browser (guarded for the test env).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
}
