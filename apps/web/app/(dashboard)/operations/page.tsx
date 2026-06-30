/**
 * Operations — "Is data flowing and trustworthy?" (server shell).
 * Ingestion + connector-sync health + data-quality. Body filled by the page agent.
 */
import { OperationsContent } from './operations-content';

export const metadata = { title: 'Operations — Brain' };

export default function OperationsPage() {
  return <OperationsContent />;
}
