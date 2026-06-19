/**
 * attribution.api.v1.ts — shared contract for the attribution write-pipeline trigger.
 *
 * The reconcile op drives the credit/clawback writer over the realized ledger + Silver touches.
 * It is a system/batch trigger (recommend-only data plane), so the result is simple counts.
 */
import { z } from 'zod';

export const AttributionReconcileResultSchema = z.object({
  /** orders newly credited this run. */
  credited: z.number().int().nonnegative(),
  /** orders newly clawed back this run. */
  clawed_back: z.number().int().nonnegative(),
  /** finalized orders with no resolvable journey (left unattributed — honest). */
  unattributed: z.number().int().nonnegative(),
});
export type AttributionReconcileResult = z.infer<typeof AttributionReconcileResultSchema>;
