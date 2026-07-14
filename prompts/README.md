<!-- SPEC: F.5 -->
# `prompts/` — git-backed, versioned prompt templates

This directory is the **version store** for every prompt template used by Brain's AI platform.
Git *is* the versioning mechanism — there is no prompts DB, no registry service, no runtime here.

## Rules
- **One file per template revision.** A template's version is encoded in the filename suffix
  (`*.v1.md`, `*.v2.md`, …). Never edit a shipped version in place — add a new `vN` file so the
  old revision stays reproducible (Iceberg time-travel / audit parity for the AI layer).
- **`manifest.json` is the authored index.** Every template file has an entry
  (`id`, `version`, `path`, optional `taskClass`, `description`). The `@brain/prompt-loader`
  package (`PromptManifest` / `PromptTemplateRef`) reads this shape.
- **No secrets, no PII, no per-brand data.** Templates are brand-agnostic; tenant context is
  injected at call time, never baked into a template.
- **`taskClass` aligns with LiteLLM routing.** A template's `taskClass` matches a
  `task_class_routing` alias in `infra/litellm.config.yaml` so the gateway routes it to the right
  model tier.

## Status (SCAFFOLD-ONLY — PLAN-OF-RECORD §PART 6)
The loader (`@brain/prompt-loader`) is a skeleton: `list()` reads the manifest, but `load()`
(fs text resolution) is `NotImplemented`. There is **no agent runtime** that consumes these
templates yet — that ships with a later wave.
