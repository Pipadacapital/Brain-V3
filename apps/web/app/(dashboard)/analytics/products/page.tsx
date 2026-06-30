/**
 * Products — "What sells, and how well?" (server shell).
 * Per-SKU performance over the Silver order-line mart. Body filled by the page agent.
 */
import { ProductsContent } from './products-content';

export const metadata = { title: 'Products — Brain' };

export default function ProductsPage() {
  return <ProductsContent />;
}
