#!/usr/bin/env bash
#
# structured-log-guard.sh — structured-logging regression guard (AUD-OBS-2, BLOCKING CI gate).
#
# R-05 swept ~223 `console.*` call sites across the deployable services onto the structured
# pino logger (`createLogger` in @brain/observability — JSON lines, service field, brand_id/
# correlation_id child bindings, NN-6 PII redaction, error-level → Sentry capture). A raw
# `console.log/info/warn/error/debug` in service code silently BYPASSES all of that: no level
# discipline, no correlation context, no redaction, no error tracking. This guard keeps the
# sweep swept: it FAILS (exit 1) on any non-comment, non-allowlisted `console.*` call in the
# deployable backend service source trees.
#
# SCOPE (deliberately narrow — do not boil the ocean):
#   apps/collector/src, apps/core/src, apps/stream-worker/src   (*.ts, excluding *.test.ts)
# Out of scope: apps/web (browser/Next.js — different logging story), packages/ (libraries may
# be used from CLIs; the services wrap them), tests, tools, scripts.
#
# ALLOWLIST (tools/lint/structured-log-guard-allowlist.txt): file paths where a raw stdout
# write is the POINT (e.g. a CLI job printing a machine-readable JSON report). One path per
# line, '#' comments allowed.
#
# Comment handling: a match on a line whose statement-part is a comment (`//`, `*`, `/*`
# prefixes, or `console.` appearing after `//` on the line) is NOT a violation — prose that
# mentions console.* is fine.
#
# Usage:
#   tools/lint/structured-log-guard.sh             # scan; exit 1 on any violation
#   tools/lint/structured-log-guard.sh --selftest  # prove catch + comment-skip + allowlist
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ALLOWLIST="${REPO_ROOT}/tools/lint/structured-log-guard-allowlist.txt"
SCAN_ROOTS=("apps/collector/src" "apps/core/src" "apps/stream-worker/src")
PATTERN='console\.(log|info|warn|error|debug)[[:space:]]*\('

# scan <root-dir> [allowlist-file] — prints violations "path:line:content", returns 1 if any.
scan() {
  local root="$1" allowlist="${2:-}"
  local violations=0
  local matches
  # grep -rn over *.ts excluding tests; no matches → clean.
  matches="$(grep -rnE "$PATTERN" "$root" --include='*.ts' --exclude='*.test.ts' 2>/dev/null || true)"
  [ -z "$matches" ] && return 0
  while IFS= read -r hit; do
    local file="${hit%%:*}" rest="${hit#*:}"
    local line="${rest%%:*}" content="${rest#*:}"
    # Strip leading whitespace for the comment-prefix check.
    local trimmed="${content#"${content%%[![:space:]]*}"}"
    case "$trimmed" in
      '//'*|'*'*|'/*'*) continue ;; # comment line — prose mention, not a call
    esac
    # `console.` only after an inline `//` on the line → comment mention, not a call.
    local before_console="${content%%console.*}"
    case "$before_console" in
      *'//'*) continue ;;
    esac
    # Allowlisted file (repo-relative path match)?
    if [ -n "$allowlist" ] && [ -f "$allowlist" ]; then
      local rel="${file#"${REPO_ROOT}"/}"
      if grep -qxF "$rel" <(grep -v '^\s*#' "$allowlist" | grep -v '^\s*$'); then
        continue
      fi
    fi
    echo "VIOLATION ${file}:${line}: ${trimmed}"
    violations=1
  done <<< "$matches"
  return "$violations"
}

selftest() {
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/src"

  # 1) A raw console call MUST be caught.
  printf 'export function f() {\n  console.log("raw");\n}\n' > "$tmp/src/bad.ts"
  if scan "$tmp/src" >/dev/null 2>&1; then
    echo "SELFTEST FAIL: raw console.log not caught" >&2; return 1
  fi

  # 2) Comment mentions MUST be skipped (line comment + inline comment + doc star).
  printf '// console.log("in a comment")\n * console.info in a docstring\nconst x = 1; // console.warn(mention)\n' > "$tmp/src/bad.ts"
  if ! scan "$tmp/src" >/dev/null 2>&1; then
    echo "SELFTEST FAIL: comment mention flagged" >&2; return 1
  fi

  # 3) Test files MUST be excluded.
  printf 'console.log("test output");\n' > "$tmp/src/thing.test.ts"
  if ! scan "$tmp/src" >/dev/null 2>&1; then
    echo "SELFTEST FAIL: *.test.ts not excluded" >&2; return 1
  fi
  rm -f "$tmp/src/thing.test.ts"

  # 4) Allowlist MUST be honored (repo-relative path). Emulate by scanning a repo-rooted temp file.
  local relroot="tools/lint/.structured-log-guard-selftest.$$"
  mkdir -p "${REPO_ROOT}/${relroot}"
  printf 'console.log(JSON.stringify(report));\n' > "${REPO_ROOT}/${relroot}/cli.ts"
  printf '%s/cli.ts\n' "$relroot" > "$tmp/allow.txt"
  local rc=0
  scan "${REPO_ROOT}/${relroot}" "$tmp/allow.txt" >/dev/null 2>&1 || rc=$?
  rm -rf "${REPO_ROOT}/${relroot}"
  if [ "$rc" -ne 0 ]; then
    echo "SELFTEST FAIL: allowlisted file flagged" >&2; return 1
  fi

  echo "structured-log-guard selftest OK (catch, comment-skip, test-exclude, allowlist)"
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

fail=0
for root in "${SCAN_ROOTS[@]}"; do
  scan "${REPO_ROOT}/${root}" "$ALLOWLIST" || fail=1
done

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'EOF'

structured-log-guard: raw console.* call(s) in deployable service source (AUD-OBS-2).
Use the service's structured logger instead (apps/<svc>/src/log.ts → createLogger from
@brain/observability): levels, brand_id/correlation_id bindings, PII redaction, and
error-level Sentry capture all come for free. If a raw stdout write is genuinely the
point (CLI report output), add the repo-relative path to
tools/lint/structured-log-guard-allowlist.txt with a justifying comment.
EOF
  exit 1
fi
echo "structured-log-guard: clean (no raw console.* in deployable service source)"
