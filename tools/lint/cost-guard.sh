#!/usr/bin/env bash
#
# cost-guard.sh — Brain banked-cost-wins regression guard (BLOCKING CI gate).
#
# The platform-reset program (docs/platform-reset/, owner-ratified 2026-07-14) is a SELECTIVE
# REBUILD: the estate is already deliberately cost-optimized and the structural wins are easy to
# regress with a one-line IaC edit. This guard FAILS the PR if any of the banked wins listed in
# 07-cost-optimization.md / 09-engineering-standards.md §2.1 has been reverted:
#
#   G1  Managed NAT Gateway reintroduced — prod egress MUST stay fck-nat (enable_nat_gateway=false).
#         A managed NAT GW is ~$32/mo + $0.045/GB; ADR-0009 pins fck-nat ($0-marginal on a t4g.nano).
#   G2  Aurora min-ACU drifted ABOVE the 0.5 floor, or max-ACU left unbounded/absent.
#         ADR-0003/ADR-0009 floor Aurora Serverless v2 at 0.5 ACU; a higher floor bills 24×7.
#   G3  EKS extended-support reintroduced, or the cluster version downgraded below 1.33.
#         eks_support_type MUST stay STANDARD (extended support = ~$360/mo) and cluster_version >= 1.33.
#   G4  Kafka rack-awareness removed — the ~$194/mo cross-AZ DataTransfer lever (KIP-392).
#         infra/helm/strimzi-kafka/values.yaml kafka.rack.enabled MUST stay true.
#
# SCOPE: this guard reads the tracked prod IaC source of truth ONLY (it does not call AWS):
#   infra/terraform/envs/prod/terraform.tfvars   (G2, G3)
#   infra/terraform/envs/prod/bootstrap.tf       (G1)
#   infra/helm/strimzi-kafka/values.yaml         (G4)
# If a file is missing the guard FAILS CLOSED (a banked win cannot be verified = treat as regressed).
#
# Usage:
#   tools/lint/cost-guard.sh            # scan the prod IaC; exit 1 on any regression
#   tools/lint/cost-guard.sh --selftest # prove each rule catches its regression (CI sanity)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0

flag() { # $1 rule  $2 message
  printf '%s✖ [%s]%s %s\n' "$RED" "$1" "$RST" "$2"
  violations=$((violations + 1))
}

# Strip whole-line comments (# … for tfvars/tf/yaml) so a commented example never trips a rule.
noncomment() { # $1 = file
  awk '{ s=$0; sub(/^[ \t]*/,"",s) } s !~ /^#/ { print }' "$1"
}

# ── G1: managed NAT Gateway must NOT be reintroduced (prod egress = fck-nat) ──────────────────────
check_nat() { # $1 = tf root dir (bootstrap.tf)
  local tf="$1/bootstrap.tf"
  if [ ! -f "$tf" ]; then
    flag G1 "prod bootstrap.tf missing ($tf) — cannot confirm fck-nat egress; failing closed."
    return
  fi
  local nc; nc="$(noncomment "$tf")"
  # The network module MUST set enable_nat_gateway=false (fck-nat owns egress, ADR-0009).
  if ! printf '%s\n' "$nc" | grep -qE 'enable_nat_gateway[[:space:]]*=[[:space:]]*false'; then
    flag G1 "managed NAT Gateway regression: enable_nat_gateway=false not found in bootstrap.tf — prod egress must stay fck-nat (ADR-0009, ~\$32/mo+\$0.045/GB saved)."
  fi
  if printf '%s\n' "$nc" | grep -qE 'enable_nat_gateway[[:space:]]*=[[:space:]]*true'; then
    flag G1 "managed NAT Gateway REINTRODUCED: enable_nat_gateway=true in bootstrap.tf — revert to fck-nat (ADR-0009)."
  fi
}

