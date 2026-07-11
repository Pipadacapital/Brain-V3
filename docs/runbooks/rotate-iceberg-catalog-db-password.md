# Rotate the `iceberg_catalog` DB password (AUD-INFRA-023 follow-up)

**Why (one-time trigger):** until the AUD-INFRA-023 masking fix (chart
`infra/helm/iceberg-rest`, `javaToolOptions`) was deployed, the iceberg-rest
fixture printed its full catalog config — **including the plaintext
`jdbc.password`** — to pod stdout on EVERY startup (measured in the 2026-07-10
crash-loop capture, 12+ restarts). Anyone who could run
`kubectl logs -n iceberg-rest` (or read retained node/log-agent copies) has seen
the current password. The credential MUST be rotated once, AFTER the masking
change is live. This runbook also serves for any future routine rotation.

**Blast radius:** iceberg-rest is a single-replica, stateless catalog front-end
(AUD-OPS-010/011). A restart is a short catalog blip: Trino serving reads that
miss the Redis cache and Spark/Connect catalog calls retry. Do it in a
low-traffic window; no data is at risk (Iceberg data/metadata live in S3, the
catalog rows in Aurora are untouched by rotation).

## Steps (order matters)

1. **Precondition — masking is live.** Confirm the running pod no longer dumps
   the config:
   ```sh
   kubectl -n iceberg-rest logs deploy/brain-prod-iceberg-rest | grep -c "Creating catalog with properties"
   # MUST be 0. If not, the chart change hasn't synced — stop here.
   ```
2. **Generate** a new strong password (e.g. `openssl rand -base64 32 | tr -d '/+='`).
3. **Update AWS Secrets Manager first** (so any unexpected pod restart mid-window
   converges to the new value once step 4 lands): edit
   `brain/prod/k8s/iceberg-rest-catalog-db`, key `jdbc-password` (keep
   `jdbc-user` = `iceberg_catalog`). ESO syncs it into k8s Secret
   `iceberg-rest-catalog-db` (ns `iceberg-rest`) within `refreshInterval: 1h`;
   force it immediately with:
   ```sh
   kubectl -n iceberg-rest annotate externalsecret iceberg-rest-catalog-db force-sync="$(date +%s)" --overwrite
   ```
4. **Change the DB password** on Aurora (from inside the VPC, same access path
   as GO-LIVE step 8):
   ```sql
   ALTER ROLE iceberg_catalog WITH PASSWORD '<new-password>';
   ```
   The running pod keeps working on its already-authenticated pooled
   connections; only NEW connections need the new password.
5. **Restart** so the pod picks up the synced Secret (env vars are
   read-at-start):
   ```sh
   kubectl -n iceberg-rest rollout restart deploy/brain-prod-iceberg-rest
   kubectl -n iceberg-rest rollout status  deploy/brain-prod-iceberg-rest
   ```
6. **Verify:** readiness green (`/v1/config` 200), a Trino
   `SELECT count(*) FROM brain_serving.mv_*` sanity read works, and the fresh
   pod's logs contain NO `Creating catalog with properties` line and NO
   password substring.
7. **Old copies:** the exposed value now authenticates nothing. If node-level
   log retention matters to you, recycle the node the old pods ran on
   (Karpenter re-provisions) — optional.
