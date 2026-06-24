-- 00_provision_brain_app_role.sql — LOCAL substrate provisioning (Docker postgres only).
--
-- WHY THIS EXISTS
-- Migration 0001 creates `brain_app` as a NOLOGIN group role on purpose: in REAL production a
-- separate login role is `GRANT brain_app TO <app_login_role>` at provisioning time (RDS IAM /
-- managed credentials), which is deliberately NOT in migrations. Locally there is no such
-- provisioning step, so on a FRESH Postgres volume `brain_app` exists but cannot log in, and
-- @brain/core + @brain/stream-worker crash at boot with:
--   "password authentication failed for user \"brain_app\""
-- (BRAIN_APP_DATABASE_URL = postgres://brain_app:brain_app@postgres:5432/brain).
--
-- HOW IT WORKS
-- The official postgres image runs every /docker-entrypoint-initdb.d/*.sql exactly once, on first
-- init of an EMPTY data directory (i.e. every fresh `docker compose down -v` cold start) — and
-- BEFORE any application migration runs. We create `brain_app` here with LOGIN + the dev password.
-- Migration 0001's `IF NOT EXISTS` then sees the role already exists and skips its CREATE, while its
-- invariant check only forbids BYPASSRLS (which we never grant) — so LOGIN survives. Idempotent.
--
-- This file is mounted ONLY into the local Docker postgres (see docker-compose.yml). It has no
-- effect on real production, which provisions the login role out-of-band per the runbook.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
    ALTER ROLE brain_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'brain_app';
  ELSE
    CREATE ROLE brain_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'brain_app';
  END IF;
END
$$;
