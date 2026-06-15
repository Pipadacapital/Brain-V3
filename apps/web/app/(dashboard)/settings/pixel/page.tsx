import { PixelWizard } from '@/components/pixel/pixel-wizard';

export const metadata = { title: 'Brain Pixel — Brain' };

export default function PixelPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Brain Pixel</h1>
        <p className="text-muted-foreground mt-1">
          Install the Brain Pixel on your website to start collecting visitor data.
        </p>
      </div>
      <PixelWizard />
    </div>
  );
}
