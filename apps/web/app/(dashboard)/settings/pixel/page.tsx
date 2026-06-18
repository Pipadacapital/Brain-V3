import { TrackingCenter } from '@/components/pixel/tracking-center';

export const metadata = { title: 'Tracking Center — Brain' };

export default function PixelPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Tracking Center</h1>
        <p className="text-muted-foreground mt-1">
          Install the Brain Pixel, watch your first event arrive live, and monitor the
          health of your collected data.
        </p>
      </div>
      <TrackingCenter />
    </div>
  );
}
