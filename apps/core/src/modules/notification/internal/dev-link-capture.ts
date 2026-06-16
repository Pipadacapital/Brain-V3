/**
 * DEV-ONLY email action-link capture.
 *
 * In dev there is no real inbox, so a developer cannot complete
 * register→verify / forgot→reset / invite→accept in the browser. This module keeps
 * the most recent action link (verify / reset / invite) per recipient in process
 * memory so a dev-only endpoint can hand it back.
 *
 * HARD PRODUCTION GATE (the only thing that matters here):
 *   - `DEV_LINKS_ENABLED` is false when NODE_ENV === 'production'.
 *   - `capture()` no-ops and `get()` returns undefined when disabled, so in prod the
 *     store is never populated — even if a caller forgets to gate.
 *   - The endpoint that reads this store is itself registered ONLY when
 *     NODE_ENV !== 'production' (see main.ts), so it does not exist in prod at all.
 * Two independent gates: the data is never captured AND the route is never mounted.
 *
 * Tokens here are the SAME single-use, time-expiring tokens that would be emailed;
 * surfacing them in dev is no weaker than reading the dev inbox. This must never run
 * in production.
 */

export type DevLinkType = 'email_verification' | 'password_reset' | 'invite';

export interface CapturedDevLink {
  type: DevLinkType;
  token: string;
  url: string;
  capturedAt: string;
}

export const DEV_LINKS_ENABLED = process.env['NODE_ENV'] !== 'production';

/** recipient (lowercased) → most recent captured link. */
const store = new Map<string, CapturedDevLink>();

function key(recipient: string): string {
  return recipient.trim().toLowerCase();
}

/** Record the latest action link for a recipient. No-op in production. */
export function captureDevLink(recipient: string, link: CapturedDevLink): void {
  if (!DEV_LINKS_ENABLED) return;
  store.set(key(recipient), link);
}

/** Read the latest action link for a recipient. Returns undefined in production. */
export function getDevLink(recipient: string): CapturedDevLink | undefined {
  if (!DEV_LINKS_ENABLED) return undefined;
  return store.get(key(recipient));
}
