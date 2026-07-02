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
 */
import { spawn } from 'node:child_process';

const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const inject = `-c app.env=${appEnv}`;
process.env.PGOPTIONS = process.env.PGOPTIONS ? `${process.env.PGOPTIONS} ${inject}` : inject;

const args = process.argv.slice(2);
const child = spawn('node-pg-migrate', ['-m', 'db/migrations', ...args], {
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
