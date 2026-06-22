/**
 * Abandoned-cart page — server component shell (Silver tier).
 *
 * Stakeholder-visible cart-recovery surface powered by the Silver tier (StarRocks silver_touchpoint).
 * Reads cart sessions converted vs abandoned via the BFF → metric-engine storefront-abandoned-cart
 * seam (I-ST01 — the UI NEVER queries StarRocks directly). Part of Phase H (Universal Pixel).
 */
import { AbandonedCartContent } from './abandoned-cart-content';

export const metadata = { title: 'Abandoned Cart — Brain' };

export default function AbandonedCartPage() {
  return <AbandonedCartContent />;
}
