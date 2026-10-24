/** Calendar dates are `YYYY-MM-DD` strings throughout (no time zone). */

export type IsoDate = string;

/** The calendar date in New York — the market date for daily snapshots. */
export function marketDate(now: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** The US market's close (4pm New York) on `date`, as epoch ms. */
export function marketCloseAt(date: IsoDate): number {
  // 4pm New York is 20:00 UTC in summer (EDT), 21:00 in winter (EST).
  for (const hour of [20, 21]) {
    const candidate = Date.parse(`${date}T${hour}:00:00Z`);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(candidate);
    if (Number(local) === 16) return candidate;
  }
  return Date.parse(`${date}T21:00:00Z`);
}

/** The most recent market close at or before `now` (any day of the week). */
export function lastMarketClose(now: Date): number {
  const today = marketCloseAt(marketDate(now));
  return today <= now.getTime() ? today : marketCloseAt(addDays(marketDate(now), -1));
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The most recent weekday on or before `date`: the last day a US close can
 * exist for. Market holidays aren't modelled (a holiday just means one
 * fruitless price check).
 */
export function lastTradingDay(date: IsoDate): IsoDate {
  let day = date;
  for (;;) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) return day;
    day = addDays(day, -1);
  }
}

/**
 * The trading day of the latest close at `at` (epoch ms): the last weekday
 * whose 4pm New York close has passed. What data fetched then describes.
 */
export function lastClosedTradingDay(at: number): IsoDate {
  let day = lastTradingDay(marketDate(new Date(at)));
  while (marketCloseAt(day) > at) day = lastTradingDay(addDays(day, -1));
  return day;
}

/** 6.5 hours: 9:30am to 4pm. */
const SESSION_MS = 390 * 60 * 1000;

/**
 * The trading day whose close a price current at `at` (epoch ms) is: from
 * that day's 4pm New York close until the next weekday's 9:30am open. Null
 * during trading hours, when a price is intraday.
 */
export function closeDayOf(at: number): IsoDate | null {
  const day = lastClosedTradingDay(at);
  let next = addDays(day, 1);
  while (lastTradingDay(next) !== next) next = addDays(next, 1);
  return at < marketCloseAt(next) - SESSION_MS ? day : null;
}

/** New York calendar date and minutes past midnight for an instant. */
export function newYorkClock(instant: Date): { date: IsoDate; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Inclusive list of dates from `start` to `end`. */
export function dateRange(start: IsoDate, end: IsoDate): IsoDate[] {
  const dates: IsoDate[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
