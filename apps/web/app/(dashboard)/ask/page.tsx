/**
 * Ask Brain page — server component shell (Phase 8, feat-decision-intelligence-inputs).
 *
 * The Decision-Intelligence surface: ask a NL question → a resolved registry binding,
 * the certified metric-engine number, its confidence grade, and provenance. BFF-only read.
 */
import { AskBrainContent } from './ask-content';

export const metadata = { title: 'Ask Brain — Brain' };

export default function AskBrainPage() {
  return <AskBrainContent />;
}
