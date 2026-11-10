import { RANGES, RANGE_LABELS, type Range } from '../../shared/ranges';
import { Segmented } from './ui/segmented';

const OPTIONS = RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }));

/** The date range buttons every chart and list shares; null selects none (a custom range). */
export function RangePicker({ value, onChange }: { value: Range | null; onChange: (range: Range) => void }) {
  return <Segmented value={value ?? ('' as Range)} options={OPTIONS} onChange={onChange} />;
}
