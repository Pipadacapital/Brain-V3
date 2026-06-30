/**
 * segment.api.v1 — Zod contracts for the saved-segments CRUD + preview BFF surface (P2).
 *
 * THE SINGLE SOURCE OF TRUTH for the saved-segment request/response shapes. Core's use-case
 * return types and web's consumer types BOTH derive from these schemas (z.infer); neither
 * hand-redeclares a covered DTO. A field rename/removal fails the alignment guard + the core
 * `satisfies` (compile-time).
 *
 * A saved segment is OPERATIONAL state (ops.saved_segment, migration 0120) — a user-authored
 * customer-segment DEFINITION (the RFM / lifecycle / affinity / churn rule tree), NOT an
 * analytical fact. The `definition` JSONB is OPAQUE to the API: validated only as a JSON object
 * (a non-null, non-array record), re-evaluated at RUN TIME against the Silver/Gold serving spine
 * (Brain has NO permanent feature-precompute table — segments persist as their RULE, never a
 * materialized member list). brand_id is ALWAYS session-derived (D-1), never in the body/header.
 *
 * INVARIANTS (02-architecture.md §3):
 *  - Counts use MinorUnitsSchema (bigint-as-string, `^-?\d+$`) — identical serialization to money.
 *  - Honest-empty preview = z.discriminatedUnion('state', [...]); `no_data` carries NO has_data fields.
 *  - Schemas are NOT `.strict()`: core may ADD a benign field without breaking web reads.
 */
import { z } from 'zod';
import { MinorUnitsSchema } from './_money.js';

// ── Opaque segment definition — validated as a JSON object only ────────────────
// The rule tree's INNER shape is owned by the (run-time) metric-engine evaluator, not the API
// boundary. We assert it is a non-null JSON object so a malformed scalar/array is rejected at
// the seam, but we DO NOT constrain its keys (forward-compatible with new predicate kinds).
export const SegmentDefinitionSchema = z.record(z.unknown());
export type SegmentDefinition = z.infer<typeof SegmentDefinitionSchema>;

// ── A persisted saved segment (one ops.saved_segment row) ──────────────────────
export const SavedSegmentDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: SegmentDefinitionSchema,
  created_by: z.string(),
  created_at: z.string(), // ISO-8601
  updated_at: z.string(), // ISO-8601
});
export type SavedSegmentDto = z.infer<typeof SavedSegmentDtoSchema>;

// ── GET /v1/segments — the brand's saved segments (newest first) ───────────────
export const SavedSegmentListSchema = z.object({
  segments: z.array(SavedSegmentDtoSchema),
});
export type SavedSegmentList = z.infer<typeof SavedSegmentListSchema>;

// ── POST /v1/segments — create one segment (brand + actor from session) ────────
export const CreateSegmentRequestSchema = z.object({
  name: z.string().min(1).max(200),
  definition: SegmentDefinitionSchema,
});
export type CreateSegmentRequest = z.infer<typeof CreateSegmentRequestSchema>;

// ── PUT /v1/segments/:id — rename and/or edit the rule tree ───────────────────
// At least one of name/definition must be present (enforced at the route).
export const UpdateSegmentRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  definition: SegmentDefinitionSchema.optional(),
});
export type UpdateSegmentRequest = z.infer<typeof UpdateSegmentRequestSchema>;

// ── POST /v1/segments/preview — count matching customers WITHOUT persisting ────
// Reuses the existing customer-base count path (gold_customer_360 via the metric-engine). The
// definition is opaque/run-time-evaluated; absent a rule evaluator the preview returns the
// brand's addressable customer base count so the UI can show an honest order-of-magnitude.
export const SegmentPreviewRequestSchema = z.object({
  definition: SegmentDefinitionSchema,
});
export type SegmentPreviewRequest = z.infer<typeof SegmentPreviewRequestSchema>;

export const SegmentPreviewResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('no_data') }),
  z.object({
    state: z.literal('has_data'),
    matched_customers: MinorUnitsSchema, // bigint → string (count)
    total_customers: MinorUnitsSchema, // bigint → string (addressable base; matched denominator)
  }),
]);
export type SegmentPreviewResult = z.infer<typeof SegmentPreviewResultSchema>;
