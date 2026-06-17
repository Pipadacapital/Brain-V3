/**
 * pixel-sdk/consent — read the CMP state, stamp consent_flags (capture-only).
 *
 * FAIL-SAFE-ABSENT (architecture Track B): when no CMP signal is present we capture the
 * anonymous BEHAVIOUR (page/cart) but WITHHOLD a consent_flags stamp claiming analytics=true.
 * The SDK does NOT enforce consent (I-ST05 — enforcement is the server can_contact() chokepoint);
 * it only TRANSPORTS the captured state. An event whose consent is unknown is sent WITHOUT
 * consent_flags → the ingest gate quarantines it (R3), which is the correct fail-closed posture.
 */
import type { BrowserEnv, ConsentFlags } from './types.js';

/** A CMP adapter reads window-level consent. Default: read window.__brainConsent if present. */
export interface ConsentReader {
  read(): Partial<ConsentFlags> | null;
}

/**
 * Resolve consent_flags. Returns undefined when the CMP signal is absent/unknown
 * (fail-safe-absent — the event ships without the field and is quarantined server-side).
 * When a partial CMP signal exists, missing booleans default to FALSE (deny-by-default).
 */
export function resolveConsent(reader: ConsentReader): ConsentFlags | undefined {
  const raw = reader.read();
  if (raw == null) return undefined;
  return {
    analytics: raw.analytics === true,
    marketing: raw.marketing === true,
    personalization: raw.personalization === true,
    ai_processing: raw.ai_processing === true,
  };
}

/** Default CMP reader — reads a window.__brainConsent object (string-keyed booleans). */
export function defaultConsentReader(getWindowConsent: () => unknown): ConsentReader {
  return {
    read(): Partial<ConsentFlags> | null {
      const c = getWindowConsent();
      if (c == null || typeof c !== 'object') return null;
      const obj = c as Record<string, unknown>;
      const out: Partial<ConsentFlags> = {};
      if (typeof obj['analytics'] === 'boolean') out.analytics = obj['analytics'];
      if (typeof obj['marketing'] === 'boolean') out.marketing = obj['marketing'];
      if (typeof obj['personalization'] === 'boolean') out.personalization = obj['personalization'];
      if (typeof obj['ai_processing'] === 'boolean') out.ai_processing = obj['ai_processing'];
      return Object.keys(out).length > 0 ? out : null;
    },
  };
}

/** Unused-param guard so BrowserEnv stays importable for future CMP integrations. */
export type { BrowserEnv };
