/**
 * @brain/audit — Audit log write helper (I-S06).
 *
 * The audit_log table is append-only at the PostgreSQL GRANT level
 * (brain_app role: INSERT + SELECT only, NO UPDATE/DELETE).
 *
 * Each entry carries a hash-chain: entry_hash = sha256(prev_hash || canonical(row)).
 * The hash-chain computation is performed here before the INSERT.
 *
 * L-02 CLOSURE: This file replaces the djb2 stub with real sha256 hashing
 * (crypto.createHash('sha256')) and implements a DB-backed AuditWriter
 * that INSERTs into audit_log with a real hash-chain.
 *
 * NN-6: Every SELECT in this package MUST carry WHERE brand_id = $1.
 * The audit_log table has RLS disabled (cross-brand SoR); isolation is
 * enforced at the application layer by the mandatory brand_id filter.
 */
import { createHash } from 'node:crypto';

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

// ── Canonical JSON (R-19: deterministic, FULL-coverage serialization) ─────────

/**
 * canonicalize — a deterministic, order-independent JSON string for hashing.
 *
 * Recursively sorts object keys at EVERY depth and includes every value, so two
 * logically-equal rows built with different key-insertion order hash identically,
 * and EVERY field (including the entire nested `payload`) is covered by the hash.
 *
 * Why this is hand-rolled and not `JSON.stringify(row, keysArray)`: the array form
 * of the second argument is a property ALLOWLIST, not a key-sorter. It applies
 * recursively, so any nested key not in the top-level allowlist (i.e. every
 * `payload.*` key) is SILENTLY DROPPED from the output — the payload would not be
 * hashed at all, and the audit log would not be tamper-evident on its content.
 * (See the regression tests.)
 *
 * Rules: objects → '{' + sorted "key":canonical(value) pairs + '}'; arrays preserve
 * order; `undefined`/function members are omitted (JSON semantics); everything else
 * defers to JSON.stringify for the leaf. Determinism does NOT depend on the JS engine's
 * key-insertion order.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Leaf (string/number/boolean/null/bigint-throws-upstream). undefined → 'null' only
    // when it reaches here directly; object/array members handle undefined via omission.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : canonicalize(v))).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // JSON drops undefined object members
    parts.push(`${JSON.stringify(key)}:${canonicalize(v)}`);
  }
  return `{${parts.join(',')}}`;
}

// ── Hash-chain helper (L-02: real sha256; R-19: full-coverage canonicalization) ─

/**
 * Compute the entry_hash for an audit log row using real SHA-256.
 *
 * entry_hash = sha256(prev_hash || canonical(row))
 *
 * where canonical(row) sorts keys at every depth and covers EVERY field, including
 * the full nested payload — so any tamper (including inside the payload) breaks the
 * chain, and the hash is independent of key-insertion order.
 *
 * L-02: Uses crypto.createHash('sha256') — NOT the djb2 stub.
 */
export function computeEntryHash(
  prevHash: string | null,
  entry: Omit<AuditEntry, 'idempotency_key'>,
): string {
  const input = `${prevHash ?? 'genesis'}||${canonicalize(entry)}`;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ── Writer interface ─────────────────────────────────────────────────────────

/**
 * Interface for writing audit log entries.
 */
export interface AuditWriter {
  /**
   * Append an entry to the audit log.
   * The implementation computes prev_hash from the last row before inserting.
   *
   * @returns The ID of the newly inserted row and its entry_hash.
   */
  append(entry: AuditEntry): Promise<{ id: bigint; entry_hash: string }>;

  /**
   * Query recent audit entries for a brand (NN-6: WHERE brand_id = $1 mandatory).
   */
  getRecentEntries(
    brandId: string,
    limit?: number,
  ): Promise<Array<{ id: bigint; action: string; entity_type: string; entity_id: string; created_at: Date; entry_hash: string }>>;
}

// ── DB-backed writer (L-02: replaces NoopAuditWriter) ───────────────────────

/**
 * Minimal DB client interface for audit writes.
 * The real implementation uses @brain/db DbClient.
 */
export interface AuditDbClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

/**
 * DB-backed audit writer (L-02 closure).
 *
 * Writes to the audit_log table with real sha256 hash-chain.
 * Every read is scoped to brand_id (NN-6).
 *
 * NOTE: The db client passed here must already have the appropriate GUC
 * context set (workspace_id / brand_id) for the enclosing request.
 * The audit_log itself has RLS disabled (cross-brand SoR) but the
 * AuditDbClient.query() is expected to be a raw client (not GUC-wrapped)
 * since audit_log needs no RLS; isolation is enforced by the mandatory
 * WHERE brand_id filter in every SELECT.
 */
export class DbAuditWriter implements AuditWriter {
  constructor(private readonly db: AuditDbClient) {}

  async append(entry: AuditEntry): Promise<{ id: bigint; entry_hash: string }> {
    // Step 1: Fetch the last row's entry_hash for this brand to continue the chain.
    // NN-6: ALWAYS include WHERE brand_id = $1.
    const prevResult = await this.db.query<{ entry_hash: string }>(
      `SELECT entry_hash
       FROM audit_log
       WHERE brand_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [entry.brand_id],
    );

    const prevHash = prevResult.rows[0]?.entry_hash ?? null;

    // Step 2: Compute the entry hash (sha256, L-02).
    const entryForHash: Omit<AuditEntry, 'idempotency_key'> = {
      brand_id: entry.brand_id,
      actor_id: entry.actor_id,
      actor_role: entry.actor_role,
      action: entry.action,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      payload: entry.payload,
    };
    const entryHash = computeEntryHash(prevHash, entryForHash);

    // Step 3: INSERT the audit row (append-only — no UPDATE/DELETE on audit_log).
    const insertResult = await this.db.query<{ id: string }>(
      `INSERT INTO audit_log
         (brand_id, actor_id, actor_role, action, entity_type, entity_id, payload, prev_hash, entry_hash, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        entry.brand_id,
        entry.actor_id,
        entry.actor_role,
        entry.action,
        entry.entity_type,
        entry.entity_id,
        JSON.stringify(entry.payload),
        prevHash,
        entryHash,
        entry.idempotency_key ?? null,
      ],
    );

    const insertedId = insertResult.rows[0]?.id;
    return {
      id: insertedId ? BigInt(insertedId) : 0n,
      entry_hash: entryHash,
    };
  }

  async getRecentEntries(
    brandId: string,
    limit = 50,
  ): Promise<Array<{ id: bigint; action: string; entity_type: string; entity_id: string; created_at: Date; entry_hash: string }>> {
    // NN-6: WHERE brand_id = $1 is MANDATORY on every SELECT from audit_log.
    const result = await this.db.query<{
      id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      created_at: Date;
      entry_hash: string;
    }>(
      `SELECT id, action, entity_type, entity_id, created_at, entry_hash
       FROM audit_log
       WHERE brand_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [brandId, limit],
    );

    return result.rows.map((r) => ({
      id: BigInt(r.id),
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      created_at: r.created_at,
      entry_hash: r.entry_hash,
    }));
  }
}

// ── No-op writer (for tests / environments without a DB) ─────────────────────

/**
 * No-op audit writer for unit testing.
 * Uses real sha256 for the hash (no stub — L-02 compliance in tests too).
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

  async getRecentEntries(
    _brandId: string,
    _limit?: number,
  ): Promise<Array<{ id: bigint; action: string; entity_type: string; entity_id: string; created_at: Date; entry_hash: string }>> {
    return [];
  }
}
