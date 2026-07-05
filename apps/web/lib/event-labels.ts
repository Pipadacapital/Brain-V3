/**
 * event-labels — the SINGLE plain-language dictionary for every internal event type
 * the UI can encounter, so no raw event code (`page.viewed`, `order.live.v1`) ever
 * reaches the DOM (plain-language rule 3).
 *
 * Grounded in the real taxonomies (kept in sync by covering their union):
 *   - pixel events: apps/core .../analytics/internal/application/queries/_pixel-events.ts
 *     + the universal capture script (apps/collector .../pixel-asset.route.ts emit() calls)
 *     + packages/pixel-sdk EventName (session/exit_intent/download/video/share).
 *   - touchpoint events: db/iceberg/spark/silver/silver_touchpoint.py TOUCHPOINT_EVENT_TYPES.
 *   - server-trusted connector events: order/spend/settlement/refund/fulfillment `.v1`
 *     lanes + resource upserts (apps/core + apps/stream-worker literals).
 *
 * `eventLabel()` NEVER returns the raw code — unknown types fall back to a humanized
 * Title-Case form (`.vN` suffix stripped, `.`/`_` split) with a generic icon.
 *
 * Pure module (no React runtime, no JSX) — safe to import from server or client components.
 */

import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArchiveRestore,
  Banknote,
  CheckCircle2,
  Coins,
  CreditCard,
  DoorOpen,
  Download,
  Eye,
  FileText,
  Fingerprint,
  LayoutGrid,
  ListChecks,
  LogIn,
  LogOut,
  Megaphone,
  MousePointer,
  MousePointerClick,
  MoveVertical,
  Package,
  PackageCheck,
  PackageMinus,
  PackagePlus,
  Play,
  RotateCcw,
  Search,
  Share2,
  ShoppingBag,
  ShoppingCart,
  Ticket,
  Truck,
  UserRound,
  Video,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

export interface EventLabel {
  /** Human name — what a merchant calls this ("Page view", "Purchase"). */
  label: string;
  /** Lucide icon component (render as <Icon className="h-4 w-4" />). */
  Icon: LucideIcon;
  /** One plain-language sentence describing what this event means. */
  description: string;
}

