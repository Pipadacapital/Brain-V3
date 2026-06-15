# PLAYBOOK — incident

> Owner: Platform/SRE. See `engineering-os-blueprint/07-operations-and-reliability.md §4`.
> Sources: doc 04 §12.6/§14.5/§16/§18.6 · doc 10 §13/§18 · doc 11 §10/§15.
> Last updated: 2026-06-15.

---

## Severity Ladder

| Sev | Definition | Response | Who's paged | Comms cadence |
|---|---|---|---|---|
| **SEV1** | Cross-brand data leak (any brand-A data visible to brand-B); OR collector data-loss (accepted events not in Bronze after spool drain); OR billing/ledger corruption (closed-period mutation, double-count, or hash-chain break on audit ledger); OR PII exfiltration or exposure of raw PII outside the vault | Immediate — within 5 minutes of detection | On-call Platform/SRE (primary) + CTO + Principal Architect + VP Eng — all simultaneously | Every 15 minutes until contained; initial message within 10 minutes of page |
| **SEV2** | Analytics API down or returning incorrect finalized numbers; ingestion backlog on the live Kafka lane exceeding SLO lag threshold for > 5 minutes; auto-rollback fired in prod; billing API unavailable; any single connector in Failed state for > 30 minutes affecting an active brand; parity oracle failing in prod (not yet a data leak, but correctness at risk) | Within 30 minutes | On-call Platform/SRE (primary) + affected service owner (secondary) | Every 30 minutes until resolved; initial message within 20 minutes of page |
| **SEV3** | Minor degradation with no data correctness risk: individual dashboard slow or unavailable; NLQ/AI narration unavailable (deterministic numbers still served); a single connector in Delayed or RateLimited state; non-critical background job (e.g. compaction) failing; staging environment down | Within 2 hours during business hours | On-call Platform/SRE (async — Slack/ticket) | Once on open, once on resolve; no recurring cadence |
| **SEV4** | No user impact: internal tooling issue, non-production environment issue, informational alert, metric spike that auto-resolved within the evaluation window | Next business day | Ticket only (no page) | On resolve |

**Resolution targets + escalation (doc 12 §10, authoritative):** SEV1 → **mitigate < 1 hour**; SEV2 → **< 4 hours**; SEV3 → next business day; SEV4 → next sprint. **Escalation chain:** on-call → EM → VP Eng → CTO. Platform/SRE runs the incident process; the owning stream fixes the root cause.

> ASSUMPTION: Specific page targets are listed by role rather than named individuals, as the source docs (doc 11 §2 RACI, doc 12 §10) define roles (CTO, VP Eng, EM, Platform/SRE) but not on-call rotation individuals. The on-call rotation schedule (who is Platform/SRE primary on-call on a given day) is maintained separately in the operations runbook. The 15/30-minute comms cadences are set by Platform/SRE judgment; doc 12 §10 fixes the *resolution* targets (<1h / <4h) but not the recurring comms cadence.

> ASSUMPTION: The "30 minutes for a single connector in Failed state" SEV2 threshold is set here. Doc 04 §13.2 defines the seven connector states and requires honest health reporting but does not specify a numeric escalation threshold.

---

## Roles

- **Incident Commander (IC):** single point of authority for the duration of the incident. Makes all mitigation and escalation decisions. Declares and closes severity. Owns the incident channel. For SEV1: CTO by default if available; otherwise most-senior available engineer explicitly named. For SEV2: VP Eng or Platform/SRE lead. For SEV3/4: on-call Platform/SRE.

- **Responders:** the engineers executing mitigation actions (applying kill switches, rolling back, investigating root cause). Report status to the IC only — no separate side channels during an active SEV1/2.

- **Comms lead:** for SEV1/2, one named person (separate from the IC) owns all external and internal stakeholder comms — status page updates, design-partner notifications, leadership updates. This role is explicitly not the IC (who must stay focused on technical decisions).

> ASSUMPTION: The "Comms lead" role is distinct from the IC as a best practice for SEV1/2; the source docs reference a public status surface and design-partner notification requirements (doc 11 §15/§6) but do not explicitly define an Incident Commander structure. This playbook formalizes it.

- **Scribe:** one named person documents the incident timeline in real time — every action taken, every decision made, with timestamps. The scribe's log is the input to the postmortem. For small teams, the scribe role may be filled by a responder who is not actively executing mitigations.

---

## Kill Switches (mitigate first)

The highest-risk surfaces in Brain are the isolation seams and the single-outbound-consent chokepoint (doc 04 §12.7). The following kill switches are the first-resort mitigations — apply them **before** diagnosing root cause when the surface matches.

