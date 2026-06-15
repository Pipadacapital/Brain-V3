#!/usr/bin/env bash
# PreToolUse(Bash) guard: block direct `git push` to master/main.
# Rule: never push to the default branch directly — branch first, then open a PR.
# Reads the hook JSON on stdin; emits a PreToolUse "deny" decision when the
# command would update remote master/main. Anything else: allow (exit 0).
# Strict: no per-command override.

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Only inspect actual `git push` invocations.
printf '%s' "$cmd" | grep -qE '\bgit[[:space:]]+push\b' || exit 0

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Blocked: do not push directly to master/main. Create a feature branch first:  git switch -c feat/<name> && git push -u origin feat/<name>  then open a PR."}}'
  exit 0
}

# 1) Explicit master/main as the pushed ref or refspec destination
#    (matches " master", ":master", " main", ":main"; NOT "feat/main-nav").
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]]|:)(master|main)([[:space:]]|$)'; then
  deny
fi

# 2) Plain push (no explicit refspec) while the current branch is master/main.
#    "Plain" = at most one non-flag arg after `git push` (the remote name).
push_args=$(printf '%s' "$cmd" | sed -E 's/.*git[[:space:]]+push//')
count=$(printf '%s' "$push_args" | tr ' ' '\n' | grep -vE '^-' | grep -cE '.')
if [ "$count" -le 1 ]; then
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$cur" = "master" ] || [ "$cur" = "main" ]; then
    deny
  fi
fi

exit 0
