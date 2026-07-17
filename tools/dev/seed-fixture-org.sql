-- seed-fixture-org.sql — a single fixture organization for CI test lanes.
--
-- WHY: the schema-only migrate (0000_baseline_2026_07.sql, a pg_dump) seeds NO tenant data, and the
-- many *.live / *.integration suites assume a seeded environment — they do `SELECT id FROM
-- organization LIMIT 1` and seed their own brands against it (brand.organization_id FK → organization,
-- whose owner_user_id FKs → iam.app_user). On a fresh migrate that SELECT returns nothing and the
-- suites throw "No organization found" / insert a NULL organization_id. Reference data (ref_currency /
-- ref_timezone) is handled by migration 0136; this seeds the ONE tenant fixture the test lanes need.
--
-- Idempotent (ON CONFLICT DO NOTHING). Runs after `pnpm migrate:up` in the CI DB lanes.

INSERT INTO iam.app_user (id, email, email_normalized, password_hash)
VALUES ('00000000-0000-4000-8000-0000000000f1', 'fixture@x.invalid', 'fixture@x.invalid', 'x')
ON CONFLICT DO NOTHING;

INSERT INTO tenancy.organization (id, name, slug, owner_user_id)
VALUES ('00000000-0000-4000-8000-0000000000f2', 'Fixture Org', 'fixture-org',
        '00000000-0000-4000-8000-0000000000f1')
ON CONFLICT DO NOTHING;
