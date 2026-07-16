/**
 * rtbf-drill.ts — AUD-OPS-040: the live end-to-end RTBF/DPDP erasure drill harness.
 *
 * WHAT (the audit's assertion list, executed against a LIVE stack on a SYNTHETIC subject):
 *   1. SEED    — synthetic subject (pixel identify → collector → Bronze → identity graph).
 *   2. TRIGGER — RTBF via the consent-withdraw entry point (POST /api/v1/consent/withdraw,
 *                reason='erasure') — the AUD-OPS-036 bridge publishes privacy.erasure.requested
 *                and the stream-worker erasure orchestrator drives the full ordered sequence.
 *   3. ASSERT  — poll until ALL hold (or deadline):
 *                • Neo4j: Customer lifecycle_state='erased', IDENTIFIES edges inactive
 *                • PG:    tenancy.subject_keyring is_active=FALSE (DEK shred — the AUD-OPS-040
 *                         DEK-shred-in-prod HYPOTHESIS is proven exactly here)
 *                • PG:    identity.pii_erasure_log vault_shredded + completed_at + surrogate
 *                • PG:    contact_pii rows = 0
 *                • Bronze: rows matching the subject (hash / anon_id) = 0, read over the
 *                         duckdb-serving HTTP API (iceberg catalog)
 *   4. EVIDENCE — write a JSON evidence file (counts + timestamps + hash prefixes, no raw PII
 *                beyond the synthetic address) for the compliance record.
 *
 * AUD-TP-22 (cache invalidation) evidence: capture the stream-worker log line
 *   `[erasure-orchestrator] erased ... cache_invalidated=true` for the drill's brand/event —
 * Redis eviction is consumer-side fire-and-forget, so the log line + the
 * AnalyticsCacheInvalidateConsumer `evicted brand=...` line are the drill artifacts.
 *
 * ── SAFETY GATES (this script can DELETE data — it must never run by accident) ──────────
 *   • RTBF_DRILL=1                                  — explicit opt-in flag
 *   • RTBF_DRILL_CONFIRM=ERASE-SYNTHETIC-SUBJECT    — typed confirmation phrase
 *   • The subject is ALWAYS synthetic: the harness GENERATES rtbf-drill+<uuid>@rtbf-drill.invalid
 *     and refuses any operator-supplied subject that does not match that shape — it is
 *     structurally impossible to point this harness at a real person.
 *   • Brand comes from RTBF_DRILL_BRAND_ID (an operator-designated drill brand); every query
 *     in this file is brand_id-first.
 *   DO NOT run against prod until the DPDP drill is scheduled with the owner; nothing in the
 *   repo invokes this script — it is operator-run only.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────────────────
 *   RTBF_DRILL=1 RTBF_DRILL_CONFIRM=ERASE-SYNTHETIC-SUBJECT \
 *   RTBF_DRILL_BRAND_ID=<uuid> \
 *   COLLECTOR_URL=http://localhost:8787 CORE_API_URL=http://localhost:3001 \
 *   CORE_SESSION_COOKIE='brain_session=…' \
 *   DATABASE_URL=postgres://… NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=… \
 *   DUCKDB_SERVING_URL=http://localhost:8091 \
 *   pnpm --filter @brain/tool-privacy drill
 *
 * Optional: RTBF_DRILL_SEED=skip + RTBF_DRILL_SUBJECT_EMAIL=rtbf-drill+…@rtbf-drill.invalid
 *   (subject pre-seeded by the operator, e.g. via a real storefront pixel); the synthetic-shape
 *   guard still applies. RTBF_DRILL_IDENTITY_SETTLE_S (default 60) — seed → trigger wait for the
 *   identity bridge to mint the brain_id (an unlinked subject makes the orchestrator skip as
 *   no_brain_id, which the drill reports as a clear failure). RTBF_DRILL_TIMEOUT_S (default 900)
 *   — Bronze DELETE is async (Argo workflow + the PyIceberg erasure job), so the deadline is generous.
 *   RTBF_DRILL_STRICT=1 — raw-email Bronze residual becomes FATAL (default: WARN; the payload-path
 *   sweep matches pre-hashed identifier paths + raw anon/device ids, NOT raw-email text — rows
 *   carrying only the raw email age out via raw-lane retention).
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import neo4j from 'neo4j-driver';

// ── Env / gates ────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC_EMAIL_RE = /^rtbf-drill\+[A-Za-z0-9-]+@rtbf-drill\.invalid$/;
const CONFIRM_PHRASE = 'ERASE-SYNTHETIC-SUBJECT';

function fail(msg: string): never {
  console.error(`\n[rtbf-drill] FATAL: ${msg}\n`);
  process.exit(1);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function requireEnv(name: string, why: string): string {
  const v = env(name);
  if (!v) fail(`missing env ${name} — ${why}`);
  return v;
}

if (env('RTBF_DRILL') !== '1') {
  fail('RTBF_DRILL=1 not set. This harness erases (synthetic) data — explicit opt-in required.');
}
if (env('RTBF_DRILL_CONFIRM') !== CONFIRM_PHRASE) {
  fail(`RTBF_DRILL_CONFIRM must be the exact phrase "${CONFIRM_PHRASE}".`);
}

const BRAND_ID = requireEnv('RTBF_DRILL_BRAND_ID', 'the operator-designated drill brand (uuid)');
if (!UUID_RE.test(BRAND_ID)) fail('RTBF_DRILL_BRAND_ID is not a UUID');

const COLLECTOR_URL = env('COLLECTOR_URL');
const CORE_API_URL = requireEnv('CORE_API_URL', 'core BFF origin for the consent-withdraw trigger');
const CORE_SESSION_COOKIE = requireEnv(
  'CORE_SESSION_COOKIE',
  'authenticated session Cookie header value for the drill-brand operator',
);
const DATABASE_URL = requireEnv('DATABASE_URL', 'PG (ops) for keyring/erasure-log/contact_pii asserts');
const NEO4J_URI = requireEnv('NEO4J_URI', 'identity graph asserts');
const NEO4J_USER = requireEnv('NEO4J_USER', 'identity graph asserts');
const NEO4J_PASSWORD = requireEnv('NEO4J_PASSWORD', 'identity graph asserts');
const DUCKDB_SERVING_URL = requireEnv(
  'DUCKDB_SERVING_URL',
  'Bronze-row asserts over the duckdb-serving HTTP API (iceberg catalog)',
);

const SEED_MODE = env('RTBF_DRILL_SEED') ?? 'pixel'; // 'pixel' | 'skip'
const IDENTITY_SETTLE_S = Number(env('RTBF_DRILL_IDENTITY_SETTLE_S') ?? '60');
const TIMEOUT_S = Number(env('RTBF_DRILL_TIMEOUT_S') ?? '900');
const STRICT = env('RTBF_DRILL_STRICT') === '1';
const EVIDENCE_PATH =
  env('RTBF_DRILL_EVIDENCE') ?? `rtbf-drill-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

// ── Synthetic subject (structurally impossible to target a real person) ────────

let subjectEmail: string;
if (SEED_MODE === 'skip') {
  subjectEmail = requireEnv(
    'RTBF_DRILL_SUBJECT_EMAIL',
    'RTBF_DRILL_SEED=skip requires the pre-seeded synthetic subject email',
  );
} else if (SEED_MODE === 'pixel') {
  subjectEmail = `rtbf-drill+${randomUUID()}@rtbf-drill.invalid`;
} else {
  fail(`RTBF_DRILL_SEED must be 'pixel' or 'skip' (got '${SEED_MODE}')`);
}
if (!SYNTHETIC_EMAIL_RE.test(subjectEmail)) {
  fail(
    `subject '${subjectEmail}' is not a synthetic drill address ` +
    `(must match rtbf-drill+…@rtbf-drill.invalid) — this harness never erases real subjects`,
  );
}
const anonId = `rtbf-drill-anon-${randomUUID()}`;

// ── Small helpers ──────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
function log(msg: string): void {
  console.log(`[rtbf-drill] ${nowIso()} ${msg}`);
}

/** Minimal duckdb-serving client (single POST /v1/query, no polling) — read-only queries. */
async function servingQuery(sql: string): Promise<unknown[][]> {
  const res = await fetch(`${DUCKDB_SERVING_URL}/v1/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: unknown[][];
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(`duckdb-serving HTTP ${res.status}: ${body.error?.message ?? 'unknown error'}`);
  }
  if (body.error) throw new Error(`duckdb-serving: ${body.error.message}`);
  return body.data ?? [];
}

/** Single-quote-escape for the (drill-generated, shape-validated) literals in serving SQL. */
function sq(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function bronzeCount(likeNeedle: string): Promise<number> {
  const rows = await servingQuery(
    `SELECT count(*) FROM iceberg.brain_bronze.collector_events_connect ` +
    `WHERE json_extract_string(payload, '$.brand_id') = ${sq(BRAND_ID)} ` +
    `AND payload LIKE ${sq(`%${likeNeedle}%`)}`,
  );
  return Number(rows[0]?.[0] ?? 0);
}

// ── Check framework ────────────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  pass: boolean;
  fatal: boolean;
  detail: string;
}

interface DrillContext {
  subjectHash?: string;
  brainId?: string;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`brand=${BRAND_ID} subject=${subjectEmail} seed=${SEED_MODE} strict=${STRICT}`);

  const pgPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const ctx: DrillContext = {};
  const evidence: Record<string, unknown> = {
    drill: 'rtbf-e2e (AUD-OPS-040)',
    started_at: nowIso(),
    brand_id: BRAND_ID,
    subject_email: subjectEmail, // synthetic by construction — safe to record
    anon_id: anonId,
    seed_mode: SEED_MODE,
    strict: STRICT,
  };

  try {
    // ── 1. SEED ────────────────────────────────────────────────────────────────
    if (SEED_MODE === 'pixel') {
      if (!COLLECTOR_URL) fail('COLLECTOR_URL required for RTBF_DRILL_SEED=pixel');
      const eventId = randomUUID();
      const seedEvent = {
        schema_version: '1',
        event_id: eventId,
        brand_id: BRAND_ID,
        event_name: 'identify',
        occurred_at: nowIso(),
        consent_flags: { analytics: true, marketing: true, personalization: true, ai_processing: true },
        properties: { email: subjectEmail, brain_anon_id: anonId, source: 'rtbf-drill' },
      };
      const res = await fetch(`${COLLECTOR_URL}/v1/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(seedEvent),
      });
      if (!res.ok) fail(`collector seed failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      evidence['seed_event_id'] = eventId;
      log(`seeded identify event ${eventId} → collector`);

      // Bronze landing proof (the "row existed before erasure" half of the Bronze assertion).
      const seedDeadline = Date.now() + TIMEOUT_S * 1000;
      let bronzeSeedCount = 0;
      while (Date.now() < seedDeadline) {
        bronzeSeedCount = await bronzeCount(anonId);
        if (bronzeSeedCount > 0) break;
        await sleep(10_000);
      }
      if (bronzeSeedCount === 0) fail('seed event never appeared in Bronze (collector_events_connect)');
      evidence['bronze_rows_before_erasure'] = bronzeSeedCount;
      log(`Bronze landed (${bronzeSeedCount} row[s]) — waiting ${IDENTITY_SETTLE_S}s for identity bridge`);
      await sleep(IDENTITY_SETTLE_S * 1000);
    } else {
      log('seed skipped (operator pre-seeded subject)');
    }

    // ── 2. TRIGGER — consent-withdraw entry point, reason='erasure' ───────────
    const idempotencyKey = randomUUID();
    const trig = await fetch(`${CORE_API_URL}/api/v1/consent/withdraw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: CORE_SESSION_COOKIE,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        recipient: subjectEmail,
        channel: 'marketing_email',
        category: null,
        reason: 'erasure',
      }),
    });
    const trigBody = (await trig.json().catch(() => ({}))) as Record<string, unknown>;
    if (trig.status !== 201) {
      fail(`erasure trigger failed: HTTP ${trig.status} ${JSON.stringify(trigBody).slice(0, 300)}`);
    }
    const subjectHash = typeof trigBody['subject_hash'] === 'string' ? trigBody['subject_hash'] : undefined;
    if (!subjectHash) fail('withdraw response carried no subject_hash — cannot key the assertions');
    ctx.subjectHash = subjectHash;
    evidence['trigger'] = {
      entry_point: 'consent.withdraw',
      idempotency_key: idempotencyKey,
      subject_hash_prefix: subjectHash.slice(0, 12),
      at: nowIso(),
    };
    log(`erasure triggered (subject_hash prefix ${subjectHash.slice(0, 12)}…)`);

    // ── 3. ASSERT loop ─────────────────────────────────────────────────────────
    const checks: Array<(c: DrillContext) => Promise<CheckResult>> = [
      // Neo4j: lifecycle erased + edges tombstoned (also resolves brain_id for the PG checks).
      async (c) => {
        const s = driver.session({ defaultAccessMode: neo4j.session.READ });
        try {
          const res = await s.run(
            `MATCH (i:Identifier {brand_id:$b, hash:$h})-[r:IDENTIFIES]->(cust:Customer)
             RETURN cust.brain_id AS brain_id, cust.lifecycle_state AS state, r.is_active AS active`,
            { b: BRAND_ID, h: c.subjectHash },
          );
          if (res.records.length === 0) {
            return {
              name: 'neo4j_lifecycle_erased', pass: false, fatal: true,
              detail: 'subject hash not in graph — identity bridge never linked it (increase RTBF_DRILL_IDENTITY_SETTLE_S?)',
            };
          }
          c.brainId = res.records[0]!.get('brain_id') as string;
          const allErased = res.records.every(
            (r) => r.get('state') === 'erased' && r.get('active') !== true,
          );
          return {
            name: 'neo4j_lifecycle_erased', pass: allErased, fatal: true,
            detail: `links=${res.records.length} states=${[...new Set(res.records.map((r) => r.get('state')))].join(',')}`,
          };
        } finally {
          await s.close();
        }
      },
      // PG: DEK shred (THE AUD-OPS-040 hypothesis — subject_keyring is_active=FALSE).
      async (c) => {
        if (!c.brainId) return { name: 'pg_keyring_shredded', pass: false, fatal: true, detail: 'no brain_id yet' };
        const r = await pgPool.query(
          `SELECT count(*)::int AS active FROM tenancy.subject_keyring
           WHERE brand_id = $1 AND brain_id = $2 AND is_active = TRUE`,
          [BRAND_ID, c.brainId],
        );
        const active = Number(r.rows[0]?.active ?? 0);
        return {
          name: 'pg_keyring_shredded', pass: active === 0, fatal: true,
          detail: `active_keyring_rows=${active}`,
        };
      },
      // PG: erasure audit record completed.
      async (c) => {
        if (!c.brainId) return { name: 'pg_erasure_log_completed', pass: false, fatal: true, detail: 'no brain_id yet' };
        const r = await pgPool.query(
          `SELECT count(*)::int AS done FROM identity.pii_erasure_log
           WHERE brand_id = $1 AND brain_id = $2
             AND vault_shredded = TRUE AND completed_at IS NOT NULL AND surrogate_brain_id IS NOT NULL`,
          [BRAND_ID, c.brainId],
        );
        const done = Number(r.rows[0]?.done ?? 0);
        return { name: 'pg_erasure_log_completed', pass: done > 0, fatal: true, detail: `completed_rows=${done}` };
      },
      // PG: contact_pii hard-deleted.
      async (c) => {
        if (!c.brainId) return { name: 'pg_contact_pii_zero', pass: false, fatal: true, detail: 'no brain_id yet' };
        const r = await pgPool.query(
          `SELECT count(*)::int AS n FROM contact_pii WHERE brand_id = $1 AND brain_id = $2`,
          [BRAND_ID, c.brainId],
        );
        const n = Number(r.rows[0]?.n ?? 0);
        return { name: 'pg_contact_pii_zero', pass: n === 0, fatal: true, detail: `contact_pii_rows=${n}` };
      },
      // Bronze: subject-keyed rows gone (anon id + identifier hash — the predicates the
      // payload-path sweep actually matches). Async (Argo → PyIceberg DELETE) — this is the slow one.
      async (c) => {
        const byAnon = await bronzeCount(anonId);
        const byHash = c.subjectHash ? await bronzeCount(c.subjectHash) : 0;
        return {
          name: 'bronze_subject_rows_zero', pass: byAnon === 0 && byHash === 0, fatal: true,
          detail: `rows_by_anon_id=${byAnon} rows_by_hash=${byHash}`,
        };
      },
      // Bronze: raw-email residual (WARN unless STRICT — see header).
      async () => {
        const byEmail = await bronzeCount(subjectEmail);
        return {
          name: 'bronze_raw_email_residual', pass: byEmail === 0, fatal: STRICT,
          detail: `rows_by_raw_email=${byEmail}` + (byEmail > 0 && !STRICT ? ' (non-fatal: ages out via raw-lane retention)' : ''),
        };
      },
    ];

    const deadline = Date.now() + TIMEOUT_S * 1000;
    let results: CheckResult[] = [];
    for (;;) {
      results = [];
      for (const check of checks) {
        try {
          results.push(await check(ctx));
        } catch (err) {
          results.push({
            name: 'check_error', pass: false, fatal: true,
            detail: String(err).slice(0, 300),
          });
        }
      }
      const blocking = results.filter((r) => !r.pass && r.fatal);
      log(results.map((r) => `${r.pass ? 'PASS' : 'PEND'} ${r.name} (${r.detail})`).join(' | '));
      if (blocking.length === 0) break;
      if (Date.now() >= deadline) {
        evidence['result'] = 'FAIL';
        evidence['checks'] = results;
        evidence['finished_at'] = nowIso();
        writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
        fail(
          `deadline (${TIMEOUT_S}s) reached with failing checks: ` +
          blocking.map((r) => `${r.name} [${r.detail}]`).join('; ') +
          ` — evidence written to ${EVIDENCE_PATH}`,
        );
      }
      await sleep(15_000);
    }

    // ── 4. EVIDENCE ────────────────────────────────────────────────────────────
    evidence['result'] = 'PASS';
    evidence['brain_id'] = ctx.brainId;
    evidence['checks'] = results;
    evidence['finished_at'] = nowIso();
    evidence['operator_todo'] = [
      'Attach the stream-worker log line: [erasure-orchestrator] erased … cache_invalidated=true (AUD-TP-22)',
      'Attach the bronze-raw-erasure Argo Workflow name + succeeded status (AUD-OPS-037)',
      'Note: physical Bronze completion follows bronze-maintenance snapshot expiry (D4 posture)',
    ];
    writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    log(`DRILL PASSED — evidence written to ${EVIDENCE_PATH}`);
  } finally {
    await pgPool.end().catch(() => undefined);
    await driver.close().catch(() => undefined);
  }
}

main().catch((err) => fail(String(err)));
