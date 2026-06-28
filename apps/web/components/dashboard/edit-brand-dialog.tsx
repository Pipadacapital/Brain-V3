'use client';

/**
 * EditBrandDialog — edit the SAFE brand-profile fields (display_name, domain, timezone, region_code).
 *
 * Scope is deliberately the no-recompute set: these are cosmetic/locale fields that do NOT change how
 * money or the medallion is computed. Currency, revenue_definition and the recognition horizons are
 * intentionally NOT editable here — changing them rewrites revenue truth (currency is also server-locked
 * once financial data exists, MA-11), so they are out of this dialog by design.
 *
 * Flow: on open we fetch the full brand via brandApi.get(id) to pre-fill timezone/region_code (the
 * dashboard brand-summary may not carry them); Save → brandApi.update(id, {...}) → PATCH /v1/brands/:id
 * (server enforces owner/brand_admin) → invalidate DASHBOARD_QUERY_KEY so the switcher + list refresh.
 */

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ErrorCard } from '@/components/ui/error-card';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toaster';
import { brandApi, userFacingMessage } from '@/lib/api/client';
import { DASHBOARD_QUERY_KEY } from '@/lib/hooks/use-dashboard';

// Locale allowlists (mirror create-brand-dialog.tsx — GCC + India).
const TIMEZONE_LABELS: Record<string, string> = {
  'Asia/Kolkata': 'Asia/Kolkata (IST, UTC+5:30)',
  'Asia/Dubai': 'Asia/Dubai (GST, UTC+4)',
  'Asia/Riyadh': 'Asia/Riyadh (AST, UTC+3)',
  'Asia/Qatar': 'Asia/Qatar (AST, UTC+3)',
  'Asia/Kuwait': 'Asia/Kuwait (AST, UTC+3)',
  'Asia/Bahrain': 'Asia/Bahrain (AST, UTC+3)',
  'Asia/Muscat': 'Asia/Muscat (GST, UTC+4)',
};

const REGION_LABELS: Record<string, string> = {
  IN: 'IN — India',
  AE: 'AE — United Arab Emirates',
  SA: 'SA — Saudi Arabia',
  QA: 'QA — Qatar',
  KW: 'KW — Kuwait',
  BH: 'BH — Bahrain',
  OM: 'OM — Oman',
};

interface EditBrandDialogProps {
  brand: { id: string; display_name: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EditBrandDialog({ brand, open, onOpenChange }: EditBrandDialogProps) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [domain, setDomain] = useState('');
  const [timezone, setTimezone] = useState('');
  const [regionCode, setRegionCode] = useState('');

  // Load the full brand on open so timezone/region pre-fill accurately.
  useEffect(() => {
    if (!open || !brand) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    brandApi
      .get(brand.id)
      .then((b) => {
        if (cancelled) return;
        setDisplayName(b.display_name ?? '');
        setDomain(b.domain ?? '');
        setTimezone(b.timezone ?? '');
        setRegionCode(b.region_code ?? '');
      })
      .catch((err) => {
        if (!cancelled) setLoadError(userFacingMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, brand]);

  async function handleSave() {
    if (!brand) return;
    setSaving(true);
    try {
      await brandApi.update(brand.id, {
        display_name: displayName.trim(),
        // Empty string clears the domain (server canonicalizes / nulls); undefined would leave untouched.
        domain: domain.trim() === '' ? null : domain.trim(),
        timezone: timezone || undefined,
        region_code: regionCode || undefined,
      });
      toast({ title: 'Brand updated', description: `"${displayName.trim()}" was saved.` });
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
      onOpenChange(false);
    } catch (err) {
      toast({ title: 'Could not save brand', description: userFacingMessage(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent aria-describedby="edit-brand-dialog-desc" data-testid="edit-brand-dialog">
        <DialogHeader>
          <DialogTitle>Edit brand</DialogTitle>
          <DialogDescription id="edit-brand-dialog-desc">
            Update the brand profile. Currency and revenue settings are managed separately — they
            affect how revenue is computed, so they aren&apos;t edited here.
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <ErrorCard error={new Error(loadError)} />
        ) : loading ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading brand">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleSave();
            }}
            noValidate
          >
            <div className="space-y-4">
              {/* Brand name */}
              <div className="space-y-1.5">
                <Label htmlFor="edit-display_name">Brand name</Label>
                <Input
                  id="edit-display_name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="My Brand"
                  aria-required="true"
                  data-testid="input-edit-brand-name"
                />
              </div>

              {/* Website */}
              <div className="space-y-1.5">
                <Label htmlFor="edit-domain">Website</Label>
                <Input
                  id="edit-domain"
                  type="url"
                  inputMode="url"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="mystore.com"
                  data-testid="input-edit-domain"
                />
                <p className="text-xs text-muted-foreground">
                  Where your store lives — used to install the tracking pixel and attribute events.
                </p>
              </div>

              {/* Timezone */}
              <div className="space-y-1.5">
                <Label htmlFor="edit-timezone">Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger id="edit-timezone" data-testid="select-edit-timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TIMEZONE_LABELS).map(([tz, label]) => (
                      <SelectItem key={tz} value={tz}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Region */}
              <div className="space-y-1.5">
                <Label htmlFor="edit-region_code">Region</Label>
                <Select value={regionCode} onValueChange={setRegionCode}>
                  <SelectTrigger id="edit-region_code" data-testid="select-edit-region">
                    <SelectValue placeholder="Select region" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(REGION_LABELS).map(([code, label]) => (
                      <SelectItem key={code} value={code}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Used for regional data residency and privacy rules.
                </p>
              </div>
            </div>

            <DialogFooter className="mt-6">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={saving}
                data-testid="btn-edit-brand-cancel"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={saving || displayName.trim() === ''}
                data-testid="btn-edit-brand-save"
              >
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
