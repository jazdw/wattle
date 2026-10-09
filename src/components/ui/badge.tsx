import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium', {
  variants: {
    variant: {
      default: 'border-transparent bg-muted text-foreground',
      gold: 'border-transparent bg-accent/25 text-accent-foreground dark:text-accent',
      outline: 'text-muted-foreground',
      warning: 'border-transparent bg-warning/20 text-foreground',
      danger: 'border-transparent bg-negative/15 text-negative',
    },
  },
  defaultVariants: { variant: 'default' },
});

export function Badge({ className, variant, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
