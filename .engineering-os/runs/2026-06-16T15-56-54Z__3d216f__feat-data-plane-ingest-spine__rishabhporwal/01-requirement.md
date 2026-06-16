# Requirement: Thin data-plane ingest spine (collector → Redpanda → Bronze)

| Field | Value |
|-------|-------|
| **req_id** | `feat-data-plane-ingest-spine` |
| **Title** | Thin data-plane ingest spine — hello-world event flows collector → Redpanda → Bronze, behind RLS |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-16T15:56:54Z |
| **Tier impact** | M1 data-plane critical path (head of the spine) |
| **Region impact** | None new |

---

## Lane *(advisor to confirm — deterministic scan: high_stakes; surfaces: multi_tenancy, connectors, schema_proto)*

---

## Raw text (from the Stakeholder)

> Thin data-plane ingest spine (M1 critical path, doc 05 §14 exit: "a hello-world event flows pixel→collector→Redpanda→Bronze, behind RLS, contracts generated"). Wire the EXISTING scaffolds into a working end-to-end path for ONE synthetic/pixel event — NOT greenfield: `apps/collector` (intake/spool/drainer/envelope/health dirs), `apps/stream-worker` (consumers/pipeline/sinks/identity-bridge), `db/iceberg/bronze_table.sql` + `bronze_spec.json`, and the collector event contract `packages/contracts/src/events/m1.events.v1.ts` + `sample.collector.event.v1.ts`.
>
> DELIVER:
> 1. **Collector accept-before-validate edge** — a POSTed event is durably spooled and ACKed BEFORE validation (the 99.95% durability invariant), then drained to Redpanda/Kafka. Reject nothing at the edge.
> 2. **stream-worker** consumes from Redpanda → validates against the contract → dedups (idempotency key) → writes to brand-partitioned Bronze.
> 3. **RLS / tenant isolation from day one** — every Bronze write carries brand_id; cross-brand read = zero rows under SET ROLE brain_app (the ONE invariant; dev superuser masks RLS — verify under brain_app).
> 4. **Idempotent + replayable** — no dup on redelivery.
> 5. **Automated end-to-end test** — synthetic event → collector → redpanda → stream-worker → Bronze row present, behind RLS; plus a durability test (event ACKed even if downstream is down — the spool holds it).

---

## Problem statement

The control plane is shipped, but the data plane is entirely stubs (`apps/collector/main.ts` + `apps/stream-worker/main.ts` are 9-line stubs). Nothing flows into Bronze, so there is no substrate for identity / ledger / metrics. M1's exit criterion (doc 05 §14) requires a hello-world event flowing collector→Redpanda→Bronze behind RLS. This is the head of the data-plane vertical spine.

## Target user

Internal/platform (the data spine that every downstream metric reads). India DTC brand context, M1.

## Success metric

A synthetic event POSTed to the collector is (a) durably ACKed before validation, (b) lands as a brand-scoped row in Bronze via Redpanda + stream-worker, (c) is idempotent on redelivery, (d) cannot be read cross-brand under `brain_app` — all proven by an automated end-to-end test + a durability test (ACK survives a downstream outage).

## Constraints

- **Hard rule:** no NEW service / deployable / database / ledger / pattern — use the EXISTING 3 deployables (collector, stream-worker, core) + the existing Bronze + Redpanda from the docker infra.
- Absolute brand/tenant isolation (the ONE invariant); RLS from day one; verify under `SET ROLE brain_app` (dev superuser bypasses RLS).
- Contracts-first (I-E01): the collector event contract + codegen committed before consumers.
- Accept-before-validate (99.95% durability) — the spool ACKs before any validation/downstream call.
- Idempotent + replayable (I-ST04).

## Non-goals

- Identity graph, realized-revenue ledger, metric engine, Analytics API, dashboard surface (later slices).
- Real Shopify / Meta connector ingestion (Shopify validate-sync is parked — `SHOPIFY-VALIDATE-01`). This slice uses a synthetic/pixel event only.
- StarRocks/Gold/dbt marts.

## Linked prior runs

- chore-platform-foundations-sprint0 (Redpanda, Bronze/Iceberg scaffold, contracts/codegen, RLS migration #1)

## Notes

- Scaffolds already present: collector dirs (intake/spool/drainer/envelope/health), stream-worker dirs (consumers/pipeline/sinks/identity-bridge), `db/iceberg/bronze_table.sql`+`bronze_spec.json`+`schema-evolution-policy.md`, contracts `m1.events.v1.ts`+`sample.collector.event.v1.ts`.
- Builder note (lesson from feat-members-team-management): keep builder scopes tight and COMMIT PER SLICE — two prior builders died on infra socket timeouts (~61 min) and only committed-per-slice work survived.
- Verify Redpanda + Bronze sink are in the docker-compose; if Bronze is Postgres-backed in dev (vs Iceberg), confirm the dev sink with the architect.
