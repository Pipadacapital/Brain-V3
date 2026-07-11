# Kafka operations (prod) — Strimzi sync-safety + PVC prune guard

Audit trail: **AUD-INFRA-002** (Kafka data PVCs are ArgoCD prune candidates), AUD-INFRA-003
(false-OutOfSync noise masking it), AUD-LIVE-5 (original guard). Cluster: `brain-prod-kafka`
(KRaft, KafkaNodePool `combined`, namespace `kafka`), managed by the ArgoCD apps
`strimzi-operator-prod` (wave 0) + `strimzi-kafka-prod` (wave 1).

## HARD RULES (no exceptions)

- **NEVER prune-sync `strimzi-kafka-prod`.** No `argocd app sync strimzi-kafka-prod --prune`,
  no "Prune" checkbox in the UI. The 3 Kafka data PVCs are Strimzi-created (not in git),
  carry the app's tracking label, and show `requiresPruning: true` — a prune-enabled sync
  **deletes all three broker data volumes** ("no event loss" violated in one click).
- **NEVER Replace-sync `neo4j-prod`.** No `--replace` / "Replace" checkbox. Replace
  delete+recreates the Neo4j StatefulSet and its identity store guarantees; the app's
  perpetual cosmetic OutOfSync (AUD-INFRA-003 defaulted-field drift) is NOT a reason to
  escalate sync options.
- Normal (non-prune, non-replace) manual syncs of both apps are fine.

## The 3 prune-candidate PVCs

```
kafka/data-0-brain-prod-kafka-combined-0
kafka/data-0-brain-prod-kafka-combined-1
kafka/data-0-brain-prod-kafka-combined-2
```

They remain **live prune candidates until the guard annotations are on the PVC objects**.
The chart-side guard (`infra/helm/strimzi-kafka/templates/kafka-cr.yaml`,
`spec.template.persistentVolumeClaim.metadata.annotations`) is correct, but it never reached
the cluster (root cause below) — so **annotate manually right after this merge** (idempotent,
metadata-only, safe):

```bash
kubectl -n kafka annotate pvc \
  data-0-brain-prod-kafka-combined-0 \
  data-0-brain-prod-kafka-combined-1 \
  data-0-brain-prod-kafka-combined-2 \
  argocd.argoproj.io/compare-options=IgnoreExtraneous \
  'argocd.argoproj.io/sync-options=Prune=false,Delete=false' \
  --overwrite
```

Verify (each PVC must show both annotations, and the app must stop listing them as
`requiresPruning`):

```bash
kubectl -n kafka get pvc data-0-brain-prod-kafka-combined-0 \
  -o jsonpath='{.metadata.annotations.argocd\.argoproj\.io/sync-options}'; echo
kubectl -n argocd get application strimzi-kafka-prod -o json \
  | jq '[.status.resources[] | select(.kind=="PersistentVolumeClaim")]'
```

## Root cause (MEASURED, 2026-07-11): stale ArgoCD manifest cache

Why three Succeeded syncs of guard-carrying revisions changed nothing:

- `strimzi-kafka-prod` carried `argocd.argoproj.io/manifest-generate-paths:
  infra/helm/strimzi-kafka` — **relative**, and ArgoCD resolves relative values against
  `spec.source.path` (also `infra/helm/strimzi-kafka`), so the watched path was the
  never-existing `infra/helm/strimzi-kafka/infra/helm/strimzi-kafka`.
- Per the ArgoCD v2.13 manifest-paths contract, when no changed file matches the annotation
  "the existing cache will be considered valid for the new commit" → the repo-server
  forward-copied the pre-guard render to every new revision. Evidence: repo-server logs show
  only `manifest cache hit …/<new sha>` and **zero** `helm template … strimzi-kafka`
  invocations across the 18:40 / 19:12 / 20:52 syncs of 2026-07-11; the KafkaNodePool's
  `last-applied-configuration` is the pre-guard manifest (labels only, no annotations); the
  app reported the KafkaNodePool **Synced** because desired == stale cache == live.
- NOT the CRD (live `kafkanodepools.kafka.strimzi.io` schema carries
  `spec.template.persistentVolumeClaim.metadata.annotations`), NOT the chart (local
  `helm template -f values-prod.yaml` renders the annotations), NOT Strimzi.

**Fix:** the annotation is now repo-root-absolute (`/infra/helm/strimzi-kafka`) in
`infra/argocd/envs/prod/strimzi-kafka.yaml`. Note the fix takes effect only after
`brain-app-of-apps` syncs the Application object itself.

### Propagation sequence after this merge

1. Sync `brain-app-of-apps` (updates the Application annotation), then **Hard Refresh**
   `strimzi-kafka-prod` to evict the stale manifest cache without waiting for TTL:
   `argocd app get strimzi-kafka-prod --hard-refresh` (or UI → Refresh ▾ → Hard Refresh).
2. KafkaNodePool `combined` should now show OutOfSync (annotations diff). Plain sync — no
   prune, no replace.
3. Strimzi reconciles and patches the template metadata onto the **existing** PVCs
   (PVC labels/annotations are operator-managed since Strimzi 0.15; its PVC reconcile only
   preserves `spec.volumeName`, metadata diffs are patched). Verify with the commands above;
   if the annotations do NOT appear on the PVCs within one reconcile interval, treat that
   propagation claim as falsified and keep the manual annotations (already applied in the
   step above) as the standing guard.

### Same bug elsewhere (follow-up, do NOT fix ad hoc)

Every other prod/staging Application (`core`, `web`, `collector`, `trino`, `kafka-connect`,
`cronworkflows`, …) uses the same relative `manifest-generate-paths` form → their syncs can
also serve stale manifests (e.g. image-digest bumps silently not deploying). Tracked as an
AUD-INFRA-002 follow-up; fix is the same one-character leading `/` per app, one reviewed PR.
