/**
 * Data Journey (Medallion) page — server component shell.
 *
 * Traces a brand's data through the medallion pipeline stages
 * Bronze → Silver → Identity → Gold → Serving, so the user can SEE where their data is,
 * how fresh each stage is, and where (honestly) it hasn't arrived yet.
 */
import { MedallionJourneyContent } from './medallion-journey-content';

export const metadata = { title: 'Data Journey — Brain' };

export default function MedallionJourneyPage() {
  return <MedallionJourneyContent />;
}
