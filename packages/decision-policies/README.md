<!-- SPEC: H -->
# @brain/decision-policies

Versioned YAML **decision policies** + a compiler **skeleton**. Wave H **scaffold only** — see
`knowledge-base/contracts/CONTRACT-H.md`.

## What ships now
- `policies/*.v<n>.yaml` — versioned policy definitions. `(name, version)` → `gold_decisions.policy_version`.
- **Shape validator + compiler skeleton** (`compilePolicy` / `validatePolicy`): validates the YAML
  shape and resolves every constraint / expected-value metric reference against the **certified
  metric name set** (Wave D launch set — `CERTIFIED_METRICS`). Constraints reference certified
  metrics **only by name** (e.g. `cm2_pct >= 0.20`); a typo never compiles. This is why Wave D
  precedes Wave H runtime.
- `PolicyEvaluatorPort` (domain port) + `NotImplementedPolicyEvaluator` (fail-closed adapter).

## What is DEFERRED (does not exist here)
- The evaluation engine, EV models, and arbitration. The evaluator adapter **throws**; the YAML
  file→object parse seam (`loadPolicyDocument`) **throws**. No evaluator runs unless the DEFAULT-OFF
  per-brand flag `decision.engine` (`@brain/platform-flags`) is turned on.

## Related scaffold
`db/iceberg/gold_decisions_table.sql` — the (inert) decision-record DDL.