/** Curated dictionary — internal event type → human label + icon + one-sentence meaning. */
const EVENT_LABELS: Record<string, EventLabel> = {
  // ── Pixel: browsing behaviour ────────────────────────────────────────────────
  'page.viewed': { label: 'Page view', Icon: Eye, description: 'A shopper viewed a page on your store.' },
  'product.viewed': { label: 'Product view', Icon: Package, description: 'A shopper viewed a product page.' },
  'collection.viewed': { label: 'Collection view', Icon: LayoutGrid, description: 'A shopper browsed a collection or category page.' },
  'search.submitted': { label: 'Search', Icon: Search, description: 'A shopper searched for something on your store.' },
  'scroll.depth': { label: 'Scrolled page', Icon: MoveVertical, description: 'A shopper scrolled part of the way down a page.' },
  'element.clicked': { label: 'Clicked element', Icon: MousePointer, description: 'A shopper clicked a button or link on a page.' },
  'rage.click': { label: 'Rage click', Icon: MousePointerClick, description: 'A shopper clicked the same spot repeatedly in frustration — often a sign something looks clickable but is not working.' },
  'dead.click': { label: 'Dead click', Icon: MousePointer, description: 'A shopper clicked something that did nothing — a possible broken or confusing element.' },
  exit_intent: { label: 'About to leave', Icon: DoorOpen, description: 'A shopper moved their cursor to leave the page — a signal they were about to exit.' },
  download: { label: 'File download', Icon: Download, description: 'A shopper downloaded a file from your store.' },
  video: { label: 'Video interaction', Icon: Video, description: 'A shopper played or interacted with a video on your store.' },
  share: { label: 'Shared content', Icon: Share2, description: 'A shopper shared a page or product from your store.' },

  // ── Pixel: cart ──────────────────────────────────────────────────────────────
  'cart.item_added': { label: 'Added to cart', Icon: PackagePlus, description: 'A shopper added an item to their cart.' },
  'cart.item_removed': { label: 'Removed from cart', Icon: PackageMinus, description: 'A shopper removed an item from their cart.' },
  'cart.updated': { label: 'Cart updated', Icon: ShoppingCart, description: 'A shopper changed something in their cart, like a quantity.' },
  'cart.viewed': { label: 'Viewed cart', Icon: ShoppingCart, description: 'A shopper opened their cart to review it.' },

  // ── Pixel: checkout + payment funnel ────────────────────────────────────────
  'checkout.started': { label: 'Started checkout', Icon: CreditCard, description: 'A shopper began the checkout process.' },
  'checkout.step_viewed': { label: 'Checkout step', Icon: ListChecks, description: 'A shopper reached a step in the checkout process.' },
  'checkout.shipping_selected': { label: 'Chose shipping', Icon: Truck, description: 'A shopper selected a shipping method at checkout.' },
  'payment.initiated': { label: 'Payment started', Icon: CreditCard, description: 'A shopper began paying for their order.' },
  'payment.succeeded': { label: 'Payment succeeded', Icon: CheckCircle2, description: 'A shopper’s payment went through successfully.' },
  'payment.failed': { label: 'Payment failed', Icon: XCircle, description: 'A shopper’s payment attempt did not go through.' },
  'coupon.applied': { label: 'Coupon applied', Icon: Ticket, description: 'A shopper applied a discount code at checkout.' },
  'order.placed': { label: 'Order placed (browser)', Icon: ShoppingBag, description: 'The shopper’s browser reported an order was placed — the confirmed purchase comes from your store platform.' },
  'purchase.completed': { label: 'Purchase completed', Icon: ShoppingBag, description: 'A shopper completed a purchase on your store.' },

  // ── Pixel: identity + account funnel ────────────────────────────────────────
  'user.logged_in': { label: 'Logged in', Icon: LogIn, description: 'A shopper logged into their account on your store.' },
  'user.signed_up': { label: 'Signed up', Icon: UserRound, description: 'A shopper created a new account on your store.' },
  identify: { label: 'Identified visitor', Icon: Fingerprint, description: 'An anonymous visitor was recognised as a known customer.' },
  'form.submitted': { label: 'Form submitted', Icon: FileText, description: 'A shopper submitted a form, like a newsletter signup or contact form.' },

  // ── Pixel: session lifecycle + reliability ──────────────────────────────────
  'session.started': { label: 'Visit started', Icon: Play, description: 'A shopper started a new browsing session on your store.' },
  'session.ended': { label: 'Visit ended', Icon: LogOut, description: 'A shopper’s browsing session came to an end.' },
  'pixel.dropped': { label: 'Tracking gap', Icon: AlertCircle, description: 'Some tracking events could not be delivered from the shopper’s browser, so a small gap may exist.' },

  // ── Server-trusted connector events (revenue truth) ─────────────────────────
  'order.live.v1': { label: 'Purchase', Icon: ShoppingBag, description: 'A confirmed order from your store platform — the source of truth for revenue.' },
  'order.backfill.v1': { label: 'Purchase (imported)', Icon: ArchiveRestore, description: 'A past order imported from your store platform’s history.' },
  'order.created': { label: 'Order created', Icon: ShoppingBag, description: 'A new order was recorded from your store platform.' },
  'order.updated': { label: 'Order update', Icon: ShoppingBag, description: 'An existing order changed on your store platform, like a status or payment update.' },
  'checkout.abandoned.v1': { label: 'Checkout abandoned', Icon: DoorOpen, description: 'A shopper started checkout but did not finish their purchase.' },
  'refund.recorded.v1': { label: 'Refund', Icon: RotateCcw, description: 'A refund was issued for an order.' },
  'refund.created': { label: 'Refund', Icon: RotateCcw, description: 'A refund was issued for an order.' },
  'settlement.live.v1': { label: 'Settlement', Icon: Banknote, description: 'A payout settlement was recorded — money moving from the payment provider to you.' },

  // ── Marketing ────────────────────────────────────────────────────────────────
  'spend.live.v1': { label: 'Ad spend', Icon: Coins, description: 'Advertising spend reported by an ad platform like Meta or Google.' },
  'ad.entity.updated': { label: 'Ad campaign update', Icon: Megaphone, description: 'A campaign, ad set, or ad changed on an ad platform.' },

  // ── Fulfillment + logistics ──────────────────────────────────────────────────
  'fulfillment.recorded.v1': { label: 'Order fulfilled', Icon: PackageCheck, description: 'An order was packed and handed over for delivery.' },
  'shipment.created': { label: 'Shipment created', Icon: Truck, description: 'A shipment was created for an order.' },
  'shiprocket.shipment_status.v1': { label: 'Shipment status update', Icon: Truck, description: 'A delivery status update for a shipment, like picked up or delivered.' },
  'shiprocket.return_status.v1': { label: 'Return status update', Icon: RotateCcw, description: 'A status update for a returned shipment.' },

  // ── Checkout providers ───────────────────────────────────────────────────────
  'gokwik.checkout_started.v1': { label: 'Started checkout (GoKwik)', Icon: CreditCard, description: 'A shopper began checkout through GoKwik.' },
  'gokwik.checkout_step.v1': { label: 'Checkout step (GoKwik)', Icon: ListChecks, description: 'A shopper reached a step in the GoKwik checkout.' },
  'gokwik.rto_predict.v1': { label: 'Delivery risk prediction', Icon: AlertTriangle, description: 'A prediction of how likely this order is to be returned to origin (RTO).' },
  'shopflo.checkout_started.v1': { label: 'Started checkout (Shopflo)', Icon: CreditCard, description: 'A shopper began checkout through Shopflo.' },
  'shopflo.checkout_step.v1': { label: 'Checkout step (Shopflo)', Icon: ListChecks, description: 'A shopper reached a step in the Shopflo checkout.' },
  'shopflo.checkout_completed.v1': { label: 'Checkout completed (Shopflo)', Icon: CheckCircle2, description: 'A shopper completed checkout through Shopflo.' },
  'shopflo.checkout_abandoned.v1': { label: 'Checkout abandoned (Shopflo)', Icon: DoorOpen, description: 'A shopper started a Shopflo checkout but did not finish.' },

  // ── Catalog / customer resource updates ─────────────────────────────────────
  'customer.upsert.v1': { label: 'Customer update', Icon: UserRound, description: 'A customer profile was added or updated from your store platform.' },
  'customer.created': { label: 'New customer', Icon: UserRound, description: 'A new customer profile was recorded from your store platform.' },
  'customer.updated': { label: 'Customer update', Icon: UserRound, description: 'A customer profile changed on your store platform.' },
  'product.upsert.v1': { label: 'Product update', Icon: Package, description: 'A product was added or updated from your store platform.' },
  'product.created': { label: 'New product', Icon: Package, description: 'A new product was recorded from your store platform.' },
  'product.updated': { label: 'Product update', Icon: Package, description: 'A product changed on your store platform.' },
};

