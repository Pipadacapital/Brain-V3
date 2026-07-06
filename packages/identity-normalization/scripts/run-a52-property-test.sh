#!/usr/bin/env bash
# SPEC: A.5.2
# run-a52-property-test.sh — single-script cross-language hash-equivalence property test (WA-06).
#
# 1) Node/TS writes a deterministic 12k-row corpus (raw identifier + TS-side normalized +
#    interop + internal hashes) as JSONL.
# 2) Python re-derives every field from `raw` with the twin module and diffs byte-for-byte.
#
# Passes iff the Python differ prints MISMATCHES=0 over >=10k rows (A.5.2).
# Requires: pnpm workspace installed; python3 with `phonenumbers` (pip).
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${PKG_DIR}/../.." && pwd)"
CORPUS="$(mktemp -t a52-corpus.XXXXXX).jsonl"
trap 'rm -f "${CORPUS}"' EXIT

echo "[a52] generating corpus (TS) -> ${CORPUS}"
(cd "${PKG_DIR}" && pnpm exec tsx src/a52-gen-corpus.ts "${CORPUS}")

echo "[a52] re-deriving + diffing (Python twin)"
python3 "${REPO_ROOT}/db/iceberg/spark/_identity_normalization_xlang_test.py" "${CORPUS}"
