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
import { spawnSync } from 'node:child_process';

const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'development';
const inject = `-c app.env=${appEnv}`;
process.env.PGOPTIONS = process.env.PGOPTIONS ? `${process.env.PGOPTIONS} ${inject}` : inject;

const args = process.argv.slice(2);
const result = spawnSync('node-pg-migrate', ['-m', 'db/migrations', ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});
process.exit(result.status ?? 1);
