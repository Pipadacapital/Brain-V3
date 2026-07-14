#!/usr/bin/env bash
#
# serving-pii-guard.sh — Brain serving-layer PII-projection lint (BLOCKING CI gate).
#
# ADR-0007 invariant D6: PII never reaches serving. The app/BFF/metric-engine read ONLY
# the Trino serving views brain_serving.mv_* (db/trino/views/*.sql — thin projections over
# the Iceberg Gold/Silver marts). This guard is defense-in-depth for that invariant: it
# FAILS (exit 1) if any serving view PROJECTS an output column whose NAME matches a raw
# PII pattern — email / phone / first_name / last_name / full_name / address — as an
# underscore-delimited segment (so customer_email, billing_address, email … all flag).
#
# ALLOWED (hashed/derived forms carry no raw PII):
#   • email_sha256 / phone_sha256 / email_domain  (exact names)
#   • *_hash / *_hashed                            (hash-suffixed, e.g. customer_email_hash)
#   • hashed_*                                     (hash-prefixed, e.g. hashed_customer_email —
#                                                   the live mv_silver_return form)
#   • has_*                                        (boolean presence flags, e.g. has_email,
#                                                   has_address — the live mv_silver_checkout_signal form)
#   • an EXPLICIT_ALLOW entry ("<file>:<column>") — a documented, reviewed exception ONLY.
#
# SCOPE (by design):
#   • Only PROJECTED output column names/aliases — the SELECT list. A raw-PII word in a
#     WHERE/GROUP BY, a table name, or a source-column reference inside an aliased
#     expression does NOT flag (it never reaches the serving output schema).
#   • `--` comments are stripped before matching (same technique run-trino-views.sh uses
#     to prep statements), so prose in view headers never flags.
#   • The parser is line-oriented, tuned to the thin-projection style of these views
#     (SELECT, one column per line, FROM). That is CI-checkable here because serving
#     views are REQUIRED to be thin projections (no compute, no inline subqueries).
#
# Usage:
#   tools/lint/serving-pii-guard.sh          # scan db/trino/views/*.sql; exit 1 on any violation
#   VIEWS_DIR=path tools/lint/serving-pii-guard.sh   # scan a different views dir (self-test uses this)
#
# Self-test: tools/lint/serving-pii-guard-test.sh (fixture corpus; run by CI first).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

VIEWS_DIR="${VIEWS_DIR:-db/trino/views}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'
violations=0
scanned=0

# ── Explicit per-column allowlist ────────────────────────────────────────────────────────────────
# Format: "<file basename>:<projected column name>" — ONE line per entry, each with a comment
# explaining WHY the column is not raw PII (or a TODO to remove it). Empty today: no current
# serving view projects raw PII. Add here ONLY with review — never weaken the pattern instead.
EXPLICIT_ALLOW=(
  # e.g. "mv_gold_example.sql:support_email"  # TODO(ticket): rename to support_email_sha256
)

is_explicitly_allowed() { # $1 = "<file>:<column>"
  local e
  [ "${#EXPLICIT_ALLOW[@]}" -eq 0 ] && return 1
  for e in "${EXPLICIT_ALLOW[@]}"; do [ "$e" = "$1" ] && return 0; done
  return 1
}

# Print a violation and bump the counter.
flag() { # $1 rule  $2 file:line  $3 message
  printf '%s✖ [%s]%s %s\n      %s\n' "$RED" "$1" "$RST" "$2" "$3"
  violations=$((violations + 1))
}

