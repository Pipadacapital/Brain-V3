/**
 * Conversion-Feedback / CAPI read seam (Phase 6 — feat-capi-conversion-feedback, Track C).
 *
 * Three bounded, brand-scoped reads that power the stakeholder-visible Conversion-Feedback
 * surface (/analytics/conversion-feedback). All read ONLY through the BFF → this use-case →
 * the CAPI passback system-of-record (capi_passback_log + capi_deletion_log, migration 0034)
 * inside withBrandTxn (the GUC is set per-transaction; RLS-enforced, NON-INERT under
 * brain_app — superuser `brain` BYPASSES, so these reads prove isolation only under the app
 * role; MEMORY: dev-db-superuser-masks-rls).
 *
 *   getCapiFeedbackSummary   — passed-back vs BLOCKED-BY-CONSENT counts (the SLO=0 made
 *                              VISIBLE), deletion count, match-quality proxy, and whether
 *                              any row is the dev-boundary 'would_send_dev' (no live creds).
 *   getCapiFeedbackEvents    — the last-N passback log rows (event_id short, status, value
 *                              minor+currency, match_key_count, occurred_at) — NO raw PII.
 *   getCapiFeedbackDeletions — the last-N retroactive-deletion requests (status, event_count,
 *                              requested/completed timestamps, latency seconds).
 *
 * PII POSTURE (I-S02 / COMPLIANCE.md): these reads surface COUNTS + a TRUNCATED event_id
 * (a deterministic sha256 — never PII) + decision metadata ONLY. The subject_hash is NOT
 * returned (the consent key never leaves the query); raw email/phone NEVER existed in these
 * tables (Meta-match hashes are computed transiently at the send boundary, never stored —
 * architecture §3.2). Money is BIGINT minor units + currency_code (I-S07) — display
 * formatting (minor→major) happens in the web layer, never here.
 *
 * DEV-HONESTY (the dev boundary, made explicit): in dev there are no live Meta CAPI
 * credentials, so a granted+matched conversion writes status='would_send_dev' (matched &
 * gated, but NOT sent — a real send is a platform follow-up). The summary's `would_send_dev`
 * count + the `dev_boundary` flag let the UI render an honest "would-send in dev" banner.
 * A 'sent' status only ever appears with live prod creds — never faked.
 *
 * FAIL-CLOSED + RESILIENT-TO-PARALLEL-BUILD: capi_passback_log / capi_deletion_log are landed
 * by the parallel Track A migration (0034). Until that migration runs in a given environment,
 * the relation does not exist (Postgres 42P01 undefined_table). The honest degradation is
 * state:'no_data' (NOT an error, NOT a fabricated count) — the surface still tells the truth
 * (nothing passed back yet). This mirrors get-consent-compliance.ts exactly.
 *
 * F-SEC-02: every read runs inside withBrandTxn. D-2: bounded operational reads (not a metric
 * computation) — no ad-hoc money SUM that the metric-registry owns; the value_minor returned
 * is the per-event ledger amount already persisted on the passback row.
 */

import type { EngineDeps } from '@brain/metric-engine';
import { withBrandTxn } from '@brain/metric-engine';

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

/** Bounded windows for the feed reads. */
const EVENTS_LIMIT = 50;
const DELETIONS_LIMIT = 50;

/** The passback log statuses (mirrors the 0034 CHECK constraint). */
export type CapiPassbackStatus =
  | 'sent'
  | 'blocked_no_consent'
  | 'would_send_dev'
  | 'deleted'
  | 'failed';

/** The deletion log statuses (mirrors the 0034 CHECK constraint). */
export type CapiDeletionStatus = 'requested' | 'deleted' | 'would_delete_dev' | 'failed';

// ── 1. Summary ───────────────────────────────────────────────────────────────────

export type CapiFeedbackSummaryResult =
  | { state: 'no_data' }
  | {
      state: 'has_data';
      platform: 'meta';
      /** sent + would_send_dev (matched & gated through; "passed back" to the platform). */
      passed_back: string; // bigint string
      /** status='sent' only — a REAL live send (0 in dev; never faked). */
      sent: string; // bigint string
      /** status='would_send_dev' — matched & gated but not sent (no live creds). */
      would_send_dev: string; // bigint string
      /** status='blocked_no_consent' — the SLO=0 (non_consented_sends) made VISIBLE. */
      blocked_by_consent: string; // bigint string
      /** status='deleted' — passback rows superseded by a retroactive deletion. */
      deleted: string; // bigint string
      /** status='failed' — a real send error (prod only). */
      failed: string; // bigint string
      /** capi_deletion_log row count (retroactive-deletion requests). */
      deletion_requests: string; // bigint string
      /** Avg match_key_count across passed-back rows, as a 0–4 integer-basis-point share. */
      match_quality_pct: number | null; // 0..100, two-dp; null when nothing passed back
      avg_match_keys: number | null; // 0..4, one-dp; null when nothing passed back
      /** TRUE when ANY row is 'would_send_dev' — drives the dev-boundary banner. */
      dev_boundary: boolean;
    };

