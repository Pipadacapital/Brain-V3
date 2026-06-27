/**
 * InMemoryDecisionLog — an in-process DecisionLogRepository (tests + dev).
 *
 * Append-only + idempotent on decision_id (a replay of the same decision is a no-op), mirroring the
 * PG identity_audit adapter's semantics without a database. Insertion order is preserved so a test
 * can assert the ledger sequence. brand_id-scoped on every key.
 */
import type {
  DecisionLogRepository,
  DecisionLogEntry,
  DecisionLogReceipt,
} from '../../domain/identity/decisions/DecisionLogRepository.js';

export class InMemoryDecisionLog implements DecisionLogRepository {
  private readonly ordered: DecisionLogEntry[] = [];
  private readonly byKey = new Map<string, DecisionLogEntry>();

  async append(entry: DecisionLogEntry): Promise<DecisionLogReceipt> {
    const key = `${entry.brand_id}:${entry.decision_id}`;
    if (this.byKey.has(key)) {
      return { appended: false, decision_id: entry.decision_id };
    }
    // Defensive copy so a later mutation of the caller's object cannot rewrite the ledger.
    const frozen: DecisionLogEntry = { ...entry, decision: entry.decision };
    this.ordered.push(frozen);
    this.byKey.set(key, frozen);
    return { appended: true, decision_id: entry.decision_id };
  }

  async read(args: { brand_id: string; decision_id: string }): Promise<DecisionLogEntry | null> {
    return this.byKey.get(`${args.brand_id}:${args.decision_id}`) ?? null;
  }

  /** Test helper — the append-ordered ledger (a copy). */
  all(): DecisionLogEntry[] {
    return [...this.ordered];
  }
}
