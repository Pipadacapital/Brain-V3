/**
 * channel-meta — shared per-channel presentation for the attribution surface.
 *
 * One source of truth for the human label, an icon glyph (non-colour redundancy per
 * the accessibility skill — status/series is NEVER colour-only), a stable display
 * order, and the decorative chart hue. Reused by the attributed-channel chart, the
 * channel-ROAS table, and the SR-table fallbacks so a colourblind user always gets the
 * full signal (icon + text), never colour alone.
 *
 * The JourneyChannel set is the canonical deterministic CASE-ladder value (click_id →
 * paid; else utm.medium; else referrer → referral; else direct) — never a classifier.
 */

import {
  Megaphone,
  Facebook,
  Search,
  Music2,
  Mail,
  Share2,
  Link2,
  Globe,
} from 'lucide-react';
import type { JourneyChannel } from '@/lib/api/types';

export interface ChannelMeta {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  order: number;
  /** Decorative hue only — meaning is carried by the icon + text label, never colour. */
  chartVar: string;
}

const CHANNEL_META: Record<JourneyChannel, ChannelMeta> = {
  paid: { label: 'Paid', icon: Megaphone, order: 0, chartVar: 'hsl(var(--chart-1))' },
  paid_meta: { label: 'Paid · Meta', icon: Facebook, order: 1, chartVar: 'hsl(var(--chart-1))' },
  paid_google: { label: 'Paid · Google', icon: Search, order: 2, chartVar: 'hsl(var(--chart-2))' },
  paid_tiktok: { label: 'Paid · TikTok', icon: Music2, order: 3, chartVar: 'hsl(var(--chart-3))' },
  email: { label: 'Email', icon: Mail, order: 4, chartVar: 'hsl(var(--chart-4))' },
  organic_social: { label: 'Organic Social', icon: Share2, order: 5, chartVar: 'hsl(var(--chart-5))' },
  referral: { label: 'Referral', icon: Link2, order: 6, chartVar: 'hsl(var(--chart-2))' },
  direct: { label: 'Direct', icon: Globe, order: 7, chartVar: 'hsl(var(--chart-3))' },
};

/** Resolve presentation for a channel, falling back to a safe Globe/raw-label default.
 *  Accepts `string` because core's ChannelRoasDto / ChannelContributionDto channel is a free
 *  string (not the JourneyChannel enum) — the fallback covers any unknown channel honestly. */
export function channelMeta(channel: string): ChannelMeta {
  return (
    CHANNEL_META[channel as JourneyChannel] ?? {
      label: channel,
      icon: Globe,
      order: 99,
      chartVar: 'hsl(var(--chart-1))',
    }
  );
}
