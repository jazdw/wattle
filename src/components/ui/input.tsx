import { useId, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Every form control gets an id (browsers expect an id or name on each) unless the caller gives one. */
function useControlId(props: { id?: string; name?: string }): string | undefined {
  const generated = useId();
  return props.id ?? (props.name ? undefined : generated);
}

export function Input({ className, ...props }: ComponentProps<'input'>) {
  const id = useControlId(props);
  return (
    <input
      id={id}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  const id = useControlId(props);
  return (
    <select
      id={id}
      className={cn(
        'flex h-9 w-full rounded-md border border-input bg-card px-2 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>) {
  return <label className={cn('text-sm font-medium leading-none', className)} {...props} />;
}

/** A labelled control: wrapping it in <label> ties the text to the input for screen readers. */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium leading-none">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
