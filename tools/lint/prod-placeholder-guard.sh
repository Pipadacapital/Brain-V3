#!/usr/bin/env bash
################################################################################
# Brain — prod placeholder guard (AUD-COST-007)
#
# Prod is a blueprint until `infra/terraform/envs/prod` is applied: the prod
# values/manifests legitimately carry fill-at-apply placeholders (ACCOUNT_ID,
# REPLACE_WITH_*) until `terraform output` produces the real values. Canonical
# list + fill sources: infra/helm/PLACEHOLDERS.md / docs/runbooks/GO-LIVE.md.
#
# Modes:
#   (default, PR)  Render every prod chart (helm template + values-prod) and
#                  scan the deployed ArgoCD prod manifests. FAIL if a chart no
#                  longer renders, or if a placeholder token appears that is
#                  NOT in tools/lint/prod-placeholder-allowlist.txt (catches
#                  typos and undocumented placeholders creeping in). Documented
#                  placeholders are ALLOWED — pre-apply they genuinely cannot
#                  be filled, so PRs must stay green.
#   --strict       FAIL while ANY placeholder remains in the rendered prod
#                  output. Wired as a gate in deploy.yml prod-promote: a prod
#                  promotion can never be committed while rendered prod values
#                  still carry REPLACE_WITH_*/ACCOUNT_ID.
#   --selftest     Prove the pattern + allowlist logic catch violations.
#
# Scope: infra/helm/<chart>/values-prod.yaml — RENDERED via helm template when
# the dir is a real chart (Chart.yaml), raw-scanned for values-only dirs that
# feed upstream charts (neo4j, keda) — plus infra/argocd/app-of-apps.yaml and
# infra/argocd/envs/prod/*.yaml. infra/argocd/rollouts/ is EXCLUDED: those
# manifests are referenced by no ArgoCD Application (aspirational blueprints,
# never deployed — see AUD-COST-007 verifier note).
#
# The B3 digest fail-closed template guards are satisfied with a dummy digest:
# image digests are CD-filled at deploy time (deploy.yml gitops/prod-promote) and
# explicitly NOT part of the placeholder gap.
################################################################################
set -euo pipefail
cd "$(dirname "$0")/../.."

PATTERN='REPLACE_WITH_[A-Z0-9_]+|ACCOUNT_ID'
ALLOWLIST_FILE="tools/lint/prod-placeholder-allowlist.txt"
DUMMY_DIGEST="sha256:0000000000000000000000000000000000000000000000000000000000000000"

MODE=pr
case "${1:-}" in
  --strict) MODE=strict ;;
  --selftest) MODE=selftest ;;
  "") ;;
  *) echo "usage: $0 [--strict|--selftest]" >&2; exit 2 ;;
esac

# Extra --set flags per chart to satisfy the B3 digest fail-closed guard.
digest_sets() {
  case "$1" in
    collector | core | stream-worker | web)
      echo "--set image.digest=${DUMMY_DIGEST}" ;;
    cronworkflows)
      echo "--set image.digest=${DUMMY_DIGEST} --set streamWorkerImage.digest=${DUMMY_DIGEST} --set sparkBronze.image.digest=${DUMMY_DIGEST} --set sparkV4.image.digest=${DUMMY_DIGEST}" ;;
    *) echo "" ;;
  esac
}

# ── selftest ────────────────────────────────────────────────────────────────
if [ "$MODE" = "selftest" ]; then
  fixture='roleArn: arn:aws:iam::ACCOUNT_ID:role/brain-prod-core
