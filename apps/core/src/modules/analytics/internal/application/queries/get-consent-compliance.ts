/**
 * Consent / Compliance read seam (D13 — feat-d13-consent-cancontact, Track C).
 *
 * Four bounded, brand-scoped reads that power the per-brand Consent / Compliance
 * surface (/settings/consent). All read ONLY through the BFF → this use-case → the
 * consent system-of-record (consent_record + consent_tombstone + send_log) inside
 * withBrandTxn (the GUC is set per-transaction; RLS-enforced, NON-INERT under
 * brain_app — superuser `brain` bypasses, so these reads prove isolation only under
 * the app role; MEMORY: dev-db-superuser-masks-rls).
 *
 *   getConsentCoverage         — granted/withdrawn subject counts per category.
 *   getConsentSuppressionSummary — subjects suppressed for marketing (the fail-closed
 *                                  denominator: tombstones + no-consent).
 *   getConsentGateActivity     — the last-N can_contact() gate decisions by reason,
 *                                  from audit_log (action='notification.can_contact'),
 *                                  making the DEFAULT-CLOSED posture VISIBLE.
 *   getConsentWindowConfig     — the 9am–9pm IST permitted-hours window, READ-ONLY
 *                                  (it is SERVER-enforced at the queue, never a UI hint).
 *
 * PII POSTURE (I-S02 / COMPLIANCE.md): these reads surface COUNTS + hashed subject
 * keys ONLY. Raw email/phone NEVER leaves the query — the consent tables store
 * subject_hash (identity-core per-brand salt hash), and audit_log.payload carries
 * hashes + decision metadata, never PII. No amount/money columns (consent is not
 * monetary).
 *
 * FAIL-CLOSED + RESILIENT-TO-PARALLEL-BUILD: the consent_record / consent_tombstone /
 * send_log tables are landed by the parallel Track A/B migration (0032). Until that
 * migration runs in a given environment, the relation does not exist (Postgres
 * 42P01 undefined_table). The honest, compliance-correct degradation is FAIL-CLOSED:
 * NO consent rows == nothing is sendable == the empty state reads "blocked by default".
 * So a missing relation is caught and mapped to state:'no_data' (NOT an error, NOT a
 * fabricated allow) — the surface still tells the truth (default-closed).
 *
 * F-SEC-02: every read runs inside withBrandTxn. D-2: bounded operational reads (not
 * a metric computation) — no ad-hoc money SUM. D-1: counts are bigint strings.
 */

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';
import type { ConsentCategory } from '@brain/contracts';
import { CONSENT_CATEGORIES } from '@brain/contracts';

/** Postgres error code for "relation does not exist" (table not yet migrated). */
const UNDEFINED_TABLE = '42P01';

function isUndefinedTable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === UNDEFINED_TABLE
  );
}

// ── 1. Coverage ────────────────────────────────────────────────────────────────

export interface ConsentCoverageRow {
  category: ConsentCategory;
  granted: string; // bigint string — distinct subjects whose LATEST state is 'granted'
  withdrawn: string; // bigint string — distinct subjects whose LATEST state is 'withdrawn' OR tombstoned
}

export type ConsentCoverageResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      by_category: ConsentCoverageRow[];
      total_subjects: string; // bigint string — distinct subjects with any consent_record
    };

/**
 * getConsentCoverage — per-category granted/withdrawn subject counts.
 *
 * "Latest-wins" per (subject_hash, category) by effective_at (the append-only SoR
 * shape — corrections are later rows, never UPDATEs). A subject counts as withdrawn
 * if its latest record is 'withdrawn' OR a tombstone covers the category (or all).
 */
