# ADR-0009 — Prod data store = Aurora Serverless v2; prod egress = fck-nat (starter)

**Status:** Accepted (2026-06-30). Encoded in `infra/terraform/envs/prod` M4 module set; **not yet applied** (prod is bootstrap-only until M4).

## Context

Two prod-infra choices were left open after the blueprint authored both options as standalone Terraform modules (`modules/{aurora,rds}`, `modules/{nat-instance,vpc-endpoints}` + `modules/network`). Brain's starter prod target: ~100 brands, ~100k events/day, peak bursts ~500/sec (flash sales), cost-conscious, AWS `ap-south-1`, zero idle spend until live.

Key fact: **PostgreSQL is operational-only** here. Analytics lives on Iceberg/Trino; PG holds the `ops` schema (identity/journey export, ML inference log, connector instances + secrets, collector spool, audit). So the DB workload is modest but **spiky** (spool drains, sync ticks, OAuth/token writes surge during flash sales), not a steady analytical grind.

## Decision 1 — Aurora Serverless v2 (over plain RDS)

Use `modules/aurora` (Aurora PostgreSQL, Serverless v2, **0.5–2 ACU**) as the prod operational DB; retire `modules/rds` from the prod path.

**Why:**
- The operational workload is **bursty** — exactly what serverless auto-scaling absorbs. A fixed RDS instance must be over-provisioned for the burst or it throttles; Aurora scales 0.5→2 ACU automatically and back down.
- **HA/failover is built in** (Aurora multi-AZ storage) without paying for a second standby instance as plain RDS HA requires.
- **Scales without re-architecture** as brands grow (raise the ACU ceiling), satisfying the "handle 2× burst without degradation" criterion.
- Floor ~0.5 ACU ≈ **$45/mo** — the only real downside vs a `db.t4g.small` (~$25/mo), and worth it for burst-elasticity + managed HA on a revenue-critical operational store.

**Rejected:** plain RDS `db.t4g.medium` — cheaper at *steady* load but doesn't auto-scale for flash-sale bursts and needs a paid standby for HA. Fine for a fixed/predictable workload; Brain's isn't.

**Graduation/revisit:** if sustained load pushes ACU consistently near the ceiling, raise max ACU; if the workload becomes steady-and-predictable (not bursty) at large scale, reassess a provisioned Aurora/RDS instance for cost.

## Decision 2 — fck-nat single instance (over per-AZ managed NAT Gateway) — for STARTER prod

Use `modules/nat-instance` (a single `t4g.nano` fck-nat) + `modules/vpc-endpoints` (S3 gateway free; STS/Secrets Manager/ECR/CloudWatch interface) for private-subnet egress; set `modules/network` `enable_nat_gateway = false`.

**Why:**
- **Cost:** ~$3–4/mo vs ~$32/mo **per** managed NAT Gateway × AZs (+$0.045/GB). At starter scale that's ~**$60–95/mo saved** — a large fraction of the ~$240–320/mo total.
- **The HA risk is tolerable for Brain specifically.** NAT is *egress* only (connector re-pulls, OAuth token exchange, LLM); inbound webhooks reach the collector via its public-side path, not NAT. Brain's ingestion is **replay-tolerant by design** — Bronze (Iceberg) is the system of record, the collector spools, delivery is at-least-once. A few minutes of egress downtime during fck-nat auto-recovery delays a re-pull; the next cycle catches up. **No event loss** (the core rule) is preserved.
- VPC endpoints keep S3/Secrets/ECR traffic *off* NAT entirely, shrinking both the NAT throughput need and the blast radius.

**Rejected (for starter):** per-AZ managed NAT Gateway — genuinely HA and managed, but ~$60–95/mo more for availability that Brain's replay-tolerant egress doesn't yet need.

**Graduation/revisit — switch to per-AZ managed NAT when ANY of:**
- egress becomes revenue-critical (paying brands depend on real-time freshness, not eventual catch-up), or
- NAT data volume makes the per-GB managed cost ≈ the instance saving, or
- the fck-nat instance's single-AZ failure profile is no longer acceptable.
Switching back is one flag: `enable_nat_gateway = true` (+ drop the nat-instance/vpc-endpoint module calls).

## Implementation note

`modules/network` previously hardwired NAT Gateways with an **inline** private default route, so fck-nat couldn't be wired (two default routes collide). This ADR adds an `enable_nat_gateway` toggle (default **true** — no behavior change for existing callers): private route tables are now always created and exported via `private_route_table_ids`, and the managed NAT default route is a separate `aws_route` gated by the toggle. With `enable_nat_gateway = false`, `modules/nat-instance` owns the private `0.0.0.0/0` route. terraform validate green for both modes.

## Consequences

- Prod `envs/prod` M4 module set: `aurora` (not `rds`), `network { enable_nat_gateway = false }` + `nat-instance` + `vpc-endpoints`.
- Net starter egress+DB cost ≈ Aurora ~$45 + fck-nat ~$4 + endpoints ~$7×N, vs RDS-HA + NAT-per-AZ which would add well over $100/mo.
- Both decisions are **one-flag reversible** and gated behind documented graduation triggers — no lock-in.
