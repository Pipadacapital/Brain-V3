// SPEC: WA.1.10 — golden dataset fixed fixtures: 3 fictional brands (§1.10)
//
// All ids are FIXED constants (not generated) so the seed SQL, the generator,
// the harness, and every spec-named test agree on them forever.
//
// Brand design (scenario carriers):
//   aurora — "Aurora Athletics"  IN / INR / Shopify prepaid-heavy. Carries anon→known,
//            multi-device, late-identify (day-7 re-stitch), refunds, consent-off.
//   bazaar — "Bazaar Bloom"      IN / INR / GoKwik+Shiprocket COD-heavy. Carries COD
//            delivered/RTO, shared-device families, consent-off.
//   cedar  — "Cedar & Sand"      KW / KWD (GCC, 3-decimal minor units). Carries KWD
//            scale-3 orders, multi-device, refunds, consent-off.

export const GOLDEN_ORG_ID = '00000000-90de-4001-8000-000000000001';
export const GOLDEN_OWNER_USER_ID = '00000000-90de-4002-8000-000000000002';
export const GOLDEN_OWNER_EMAIL = 'golden-fixtures-owner@example.test';

export interface GoldenBrand {
  readonly key: 'aurora' | 'bazaar' | 'cedar';
  readonly displayName: string;
  readonly id: string;
  readonly installToken: string;
  readonly domain: string;
  readonly currencyCode: 'INR' | 'KWD';
  /** ISO-4217 minor-unit scale (INR=2, KWD=3 — @brain/money authority). */
  readonly minorScale: 2 | 3;
  readonly regionCode: 'IN' | 'KW';
  readonly timezone: string;
  /** Which connector shape carries this brand's orders. */
  readonly orderSource: 'shopify' | 'gokwik' | 'canonical_kwd';
}

export const AURORA: GoldenBrand = {
  key: 'aurora',
  displayName: 'Aurora Athletics (golden)',
  id: 'a0a0a0a0-0001-4000-8000-000000000a01',
  installToken: 'a0a0a0a0-1001-4000-8000-00000000f001',
  domain: 'aurora-athletics.golden.test',
  currencyCode: 'INR',
  minorScale: 2,
  regionCode: 'IN',
  timezone: 'Asia/Kolkata',
  orderSource: 'shopify',
};

export const BAZAAR: GoldenBrand = {
  key: 'bazaar',
  displayName: 'Bazaar Bloom (golden)',
  id: 'b0b0b0b0-0002-4000-8000-000000000b02',
  installToken: 'b0b0b0b0-1002-4000-8000-00000000f002',
  domain: 'bazaar-bloom.golden.test',
  currencyCode: 'INR',
  minorScale: 2,
  regionCode: 'IN',
  timezone: 'Asia/Kolkata',
  orderSource: 'gokwik',
};

export const CEDAR: GoldenBrand = {
  key: 'cedar',
  displayName: 'Cedar & Sand (golden)',
  id: 'c0c0c0c0-0003-4000-8000-000000000c03',
  installToken: 'c0c0c0c0-1003-4000-8000-00000000f003',
  domain: 'cedar-and-sand.golden.test',
  currencyCode: 'KWD',
  minorScale: 3,
  regionCode: 'KW',
  timezone: 'Asia/Kuwait',
  orderSource: 'canonical_kwd',
};

export const GOLDEN_BRANDS: readonly GoldenBrand[] = [AURORA, BAZAAR, CEDAR];
export const GOLDEN_BRAND_IDS: readonly string[] = GOLDEN_BRANDS.map((b) => b.id);

// ── Acquisition channels (same shape seed-touchpoints.mjs proved against the live mart) ──
export interface GoldenChannel {
  readonly name: string;
  readonly utm: Readonly<Record<string, string>>;
  readonly clickIdKey: 'gclid' | 'fbclid' | 'ttclid' | null;
  readonly referrer: string;
}

export const CHANNELS: readonly GoldenChannel[] = [
  { name: 'google_cpc', utm: { source: 'google', medium: 'cpc', campaign: 'golden-search-brand' }, clickIdKey: 'gclid', referrer: 'https://www.google.com/' },
  { name: 'meta_paid', utm: { source: 'facebook', medium: 'paid_social', campaign: 'golden-prospecting' }, clickIdKey: 'fbclid', referrer: 'https://l.facebook.com/' },
  { name: 'tiktok_paid', utm: { source: 'tiktok', medium: 'paid_social', campaign: 'golden-ugc' }, clickIdKey: 'ttclid', referrer: 'https://www.tiktok.com/' },
  { name: 'email', utm: { source: 'newsletter', medium: 'email', campaign: 'golden-weekly-drop' }, clickIdKey: null, referrer: 'direct' },
  { name: 'direct', utm: {}, clickIdKey: null, referrer: 'direct' },
];

// ── Product catalog (per-brand handles + prices in DECIMAL STRINGS at brand scale) ──
export interface GoldenProduct {
  readonly handle: string;
  readonly sku: string;
  /** Decimal price string at the brand's scale (INR "1499.00" / KWD "12.500"). */
  readonly price: string;
}

export const CATALOG: Readonly<Record<GoldenBrand['key'], readonly GoldenProduct[]>> = {
  aurora: [
    { handle: 'trail-runner-shoe', sku: 'AUR-001', price: '3499.00' },
    { handle: 'compression-tee', sku: 'AUR-002', price: '1299.00' },
    { handle: 'training-shorts', sku: 'AUR-003', price: '999.00' },
    { handle: 'hydration-belt', sku: 'AUR-004', price: '1499.00' },
    { handle: 'grip-socks-3pk', sku: 'AUR-005', price: '649.00' },
    { handle: 'foam-roller', sku: 'AUR-006', price: '1899.00' },
  ],
  bazaar: [
    { handle: 'jasmine-attar', sku: 'BZR-001', price: '899.00' },
    { handle: 'block-print-dupatta', sku: 'BZR-002', price: '1199.00' },
    { handle: 'brass-diya-set', sku: 'BZR-003', price: '749.00' },
    { handle: 'terracotta-planter', sku: 'BZR-004', price: '549.00' },
    { handle: 'kantha-throw', sku: 'BZR-005', price: '2299.00' },
  ],
  cedar: [
    { handle: 'oud-candle', sku: 'CDR-001', price: '12.500' },
    { handle: 'sandalwood-diffuser', sku: 'CDR-002', price: '18.750' },
    { handle: 'amber-room-spray', sku: 'CDR-003', price: '9.950' },
    { handle: 'incense-gift-box', sku: 'CDR-004', price: '24.125' },
    { handle: 'ceramic-burner', sku: 'CDR-005', price: '15.000' },
  ],
};

export const LANDINGS: readonly string[] = ['/', '/collections/new', '/collections/bestsellers', '/blogs/journal'];

/** Fictional customer email for a persona — appears RAW only in raw-lane fixtures (real Bronze posture); hashed everywhere else. */
export function personaEmail(brand: GoldenBrand, personaId: string): string {
  return `${personaId}@${brand.domain}`;
}

/** Deterministic fictional IN phone (+91, 10 digits starting 9) for a persona ordinal. */
export function personaPhoneIN(ordinal: number): string {
  const tail = String(100000000 + (ordinal % 899999999)).padStart(9, '0');
  return `+919${tail}`;
}