/**
 * getCapiFeedbackSummary — the headline counts for the Conversion-Feedback surface.
 *
 * `blocked_by_consent` is the SLO=0 (non_consented_sends) made visible: every conversion
 * a non-consented subject would have generated shows up here as a BLOCK, never a send.
 * `would_send_dev` + `dev_boundary` surface the honest dev posture (matched, gated, but
 * not sent — no live Meta creds). Match quality is the avg fraction of the 4 Meta match
 * keys (em, ph, fbc, fbp) present per passed-back event.
 */
export async function getCapiFeedbackSummary(
  brandId: string,
  deps: EngineDeps,
): Promise<CapiFeedbackSummaryResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const existsResult = await client.query<{ exists: boolean }>(
        `SELECT
           EXISTS(SELECT 1 FROM capi_passback_log WHERE brand_id = $1)
           OR EXISTS(SELECT 1 FROM capi_deletion_log WHERE brand_id = $1) AS exists`,
        [brandId],
      );
      if (existsResult.rows[0]?.exists !== true) {
        return { state: 'no_data' };
      }

      const passback = await client.query<{
        sent: string;
        would_send_dev: string;
        blocked: string;
        deleted: string;
        failed: string;
        avg_match: string | null; // numeric avg of match_key_count over passed-back rows
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'sent')::text               AS sent,
           COUNT(*) FILTER (WHERE status = 'would_send_dev')::text     AS would_send_dev,
           COUNT(*) FILTER (WHERE status = 'blocked_no_consent')::text AS blocked,
           COUNT(*) FILTER (WHERE status = 'deleted')::text            AS deleted,
           COUNT(*) FILTER (WHERE status = 'failed')::text             AS failed,
           AVG(match_key_count) FILTER (WHERE status IN ('sent','would_send_dev'))::text AS avg_match
         FROM capi_passback_log
         WHERE brand_id = $1`,
        [brandId],
      );

      const deletions = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM capi_deletion_log WHERE brand_id = $1`,
        [brandId],
      );

      const p = passback.rows[0];
      const sent = p?.sent ?? '0';
      const wouldSendDev = p?.would_send_dev ?? '0';
      const blocked = p?.blocked ?? '0';
      const deleted = p?.deleted ?? '0';
      const failed = p?.failed ?? '0';

      // passed_back = sent + would_send_dev (BigInt — never float arithmetic on counts).
      const passedBack = (BigInt(sent) + BigInt(wouldSendDev)).toString();

      // Match quality: avg_match is 0..4 (the four Meta match keys em/ph/fbc/fbp). null when
      // nothing passed back. match_quality_pct = avg / 4 * 100 (display-only ratio, two-dp).
      const avgMatchRaw = p?.avg_match;
      const avgMatchKeys =
        avgMatchRaw != null ? Math.round(Number(avgMatchRaw) * 10) / 10 : null;
      const matchQualityPct =
        avgMatchRaw != null ? Math.round((Number(avgMatchRaw) / 4) * 100 * 100) / 100 : null;

      return {
        state: 'has_data',
        platform: 'meta',
        passed_back: passedBack,
        sent,
        would_send_dev: wouldSendDev,
        blocked_by_consent: blocked,
        deleted,
        failed,
        deletion_requests: deletions.rows[0]?.count ?? '0',
        match_quality_pct: matchQualityPct,
        avg_match_keys: avgMatchKeys,
        dev_boundary: BigInt(wouldSendDev) > 0n,
      };
    } catch (err) {
      // Table not migrated yet → honest 'no_data' (nothing passed back).
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}

// ── 2. Events ──────────────────────────────────────────────────────────────────

export interface CapiFeedbackEventRow {
  /** First 12 hex chars of the deterministic event_id (sha256 — NEVER PII). */
  event_id_short: string;
  status: CapiPassbackStatus;
  /** can_contact() reason when status='blocked_no_consent' (e.g. 'consent_absent'). */
  block_reason: string | null;
  /** 0..4 — count of Meta match keys present (em/ph/fbc/fbp); the match-quality proxy. */
  match_key_count: number;
  value_minor: string; // bigint string (I-S07) — formatted minor→major in the web layer
  currency_code: string; // CHAR(3) — 'INR' | 'AED' | 'SAR'
  occurred_at: string; // ISO timestamp (the order occurred_at / event_time)
  recorded_at: string; // ISO timestamp (when the passback decision was logged)
}

