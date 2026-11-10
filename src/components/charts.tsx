import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Currency } from '../../shared/money';
import type { HistoryResponse } from '../../shared/types';
import { longDate, money, shortDate } from '../lib/format';
import { stackAreas, type ChartSeries } from '../lib/series';

/* ------------------------------------------------------------------ */
/* Time series                                                         */
/* ------------------------------------------------------------------ */

interface TooltipPayload {
  dataKey: string;
  value: number;
  color: string;
  name: string;
}

/** The space between two of a chart's lines, shaded and named (Overview: what's between the balance and the money put in). */
export interface ChartBand {
  label: string;
  color: string;
  /** Where the upper series falls below the lower one (a loss): shaded this instead. */
  negativeColor?: string;
  /** The keys of the lower and upper series: the band's value is upper less lower. */
  from: string;
  to: string;
}

const BAND_KEY = '__band';
const BAND_BELOW_KEY = '__band_below';

function SeriesTooltip({
  active,
  payload,
  label,
  currency,
  showTotal,
  band,
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
  currency: Currency;
  showTotal: boolean;
  band?: ChartBand;
}) {
  if (!active || !payload?.length || !label) return null;
  // A series stacked as its parts above and below zero (see TimeSeriesChart) is one row again.
  const byName = new Map<string, TooltipPayload>();
  for (const row of payload) {
    if (row.value === null || row.value === undefined || row.dataKey === BAND_KEY || row.dataKey === BAND_BELOW_KEY) continue;
    const seen = byName.get(row.name);
    byName.set(row.name, seen ? { ...seen, value: seen.value + row.value } : row);
  }
  const rows = [...byName.values()];
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const lower = band && rows.find((row) => row.dataKey === band.from);
  const upper = band && rows.find((row) => row.dataKey === band.to);
  return (
    <div className="min-w-44 rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{longDate(label)}</p>
      {band && lower && upper && (
        <p className="mb-1 flex justify-between gap-4 font-semibold">
          <span>{band.label}</span>
          <span>{money(upper.value - lower.value, currency)}</span>
        </p>
      )}
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
  lines = false,
  band,
  height = 280,
}: {
  history: HistoryResponse;
  series: ChartSeries[];
  currency: Currency;
  stacked: boolean;
  /** Lines only, no fill (unstacked). */
  lines?: boolean;
  band?: ChartBand;
  height?: number;
}) {
  const areas = useMemo(() => stackAreas(series, stacked), [series, stacked]);
  const data = useMemo(
    () =>
      history.dates.map((date, position) => {
        const row: Record<string, string | number | null | number[]> = { date };
        for (const item of areas) row[item.key] = item.values[position];
        if (band) {
          const from = series.find((item) => item.key === band.from)?.values[position];
          const to = series.find((item) => item.key === band.to)?.values[position];
          const known = from !== null && from !== undefined && to !== null && to !== undefined;
          // Above its lower series it's the band's colour; below, its negative colour (when it has one).
          const below = known && to < from && Boolean(band.negativeColor);
          row[BAND_KEY] = known && !below ? [Math.min(from, to), Math.max(from, to)] : null;
          row[BAND_BELOW_KEY] = known && below ? [to, from] : null;
        }
        return row;
      }),
    [history.dates, areas, band, series],
  );
  const single = series.length === 1 && !lines;

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
          <Tooltip
            content={<SeriesTooltip currency={currency} showTotal={stacked} band={band} />}
            cursor={{ stroke: 'var(--color-muted-foreground)', strokeWidth: 1 }}
          />
          {band && <Area dataKey={BAND_KEY} name={band.label} type="monotone" stroke="none" fill={band.color} fillOpacity={0.18} isAnimationActive={false} activeDot={false} dot={false} />}
          {band?.negativeColor && <Area dataKey={BAND_BELOW_KEY} name={band.label} type="monotone" stroke="none" fill={band.negativeColor} fillOpacity={0.18} isAnimationActive={false} activeDot={false} dot={false} />}
          {areas.map((item) => (
            <Area
              key={item.key}
              dataKey={item.key}
              name={item.shortLabel ?? item.label}
              type="monotone"
              stackId={stacked ? 'stack' : undefined}
              stroke={item.color}
              strokeWidth={2}
              fill={lines ? 'none' : single ? 'url(#fill-single)' : item.color}
              fillOpacity={lines ? 0 : single ? 1 : 0.85}
              connectNulls={!item.gaps}
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
