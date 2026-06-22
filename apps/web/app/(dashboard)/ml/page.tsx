/**
 * ML page — server-component shell (C5 ML platform — model registry + serving).
 * BFF-only (I-ST01): the registry + serving are read via /api/v1/ml/*.
 */
import { MlContent } from './ml-content';

export const metadata = { title: 'Models — Brain' };

export default function MlPage() {
  return <MlContent />;
}