| Surface | Switch | Latency | How to trigger |
|---|---|---|---|
| Per-brand data issue (incorrect numbers, wrong connector data, suspected leak for one brand) | Per-brand feature flag off — disables all Analytics API responses and recommendation surfacing for that brand; brand sees "data unavailable" state | ≤ 60 seconds from flag write to all pods honoring it | Write `flags.brand.<brand_id>.enabled = false` via the feature-flag admin API (packages/feature-flags); confirm with a test request within 60s |
| Notification / outbound send (accidental mass outreach, consent violation risk, WhatsApp blast risk) | Single send/consent chokepoint off — disables all outbound sends across all channels for all brands; in-product notifications remain | ≤ 60 seconds | Write `flags.global.notification.send_enabled = false`; the M10 Notification module checks this flag before every channel dispatch (doc 04 §A3.8 / §ADR-012) |
| Connector data ingestion (backfill storm, malformed events from a connector, suspected data quality attack) | Connector pause — pause the specific connector's backfill consumer group; live events remain if the connector is Healthy | ≤ 60 seconds (consumer group pause via Redpanda admin API) | `redpanda-ctl consumer-group pause --group backfill.<connector_id>`; confirm lag stops growing in Grafana |
| Collector overload / Redpanda degradation (spool approaching full, Redpanda partition errors) | Collector shed-load — the collector's backpressure guard returns 503 + Retry-After when the spool is full; this is automatic but can be forced to engage early by lowering the spool-full threshold via env var | < 30 seconds (env var change triggers rolling restart) | Update `SPOOL_FULL_THRESHOLD_MB` ConfigMap in `infra/k8s/collector/overlays/production/`; ArgoCD syncs the new threshold; existing traffic sheds until spool drains |
| AI / NLQ narration (model provider outage, injection attack detected, runaway cost) | Gateway circuit breaker — LiteLLM gateway open; all model-calling paths return the deterministic number with "narration unavailable" | Automatic (circuit breaker opens on threshold); manual force: set `flags.global.ai.narration_enabled = false` | The Analytics API's AI module already degrades to deterministic number when the gateway is down (doc 04 §11.1); the flag provides a clean forced-off path for security incidents |
| Full prod deployment lock (during an active SEV1 or SEV2 deploy-related incident) | ArgoCD prod Applications sync disabled — prevents any further manifest change from propagating to prod while the incident is active | Immediate (ArgoCD UI or CLI) | `argocd app set <app> --sync-policy none` for all prod Applications; re-enable after IC declares incident resolved |
| Recommendation surfacing (detector firing incorrectly, false positives at scale) | Recommendation flag off per brand or globally — the Recommendation module (M9) gates on `flags.brand.<brand_id>.recommendations_enabled`; a global flag off suppresses all recommendations | ≤ 60 seconds | Write `flags.global.recommendations_enabled = false` (or per-brand); Morning Brief and Home/Command Center show "no new recommendations" |

**Flag-key conventions (doc 12 §7, documented):** the canonical families are `connector.<type>.enabled`, `recommendation.<detector>.enabled`, `ai.<capability>.enabled`, `beta.<feature>`, plus per-brand `brand.<brand_id>.*` kill switches — all in `packages/feature-flags`, audited, NOT a targeting engine. The exact leaf keys used above are illustrative instances of these families; finalize them in the feature-flag registry at Sprint 0.

> ASSUMPTION: The `SPOOL_FULL_THRESHOLD_MB` env-var-based shed-load mechanism is specified here as the operational interface for the spool's backpressure guard (doc 04 §A3.1/§ADR-003 defines the guard but not the operational interface). The exact mechanism must be confirmed against the Collector implementation.

---

## Detection

Brain generates incidents through the following signals (doc 04 §15; observability skill):

| Signal | What it detects | Grafana alert name |
|---|---|---|
| `brain.collector.accept_ack_rate` < 99.95% for 5 min | Collector SLO breach | `collector-slo-breach` |
| `brain.api.error_rate` > 1% for 5 min per service | Product surface SEV2 | `api-error-rate-spike` |
| `brain.api.p95_latency_ms` > 2000 for 5 min | Latency SLO breach | `api-latency-spike` |
| `brain.kafka.live_lane_lag` > threshold for 5 min | Ingestion backlog | `kafka-live-lag-breach` |
| `brain.isolation.cross_brand_leak_count` > 0 | Cross-brand data leak (SEV1) | `isolation-leak-immediate` |
| `brain.parity_oracle.status` = failing | Parity / data correctness risk | `parity-oracle-failing` |
| `brain.audit_chain.hash_break` = true | Audit ledger tamper / corruption (SEV1) | `audit-chain-break` |
| `brain.kafka.dlq_depth` growing for 10 min per domain | DLQ accumulation | `dlq-depth-growing` |
| `brain.connector.failed_count` > 0 for 30 min | Connector in Failed state | `connector-failed` |
| `brain.starrocks.freshness_lag_minutes` > 30 | StarRocks serving stale | `starrocks-freshness-breach` |
| Error-budget fast-burn: 2% of monthly budget in 1 hour | SLO error budget exhausting rapidly | `slo-fast-burn` |

