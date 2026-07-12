# Migration baseline (0000_baseline_2026_07)

The historical `db/migrations/0001_init.sql … 0128_list_shiprocket_connectors_for_webhook.sql`
were **consolidated into a single baseline**, `db/migrations/0000_baseline_2026_07.sql`, so a fresh
database builds the whole schema in one fast migration instead of replaying 128 files. New migrations
continue from `0129_`.

The old 128 files live in git history only (see the commit that introduced this baseline).

## How the baseline stays correct on every kind of database

`scripts/migrate.mjs` runs a small **stamp guard** before each `up`:

| Database state | What happens |
|---|---|
| **Fresh / empty** (no `pgmigrations` rows) | The guard no-ops; node-pg-migrate runs `0000_baseline` (full schema) then `0129+`. |
| **Existing** (prod/staging/dev already at 0128; has migration history but not the baseline row) | The guard **stamps** `0000_baseline_2026_07` as already-applied — a pure `pgmigrations` bookkeeping insert, no schema change — so node-pg-migrate **skips** the baseline and runs only `0129+`. |
| **Already baselined** | Guard is a no-op; normal forward migration. |

The guard is idempotent and non-destructive. `migrate.mjs` also passes `--no-check-order` because an
existing DB records the old ordinal names with no files on disk; without it node-pg-migrate reads that
gap as an out-of-order migration and aborts. If the guard cannot run it **fails closed** (refuses to
migrate) so the baseline can never accidentally re-run on a populated database.

## Verifying the prod re-stamp (at promotion)

When the promotion's migrate job runs `pnpm migrate:up` against prod, the guard auto-stamps the
baseline. To confirm afterwards:

```sql
-- Expect: baseline_stamped = t, and total rows = 128 (history) + 1 (baseline) + any 0129+.
SELECT
  bool_or(name = '0000_baseline_2026_07') AS baseline_stamped,
  count(*)                                 AS total_rows
FROM public.pgmigrations;
```

If you ever want to stamp prod **before** the deploy (belt-and-suspenders), run exactly the guard's
statement (idempotent):

```sql
DO $$
BEGIN
  IF to_regclass('public.pgmigrations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.pgmigrations)
       AND NOT EXISTS (SELECT 1 FROM public.pgmigrations WHERE name = '0000_baseline_2026_07') THEN
      INSERT INTO public.pgmigrations (name, run_on) VALUES ('0000_baseline_2026_07', now());
    END IF;
  END IF;
END $$;
```

## Regenerating the baseline

The baseline is a `pg_dump --schema-only` snapshot of the schema the 128 migrations build, verified by
replay + byte-identical schema-diff. To regenerate (e.g. after a batch of new migrations you also want
to fold in — not usually necessary):

```bash
# 1. Replay every migration on a throwaway DB (matches prod's Aurora PG16).
docker compose --profile core up -d postgres
PGPASSWORD=brain psql -h localhost -U brain -d brain -c "CREATE DATABASE baseline_rehearsal OWNER brain;"
DATABASE_URL=postgres://brain:brain@localhost:5432/baseline_rehearsal APP_ENV=staging \
  PGOPTIONS="-c role=brain" pnpm migrate:up

# 2. Dump schema-only with the PG16 client (avoids pg18 \restrict / transaction_timeout artifacts),
#    excluding the node-pg-migrate bookkeeping table + its sequence.
docker compose exec -T -e PGPASSWORD=brain postgres pg_dump -U brain -d baseline_rehearsal \
  --schema-only --no-owner \
  --exclude-table=public.pgmigrations --exclude-table=public.pgmigrations_id_seq > /tmp/schema.sql

# 3. Strip \restrict/\unrestrict lines, prepend the CREATE ROLE brain_app NOLOGIN prereq
#    (pg_dump omits CREATE ROLE), and write db/migrations/0000_baseline_<yyyy_mm>.sql.
# 4. Verify: apply the baseline to a second fresh DB and diff the two schema dumps — must be identical.
```
