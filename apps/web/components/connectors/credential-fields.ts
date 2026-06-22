/**
 * credential-fields.ts — per-provider credential field definitions for connector connect forms.
 *
 * Extracted as a pure module so it can be unit-tested without the full component tree.
 * Imported by marketplace-view.tsx.
 *
 * A field marked secret=true is stored in the backend secret bundle and NEVER echoed
 * back to the client (renders as type="password", autoComplete="off"). Non-secret fields are
 * merchant identifiers visible in the provider dashboard. The backend bundles all
 * fields under ONE secret_ref per connector.
 */

export interface CredentialField {
  key: string;
  label: string;
  placeholder: string;
  secret: boolean;
}

const RAZORPAY_FIELDS: CredentialField[] = [
  { key: 'key_id', label: 'Key ID', placeholder: 'rzp_live_XXXXXXXX', secret: false },
  { key: 'key_secret', label: 'Key Secret', placeholder: '••••••••••••', secret: true },
  { key: 'webhook_secret', label: 'Webhook Secret', placeholder: '••••••••••••', secret: true },
  { key: 'razorpay_account_id', label: 'Account ID', placeholder: 'acc_XXXXXXXX', secret: false },
];

// Shopflo self-serve: static API Access Token + Merchant-ID + the webhook shared
// secret the merchant pastes from Dashboard → Settings → Integrations.
const SHOPFLO_FIELDS: CredentialField[] = [
  { key: 'api_token', label: 'API Access Token', placeholder: '••••••••••••', secret: true },
  { key: 'merchant_id', label: 'Merchant ID', placeholder: 'merchant_XXXXXXXX', secret: false },
  { key: 'webhook_secret', label: 'Webhook Secret', placeholder: '••••••••••••', secret: true },
];

// GoKwik: static appid/appsecret (both partner-issued).
const GOKWIK_FIELDS: CredentialField[] = [
  { key: 'appid', label: 'App ID', placeholder: 'app_XXXXXXXX', secret: false },
  { key: 'appsecret', label: 'App Secret', placeholder: '••••••••••••', secret: true },
];

// WooCommerce self-serve: the merchant pastes site URL + WC REST API consumer key/secret
// (generated from WooCommerce → Settings → Advanced → REST API). site_url is a non-secret
// identifier; consumer_key and consumer_secret are secrets (never echoed back to the client).
const WOOCOMMERCE_FIELDS: CredentialField[] = [
  { key: 'site_url', label: 'Store URL', placeholder: 'https://my-store.example.com', secret: false },
  { key: 'consumer_key', label: 'Consumer Key', placeholder: 'ck_xxxxxxxxxxxxxxxxxxxx', secret: false },
  { key: 'consumer_secret', label: 'Consumer Secret', placeholder: '••••••••••••', secret: true },
];

/**
 * Resolve a provider's credential fields; defaults to Razorpay's set for any other credential tile.
 * Exported for unit-testing.
 */
export function credentialFieldsFor(tileId: string): CredentialField[] {
  switch (tileId) {
    case 'woocommerce':
      return WOOCOMMERCE_FIELDS;
    case 'shopflo':
      return SHOPFLO_FIELDS;
    case 'gokwik':
      return GOKWIK_FIELDS;
    default:
      return RAZORPAY_FIELDS;
  }
}
