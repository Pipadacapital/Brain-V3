One PR consolidating the AI Growth OS first flagship slice, the strategy that justifies it, and the fixes that unblock a from-zero boot. Grounded in marts/modules that already exist — no lakehouse bypass, no parallel systems.

## What's in here (5 commits)

### 1. fix(cold-start) — unblock a true from-zero local boot (4 latent bugs)
- 0072: partition-twin index name collision in `audit` → renamed `…_p`.
- 0091/0092: unqualified `connector_instance` (node-pg-migrate pins search_path=public) → qualified `connectors.connector_instance`.
- collector Kafka producer: `idempotent:true`+`retries:0` rejected by KafkaJS → set `idempotent:false`.
- Apicurio: v1 header ignored on v2 → use `?ifExists=RETURN_OR_UPDATE`.

### 2. docs(strategy) — AI Growth OS blueprint (29-agent grounded workflow)
docs/strategy/brain-growth-os-blueprint.md — 22 deliverables. North Star = Reconciled GMV Under Decision. Bet: system of revenue truth. Adversarial Open-Risks appendix. Reproducible workflow in .eos-workflows/.

### 3–4. feat(insights) — Insight + Opportunity Engine + AI Copilot
- Engine (packages/metric-engine/src/insights.ts): computeInsights() over real Gold marts via withSilverBrand — revenue swing+driver, RTO leakage, churn LTV-at-risk, VIP concentration, CAC trend. Exact integer math, severity + $-impact + grounded why + confidence, ranked, honest no_data. Unit-tested.
- Briefing (GET /api/v1/insights/briefing): deterministic narrative — numbers from marts, never the model.
- UI (/insights + nav): Copilot briefing, $-quantified KPIs, revenue chart, ranked insight feed.

### 5. feat(insights) — close the loop (revenue engine)
materializeInsightsAsRecommendations persists insights as ai_config.recommendation (idempotent, dismissal-preserving) → Accept/Snooze/Dismiss write the append-only recommendation_action ledger; outcomes measurable via recommendation_outcome. The RGUD substrate.

## Verified
- metric-engine + core + web typecheck clean; insight-engine unit tests green.
- End-to-end on a real session: register → onboard → briefing returns 5 ranked insights (churn ₹8.7L · RTO 20%/₹4L · revenue −18% driver rto_reversal · CAC +25% MoM · VIP ₹12L) → 5 recommendations persisted → dismiss writes ledger (actor+reason), flips status, read-through preserves it.

## Notes for review
- /insights demo lit via tools/seed/insights-demo-seed.sh <brand> (seeds Gold marts through the real read path); full Bronze→Silver→Gold pipeline blocked locally (missing brain_oltp_pg StarRocks external catalog + empty Bronze). Wiring that catalog replaces the seeder with live data — next step.
- 0091/0092 already on master; qualification edits are no-ops for migrated DBs, fix fresh installs only.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