host: REPLACE_WITH_AURORA_ENDPOINT
oops: REPLACE_WITH_TOTALLY_UNDOCUMENTED'
  got=$(grep -oE "$PATTERN" <<<"$fixture" | sort -u)
  expected=$'ACCOUNT_ID\nREPLACE_WITH_AURORA_ENDPOINT\nREPLACE_WITH_TOTALLY_UNDOCUMENTED'
  [ "$got" = "$expected" ] || { echo "SELFTEST FAIL: pattern extraction (got: $got)" >&2; exit 1; }
  allowed=$(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE" | sort -u)
  undocumented=$(comm -23 <(printf '%s\n' "$got") <(printf '%s\n' "$allowed"))
  [ "$undocumented" = "REPLACE_WITH_TOTALLY_UNDOCUMENTED" ] \
    || { echo "SELFTEST FAIL: allowlist diff (got: $undocumented)" >&2; exit 1; }
  echo "selftest OK: pattern + allowlist logic catch undocumented placeholders"
  exit 0
fi

command -v helm >/dev/null || { echo "helm is required" >&2; exit 1; }

FINDINGS=$(mktemp)
trap 'rm -f "$FINDINGS"' EXIT
render_failed=0

for dir in infra/helm/*/; do
  chart=$(basename "$dir")
  [ -f "${dir}values-prod.yaml" ] || continue
  if [ -f "${dir}Chart.yaml" ]; then
    # shellcheck disable=SC2046  # digest_sets emits space-free --set flags
    if ! rendered=$(helm template "guard-${chart}" "$dir" -f "${dir}values-prod.yaml" $(digest_sets "$chart") 2>&1); then
      echo "RENDER FAIL: ${chart} — helm template with values-prod no longer renders:" >&2
      echo "$rendered" >&2
      render_failed=1
      continue
    fi
    grep -oE "$PATTERN" <<<"$rendered" | sed "s|^|helm/${chart}	|" >>"$FINDINGS" || true
  else
    # values-only dir for an upstream chart — raw scan
    grep -oE "$PATTERN" "${dir}values-prod.yaml" | sed "s|^|helm/${chart}(raw)	|" >>"$FINDINGS" || true
  fi
done

for f in infra/argocd/app-of-apps.yaml infra/argocd/envs/prod/*.yaml; do
  [ -f "$f" ] || continue
  grep -oE "$PATTERN" "$f" | sed "s|^|${f}	|" >>"$FINDINGS" || true
done

sort -u -o "$FINDINGS" "$FINDINGS"

if [ "$render_failed" -ne 0 ]; then
  echo "FAIL: one or more prod charts no longer render (see above)." >&2
  exit 1
fi

if [ "$MODE" = "strict" ]; then
  if [ -s "$FINDINGS" ]; then
    echo "FAIL (--strict): placeholders remain in rendered prod values/manifests — refusing to proceed." >&2
    echo "Run the go-live fill pass (docs/runbooks/GO-LIVE.md step 3 / infra/helm/PLACEHOLDERS.md):" >&2
    cat "$FINDINGS" >&2
    exit 1
  fi
  echo "strict OK: no placeholders remain in rendered prod values/manifests"
  exit 0
fi

# PR mode: only UNDOCUMENTED tokens fail
tokens=$(cut -f2 "$FINDINGS" | sort -u)
allowed=$(grep -vE '^\s*(#|$)' "$ALLOWLIST_FILE" | sort -u)
undocumented=$(comm -23 <(printf '%s\n' "$tokens") <(printf '%s\n' "$allowed") | grep -v '^$' || true)

if [ -n "$undocumented" ]; then
  echo "FAIL: undocumented placeholder token(s) in rendered prod values/manifests:" >&2
  while IFS= read -r tok; do
    awk -F'\t' -v t="$tok" '$2 == t' "$FINDINGS" >&2
  done <<<"$undocumented"
  echo "Either fill the value, or document it in infra/helm/PLACEHOLDERS.md and add it to ${ALLOWLIST_FILE}." >&2
  exit 1
fi

count=$(wc -l <"$FINDINGS" | tr -d ' ')
echo "PR-mode OK: all prod charts render; ${count} placeholder occurrence(s), all documented (fill at go-live — see docs/runbooks/GO-LIVE.md)."
cut -f2 "$FINDINGS" | sort | uniq -c || true
exit 0
