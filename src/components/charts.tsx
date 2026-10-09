import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Currency } from '../../shared/money';
import type { HistoryResponse } from '../../shared/types';
import { longDate, money, shortDate } from '../lib/format';
import type { ChartSeries } from '../lib/series';

/* ------------------------------------------------------------------ */
/* Time series                                                         */
/* ------------------------------------------------------------------ */


/** Contiguous runs of estimated dates, for shading. */
function estimatedRanges(dates: string[], estimated: boolean[]): [string, string][] {
  const ranges: [string, string][] = [];
  let start: string | null = null;
  dates.forEach((date, index) => {
    if (estimated[index] && start === null) start = date;
    if (!estimated[index] && start !== null) {
      ranges.push([start, dates[index - 1]]);
      start = null;
    }
  });
  if (start !== null) ranges.push([start, dates.at(-1)!]);
  return ranges;
}

interface TooltipPayload {
  dataKey: string;
  value: number;
  color: string;
  name: string;
}

function SeriesTooltip({
  active,
  payload,
  label,
  currency,
  showTotal,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  currency: Currency;
  showTotal: boolean;
}) {
  if (!active || !payload?.length || !label) return null;
  const rows = payload.filter((row) => row.value !== null && row.value !== undefined);
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div className="min-w-44 rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{longDate(label)}</p>
      {showTotal && rows.length > 1 && (
        <p className="mb-1 flex justify-between gap-4 font-semibold">
          <span>Total</span>
          <span>{money(total, currency)}</span>
        </p>
      )}
      {[...rows].reverse().map((row) => (
        <p key={row.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-sm" style={{ background: row.color }} />
            {row.name}
          </span>
          <span>{money(row.value, currency)}</span>
        </p>
      ))}
    </div>
  );
}

function axisMoney(currency: Currency) {
  return (value: number) => money(value, currency, { compact: true });
}

export function TimeSeriesChart({
  history,
  series,
  currency,
  stacked,
  height = 280,
}: {
  history: HistoryResponse;
  series: ChartSeries[];
  currency: Currency;
  stacked: boolean;
  height?: number;
}) {
  const data = useMemo(
    () =>
      history.dates.map((date, position) => {
        const row: Record<string, string | number | null> = { date };
        for (const item of series) row[item.key] = item.values[position];
        return row;
      }),
    [history.dates, series],
  );
  const shaded = useMemo(() => estimatedRanges(history.dates, history.estimated), [history.dates, history.estimated]);
  const single = series.length === 1;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }} stackOffset={stacked ? 'sign' : 'none'}>
          <defs>
            {single && (
              <linearGradient id="fill-single" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={series[0].color} stopOpacity={0.25} />
                <stop offset="100%" stopColor={series[0].color} stopOpacity={0.02} />
              </linearGradient>
            )}
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="0" />
          <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis
            tickFormatter={axisMoney(currency)}
            tickLine={false}
            axisLine={false}
            width={64}
            domain={['auto', 'auto']}
          />
          {shaded.map(([from, to]) => (
            <ReferenceArea key={from} x1={from} x2={to} fill="var(--color-muted-foreground)" fillOpacity={0.07} ifOverflow="hidden" />
          ))}
          <Tooltip
            content={<SeriesTooltip currency={currency} showTotal={stacked} />}
            cursor={{ stroke: 'var(--color-muted-foreground)', strokeWidth: 1 }}
          />
          {series.map((item) => (
            <Area
              key={item.key}
              dataKey={item.key}
              name={item.label}
              type="monotone"
              stackId={stacked ? 'stack' : undefined}
              stroke={item.color}
              strokeWidth={2}
              fill={single ? 'url(#fill-single)' : item.color}
              fillOpacity={single ? 1 : 0.85}
              connectNulls
              isAnimationActive={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--color-card)' }}
              dot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Legend({ items }: { items: { key: string; label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: item.color }} />
          <span className="text-muted-foreground">{item.label}</span>
          {item.value && <span className="font-medium">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Donut                                                               */
/* ------------------------------------------------------------------ */

export interface Slice {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function Donut({
  slices,
  center,
  caption,
  formatValue,
  size = 200,
}: {
  slices: Slice[];
  center: string;
  caption: string;
  formatValue: (slice: Slice, share: number) => string;
  size?: number;
}) {
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <ResponsiveContainer>
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            innerRadius="68%"
            outerRadius="100%"
            paddingAngle={slices.length > 1 ? 1.5 : 0}
            stroke="var(--color-card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map((slice) => (
              <Cell key={slice.key} fill={slice.color} />
            ))}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const slice = payload[0].payload as Slice;
              return (
                <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
                  <p className="font-medium">{slice.label}</p>
                  <p className="text-muted-foreground">{formatValue(slice, total ? slice.value / total : 0)}</p>
                </div>
              );
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="text-lg font-semibold">{center}</p>
          <p className="text-xs text-muted-foreground">{caption}</p>
        </div>
      </div>
    </div>
  );
}