# ── G2: Aurora min-ACU floor (0.5) + bounded max-ACU ──────────────────────────────────────────────
check_aurora() { # $1 = tf root dir (terraform.tfvars)
  local tfvars="$1/terraform.tfvars"
  if [ ! -f "$tfvars" ]; then
    flag G2 "prod terraform.tfvars missing ($tfvars) — cannot confirm Aurora floor; failing closed."
    return
  fi
  local nc; nc="$(noncomment "$tfvars")"
  local min max
  min="$(printf '%s\n' "$nc" | grep -E '^[[:space:]]*aurora_min_capacity[[:space:]]*=' | head -1 | sed -E 's/.*=[[:space:]]*//; s/[^0-9.].*$//')"
  max="$(printf '%s\n' "$nc" | grep -E '^[[:space:]]*aurora_max_capacity[[:space:]]*=' | head -1 | sed -E 's/.*=[[:space:]]*//; s/[^0-9.].*$//')"
  if [ -z "$min" ]; then
    flag G2 "aurora_min_capacity not set in terraform.tfvars — the 0.5-ACU floor is unverifiable (ADR-0003/0009)."
  # awk float compare: fail if min > 0.5.
  elif awk -v m="$min" 'BEGIN { exit !(m > 0.5) }'; then
    flag G2 "aurora_min_capacity=$min is ABOVE the 0.5-ACU floor — Serverless v2 min bills 24×7; keep min=0.5 (ADR-0003/0009)."
  fi
  if [ -z "$max" ]; then
    flag G2 "aurora_max_capacity not set in terraform.tfvars — an unbounded max-ACU can bill uncapped; set an explicit ceiling (ADR-0003/0009)."
  fi
}

# ── G3: EKS STANDARD support + version >= 1.33 (no extended-support / downgrade) ──────────────────
check_eks() { # $1 = tf root dir (terraform.tfvars)
  local tfvars="$1/terraform.tfvars"
  if [ ! -f "$tfvars" ]; then
    flag G3 "prod terraform.tfvars missing ($tfvars) — cannot confirm EKS support type/version; failing closed."
    return
  fi
  local nc; nc="$(noncomment "$tfvars")"
  local support ver
  support="$(printf '%s\n' "$nc" | grep -E '^[[:space:]]*eks_support_type[[:space:]]*=' | head -1 | sed -E 's/.*=[[:space:]]*"?//; s/[^A-Za-z].*$//')"
  ver="$(printf '%s\n' "$nc" | grep -E '^[[:space:]]*cluster_version[[:space:]]*=' | head -1 | sed -E 's/.*=[[:space:]]*"?//; s/".*$//; s/[[:space:]].*$//')"
  if [ -z "$support" ]; then
    flag G3 "eks_support_type not set in terraform.tfvars — STANDARD support is unverifiable (extended support = ~\$360/mo; AUD-OPS-028)."
  elif [ "$support" != "STANDARD" ]; then
    flag G3 "eks_support_type=$support — EXTENDED support reintroduced (~\$360/mo); keep STANDARD (AUD-OPS-028)."
  fi
  if [ -z "$ver" ]; then
    flag G3 "cluster_version not set in terraform.tfvars — cannot confirm the cluster is on >=1.33 (extended-support avoidance)."
  else
    # numeric-sort compare: fail if ver < 1.33.
    local lowest
    lowest="$(printf '%s\n1.33\n' "$ver" | sort -t. -k1,1n -k2,2n | head -1)"
    if [ "$lowest" != "1.33" ] && [ "$ver" != "1.33" ]; then
      flag G3 "cluster_version=$ver is BELOW 1.33 — a downgrade re-enters extended support (~\$360/mo); keep >=1.33 (AUD-OPS-028)."
    fi
  fi
}

# ── G4: Kafka rack-awareness (KIP-392) must stay enabled (~\$194/mo cross-AZ lever) ───────────────
check_rack() { # $1 = repo root
  local vals="$1/infra/helm/strimzi-kafka/values.yaml"
  if [ ! -f "$vals" ]; then
    flag G4 "strimzi-kafka values.yaml missing ($vals) — cannot confirm Kafka rack-awareness; failing closed."
    return
  fi
  # Look for the `rack:` block's `enabled: true`. The value key is `kafka.rack.enabled`.
  # Extract the rack block (from `  rack:` to the next same-or-lower-indent key) and require enabled: true.
  if ! awk '
      /^[[:space:]]{2,}rack:[[:space:]]*$/ { inrack=1; next }
      inrack && /^[[:space:]]*[A-Za-z].*:/ && $0 !~ /^[[:space:]]{4,}/ { inrack=0 }
      inrack && /enabled:[[:space:]]*true/ { found=1 }
      END { exit !found }
    ' "$vals"; then
    flag G4 "Kafka rack-awareness regression: kafka.rack.enabled is not true in strimzi-kafka/values.yaml — this is the ~\$194/mo cross-AZ DataTransfer lever (KIP-392); keep it enabled."
  fi
}

