/**
 * Home — "How is my business doing now?" (server shell; client work in HomeContent).
 * Top-level tab #1 of the redesigned IA. /dashboard redirects here.
 */
import { HomeContent } from './home-content';

export const metadata = { title: 'Home — Brain' };

export default function HomePage() {
  return <HomeContent />;
}
