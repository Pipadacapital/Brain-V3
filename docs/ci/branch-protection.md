# Branch Protection Definition — Brain

**Owner:** Platform/SRE  
**Status:** Binding Sprint-0 definition — enforced on `main` branch.  
**Source:** 03-architecture-plan.md §Track B; PLAYBOOK-deploy.md §Rollout; doc 12 §2.

---

## `main` Branch Protection Rules

### Required Status Checks (all must pass before merge)

| Check | Workflow | Blocks on |
|-------|----------|-----------|
| `pr / lint-typecheck-unit` | `pr.yml` | lint + typecheck + unit + contract + isolation + parity |
| `pr / secret-scan` | `pr.yml` | gitleaks finds a real secret |
| `pr / build-and-scan (collector)` | `pr.yml` | trivy HIGH/CRITICAL or osv finding |
| `pr / build-and-scan (stream-worker)` | `pr.yml` | trivy HIGH/CRITICAL |
| `pr / build-and-scan (core)` | `pr.yml` | trivy HIGH/CRITICAL |
| `pr / build-and-scan (web)` | `pr.yml` | trivy HIGH/CRITICAL |
| `infra / tf-fmt` | `infra.yml` | terraform fmt not clean |
| `infra / tf-validate (dev)` | `infra.yml` | terraform validate fails |
| `infra / checkov` | `infra.yml` | NN-3/4/5 Checkov custom check fails |
| `infra / opa-conftest` | `infra.yml` | OPA policy gate rejects IRSA/S3 config |

*Note: `infra/*` checks only run when `infra/**`, `.github/policy/**`, or `policy/**` change.*

### Review Requirements

| Change type | Minimum approvals | Required reviewers |
|-------------|-------------------|--------------------|
| Standard PR | 1 | Any team member |
| `packages/contracts/**` | **2** | Consuming-domain owner (CODEOWNERS) + 1 other |
| `db/migrations/**` | **2** | Data Engineer + 1 other |
| RLS policy change | **2** | Security Reviewer + Architect |
| `packages/metric-engine/**` | **2** | Data Engineer + 1 other |
| `audit_log` schema change | **2** | Architect + Security Reviewer |
| Billing/ledger table migration | **2** | VP Eng sign-off + Architect |

### Merge Requirements

| Rule | Setting |
|------|---------|
| Merge strategy | **Squash merge only** (clean linear history) |
| No force-push | Enforced — `main` is a protected branch |
| No bypass | Branch protection cannot be bypassed by admins |
| Stale review dismissal | Enabled — new pushes dismiss existing approvals |
| Require linear history | Enabled |
| Status checks must be up to date | Enabled (checks must re-run on latest HEAD) |

---

## GitHub Environments

### `staging`

- **Auto-deploy:** ArgoCD syncs staging automatically on merge to `main` (no manual gate).
- **Environment URL:** `https://staging.brain-platform.io`
- **Required reviewers:** none (auto)
- **Wait timer:** 0 minutes

### `production`

- **Manual promote:** Requires explicit approval from VP Eng before the `prod-promote` job runs.
- **Required reviewers:** VP Eng (configured in GitHub Environment settings)
- **Wait timer:** 0 minutes (reviewer must actively approve)
- **Deployment protection rule:** Only `main` branch can deploy to production.

---

## CODEOWNERS

Defined in `.github/CODEOWNERS`:

```
# Global: any change needs at least 1 team-member approval
*                              @brain-platform/engineering

# Contracts: consuming-domain owner approval required (I-E01)
/packages/contracts/           @brain-platform/data-engineers @brain-platform/backend-engineers

# DB migrations: data-engineer sign-off required
/db/migrations/                @brain-platform/data-engineers

# IaC: platform sign-off required
/infra/                        @brain-platform/platform-sre

# Security-sensitive
/policy/                       @brain-platform/security
/.github/policy/               @brain-platform/security
```

---

## Applying Branch Protection

To apply via `gh` CLI (run from repo root with admin token):

```bash
gh api repos/brain-platform/brain/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["pr / lint-typecheck-unit","pr / secret-scan","infra / tf-fmt","infra / checkov"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":1,"dismiss_stale_reviews":true}' \
  --field restrictions=null \
  --field required_linear_history=true \
  --field allow_force_pushes=false \
  --field allow_deletions=false
```

For the 2-approval rule on protected paths, set it in the GitHub UI under **Settings → Branches → Branch protection rules** with CODEOWNERS enforcement.

---

## Rollback Procedure (reference — see PLAYBOOK-deploy.md)

1. **ArgoCD revert:** `argocd app rollback brain-<service>-prod --revision <N>`
2. **Feature-flag kill-switch:** Set `connector.collector.enabled=false` in `packages/feature-flags` — propagates within 60s.
3. Both mechanisms are armed from `main` merge; EC8 drill verifies both paths before staging sign-off.
