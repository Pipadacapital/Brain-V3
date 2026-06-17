/**
 * Dashboard page — server component shell (Next.js App Router).
 * Client data-fetching is delegated to DashboardContent (use client).
 */
import { DashboardContent } from './dashboard-content';

export const metadata = { title: 'Dashboard — Brain' };

export default function DashboardPage() {
  return <DashboardContent />;
}
