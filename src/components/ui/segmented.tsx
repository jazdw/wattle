import { cn } from '@/lib/utils';

/** Compact segmented control (range pickers, view toggles). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-md border bg-muted p-0.5', className)} role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-[5px] px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors',
            value === option.value && 'bg-card text-foreground shadow-xs',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
