/**
 * /analytics/conversion-feedback — permanent redirect to /marketing?tab=conversion-feedback.
 * The CAPI conversion-passback surface was folded into the Marketing tab.
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Conversion Feedback — Brain' };

export default function ConversionFeedbackPage() {
  redirect('/marketing?tab=conversion-feedback');
}
