# Deploy Report — `feat-data-plane-ingest-spine`

| Field | Value |
|---|---|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Stage** | 8 — Platform/SRE deploy |
| **Phase** | 1-dev-only (gh unauth, no cloud infra) |
| **Branch** | `feat/data-plane-ingest-spine` |
| **HEAD commit** | `ef78505` |
| **Deployed** | 2026-06-16T22:30:00Z |
| **Status** | **SHIPPED** |

---

## 1. Migration Verify (0015 + 0016)

Command run:
```
docker exec brainv3-postgres-1 psql -U brain -d brain -c \
  "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('collector_spool','bronze_events');"
```

Result:
```
     relname     | relrowsecurity | relforcerowsecurity
-----------------+----------------+---------------------
 bronze_events   | t              | t
 collector_spool | f              | f
(2 rows)
```

Policy check:
```
docker exec brainv3-postgres-1 psql -U brain -d brain -c \
  "SELECT polname, polcmd, pg_get_expr(polqual, polrelid) AS using_expr FROM pg_policy
   JOIN pg_class ON pg_class.oid = pg_policy.polrelid WHERE relname = 'bronze_events';"
```

Result:
```
     polname      | polcmd |                                using_expr
------------------+--------+--------------------------------------------------------------------------
 tenant_isolation | *      | (brand_id = (current_setting('app.current_brand_id'::text, true))::uuid)
```

**Verdict: VERIFIED-APPLIED (builders applied to dev prior to this stage)**

- `bronze_events`: rls=t, force=t — PASS (spec: force=t)
- `collector_spool`: rls=f — PASS (spec: no RLS, pre-brand-validation)
- Policy two-arg `current_setting('app.current_brand_id', TRUE)` — PASS (NN-1 compliant)
- Down = `DROP TABLE IF EXISTS bronze_events, collector_spool` (additive, no existing table touched)

---

## 2. Build Gate

Order: collector → stream-worker (dependency order, as specified).

| Package | Typecheck | Build (`tsc -b`) |
|---|---|---|
| `@brain/collector` | EXIT 0 | EXIT 0 |
| `@brain/stream-worker` | EXIT 0 | EXIT 0 |
| `@brain/events` | EXIT 0 | EXIT 0 |
| `@brain/contracts` | EXIT 0 | EXIT 0 |

**Lint @brain/stream-worker:** `pnpm --filter @brain/stream-worker lint` → EXIT 0 (0 errors, SR-01 closed)

All build scripts present (`tsc -b`). No invented commands.

---

## 3. Smoke

The committed full-wire e2e + durability + dedup + isolation tests are the bake proxy (all green per QA review + Final Review independent re-run). No long-lived server started.

Healthz check: collector not running as a long-lived process in this dev environment (expected — no `pnpm dev` running). The test harness starts the collector as a subprocess on a random OS port within the test itself (verified in `pipeline-wire.e2e.test.ts` commit `dcf2d55`).

Test disposition:
- E2E happy path: 1/1 PASS (38.55s, commit `dcf2d55`)
- Durability (ACK survives Redpanda-down): 5/5 PASS
- Dedup/replay (exactly one row): 4/4 PASS
- Isolation negative-control (cross-brand = 0 under brain_app): PASS; false-pass trap proven by Final Reviewer live re-run

**Smoke: BAKED (committed full-wire tests green; Final Reviewer independently replicated all 5 gates)**

---

## 4. PR Status

gh CLI unauthenticated (Phase 1-dev-only). Manual compare URL:

```
https://github.com/Rishabhporwal/Brain-V4/compare/master...feat/data-plane-ingest-spine
```

Branch is off `master` directly (clean base — unlike prior stacked branches). No stacked dependency to merge first.

---

## 5. Rollback Handle

```
# Rollback (additive tables only — no existing tables touched):
docker exec brainv3-postgres-1 psql -U brain -d brain \
  -c "DROP TABLE IF EXISTS bronze_events; DROP TABLE IF EXISTS collector_spool;"
# Re-deploy prior collector + stream-worker image (no migration down needed for any pre-existing table)
```

---

## 6. Real-Infra Promotion Needs (deferred to Phase 3)

The following are NOT built in M1 (Phase 1-dev-only) and are explicit deferred items:

1. **Redpanda topic provisioning** — `dev.collector.event.v1` and `dev.collector.event.v1.dlq` created by auto-create in dev. Production requires explicit topic provisioning with retention policy, partition count, and tenant-key partitioning.
2. **Iceberg flip (Phase 3)** — `bronze_events` is the M1 dev staging mirror. Phase-3 Spark/PyIceberg nightly job registers rows to `brain_bronze.collector_events` via Nessie. Column shape identical by design.
3. **Spool TTL + housekeeping** — `collector_spool` has no TTL/archival job; drained rows accumulate. Must-add before production load.
4. **Write-key auth on /collect** — SR-03 (MEDIUM): spool stores unvalidated body; acceptable M1-internal only. API-gateway write-key auth required before external traffic.
5. **Rate-limit wiring** — SR-04 (MEDIUM): `fastify-rate-limit` configured but unwired. Must wire before external /collect traffic.
6. **ArgoCD app overlays** — Slice 5 pipeline (Dockerfile + affected CI + ArgoCD overlays + canary + rollback alarm) is in the slice plan but Phase 1-dev-only has no cloud orchestrator. Wire when graduating to cloud deploy.
