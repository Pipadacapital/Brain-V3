/**
 * snapshot.ts — the reproducibility handle (D3).
 *
 * A `snapshot_id` is a DETERMINISTIC, content-addressed handle that PINS the read frame so
 * re-running a metric_binding at the snapshot reproduces the SAME number. The metric-engine's
 * reads are already `as_of`-bounded (realized_gmv_as_of, provisional_gmv_as_of, the latest
 * grade per (category,target), etc.), so the M1 snapshot pins the `as_of` date:
 *
 *     snapshot_id = base64url( as_of-date )      // e.g. '2026-06-18' → 'MjAyNi0wNi0xOA'
 *
 * Reproduction = resolveMetric(metric_id, version) + the persisted `params` + the `as_of`
 * decoded from `snapshot_id`, fed back through the SAME engine compute path inside
 * withBrandTxn → identical number (engine is Tier-0 deterministic, toleranceMinor:0).
 *
 * The handle is OPAQUE to the UI/MCP — they round-trip it, never parse it. It is
 * forward-compatible: a later version may pin a watermark / version vector behind the same
 * encode/decode seam without changing callers (versioned prefix below).
 *
 * @see 02-architecture.md §D3
 */

/**
 * Snapshot version prefix. Bump only when the pinned frame's SEMANTICS change.
 * The encoded payload is `v1:<as_of>` so a future v2 can pin more without ambiguity.
 */
const SNAPSHOT_VERSION = 'v1';

/** Strict YYYY-MM-DD shape (the only as_of form the engine accepts). */
const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/** base64url encode (no padding) — deterministic, URL-safe, no Buffer-padding drift. */
function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** base64url decode — inverse of b64urlEncode. */
function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * encodeSnapshot — pin an `as_of` date into a reproducibility handle.
 *
 * @param asOf - 'YYYY-MM-DD' (server-computed, never client-trusted).
 * @returns The opaque snapshot_id (deterministic for the same as_of).
 * @throws  If asOf is not a valid YYYY-MM-DD (fail-closed — never pin a garbage frame).
 */
export function encodeSnapshot(asOf: string): string {
  if (!AS_OF_RE.test(asOf)) {
    throw new Error(`[snapshot] invalid as_of '${asOf}' — expected YYYY-MM-DD.`);
  }
  return b64urlEncode(`${SNAPSHOT_VERSION}:${asOf}`);
}

/**
 * decodeSnapshot — recover the pinned `as_of` date from a snapshot_id.
 *
 * @param snapshotId - The handle produced by encodeSnapshot.
 * @returns The pinned 'YYYY-MM-DD' as_of date.
 * @throws  If the handle is malformed / unknown-version / decodes to a non-date
 *          (fail-closed — a corrupt handle must NOT silently reproduce a wrong number).
 */
export function decodeSnapshot(snapshotId: string): string {
  let decoded: string;
  try {
    decoded = b64urlDecode(snapshotId);
  } catch {
    throw new Error(`[snapshot] undecodable snapshot_id.`);
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) {
    throw new Error(`[snapshot] malformed snapshot_id payload.`);
  }
  const version = decoded.slice(0, sep);
  const asOf = decoded.slice(sep + 1);
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`[snapshot] unknown snapshot version '${version}'.`);
  }
  if (!AS_OF_RE.test(asOf)) {
    throw new Error(`[snapshot] snapshot_id decodes to a non-date as_of.`);
  }
  return asOf;
}
