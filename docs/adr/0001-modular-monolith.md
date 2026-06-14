# ADR-0001 — Modular monolith first, 3 deployables
Status: Accepted. See docs/04 §B (ADR-001..013) in the Brain-docs repo for the full set.
Decision: Collector + stream-worker + core monolith + Argo jobs. Bounded contexts are
import-lint-enforced internal modules; extraction (Identity P2, Billing P2, Python ML P3)
is a move-a-folder operation. Context/Consequences: docs/04 §B.
