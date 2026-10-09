import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  SIZES,
  STYLES,
  type Classification,
} from '../../shared/taxonomy';
import { api } from '../api';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { Alert } from './ui/misc';

interface Props {
  security: { securityId: string; ticker: string | null; name: string | null; classification: Classification } | null;
  onClose: () => void;
}

const SIZE_LABELS = { large: 'Large', mid: 'Mid', small: 'Small' };
const STYLE_LABELS = { value: 'Value', blend: 'Blend', growth: 'Growth' };

function toPercentStrings(weights: Partial<Record<string, number>> | undefined, keys: readonly string[]) {
  return Object.fromEntries(keys.map((key) => [key, weights?.[key] ? String(Math.round(weights[key]! * 1000) / 10) : '']));
}

function fromPercentStrings(values: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => [key, Number(value) / 100]),
  );
}

/** Edit how a security splits across categories, sizes and styles. */
export function ClassificationDialog({ security, onClose }: Props) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<{ id: string; categories: Record<string, string>; sizes: Record<string, string>; styles: Record<string, string> } | null>(null);

  if (security && state?.id !== security.securityId) {
    setState({
      id: security.securityId,
      categories: toPercentStrings(security.classification.categories, CATEGORIES),
      sizes: toPercentStrings(security.classification.sizes, SIZES),
      styles: toPercentStrings(security.classification.styles, STYLES),
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const sizes = fromPercentStrings(state!.sizes);
      const styles = fromPercentStrings(state!.styles);
      return api(`/api/securities/${security!.securityId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          classification: {
            categories: fromPercentStrings(state!.categories),
            ...(Object.keys(sizes).length ? { sizes } : {}),
            ...(Object.keys(styles).length ? { styles } : {}),
          },
        }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['securities'] });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      onClose();
    },
  });

  const grid = (group: 'categories' | 'sizes' | 'styles', keys: readonly string[], labels: Record<string, string>) => (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((key) => (
        <label key={key} className="flex flex-col gap-1 text-xs text-muted-foreground">
          {labels[key]}
          <Input
            inputMode="decimal"
            placeholder="0"
            value={state?.[group][key] ?? ''}
            onChange={(event) => setState((current) => current && { ...current, [group]: { ...current[group], [key]: event.target.value } })}
          />
        </label>
      ))}
    </div>
  );

  return (
    <Dialog open={security !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Classify ${security?.ticker ?? security?.name ?? ''}`}
        description="Percentages; each group is normalised to 100%. Size and style describe the stock portion only."
      >
        <div className="grid gap-4">
          <div>
            <p className="mb-2 text-sm font-medium">Categories</p>
            {grid('categories', CATEGORIES, CATEGORY_LABELS)}
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Company size</p>
            {grid('sizes', SIZES, SIZE_LABELS)}
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Style</p>
            {grid('styles', STYLES, STYLE_LABELS)}
          </div>
        </div>
        {save.error && <Alert variant="error">{save.error.message}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
