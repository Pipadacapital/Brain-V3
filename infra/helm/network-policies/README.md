# network-policies — Brain cluster segmentation (AUD-INFRA-021/022)

One ArgoCD-managed policy set (`infra/argocd/envs/prod/network-policies.yaml`)
that ships:

1. **Default-deny-ingress NetworkPolicies** for every Brain workload namespace
   (`core`, `web`, `collector`, `stream-worker`, `trino`, `iceberg-rest`,
   `pgbouncer`, `neo4j`) plus explicit allows for the real flows — see the
   inventory in `values.yaml`.
2. **Pod Security Admission labels**: `enforce=restricted` on the 4 app
   namespaces (their charts already render restricted-compliant specs),
   `audit`/`warn=restricted` on the data-tier namespaces.

## ACTIVATION — read before expecting enforcement

- **PSA labels are live immediately** after sync (API-server-native). The 4 app
  charts were verified against the v1.31 `restricted` profile (pod-level
  runAsNonRoot + seccomp `RuntimeDefault`; per-container
  `allowPrivilegeEscalation: false` + `capabilities.drop: [ALL]`; only
  secret/emptyDir volumes) — including core's migrate Job.
- **NetworkPolicies are INERT until the CNI enforces them.** The prod EKS
  cluster runs the default AWS VPC CNI *without* the network-policy agent
  (nothing in `infra/terraform` configures the `vpc-cni` addon). Activation is
  a separate, owner-gated cluster step:

  ```sh
  aws eks update-addon --cluster-name brain-prod --addon-name vpc-cni \
    --configuration-values '{"enableNetworkPolicy": "true"}' \
    --resolve-conflicts PRESERVE
  ```

  (or the Terraform `aws_eks_addon` equivalent — infra lane). Until then the
  policy objects sit in the cluster doing nothing, which is the intended
  zero-risk rollout order: allows land BEFORE the deny can bite.

## Sync requirements

- The Application **must** sync with `ServerSideApply=true`: the `Namespace`
  manifests here carry ONLY the PSA labels and rely on SSA field management to
  merge onto the namespaces the per-app Applications created
  (`CreateNamespace=true`). A client-side apply would fight over the objects.
- No `prune` / no automated sync — manual promotion gate like every prod app.

## Deliberately out of scope

- **ns `kafka`** — Strimzi manages its own NetworkPolicies there, and
  kafka-connect (same ns) is the Bronze landing path (ADR-0010): a wrong deny
  is an event-loss risk. Cover it in a follow-up with Strimzi's
  `networkPolicyGeneration` semantics in hand.
- **Egress policies** — Aurora/Redis/MSK-side segmentation is SG territory
  (the audit notes the Aurora/Redis SGs admit the whole cluster SG — that fix
  is an infra-lane item, not a NetworkPolicy).
- **argocd / external-secrets / argo namespaces** — platform controllers with
  webhook/API surfaces; segmenting them needs their own flow audit.

## Verifying (read-only)

```sh
kubectl get netpol -A                      # policy objects present
kubectl get ns -L pod-security.kubernetes.io/enforce
# after enabling enforcement: probe a denied flow, e.g.
kubectl -n collector exec deploy/collector -- node -e \
  "fetch('http://brain-prod-trino.trino.svc.cluster.local:8080/v1/info').then(r=>console.log(r.status)).catch(e=>console.log('DENIED', e.cause?.code))"
```
