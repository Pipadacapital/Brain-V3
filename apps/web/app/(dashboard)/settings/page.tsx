/**
 * Settings page — server-component shell.
 *
 * The hub itself (grouped cards + ExplainerPanel + live data-foundation freshness)
 * is the client component below, so it can read useDataHealth for an honest
 * freshness badge without fabricating one.
 */
import { SettingsContent } from './settings-content';

export const metadata = { title: 'Settings — Brain' };

export default function SettingsPage() {
  return <SettingsContent />;
}
