/**
 * @brain/audit — Audit log write helper (I-S06).
 *
 * The audit_log table is append-only at the PostgreSQL GRANT level
 * (brain_app role: INSERT + SELECT only, NO UPDATE/DELETE).
 *
 * Each entry carries a hash-chain: entry_hash = sha256(prev_hash || canonical(row)).
 * The hash-chain computation is performed here before the INSERT.
 *
 * Sprint-0: stub types + helper interface. The real INSERT against Postgres
 * ships in M1 when the DB pool is live. The interface is defined now so
 * consuming services can be written against it.
 */
import type { CurrencyCode } from '@brain/money';

// ── Audit entry shape ─────────────────────────────────────────────────────────

export interface AuditEntry {
  /** UUID of the brand this action belongs to (I-S01). */
  brand_id: string;
  /** UUID of the actor (user) who performed the action. Null for system/job actions. */
  actor_id: string | null;
  /** Role of the actor (e.g. 'owner', 'brand_admin', 'system'). */
  actor_role: string;
  /**
   * Dot-separated action name (e.g. 'brand.created', 'metric.computed', 'consent.withdrawn').
   * Follow the pattern: {entity}.{verb}.
   */
  action: string;
  /** Entity type (e.g. 'brand', 'metric_definition', 'consent_record'). */
  entity_type: string;
  /** String-serialised entity identifier. */
  entity_id: string;
  /**
   * Arbitrary structured payload. No raw PII (I-S02).
   * Monetary values in this payload must be in minor units (I-S07).
   */
  payload: Record<string, unknown>;
  /**
   * Optional idempotency key — prevents duplicate inserts on replay.
   * Use a stable UUID derived from the operation (e.g. event_id of the triggering event).
   */
  idempotency_key?: string;
}

// ── Hash-chain helper ─────────────────────────────────────────────────────────

/**
 * Compute the entry_hash for an audit log row.
 *
 * entry_hash = sha256(prev_hash || canonical(row))
 *
 * where canonical(row) = JSON.stringify with keys sorted alphabetically.
 *
 * Sprint-0 stub: uses a deterministic string hash for unit-testability without
 * the Node.js crypto module. M1 replaces with crypto.createHash('sha256').
 */
export function computeEntryHash(
  prevHash: string | null,
  entry: Omit<AuditEntry, 'idempotency_key'>,
): string {
  const canonical = JSON.stringify(entry, Object.keys(entry).sort());
  const input = `${prevHash ?? 'genesis'}||${canonical}`;
  // Sprint-0 stub: simple deterministic hash (not cryptographic; M1 replaces with sha256).
  // This stub produces a consistent hash for the same input, enabling chain-walk tests.
  return stubHash(input);
}

/**
 * Stub hash function (Sprint-0 only).
 * Replace with crypto.createHash('sha256').update(input).digest('hex') in M1.
 */
function stubHash(input: string): string {
  // djb2-style hash → hex (deterministic, not cryptographic)
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0') + '-stub';
}

// ── Writer interface ─────────────────────────────────────────────────────────

/**
 * Interface for writing audit log entries.
 * Implemented by the real DB-backed writer in M1 (packages/db integration).
 */
export interface AuditWriter {
  /**
   * Append an entry to the audit log.
   * The implementation computes prev_hash from the last row before inserting.
   *
   * @returns The ID of the newly inserted row.
   */
  append(entry: AuditEntry): Promise<{ id: bigint; entry_hash: string }>;
}

// ── No-op writer (Sprint-0 stub) ─────────────────────────────────────────────

/**
 * No-op audit writer for Sprint-0.
 * In M1 this is replaced by a writer that INSERTs into audit_log via packages/db.
 */
export class NoopAuditWriter implements AuditWriter {
  async append(entry: AuditEntry): Promise<{ id: bigint; entry_hash: string }> {
    const hash = computeEntryHash(null, {
      brand_id: entry.brand_id,
      actor_id: entry.actor_id,
      actor_role: entry.actor_role,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      payload: entry.payload,
    });
    return { id: 0n, entry_hash: hash };
  }
}