export async function getConsentCoverage(
  brandId: string,
  deps: EngineDeps,
): Promise<ConsentCoverageResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const existsResult = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM consent_record WHERE brand_id = $1) AS exists`,
        [brandId],
      );
      if (existsResult.rows[0]?.exists !== true) {
        return { state: 'no_data' };
      }

      // Latest state per (subject_hash, category) via DISTINCT ON ordered by
      // effective_at DESC (the append-only latest-wins shape). A tombstone (category
      // match OR category IS NULL = all) forces 'withdrawn' regardless of the latest
      // grant — the fail-closed retroactive-withdrawal rule (COMPLIANCE.md:106).
      const rows = await client.query<{
        category: ConsentCategory;
        granted: string;
        withdrawn: string;
      }>(
        `WITH latest AS (
           SELECT DISTINCT ON (subject_hash, category)
                  subject_hash, category, state
           FROM consent_record
           WHERE brand_id = $1
           ORDER BY subject_hash, category, effective_at DESC
         ),
         effective AS (
           SELECT l.subject_hash, l.category,
                  CASE
                    WHEN EXISTS (
                      SELECT 1 FROM consent_tombstone t
                      WHERE t.brand_id = $1
                        AND t.subject_hash = l.subject_hash
                        AND (t.category IS NULL OR t.category = l.category)
                    ) THEN 'withdrawn'
                    ELSE l.state
                  END AS eff_state
           FROM latest l
         )
         SELECT category,
                COUNT(*) FILTER (WHERE eff_state = 'granted')::text   AS granted,
                COUNT(*) FILTER (WHERE eff_state = 'withdrawn')::text AS withdrawn
         FROM effective
         GROUP BY category`,
        [brandId],
      );

      const byCategoryMap = new Map<ConsentCategory, ConsentCoverageRow>();
      for (const cat of CONSENT_CATEGORIES) {
        byCategoryMap.set(cat, { category: cat, granted: '0', withdrawn: '0' });
      }
      for (const r of rows.rows) {
        byCategoryMap.set(r.category, {
          category: r.category,
          granted: r.granted,
          withdrawn: r.withdrawn,
        });
      }

      const totalResult = await client.query<{ total: string }>(
        `SELECT COUNT(DISTINCT subject_hash)::text AS total
         FROM consent_record WHERE brand_id = $1`,
        [brandId],
      );

      return {
        state: 'has_data',
        by_category: CONSENT_CATEGORIES.map((c) => byCategoryMap.get(c)!),
        total_subjects: totalResult.rows[0]?.total ?? '0',
      };
    } catch (err) {
      // Table not migrated yet → fail-closed empty (no consent == blocked by default).
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}

// ── 2. Suppression summary ───────────────────────────────────────────────────────

export type ConsentSuppressionSummaryResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      suppressed_subjects: string; // bigint string — subjects suppressed for MARKETING
      tombstoned_subjects: string; // bigint string — subjects with any tombstone
      granted_subjects: string;    // bigint string — subjects with marketing consent granted (not tombstoned)
    };

/**
 * getConsentSuppressionSummary — the fail-closed marketing-suppression count.
 *
 * A subject is SUPPRESSED for marketing when its latest marketing consent_record is
 * not 'granted', OR a tombstone covers marketing (or all). This mirrors the
 * SuppressionQuery seam's derived-by-query rule (no separate materialized table).
 */
export async function getConsentSuppressionSummary(
  brandId: string,
  deps: EngineDeps,
): Promise<ConsentSuppressionSummaryResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const existsResult = await client.query<{ exists: boolean }>(
        `SELECT
           EXISTS(SELECT 1 FROM consent_record WHERE brand_id = $1)
           OR EXISTS(SELECT 1 FROM consent_tombstone WHERE brand_id = $1) AS exists`,
        [brandId],
      );
      if (existsResult.rows[0]?.exists !== true) {
        return { state: 'no_data' };
      }

      const result = await client.query<{
        suppressed: string;
        tombstoned: string;
        granted: string;
      }>(
        `WITH latest_marketing AS (
           SELECT DISTINCT ON (subject_hash)
                  subject_hash, state
           FROM consent_record
           WHERE brand_id = $1 AND category = 'marketing'
           ORDER BY subject_hash, effective_at DESC
         ),
         tombstoned AS (
           SELECT DISTINCT subject_hash
           FROM consent_tombstone
           WHERE brand_id = $1
             AND (category IS NULL OR category = 'marketing')
         )
         SELECT
           (SELECT COUNT(*)::text FROM tombstoned)                                  AS tombstoned,
           (SELECT COUNT(*)::text FROM latest_marketing
              WHERE state = 'granted'
                AND subject_hash NOT IN (SELECT subject_hash FROM tombstoned))      AS granted,
           (SELECT COUNT(*)::text FROM (
              SELECT subject_hash FROM latest_marketing WHERE state <> 'granted'
              UNION
              SELECT subject_hash FROM tombstoned
            ) s)                                                                     AS suppressed`,
        [brandId],
      );

      const row = result.rows[0];
      return {
        state: 'has_data',
        suppressed_subjects: row?.suppressed ?? '0',
        tombstoned_subjects: row?.tombstoned ?? '0',
        granted_subjects: row?.granted ?? '0',
      };
    } catch (err) {
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}

// ── 3. Gate activity ─────────────────────────────────────────────────────────────

/** The decision a can_contact() gate evaluation produced (mirrors CanContactResult). */
export type GateDecision = 'allow' | 'block' | 'queue_pending_window';

export interface GateActivityRow {
  decision: GateDecision;
  reason: string;          // e.g. 'consent_absent' | 'dlt_unregistered' | 'out_of_window'
  channel: string | null;  // 'marketing_email' | 'whatsapp' | … (never raw recipient)
  purpose: string | null;  // 'marketing' | 'transactional'
  occurred_at: string;     // ISO timestamp
}

export type ConsentGateActivityResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      decisions: GateActivityRow[];
      allow_count: string; // bigint string (within the returned window)
      block_count: string;
      queue_count: string;
    };

/** Bounded window for the gate-activity feed. */
const GATE_ACTIVITY_LIMIT = 50;

/**
 * getConsentGateActivity — the last-N can_contact() decisions from audit_log.
 *
 * The engine (Track B) audits every decision with action='notification.can_contact'
 * and a PII-free payload { decision, reason, channel, purpose, subject_hash }. This
 * read surfaces them so a stakeholder SEES the default-closed gate working (a
 * 'block: consent_absent' row is the proof the gate denied an un-consented send).
 *
 * audit_log is a shipped table — but the can_contact action rows only appear once
 * the engine runs, so an empty result is honest 'no_data' (the gate hasn't fired).
 */
export async function getConsentGateActivity(
  brandId: string,
  deps: EngineDeps,
): Promise<ConsentGateActivityResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const result = await client.query<{
        payload: Record<string, unknown> | null;
        created_at: Date;
      }>(
        `SELECT payload, created_at
         FROM audit_log
         WHERE brand_id = $1
           AND action = 'notification.can_contact'
         ORDER BY created_at DESC
         LIMIT $2`,
        [brandId, GATE_ACTIVITY_LIMIT],
      );

      if (result.rows.length === 0) {
        return { state: 'no_data' };
      }

      const decisions: GateActivityRow[] = [];
      let allow = 0;
      let block = 0;
      let queue = 0;

      for (const r of result.rows) {
        const p = (r.payload ?? {}) as {
          decision?: string;
          reason?: string;
          channel?: string;
          purpose?: string;
        };
        const decision = (p.decision ?? 'block') as GateDecision;
        if (decision === 'allow') allow += 1;
        else if (decision === 'queue_pending_window') queue += 1;
        else block += 1;

        decisions.push({
          decision,
          reason: p.reason ?? 'unknown',
          channel: p.channel ?? null,
          purpose: p.purpose ?? null,
          occurred_at: r.created_at.toISOString(),
        });
      }

      return {
        state: 'has_data',
        decisions,
        allow_count: String(allow),
        block_count: String(block),
        queue_count: String(queue),
      };
    } catch (err) {
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}

// ── 4. Window config (read-only — server-enforced) ──────────────────────────────

export interface ConsentWindowConfigResult {
  // The permitted-hours commercial-send window — SERVER-enforced at the queue
  // (TCCCPR/DLT, COMPLIANCE.md §2). Read-only here; NOT a UI toggle.
  timezone: string;       // 'Asia/Kolkata'
  window_start: string;   // '09:00'
  window_end: string;     // '21:00'
  // Whether the wall-clock NOW (in the window tz) is currently inside the window —
  // computed server-side so the UI never re-derives it from a client clock.
  in_window_now: boolean;
  /** ISO ts of the next 09:00 IST boundary (when a pending_window item would flush). */
  next_window_open: string;
  enforced: 'server'; // a literal marker: this is enforced server-side, not a hint.
}

const IST_TZ = 'Asia/Kolkata';
const WINDOW_START_HOUR = 9;
const WINDOW_END_HOUR = 21;

/**
 * getConsentWindowConfig — the read-only 9–9 IST window descriptor.
 *
 * Computes in_window_now + next_window_open SERVER-side (the UI must not derive the
 * window from a client clock — the window is a server guarantee, COMPLIANCE.md §2).
 * No DB read needed — this is a fixed regulatory window for the India region.
 */
export function getConsentWindowConfig(): ConsentWindowConfigResult {
  const now = new Date();

  // Current hour-of-day in IST (Asia/Kolkata) via Intl — DST-free, fixed +05:30.
  const istHourStr = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TZ,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  const istHour = Number.parseInt(istHourStr, 10);
  const inWindow = istHour >= WINDOW_START_HOUR && istHour < WINDOW_END_HOUR;

  // Next 09:00 IST boundary: today's 09:00 IST if we're before it, else tomorrow's.
  // IST is +05:30 with no DST, so 09:00 IST == 03:30 UTC.
  const nowUtcMs = now.getTime();
  const todayUtc = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z').getTime();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  // 09:00 IST today, expressed as a UTC instant.
  let nextOpen = todayUtc + WINDOW_START_HOUR * 60 * 60 * 1000 - istOffsetMs;
  // If that instant has already passed, roll to tomorrow's 09:00 IST.
  if (nextOpen <= nowUtcMs) {
    nextOpen += 24 * 60 * 60 * 1000;
  }

  return {
    timezone: IST_TZ,
    window_start: '09:00',
    window_end: '21:00',
    in_window_now: inWindow,
    next_window_open: new Date(nextOpen).toISOString(),
    enforced: 'server',
  };
}
