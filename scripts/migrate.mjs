#!/usr/bin/env node
/**
 * migrate.mjs — node-pg-migrate entrypoint that stamps the environment into the DB session.
 *
 * DEV-TOKEN-REACH: dev-only migrations (e.g. 0024_dev_secret) guard themselves with
 *   IF current_setting('app.env', true) = 'production' THEN RAISE EXCEPTION ...
 * For that guard to be non-inert, the migration session must actually carry `app.env`. node-pg
 * (used by node-pg-migrate) honours the libpq PGOPTIONS env var even when connecting via a
 * connection string, so we inject `-c app.env=<env>` here. Verified: PGOPTIONS → current_setting.
 *
 * env precedence: APP_ENV → NODE_ENV → 'development'. DATABASE_URL is left to the caller (unchanged).
 *
 * BASELINE CONSOLIDATION (0000_baseline_2026_07): the historical 0001–0128 files were replaced by a
 * single pg_dump baseline (db/migrations/0000_baseline_2026_07.sql). A genuinely fresh/empty database
 * runs that baseline to build the full schema; an EXISTING database (prod/staging/dev already at 0128)
 * already HAS that schema, so re-running the baseline would fail. To keep both cases correct, before an
 * `up` we STAMP the baseline as already-applied on any database that has prior migration history but
 * not yet the baseline row — node-pg-migrate then SKIPS the baseline and runs only 0129+. This is the
 * self-healing replacement for a manual one-time prod re-stamp; it is idempotent and touches only the
 * pgmigrations bookkeeping table, never the schema. See db/baseline/README.md.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const BASELINE_NAME = '0000_baseline_2026_07';

const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const inject = `-c app.env=${appEnv}`;
process.env.PGOPTIONS = process.env.PGOPTIONS ? `${process.env.PGOPTIONS} ${inject}` : inject;

const args = process.argv.slice(2);
// Bare `migrate.mjs` defaults to `up`; only `up` needs the baseline stamp guard.
const isUp = args.length === 0 || args[0] === 'up';

/**
 * Resolve `pg` without adding a root dependency: it lives in node-pg-migrate's dependency scope
 * (node-pg-migrate is a root dep and requires pg), and the same layout ships in the prod core image
 * that runs `pnpm migrate:up`. Fail CLOSED — if we cannot run the guard we must NOT proceed, because
 * an un-stamped existing DB would then try to re-run the baseline and corrupt/abort the migration.
 */
async function loadPg() {
  const rootRequire = createRequire(import.meta.url);
  const npmEntry = rootRequire.resolve('node-pg-migrate');
  const pgPath = createRequire(npmEntry).resolve('pg');
  return (await import(pgPath)).default;
}

/**
 * Stamp the baseline as applied on a pre-baseline database (has migration history, lacks the baseline
 * row). Idempotent + non-destructive: a fresh DB (no pgmigrations table, or an empty one) is left
 * untouched so node-pg-migrate runs the baseline normally; a DB that already has the baseline row is a
 * no-op. Uses the same DATABASE_URL/PGOPTIONS as node-pg-migrate.
 */
async function stampBaselineIfPreexisting() {
  const pg = await loadPg();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query(
      // NOTE the nested IFs: PL/pgSQL plans an IF expression as a single query, so a flat
      // `to_regclass(...) IS NOT NULL AND EXISTS(SELECT 1 FROM public.pgmigrations)` fails to PLAN on a
      // fresh DB (the table doesn't exist yet) even though the guard is false. Gating the table
      // reference behind an outer to_regclass IF keeps the inner query un-planned until the table exists.
      `DO $$
       BEGIN
         IF to_regclass('public.pgmigrations') IS NOT NULL THEN
           IF EXISTS (SELECT 1 FROM public.pgmigrations)
              AND NOT EXISTS (SELECT 1 FROM public.pgmigrations WHERE name = '${BASELINE_NAME}') THEN
             INSERT INTO public.pgmigrations (name, run_on) VALUES ('${BASELINE_NAME}', now());
             RAISE NOTICE '[migrate.mjs] pre-baseline DB — stamped % as applied (schema already present); node-pg-migrate will skip it and run 0129+ only', '${BASELINE_NAME}';
           END IF;
         END IF;
       END $$;`,
    );
    void res;
  } finally {
    await pool.end();
  }
}

async function main() {
  if (isUp) {
    try {
      await stampBaselineIfPreexisting();
    } catch (err) {
      // Fail closed: never let an `up` proceed if the baseline guard could not run.
      process.stderr.write(
        `[migrate.mjs] baseline stamp guard FAILED — refusing to run migrations to avoid ` +
          `re-running the baseline on an existing database: ${err?.message ?? err}\n`,
      );
      process.exit(1);
    }
  }

  // --no-check-order: after the 0001–0128 → 0000_baseline consolidation, an existing DB records the
  // old ordinal names with no files on disk. node-pg-migrate's default order check reads that "gap" as
  // an unrun migration preceding run ones and aborts. Disabling it is the standard squash-migrations
  // posture: node-pg-migrate still runs on-disk files not yet in pgmigrations, in filename order (the
  // baseline is stamped/skipped on existing DBs, applied on fresh ones; 0129+ follow).
  const runArgs = isUp ? ['--no-check-order', ...args] : args;
  const child = spawn('node-pg-migrate', ['-m', 'db/migrations', ...runArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: process.env,
    // no shell: pnpm puts node_modules/.bin on PATH; shell:true + args is DEP0190
    // (unescaped concatenation) and was never needed.
  });

  // Brain migrations are ordinal-named (0001_…), not epoch-named — node-pg-migrate
  // warns "Can't determine timestamp" per file (twice) and falls back to filename
  // order, which is exactly the intended order. Pure noise: drop those lines only.
  const NOISE = /^Can't determine timestamp for \d+/;
  const filter = (dst) => {
    let buf = '';
    return (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (!NOISE.test(line)) dst.write(line + '\n');
    };
  };
  child.stdout.on('data', filter(process.stdout));
  child.stderr.on('data', filter(process.stderr));
  child.on('close', (code) => process.exit(code ?? 1));
}

await main();
