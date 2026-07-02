#!/usr/bin/env bash
################################################################################
# Brain — SLO rules dual-copy parity gate (AUD-PROD-B8-FUP3)
#
# The Prometheus alert/SLO rules live in TWO places by design:
#   canonical : infra/observe/alerts/<name>.rules.yml
#               (mounted into the LOCAL docker-compose prometheus)
#   prod copy : infra/helm/kube-prometheus-stack/values-prod.yaml
#               additionalPrometheusRulesMap.<name>.groups
#               (rendered into the PROD kube-prometheus-stack PrometheusRule)
#
# If the two copies drift, local and prod alerting silently fork. This gate
# python-yaml-loads both sides and deep-compares the `groups` structures.
#
# DATA-DRIVEN by intent:
#   - For every canonical infra/observe/alerts/*.rules.yml whose key
#     (basename minus ".rules.yml") appears in additionalPrometheusRulesMap:
#     the groups MUST be semantically identical (exit 1 with a diff otherwise).
#   - Canonical files NOT (yet) in the values map are a WARNING only — new
#     rules files may land in the map in a separate lane; this gate must stay
#     green regardless of landing order.
#   - Values-map keys with no canonical file are a WARNING too (prod-only
#     rules should be promoted to a canonical file, but that is not this
#     gate's failure mode).
#
# Usage: tools/lint/slo-rules-parity.sh
################################################################################
set -euo pipefail
cd "$(dirname "$0")/../.."

# Overridable for self-testing against a perturbed /tmp copy — CI uses defaults.
CANONICAL_DIR="${SLO_PARITY_CANONICAL_DIR:-infra/observe/alerts}"
VALUES_FILE="${SLO_PARITY_VALUES_FILE:-infra/helm/kube-prometheus-stack/values-prod.yaml}"

if [[ ! -d "$CANONICAL_DIR" ]]; then
  echo "slo-rules-parity: FAIL — canonical rules dir not found: $CANONICAL_DIR" >&2
  exit 1
fi
if [[ ! -f "$VALUES_FILE" ]]; then
  echo "slo-rules-parity: FAIL — prod values file not found: $VALUES_FILE" >&2
  exit 1
fi

CANONICAL_DIR="$CANONICAL_DIR" VALUES_FILE="$VALUES_FILE" python3 - <<'PY'
import difflib
import glob
import os
import sys

import yaml

canonical_dir = os.environ["CANONICAL_DIR"]
values_file = os.environ["VALUES_FILE"]

with open(values_file) as f:
    values = yaml.safe_load(f) or {}
rules_map = values.get("additionalPrometheusRulesMap") or {}
if not isinstance(rules_map, dict):
    print(f"slo-rules-parity: FAIL — additionalPrometheusRulesMap in {values_file} "
          f"is not a mapping (got {type(rules_map).__name__})", file=sys.stderr)
    sys.exit(1)

canonical_files = sorted(glob.glob(os.path.join(canonical_dir, "*.rules.yml")))
if not canonical_files:
    print(f"slo-rules-parity: FAIL — no *.rules.yml found in {canonical_dir} "
          f"(canonical rules dir empty or moved?)", file=sys.stderr)
    sys.exit(1)

def normalize(node):
    """Structural normalization: yaml-load already canonicalizes scalars
    (booleans, ints, block vs flow strings); keep list ORDER (rule order is
    meaningful) but make dict key order irrelevant by sorted dumping later."""
    if isinstance(node, dict):
        return {k: normalize(v) for k, v in node.items()}
    if isinstance(node, list):
        return [normalize(v) for v in node]
    return node

def dump(node):
    return yaml.safe_dump(normalize(node), sort_keys=True, default_flow_style=False)

compared, warned, failed = [], [], False

for path in canonical_files:
    key = os.path.basename(path)[: -len(".rules.yml")]
    if key not in rules_map:
        warned.append((path, key))
        continue
    with open(path) as f:
        canonical = yaml.safe_load(f) or {}
    canon_groups = canonical.get("groups")
    prod_groups = (rules_map.get(key) or {}).get("groups")
    if canon_groups is None:
        print(f"slo-rules-parity: FAIL — {path} has no top-level `groups` key", file=sys.stderr)
        failed = True
        continue
    if prod_groups is None:
        print(f"slo-rules-parity: FAIL — additionalPrometheusRulesMap.{key} in "
              f"{values_file} has no `groups` key", file=sys.stderr)
        failed = True
        continue
    canon_dump, prod_dump = dump(canon_groups), dump(prod_groups)
    if canon_dump != prod_dump:
        failed = True
        print(f"slo-rules-parity: FAIL — DRIFT between canonical {path} and "
              f"{values_file} additionalPrometheusRulesMap.{key}.groups:", file=sys.stderr)
        diff = difflib.unified_diff(
            canon_dump.splitlines(keepends=True),
            prod_dump.splitlines(keepends=True),
            fromfile=f"canonical:{path}",
            tofile=f"values:additionalPrometheusRulesMap.{key}.groups",
        )
        sys.stderr.writelines(diff)
        print(file=sys.stderr)
    else:
        compared.append((path, key))

for key in sorted(rules_map):
    if not any(os.path.basename(p)[: -len(".rules.yml")] == key for p in canonical_files):
        print(f"slo-rules-parity: WARN — additionalPrometheusRulesMap.{key} has no "
              f"canonical {canonical_dir}/{key}.rules.yml (prod-only rules; consider "
              f"promoting to a canonical file)")

for path, key in warned:
    print(f"slo-rules-parity: WARN — canonical {path} has no prod copy under "
          f"additionalPrometheusRulesMap.{key} in {values_file} (local-only rules; "
          f"add to the values map when they should alert in prod)")

if failed:
    print("slo-rules-parity: FAIL — fix the drift by syncing the two copies "
          "(canonical file is the source of truth for rule content).", file=sys.stderr)
    sys.exit(1)

if not compared:
    # Green but loud: nothing was actually compared — every canonical file is
    # missing from the map. Warnings above list them.
    print("slo-rules-parity: OK — no canonical rules files present in "
          "additionalPrometheusRulesMap yet (0 compared; see warnings).")
    sys.exit(0)

print(f"slo-rules-parity: OK — {len(compared)} rules file(s) in parity:")
for path, key in compared:
    print(f"  {path}  ==  additionalPrometheusRulesMap.{key}.groups")
PY