# ── Self-test ─────────────────────────────────────────────────────────────────────────────────────
selftest() {
  local d; d="$(mktemp -d)"
  trap 'rm -rf "$d"' RETURN
  mkdir -p "$d/tf" "$d/infra/helm/strimzi-kafka"

  # BAD corpus — every banked win regressed.
  cat > "$d/tf/bootstrap.tf" <<'EOF'
module "network" {
  enable_nat_gateway = true
}
EOF
  cat > "$d/tf/terraform.tfvars" <<'EOF'
aurora_min_capacity = 2
eks_support_type = "EXTENDED"
cluster_version  = "1.32"
EOF
  cat > "$d/infra/helm/strimzi-kafka/values.yaml" <<'EOF'
kafka:
  rack:
    enabled: false
EOF

  local bad=0
  ( violations=0
    check_nat "$d/tf"; check_aurora "$d/tf"; check_eks "$d/tf"; check_rack "$d"
    [ "$violations" -ge 5 ] ) || bad=1
  if [ "$bad" -ne 0 ]; then echo "${RED}SELFTEST FAIL: guard missed a banked-win regression on the bad corpus.${RST}"; fi

  # GOOD corpus — all wins intact (mirrors the live prod SoT).
  cat > "$d/tf/bootstrap.tf" <<'EOF'
module "network" {
  single_nat_gateway = true
  enable_nat_gateway = false # ADR-0009: fck-nat owns egress
}
EOF
  cat > "$d/tf/terraform.tfvars" <<'EOF'
# aurora_min_capacity = 4  # commented example must NOT trip the guard
aurora_min_capacity = 0.5
aurora_max_capacity = 2
eks_support_type = "STANDARD"
cluster_version  = "1.33"
EOF
  cat > "$d/infra/helm/strimzi-kafka/values.yaml" <<'EOF'
kafka:
  rack:
    enabled: true
    topologyKey: topology.kubernetes.io/zone
EOF

  local good=0
  ( violations=0
    check_nat "$d/tf"; check_aurora "$d/tf"; check_eks "$d/tf"; check_rack "$d"
    [ "$violations" -eq 0 ] ) || good=1
  if [ "$good" -ne 0 ]; then echo "${RED}SELFTEST FAIL: guard false-positived on the intact (good) corpus.${RST}"; fi

  if [ "$bad" -eq 0 ] && [ "$good" -eq 0 ]; then
    echo "${GRN}✓ cost-guard self-test passed (catches G1 NAT / G2 Aurora-ACU / G3 EKS-support+version / G4 Kafka-rack regressions; no false positives on the intact SoT).${RST}"
    return 0
  fi
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

echo "${YEL}cost-guard${RST} — verifying the banked cost wins in the prod IaC source of truth…"
check_nat    "$ROOT/infra/terraform/envs/prod"
check_aurora "$ROOT/infra/terraform/envs/prod"
check_eks    "$ROOT/infra/terraform/envs/prod"
check_rack   "$ROOT"

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}cost-guard FAILED: ${violations} banked-cost-win regression(s).${RST}"
  echo "Protect the structural wins (07-cost-optimization.md / 09-engineering-standards.md §2.1):"
  echo "fck-nat (no managed NAT), Aurora 0.5-ACU floor + bounded max, EKS STANDARD support on >=1.33,"
  echo "and Kafka rack-awareness (KIP-392, ~\$194/mo cross-AZ lever). Revert the regression or, if the"
  echo "change is deliberate, graduate it with an ADR and update this guard's expected SoT."
  exit 1
fi

echo "${GRN}✓ cost-guard passed — fck-nat egress, Aurora 0.5-ACU floor + bounded max, EKS STANDARD/>=1.33, Kafka rack-awareness all intact.${RST}"
exit 0
