import { ConnectorsList } from '@/components/connectors/connectors-list';

export const metadata = { title: 'Connectors — Brain' };

export default function ConnectorsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Data Connectors</h1>
        <p className="text-muted-foreground mt-1">
          Connect your data sources to Brain.
        </p>
      </div>
      <ConnectorsList />
    </div>
  );
}