/**
 * Humanize an unknown event code so the raw code NEVER renders: strip a trailing
 * `.vN` version suffix, split on `.`/`_`, Title-Case each word.
 * e.g. 'inventory.level_changed.v2' → 'Inventory Level Changed'.
 */
function humanizeEventCode(type: string): string {
  const stripped = type.replace(/\.v\d+$/i, '');
  return stripped
    .split(/[._]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Resolve an internal event type to its human label + icon + description.
 * SAFE for any input — unknown/new codes get a humanized Title-Case label and a
 * generic icon; the raw code is never returned as the label.
 *
 * @example
 *   const { label, Icon, description } = eventLabel('order.live.v1');
 *   // label 'Purchase', Icon ShoppingBag, description 'A confirmed order…'
 */
export function eventLabel(type: string | null | undefined): EventLabel {
  const key = (type ?? '').trim();
  if (!key) {
    return { label: 'Event', Icon: Activity, description: 'An event recorded on your store.' };
  }
  const known = EVENT_LABELS[key];
  if (known) return known;
  return {
    label: humanizeEventCode(key),
    Icon: Activity,
    description: 'An event recorded on your store.',
  };
}

/** Coarse event categories from the Silver tier (event_category column). */
const EVENT_CATEGORY_LABELS: Record<string, string> = {
  behaviour: 'Browsing',
  behavior: 'Browsing', // tolerate either spelling
  transaction: 'Money',
  fulfillment: 'Delivery',
  support: 'Support',
  marketing: 'Marketing',
  other: 'Other',
};

/**
 * Human label for a Silver event_category (behaviour/transaction/fulfillment/support/marketing/other).
 * Unknown categories fall back to a Title-Case humanization — never the raw code.
 *
 * @example eventCategoryLabel('behaviour') // → 'Browsing'
 */
export function eventCategoryLabel(category: string | null | undefined): string {
  const key = (category ?? '').trim().toLowerCase();
  if (!key) return '';
  return EVENT_CATEGORY_LABELS[key] ?? humanizeEventCode(key);
}