All alerts route to the on-call Platform/SRE via Grafana Alerting. SEV1-classified alerts (`isolation-leak-immediate`, `audit-chain-break`) additionally page CTO and VP Eng simultaneously without escalation delay.

---

## Flow

```
DETECT (SLO breach alert / error-budget burn alert / isolation count > 0)
  ↓
DECLARE SEVERITY (IC sets Sev; opens incident channel; names Comms lead + Scribe)
  ↓
MITIGATE FIRST — apply kill switch or rollback BEFORE diagnosing root cause
  │  ↓ cross-brand leak or audit chain break → SEV1 kill switch: flag off affected brand(s) + notify CTO immediately
  │  ↓ API down / parity failing → SEV2: ArgoCD rollback to last healthy revision
  │  ↓ collector backlog → shed-load or connector pause
  │  ↓ billing / ledger corruption → halt sealing for the affected period; notify VP Eng
  ↓
CONFIRM MITIGATION (Comms lead updates status page; IC confirms signals improving)
  ↓
RESOLVE ROOT CAUSE (Responders investigate; IC approves any further prod changes)
  ↓
CLOSE (IC declares resolved; Comms lead posts final status update)
  ↓
BLAMELESS POSTMORTEM (within 48 hours for SEV1 and SEV2 — doc 12 §10)
  ↓
ACTION ITEMS → lessons-learned.md + rule-proposals
```

**Postmortem window (doc 12 §10, authoritative):** blameless postmortem within **48 hours for both SEV1 and SEV2**, feeding lessons-learned tasks. (Exception: a confirmed cross-brand **PII** leak tightens to 24h — see Special Handling — given DPDP/PDPL notification windows.)

**Mitigate-first is non-negotiable.** The Incident Commander must apply at least one kill switch or rollback before the first comms update goes out. Root cause analysis runs in parallel with mitigation, not before it.

---

## Special Handling: Cross-Brand Data Leak (SEV1 — highest-risk surface)

Source: doc 04 §12.6; doc 10 §18 (risk: cross-brand leak = Critical).

A cross-brand data leak is **the existential risk** for Brain. Even one confirmed leak requires:

1. Immediate: IC declares SEV1, pages CTO + VP Eng + Principal Architect simultaneously.
2. Within 10 minutes: flag off the affected brands (or all brands if scope unclear); halt any in-flight migrations or connector syncs.
3. Within 15 minutes: first status update to internal stakeholders; evaluate whether the design partner must be notified (if their data was involved, notify within 1 hour per breach workflow doc 04 §12.6).
4. Within 30 minutes: contain the scope — identify whether the leak was at the API layer, StarRocks row policy, Redis cache, stream consumer, or a Postgres RLS miss. Use the CI isolation fuzzer results and the `isolation-leak-immediate` alert signal to narrow.
5. Within 2 hours: provide a written scope assessment to CTO/VP Eng covering: which brand(s) affected, what data class leaked, whether PII was involved, whether Bronze (immutable) was involved.
6. Breach notification obligations: if PII was involved, the Data Protection Officer must assess notification obligations under DPDP/PDPL within the incident. Do not wait for the postmortem.
7. Postmortem within 24 hours (not 48h) for a confirmed cross-brand PII leak, given regulatory notification windows.

> ASSUMPTION: The 24-hour postmortem window for a confirmed PII-involving leak is set here given DPDP/PDPL regulatory context. Doc 04 §12.6 defines the breach workflow but does not specify the postmortem window within it.

---

## Blameless Postmortem

**Postmortem document must include:**
1. Timeline (from scribe log, UTC timestamps, every action taken).
2. Root cause analysis (5-whys; no blame on individuals).
3. Contributing factors.
4. What went well (the systems/processes that contained the blast radius).
5. Action items (each with an owner, a due date, and a specific acceptance criterion).
6. Lessons learned → added to `.engineering-os/lessons-learned.md`.
7. Any resulting rule changes → proposed in `.engineering-os/rule-proposals/`.
8. SLO error budget impact (how much of the monthly budget was consumed; whether a feature-freeze is warranted per the SLO error-budget policy in the observability skill).

**The postmortem is never used to attribute blame.** The goal is system improvement. A person making a well-intentioned decision with the information available at the time is not blamed; the system that made that decision possible is examined.

---

## SLO Error-Budget Policy (summary — full policy in observability skill)

| Signal | Monthly budget (30d) | Fast-burn page threshold |
|---|---|---|
| Collector accept+ack (target 99.95%) | ~21.6 minutes/month | 2% of monthly budget consumed in 1 hour |
| Product surfaces / Analytics API (target 99.9%) | ~43.2 minutes/month | 2% of monthly budget consumed in 1 hour |

When the monthly error budget is exhausted for a service: **freeze non-critical releases** to that service until the SLI recovers. Open a postmortem even if no incident was declared. Platform/SRE + service owner conduct a monthly review.
