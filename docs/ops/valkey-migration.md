# Valkey migration runbook (ElastiCache Redis OSS 7.1 → Valkey 8.0)

**Scope:** the prod serving cache (`brain-prod-redis` replication group, single
`cache.t4g.micro`, single-AZ). Owner-run. ~5 min, effectively zero app impact.

## Why

- **Cost:** Valkey runs ~20% cheaper per node-hour than Redis OSS on ElastiCache,
  and its better per-key memory efficiency fits more of the serving working set
  on the same `cache.t4g.micro` (defers the micro→small scale knob, AUD-OPS-032).
- **Licensing:** Valkey is BSD-3 (Linux Foundation) — the community continuation
  after Redis relicensed to SSPL/RSALv2 in 2024.
- **Zero app change:** Valkey is a drop-in for Redis 7 (same RESP protocol,
  commands, data structures). `ioredis` / `IoredisCacheAdapter` / the analytics
  cache port are untouched.

## Why the migration is safe here

The serving cache is **rebuildable** — Trino/Iceberg Gold is the system of record,
and `ServingCacheReader` fails soft to a direct Trino read on any cache miss or
outage. So even a full cold cache is a transient latency blip, never data loss.

The cross-engine upgrade itself is a **native, online ElastiCache operation**:
the primary **endpoint DNS is unchanged** (so `REDIS_URL` in Secrets Manager needs
no edit), the cache stays available for reads throughout, and writes pause only for
the few-second failover. (AWS docs: "Upgrading Redis OSS to Valkey".)

## Why not just `terraform apply`

The Terraform AWS provider's in-place `engine` change on
`aws_elasticache_replication_group` is unreliable — it either no-ops
(hashicorp/terraform-provider-aws#41181) or gets stuck in a replace-loop
(#40786). A replace would destroy+recreate the group. So we drive the migration
with the AWS CLI (the supported path) and let Terraform reconcile to a **no-op**
afterwards.

## Procedure

Prereq: AWS CLI ≥ 2.18.2 (cross-engine upgrade support), creds for acct
`380254378136`, region `ap-south-1`.

1. **Land the desired-state Terraform first** (this PR): the module + prod now
   declare `engine = "valkey"`, `engine_version = "8.0"`. Do **not** run
   `terraform apply` yet — before the CLI modify, the provider would attempt the
   buggy in-place flip.

2. **Snapshot for safety** (optional; the cache is rebuildable, but cheap insurance):
   ```sh
   aws elasticache create-snapshot --region ap-south-1 \
     --replication-group-id brain-prod-redis \
     --snapshot-name brain-prod-redis-pre-valkey
   ```

3. **Run the native cross-engine upgrade** (online; endpoint DNS unchanged):
   ```sh
   aws elasticache modify-replication-group --region ap-south-1 \
     --replication-group-id brain-prod-redis \
     --engine valkey --engine-version 8.0 \
     --apply-immediately
   ```
   The group defaults to `default.redis7` today, so ElastiCache moves it to
   `default.valkey8` automatically. (If a custom param group were in use, pass a
   matching `--cache-parameter-group-name`.)

4. **Wait for it to settle:**
   ```sh
   aws elasticache describe-replication-groups --region ap-south-1 \
     --replication-group-id brain-prod-redis \
     --query 'ReplicationGroups[0].{Status:Status,Engine:MemberClusters}' --output json
   # wait until Status = available; the console shows the group under "Valkey".
   ```

5. **Reconcile Terraform (must be a no-op / in-place metadata only):**
   ```sh
   cd infra/terraform/envs/prod
   terraform plan   # EXPECT: no changes (or only engine/version drift already true in AWS).
   ```
   If the plan shows a **replacement**, STOP — do not apply. Investigate (the CLI
   modify likely hasn't finished, or the provider version needs a `terraform
   refresh` first). Applying a replacement would drop the cache.

6. **Verify the app:** hit a couple of dashboard metrics, then confirm the new
   hit-rate metric is emitting:
   ```
   serving_cache_requests_total{result="hit"}   # climbs as the cache re-warms
   ```
   During the first minutes the ratio dips (cold cache) then recovers — expected.

## Rollback

Native downgrade is supported **only from Valkey 7.2 → Redis OSS 7.1**, not from
8.0. Because the cache is rebuildable, the practical rollback is:

```sh
# flip the module/env back to redis 7.1 in TF, then:
aws elasticache modify-replication-group --region ap-south-1 \
  --replication-group-id brain-prod-redis \
  --engine redis --engine-version 7.1 --apply-immediately   # only valid from Valkey 7.2
# OR (from 8.0): restore the pre-valkey snapshot as a Redis 7.1 group, or simply
# recreate — nothing of record lives in the cache.
```

If you want the officially-reversible path, migrate to **Valkey 7.2** instead of
8.0 (`engine_version = "7.2"` in both the module default and the prod call);
7.2 is cost-identical and downgrades cleanly to Redis 7.1.