# ── SELECT-list projection extraction ────────────────────────────────────────────────────────────
# Emits "<lineno>\t<projected column name>\t<matched PII token>" for every violating projection.
# Strips `--` comments first (whole-line AND trailing), tracks SELECT…FROM ranges across lines
# (handles WITH CTEs and multiple SELECTs), then resolves each SELECT-list item to its OUTPUT
# name: the `AS alias` if present, else the last dotted component of a bare column reference.
# Expressions without an alias have no projected name here and are skipped (Trino auto-names them).
scan_view() { # $1 = file; writes violations via stdout
  awk '
    BEGIN {
      pii  = "(^|_)(email|phone|first_name|last_name|full_name|address)(_|$)"
      allow = "^(email_sha256|phone_sha256|email_domain)$"
      ntok = split("email phone first_name last_name full_name address", toks, " ")
    }
    # boundary-aware keyword search on lowercased text; returns position AFTER the keyword (0 = absent)
    function kw_after(s, kw,    r) {
      if (match(s, "(^|[^a-z0-9_])" kw "([^a-z0-9_]|$)")) return RSTART + RLENGTH
      return 0
    }
    function kw_start(s, kw) {
      if (match(s, "(^|[^a-z0-9_])" kw "([^a-z0-9_]|$)"))
        return (substr(s, RSTART, 1) ~ /[a-z]/) ? RSTART : RSTART + 1
      return 0
    }
    function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function emit(name,    t) {
      if (name ~ allow) return
      if (name ~ /_hash(ed)?$/) return
      if (name ~ /^hashed_/) return
      if (name ~ /^has_/) return
      for (t = 1; t <= ntok; t++)
        if (name ~ ("(^|_)" toks[t] "(_|$)")) { printf "%d\t%s\t%s\n", FNR, name, toks[t]; return }
    }
    function scan_list(listpart,    items, n, i, item, name) {
      n = split(listpart, items, ",")
      for (i = 1; i <= n; i++) {
        item = trim(items[i])
        if (item == "" || item == "*") continue
        sub(/^distinct[ \t]+/, "", item)
        gsub(/"/, "", item)
        if (match(item, /[ \t]as[ \t]+[a-z_][a-z0-9_]*$/)) {
          # aliased projection — the alias IS the output name
          name = substr(item, RSTART, RLENGTH)
          sub(/^[ \t]as[ \t]+/, "", name)
          emit(name)
        } else if (item ~ /^[a-z_][a-z0-9_.]*$/) {
          # bare (possibly qualified) column reference — output name = last dotted component
          name = item
          sub(/^.*\./, "", name)
          emit(name)
        }
        # anything else is an unaliased expression fragment — no projected name, skip
      }
    }
    {
      line = tolower($0)
      sub(/--.*$/, "", line)          # strip -- comments (run-trino-views.sh technique + inline)
      # Walk the line: alternate between "in a SELECT list" and "past FROM" states.
      while (line != "") {
        if (!insel) {
          p = kw_after(line, "select")
          if (p == 0) { line = ""; break }
          insel = 1
          line = substr(line, p)
        } else {
          q = kw_start(line, "from")
          if (q == 0) { scan_list(line); line = ""; break }
          scan_list(substr(line, 1, q - 1))
          insel = 0
          line = substr(line, q + 4)   # continue after FROM (catches a same-line subquery SELECT)
        }
      }
    }
  ' "$1"
}

# ── Main ────────────────────────────────────────────────────────────────────────────────────────
echo "${YEL}serving-pii-guard${RST} — scanning ${VIEWS_DIR}/*.sql for raw-PII projections (ADR-0007 D6)…"

if [ ! -d "$VIEWS_DIR" ]; then
  echo "${RED}serving-pii-guard FAILED: views dir '${VIEWS_DIR}' does not exist (misconfiguration must not pass silently).${RST}"
  exit 2
fi

shopt -s nullglob
files=("$VIEWS_DIR"/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "${RED}serving-pii-guard FAILED: no *.sql files found in '${VIEWS_DIR}' — the serving layer cannot be empty (fail-closed).${RST}"
  exit 2
fi

for f in "${files[@]}"; do
  scanned=$((scanned + 1))
  base="$(basename "$f")"
  while IFS=$'\t' read -r lineno name token; do
    [ -z "${name:-}" ] && continue
    if is_explicitly_allowed "$base:$name"; then
      echo "${YEL}  ~ [D6-allow] $f:$lineno — '$name' matches PII token '$token' but is EXPLICITLY allowlisted (see EXPLICIT_ALLOW).${RST}"
      continue
    fi
    flag D6 "$f:$lineno" "serving view projects raw-PII column '$name' (matched token: $token) — PII must never reach serving (ADR-0007 D6); project a hashed/derived form (${token}_sha256 / *_hash / has_${token}) instead"
  done < <(scan_view "$f")
done

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "${RED}serving-pii-guard FAILED: ${violations} raw-PII projection(s) in ${scanned} view file(s).${RST}"
  echo "ADR-0007 D6: PII never reaches serving. The Trino serving views (brain_serving.mv_*) are the"
  echo "ONLY surface the app/BFF/metric-engine read — they must project hashed/derived forms only"
  echo "(email_sha256, phone_sha256, *_hash, *_hashed, hashed_*, has_*, email_domain). Do NOT weaken"
  echo "the pattern; a reviewed exception goes in EXPLICIT_ALLOW with a WHY comment + TODO."
  exit 1
fi

echo "${GRN}✓ serving-pii-guard passed — ${scanned} view file(s) scanned; no raw-PII column projected into serving.${RST}"
exit 0
