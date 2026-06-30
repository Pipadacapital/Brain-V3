/**
 * Product detail page — server component shell (Next 15: params is a Promise).
 * Renders one product's storefront funnel (views→atc→purchase), conversion/return rates and
 * frequently-bought-together partners from the Gold marts (P3). Drill-down off /analytics/products.
 */
import { ProductDetailContent } from './product-detail-content';

export const metadata = { title: 'Product detail — Brain' };

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetailContent productId={decodeURIComponent(id)} />;
}
