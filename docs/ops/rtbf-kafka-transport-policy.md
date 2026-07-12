# RTBF policy — Kafka is a transient transport (broker logs are NOT purged per subject)

Audit trail: **AUD-TP-23** (MEASURED). The RTBF/erasure chain
(`EraseSubjectUseCase` → crypto-shred + PG hard-delete + Neo4j tombstone →
`bronze-raw-erasure` Iceberg deletes → snapshot expiry) purges every **store**. It does
**not** — and by policy does not need to — purge **Kafka broker logs**. This document states
that policy, the measured retention math that makes it sound, and the invariants that keep it
sound.

## Policy statement

Kafka is a **transient transport**, not a system of record. Bronze (Iceberg) is the source of
truth; every byte on a Brain topic either lands in Bronze (where per-subject erasure DOES
reach it) or ages out of the broker by retention. Per-subject deletion of broker log segments
is not implemented anywhere in the industry-standard sense (segments are immutable); Brain's
compliance posture is **bounded retention + downstream erasure**, the same posture the Iceberg
side uses for pre-delete snapshots ("physically complete after snapshot expiry" —
`docs/runbooks/adr-0010-kafka-connect-bronze.md`).

## Measured retention (prod — `infra/helm/strimzi-kafka/values.yaml` + `values-prod.yaml`)

| Scope | Setting | Value |
|---|---|---|
| Broker default | `logRetentionMs` | **7 days** (604800000) |
| `standard` topics (collector event lane + connector lanes) | `topics.retention.standardMs` | **7 days** |
| `long` topics (order-backfill, DLQ, quarantine) | `topics.retention.longMs` | **30 days** |

So the WORST-case lifetime of any subject byte on a broker is **30 days** from production
(DLQ/quarantine/backfill lanes); the common case is **7 days**. After an erasure request, any
broker-resident copies of the subject's events are physically gone within those windows with
no operator action — this bound is the erasure-completion tail for the transport layer, and it
is compatible with the DPDP/PDPL "reasonable period" posture the platform already claims for
Iceberg snapshot expiry.

## Invariants that keep this policy valid (check on ANY change to these)

1. **Retention never exceeds the erasure SLA.** Raising `standardMs`/`longMs` (or any new
   topic's retention) above 30 days requires revisiting this policy FIRST — at that point
   "transient" stops being true.
2. **No compacted topics carry subject data.** Compaction (`cleanup.policy=compact`) retains
   the latest record per key indefinitely — that would make the broker a store. Brain topics
   are delete-policy only; keep it that way (Connect's internal topics are compacted but carry
   connector configs, not subject data).
3. **NO-RAW-PII on the wire.** Envelopes carry hashed identifiers
   (`hashed_customer_email/phone`) + raw anon/device ids — never raw email/phone (the same
   invariant `erasure_raw_delete.py` relies on). A producer change that puts raw PII on a
   topic breaks this policy's risk math, not just the erasure job.
4. **Everything lands.** The "transient" claim holds because the Connect sink is always-on
   and loss within retention is recoverable (replay). An outage that threatens to outlive
   retention is an event-loss emergency (see the AUD-OPS-018 recovery section in the ADR-0010
   runbook), not merely a freshness problem.
5. **DSAR exports do not query Kafka** — Bronze supersets it
   (`docs/runbooks/dsar-manual-export.md`).

## What an erasure request actually touches (for the record)

PG (crypto-shred DEK + `erase_contact_pii_for_customer`) → Neo4j (tombstone + erased mark) →
Iceberg Bronze (`erasure_raw_delete.py` column-equality + payload-path DELETEs) → Silver/Gold
(scoped recompute drops the subject on the next fold) → Iceberg history
(`bronze_maintenance.py` `expire_snapshots`) → **Kafka: nothing, by this policy — retention
does it.**
