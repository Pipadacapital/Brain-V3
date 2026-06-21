-- 0024_dev_secret.sql — DEV-ONLY durable secret store (DEV-TOKEN-REACH)
--
-- Problem (ADR-BF-11): in dev, core's LocalSecretsManager held connector tokens in an
-- in-memory Map. That store (a) is lost on every core restart and (b) is invisible to the
-- stream-worker process (which runs the backfill worker). So a dev backfill could never
-- read the OAuth token cross-process.
--
-- Resolution: a dev-only, name-keyed secret table that both core (writer, on OAuth connect)
-- and the stream-worker (reader, at backfill time) share via the same Postgres. Durable
-- across restarts; visible cross-process.
--
-- SCOPE: DEV ONLY. In production, tokens live in AWS Secrets Manager under a per-brand CMK
-- (AwsSecretsManager); the LocalSecretsManager / WorkerLocalSecretsManager that read/write this
-- table HARD-FAIL if instantiated in production (the existing D-7 guard). This is the dev
-- stand-in for the KMS vault, analogous to the dev contact_pii table standing in for the vault.
--
-- NOT RLS-scoped: keyed by secret name (the ARN-name), not by brand rows for analytics — it is
-- the vault stand-in, not an analytical table. No PII; values are opaque connector credentials.

-- DEV-TOKEN-REACH guard: this table is a DEV-ONLY vault stand-in and must NEVER be created in
-- production (prod uses AWS Secrets Manager under a per-brand CMK). The migrate entrypoint
-- (scripts/migrate.mjs) sets `app.env` from APP_ENV/NODE_ENV via PGOPTIONS, so a production run
-- trips this guard and aborts BEFORE the table is created. Belt-and-suspenders to the existing
-- app-level hard-fail in Local/WorkerLocalSecretsManager (D-7).
DO $$
BEGIN
  IF current_setting('app.env', true) = 'production' THEN
    RAISE EXCEPTION 'DEV-TOKEN-REACH GUARD: dev_secret is a dev-only vault stand-in and must not be migrated in production (use AWS Secrets Manager).';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dev_secret (
  name          TEXT        NOT NULL,
  secret_value  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (name)
);

COMMENT ON TABLE dev_secret IS
  'DEV-ONLY vault stand-in (DEV-TOKEN-REACH). Connector credentials keyed by ARN-name, shared '
  'across core + stream-worker. Prod uses AWS Secrets Manager; the Local/Worker secrets managers '
  'that touch this table hard-fail in production.';

-- The stream-worker connects as brain_app (BRAIN_APP_DATABASE_URL) and must READ tokens here.
-- Core connects as the superuser and writes. Grant the worker its read/write needs.
GRANT SELECT, INSERT, UPDATE, DELETE ON dev_secret TO brain_app;
