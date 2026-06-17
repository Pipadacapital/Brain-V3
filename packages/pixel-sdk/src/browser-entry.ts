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

  return {
    bootstrap,
    storage,
    now: () => Date.now(),
    nowIso: () => new Date().toISOString(),
    uuid,
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

export function boot(): Pixel | undefined {
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
  // Auto-fire the initial page view.
  void pixel.page({ collector_version: COLLECTOR_VERSION });
  return pixel;
}

// Auto-boot when loaded as /pixel.js in a browser (guarded for the test env).
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  boot();
}
