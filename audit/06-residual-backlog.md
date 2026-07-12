# Brain — True Residual Backlog (post-program sweep, 2026-07-12)

Full-corpus sweep of audit/, docs/adr, docs/runbooks, docs/ops, docs/cleanup, repo TODO/DEFERRED
markers and helm/flag seams, cross-checked against merged PRs #1–#66. Everything the completed
remediation program (Waves 1–4) does NOT cover. Excludes the user-tracked queue (Shopify creds,
Woo webhook, Slack/Alertmanager, PAT, SES) and by-design honest-empty marts.

## 1. Privacy & compliance — pending EXECUTION (not code)
| Item | Source | Effort | Owner |
|---|---|---|---|
| DPDP/RTBF synthetic-subject deletion drill in prod (harness merged #35, gated on owner scheduling; DEK-shred-under-prod-KMS still HYPOTHESIS) | audit/05 §AUD-OPS-040 | S (run) | user + ops |
| AUD-OPS-041 — verify `silver_consent_rejected` receives rows for no-consent pixel traffic (medallion definition-of-done never recorded) | audit/04:73 | S | ops |
| DSAR automated export (manual runbook exists; `customers/data_request` is ack-only) | AUD-OPS-043 | M | code |
| Erasure-aware Iceberg compaction over historical snapshots (DISABLED seam; interim = DEK-deny) | ADR-0002:53 | L | user-decision then code |

## 2. DONE-verify (probably done, never recorded — walk once and mark)
- 60/60 serving views: re-run `run-trino-views.sh` after real data lands (39/60 as of 2026-07-12; rest honest-empty-blocked).
- Staged-replay proof for the #34 MERGE-discipline fixes (fixes merged; the audit's parity-proof step unrecorded).
- Wave-3 hygiene basket per-item traceability vs #39/#41/#42 diffs.
- AUD-OPS-015 SNAPSHOT_TTL + version-restore script; AUD-INFRA-005/006 (Route53/ACM imported 2026-07-12 ✓; cronworkflows sync-policy ratify-or-remove).
- `UnwiredProdVaultKeyProvider` — confirm prod wires the real KMS provider.

## 3. Trigger-gated scale/cost knobs (parked BY DESIGN — pull when the alarm fires)
| Knob | Trigger |
|---|---|
| Spark-on-k8s executionMode cutover (RBAC pre-built) | 3+ SparkTierNearDeadline/week or ~5× volume |
| Aurora max ACU 2→8; Redis micro→small; Trino maxReplicas 3→4 | named CloudWatch alarms (tripwires live) |
| Entity-incremental adoption for ~19 full-refresh Silver jobs; attribution driver `collect()` ceiling | volume growth |
| AUD-IMPL-025 partition-spec migration on collector_events_connect (shipped in w3/scale-data — NOT yet RUN against prod) | Bronze growth |
| Batch-scheduling overlap: confirm p99 wall-clock < cron gaps (metric now exists), else Argo DAG | sustained load |
| Accepted SPOFs (Trino coordinator on spot, single kafka-connect, fck-nat) | availability incident |

## 4. Deploy/CD hardening — genuinely open
- Post-deploy smoke tests + auto-rollback are ECHO-ONLY in deploy.yml (M, code).
- infra.yml bootstrap TODOs (continue-on-error / OPA skip until dev state bucket + plan role exist) (S).
- EKS API → private-only once SSM bastion/Client VPN exists (/32 pin already caused one lockout) (M, user+ops).
- Periodic full image rebuild for CVE freshness (affected-only CI never rebuilds quiet apps) (S).
- iceberg-rest chart lacks restricted securityContext (PSA warning on 2026-07-12 restart; Wave-2 covered the 4 app charts only) (S).

## 5. Parked decisions needing the OWNER
| Decision | Note | Effort |
|---|---|---|
| AUD-ARCH-002: identity ingestion consumes RAW pre-gate topic (trusts claimed brand_id pre-R2/R3; polluted identities re-enter via export) | the one substantive architecture escalation | ruling S, fix L |
| AUD-ARCH-010: no RLS on `ops.*` tenant tables | tenant-isolation depth | M |
| AUD-ARCH-007: BRN- flat public id — ratify as-is? | one-line ratification | S |
| `journeys/compare` mount-or-delete (zero consumers) | dead surface | S |
| Authentik chart stub + `tools/dev/e2e-gate.wf.js` — keep or delete | cleanup leftovers | S |
| ADR-0006 D4 sign-off on the 7-day raw-PII retention value | record or ratify | S |

## 6. ADR-recorded residual debt (scale-gated code)
- ADR-0008 scheduler debt: per-run Pool/Kafka churn, redundant enumeration, uncached secret fetches, due-time stagger (M).

## 7. Stale-doc banner pass (cheap; will mislead the next reader)
ADR-0004 ("identity build not started" — done), ADR-0009 ("not applied" — fully applied),
docs/cleanup plans (executed), RB-5 checklist (executed). REAL item inside:
docs/infra/naming-and-tagging.md adoption checklist is genuinely unchecked (S–M).

## 8. By-design seams (no action; listed so they don't resurface)
Waves E–I flags OFF (fail-closed 501s); Waves A–D per-brand flags staged; deprecation-guard
allowlist = D.3 migration ledger; predictive marts DISABLED; cdc-log/file-settlement NotImplemented.

**Honest total:** ~8 code items (mostly M), ~6 ops verify/execute (mostly S; consent-gate check +
DPDP drill are the compliance-critical two), ~8 owner rulings (one L: AUD-ARCH-002), one doc pass.
The scale knobs need nothing today except that their alarms reach a human (→ Slack receiver).
