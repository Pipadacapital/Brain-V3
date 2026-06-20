/**
 * secdef-guard.test.ts — P2.1: structural enforcement for every SECURITY DEFINER function.
 *
 * A SECURITY DEFINER function runs with the privileges of its OWNER (here: the superuser `brain`),
 * which is exactly how our cross-tenant enumeration/claim/resolve helpers bypass FORCE RLS by
 * design. That power has one classic failure mode: if such a function does NOT pin its search_path,
 * an attacker who can create objects in a schema earlier on the resolved search_path (e.g. a
 * per-session temp schema) can SHADOW a built-in/table reference and have it execute with the
 * definer's privileges — privilege escalation (CVE-class: "search_path hijack").
 *
 * Per-migration `DO $$ ... $$` assertions catch this only for the functions that REMEMBER to add
 * them. This sweep is the backstop: it enumerates EVERY SECURITY DEFINER function in `public` from
 * the live catalog and fails if ANY of them (a) does not pin search_path, or (b) is owned by a role
 * that is NOT the intended superuser definer. A new function added without `SET search_path` fails
 * CI here regardless of whether its author copied the per-migration guard.
 *
 * Why a guard and not a one-time review: the audit's concern was "14 unverified SECURITY DEFINER
 * functions." A review goes stale the next time someone adds one. This invariant does not.
 *
 * The current inventory (all verified PINNED at the time of writing) and WHY each is SECURITY
 * DEFINER (i.e. legitimately crosses tenants / runs pre-auth):
 *   • list_active_brand_ids, claim_due_repull_connectors, list_*_connectors_for_*_repull,
 *     list_connectors_for_repull, list_queued_backfill_jobs, list_shopflo_connectors
 *       → system jobs enumerate/claim ACROSS brands; each returns only routing columns
 *         (connector id, brand_id, provider, secret_ref ARN — never a secret VALUE).
 *   • resolve_*_by_* (shop_domain / install_token / merchant / account)
 *       → inbound webhooks/installs resolve the owning brand BEFORE any brand GUC exists.
 *   • provision_workspace_and_brand, find_invite_for_acceptance, find_session_for_rotation
 *       → auth/onboarding paths that run before a brand context is established.
 *   • issue_invoice, issue_credit_note, erase_customer, admin_unmerge_customer,
 *     resolve_merge_review
 *       → privileged ledger/identity mutations whose own bodies enforce the brand scope.
 * If you add a SECURITY DEFINER function, it MUST pin search_path=public and be owned by the
 * superuser definer — and you should extend the note above so the inventory stays auditable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const ADMIN_DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
// The role that SECURITY DEFINER helpers are expected to be owned by (the superuser definer that
// legitimately bypasses FORCE RLS). Override if the deploy uses a different owner.
const EXPECTED_DEFINER = process.env['BRAIN_SECDEF_OWNER'] ?? 'brain';

interface RawClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function open(dsn: string): Promise<RawClient | null> {
  try {
    const { default: pg } = (await import('pg')) as unknown as { default: { Client: new (c: unknown) => RawClient } };
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 5000 });
    await (client as unknown as { connect: () => Promise<void> }).connect();
    return client;
  } catch {
    return null;
  }
}

interface SecDefRow {
  proname: string;
  owner: string;
  config: string | null;
}

let admin: RawClient | null = null;
let rows: SecDefRow[] = [];
let ready = false;

beforeAll(async () => {
  admin = await open(ADMIN_DSN);
  if (!admin) return;
  const res = await admin.query(`
    SELECT p.proname,
           pg_get_userbyid(p.proowner) AS owner,
           array_to_string(p.proconfig, ', ') AS config
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef = true
     ORDER BY p.proname`);
  rows = res.rows as SecDefRow[];
  ready = true;
});

afterAll(async () => {
  await admin?.end?.();
});

describe('SECURITY DEFINER guard (P2.1, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!ready) console.warn('[secdef-guard] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('there is at least one SECURITY DEFINER function to guard (sanity: the sweep actually ran)', () => {
    if (!ready) return;
    // If this is ever 0, the introspection query silently matched nothing — the guard would be a
    // no-op that always passes. Fail loudly instead.
    expect(rows.length).toBeGreaterThan(0);
  });

  it('EVERY SECURITY DEFINER function pins search_path (anti-hijack, privilege-escalation guard)', () => {
    if (!ready) return;
    const unpinned = rows.filter((r) => !r.config || !/search_path=/.test(r.config));
    expect(
      unpinned.map((r) => r.proname),
      `SECURITY DEFINER functions WITHOUT a pinned search_path (escalation risk): ${unpinned
        .map((r) => r.proname)
        .join(', ')}. Add "SET search_path = public" to each.`,
    ).toEqual([]);
  });

  it('EVERY SECURITY DEFINER function pins search_path to exactly public (no mutable/extra schemas)', () => {
    if (!ready) return;
    // A pinned-but-permissive search_path (e.g. "$user, public") reopens the hole. Require exactly public.
    const loose = rows.filter((r) => r.config && /search_path=/.test(r.config) && !/search_path=public(,|$)/.test(r.config));
    expect(
      loose.map((r) => `${r.proname} [${r.config}]`),
      'SECURITY DEFINER functions whose search_path is pinned but not exactly "public"',
    ).toEqual([]);
  });

  it('EVERY SECURITY DEFINER function is owned by the intended superuser definer', () => {
    if (!ready) return;
    // Ownership determines WHOSE privileges the body runs with. An unexpected owner either silently
    // fails to bypass RLS (broken system job) or runs with the wrong authority.
    const wrongOwner = rows.filter((r) => r.owner !== EXPECTED_DEFINER);
    expect(
      wrongOwner.map((r) => `${r.proname} owned by ${r.owner}`),
      `Expected all SECURITY DEFINER functions owned by "${EXPECTED_DEFINER}".`,
    ).toEqual([]);
  });
});
