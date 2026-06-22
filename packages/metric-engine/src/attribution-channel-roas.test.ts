import { describe, it, expect } from 'vitest';
import { platformToChannel } from './attribution-channel-roas.js';

/**
 * DB-AUDIT H1 regression guard. The ad-spend platform literal is `google_ads` (@brain/ad-spend-mapper
 * AdPlatform = 'meta' | 'google_ads'), but PLATFORM_TO_CHANNEL previously keyed on `google`, so Google
 * spend fell through to the `paid` fallback and never joined `paid_google` attributed revenue → Google
 * per-channel ROAS was wrong. This pins every real spend platform to a distinct paid_<network> channel.
 *
 * SPEND_PLATFORMS must mirror AdPlatform. If a new platform is added there, add it here AND to
 * PLATFORM_TO_CHANNEL — this test fails loudly on the `paid` fallback otherwise.
 */
const SPEND_PLATFORMS = ['meta', 'google_ads'] as const;

describe('platformToChannel — every spend platform maps to a distinct paid_* channel (H1)', () => {
  it('maps the real ad-spend literals, never the generic `paid` fallback', () => {
    for (const p of SPEND_PLATFORMS) {
      const channel = platformToChannel(p);
      expect(channel, `platform ${p} fell through to the 'paid' fallback`).not.toBe('paid');
      expect(channel.startsWith('paid_')).toBe(true);
    }
  });

  it('pins the exact mappings (locks the google_ads fix)', () => {
    expect(platformToChannel('meta')).toBe('paid_meta');
    expect(platformToChannel('google_ads')).toBe('paid_google');
  });

  it('maps to distinct channels (no two platforms collapse onto one channel)', () => {
    const channels = SPEND_PLATFORMS.map(platformToChannel);
    expect(new Set(channels).size).toBe(SPEND_PLATFORMS.length);
  });

  it('still falls back to `paid` for a genuinely unknown platform', () => {
    expect(platformToChannel('unknown_network')).toBe('paid');
  });
});