export type CapiFeedbackEventsResult =
  | { state: 'no_data' }
  | { state: 'has_data'; events: CapiFeedbackEventRow[] };

/**
 * getCapiFeedbackEvents — the last-N passback log rows (default-closed proof + dev boundary).
 *
 * A 'blocked_no_consent' row is the proof the gate denied a non-consented passback (SLO=0
 * made visible); a 'would_send_dev' row is the honest dev boundary. NO raw PII, NO full
 * subject_hash, NO full event_id — only a truncated event_id for display/dedup citation.
 */
export async function getCapiFeedbackEvents(
  brandId: string,
  deps: EngineDeps,
): Promise<CapiFeedbackEventsResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const result = await client.query<{
        event_id: string;
        status: CapiPassbackStatus;
        block_reason: string | null;
        match_key_count: number;
        value_minor: string;
        currency_code: string;
        occurred_at: Date;
        recorded_at: Date;
      }>(
        `SELECT event_id, status, block_reason, match_key_count,
                value_minor::text AS value_minor, currency_code,
                occurred_at, recorded_at
         FROM capi_passback_log
         WHERE brand_id = $1
         ORDER BY recorded_at DESC
         LIMIT $2`,
        [brandId, EVENTS_LIMIT],
      );

      if (result.rows.length === 0) {
        return { state: 'no_data' };
      }

      const events: CapiFeedbackEventRow[] = result.rows.map((r) => ({
        event_id_short: (r.event_id ?? '').slice(0, 12),
        status: r.status,
        block_reason: r.block_reason ?? null,
        match_key_count: Number(r.match_key_count ?? 0),
        value_minor: r.value_minor ?? '0',
        currency_code: r.currency_code ?? 'INR',
        occurred_at: r.occurred_at.toISOString(),
        recorded_at: r.recorded_at.toISOString(),
      }));

      return { state: 'has_data', events };
    } catch (err) {
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}

// ── 3. Deletions ─────────────────────────────────────────────────────────────────

export interface CapiFeedbackDeletionRow {
  status: CapiDeletionStatus;
  /** How many prior passback events were targeted by this deletion. */
  event_count: number;
  requested_at: string; // ISO timestamp
  completed_at: string | null; // ISO timestamp; null until completed
  /** Seconds between requested_at and completed_at (the deletion latency); null if pending. */
  latency_seconds: number | null;
}

export type CapiFeedbackDeletionsResult =
  | { state: 'no_data' }
  | { state: 'has_data'; deletions: CapiFeedbackDeletionRow[] };

/**
 * getCapiFeedbackDeletions — the last-N retroactive-deletion requests.
 *
 * On a consent withdrawal (a consent_tombstone for the 'advertising' category, or all),
 * the CapiDeletionConsumer (stream-worker, Track A) writes a capi_deletion_log row within
 * the ≤15-min SLA. This read surfaces those requests so a stakeholder SEES the
 * retroactive-deletion path working. NO subject_hash returned (the withdrawn subject's
 * consent key never leaves the query). In dev, status='would_delete_dev' (no live creds).
 */
export async function getCapiFeedbackDeletions(
  brandId: string,
  deps: EngineDeps,
): Promise<CapiFeedbackDeletionsResult> {
  return withBrandTxn(deps.pool, brandId, async (client) => {
    try {
      const result = await client.query<{
        status: CapiDeletionStatus;
        event_count: number;
        requested_at: Date;
        completed_at: Date | null;
      }>(
        `SELECT status, event_count, requested_at, completed_at
         FROM capi_deletion_log
         WHERE brand_id = $1
         ORDER BY requested_at DESC
         LIMIT $2`,
        [brandId, DELETIONS_LIMIT],
      );

      if (result.rows.length === 0) {
        return { state: 'no_data' };
      }

      const deletions: CapiFeedbackDeletionRow[] = result.rows.map((r) => {
        const requestedAt = r.requested_at;
        const completedAt = r.completed_at ?? null;
        const latencySeconds =
          completedAt != null
            ? Math.max(0, Math.round((completedAt.getTime() - requestedAt.getTime()) / 1000))
            : null;
        return {
          status: r.status,
          event_count: Number(r.event_count ?? 0),
          requested_at: requestedAt.toISOString(),
          completed_at: completedAt != null ? completedAt.toISOString() : null,
          latency_seconds: latencySeconds,
        };
      });

      return { state: 'has_data', deletions };
    } catch (err) {
      if (isUndefinedTable(err)) return { state: 'no_data' };
      throw err;
    }
  });
}
