# Brain

Brain is an AI-native commerce OS.

## Product purpose
Capture Truth -> Build Trust -> Enable Decisions

## Product sequence
Registration -> Verification -> Organization -> Brand -> Region -> Team -> Shopify -> Pixel -> Verification -> Initial Sync -> Health -> Progressive Unlock -> Centers -> Recommendations -> Outcomes -> Learning

## Core rules
- Data foundation comes before dashboards.
- No empty charts as a success state.
- No event loss.
- Bronze is source of truth.
- Journey before attribution.
- Deterministic first.
- Revenue truth over platform truth.
- Confidence before decisions.

## Operating standards
- Prefer small, reversible, auditable changes.
- Treat integrations as unreliable.
- Preserve tenant isolation.
- Support replay, backfill, deduplication, and retries.
- Respect regional residency and privacy.
- Add tests for any behavior change.
- Verify with logs, metrics, or reproducible evidence.

## Product areas
- Auth and account setup
- Organization and brand management
- RBAC
- Pixel and browser tracking
- Connector ecosystem
- Identity resolution
- Journey reconstruction
- Revenue truth
- Attribution
- Conversion feedback
- Data quality
- Decision intelligence

## Review checklist
- Is the architecture aligned with Brain’s purpose?
- Does the database support the flow without unnecessary redesign?
- Does the UI build trust before insight?
- Does the system fail safely?
- Can data be replayed and audited?
- Are confidence and freshness measurable?