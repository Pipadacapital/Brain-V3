/**
 * /dashboard — permanent redirect to /home.
 * The dashboard was renamed "Home" in the redesigned IA (home has its own home-content.tsx).
 */
import { redirect } from 'next/navigation';

export const metadata = { title: 'Home — Brain' };

export default function DashboardPage() {
  redirect('/home');
}
