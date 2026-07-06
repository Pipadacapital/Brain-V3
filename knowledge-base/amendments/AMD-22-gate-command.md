<!-- SPEC: 0.4 -->
# AMD-22 — Gate command vs actual turbo task names (§0.2)

**Status:** FILED · RESOLVED — R1 adopted (BINDING)
**Date:** 2026-07-06
**Blocks:** every wave gate (GATE-A onward)

## Conflicting spec text
> §0.2 "A gate is passed only when: […] 2. `pnpm turbo build lint test` passes across the monorepo with zero new warnings."

## Ground truth (verified 2026-07-06 against turbo.json)
turbo.json defines NO `test` task. Actual tasks: `build`, `typecheck`, `lint`, `test:unit`, `test:contract`, `test:isolation`, `test:parity`, `gen:contracts`, `dev`. `pnpm turbo build lint test` fails immediately with an unknown-task error; `test:isolation`/`test:parity` additionally require the live stack and cannot be an unconditional CI gate.

## Candidate resolutions
### R1 — Define the gate on existing task names (adopted)
The gate command is:

```
pnpm turbo build lint test:unit test:contract
```

plus the wave's **spec-named tests** (tests named after spec sections per §0.5, which may live in test:isolation/test:parity lanes and run against the live stack, with evidence recorded in the gate file).
- Trade-offs: the stack-dependent suites are gate-evidence rather than part of the one-line command; explicitly listed per gate file.

### R2 — Add an aggregate `test` task to turbo.json
- Trade-offs: repo-wide CI semantics change outside this program's additive scope; an aggregate depending on test:isolation/test:parity breaks in stack-less CI, and one excluding them is just R1 with an alias.

## RECOMMENDED resolution (BINDING)
**R1.** Zero repo change (additive by omission); gates become executable exactly as written. All GATE-<wave>.md files cite this command.
