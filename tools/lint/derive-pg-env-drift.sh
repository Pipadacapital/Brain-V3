#!/usr/bin/env bash
# derive-pg-env-drift.sh — DR-007 GAP 7: the PG-env derivation exists as TWO byte-copies
# (Helm cannot .Files.Get across charts):
#   infra/helm/cronworkflows/files/derive-pg-env.sh      (the original "single fix point")
#   infra/helm/transform-worker/files/derive-pg-env.sh   (the resident chart's copy)
# The copy's header may carry an extra keep-in-sync annotation block; every functional line
# MUST be byte-identical. This gate makes the "edit here only" doctrine enforceable.
set -euo pipefail
A="infra/helm/cronworkflows/files/derive-pg-env.sh"
B="infra/helm/transform-worker/files/derive-pg-env.sh"
[ -f "$A" ] && [ -f "$B" ] || { echo "✗ derive-pg-env drift-check: missing $A or $B" >&2; exit 1; }
# Compare with comment lines stripped (the copy is allowed an annotation header, nothing else).
if diff -u <(grep -v '^\s*#' "$A") <(grep -v '^\s*#' "$B") >/dev/null; then
  echo "✓ derive-pg-env copies in sync (functional lines byte-identical)"
else
  echo "✗ derive-pg-env DRIFT between $A and $B — edit the cronworkflows original, re-copy:" >&2
  diff -u <(grep -v '^\s*#' "$A") <(grep -v '^\s*#' "$B") >&2 || true
  exit 1
fi
