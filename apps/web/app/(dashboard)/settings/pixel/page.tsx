import { TrackingCenter } from '@/components/pixel/tracking-center';

export const metadata = { title: 'Brain Pixel — Brain' };

export default function PixelPage() {
  // TrackingCenter owns the full surface (PageHeader + install/verify/health flow)
  // so the header status reflects live pixel health.
  return <TrackingCenter />;
}
