import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A member's Google photo, or their initial when there is none. */
export function Avatar({ name, picture, className }: { name: string; picture: string | null; className?: string }) {
  return picture ? (
    <img src={picture} alt="" className={cn('size-8 shrink-0 rounded-full', className)} referrerPolicy="no-referrer" />
  ) : (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-full bg-muted', className)}>{name[0]}</span>
  );
}

export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

export function Alert({ variant = 'info', children }: { variant?: 'info' | 'error' | 'warning'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'rounded-md border px-3 py-2 text-sm',
        variant === 'error' && 'border-negative/30 bg-negative/10 text-negative',
        variant === 'warning' && 'border-warning/40 bg-warning/10',
        variant === 'info' && 'bg-muted',
      )}
    >
      {children}
    </div>
  );
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground', className)} {...props} />;
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 align-middle', className)} {...props} />;
}
