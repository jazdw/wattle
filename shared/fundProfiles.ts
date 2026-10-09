import type { Classification } from './taxonomy';

/**
 * Seed classifications for common funds and ETFs. Figures are approximate
 * (rounded Morningstar-style splits) and every one can be overridden per
 * household in the UI. A profile is either a direct classification or a mix of
 * other profiles (fund-of-funds such as target-date funds).
 */
export type FundProfile = Classification | { mix: [ticker: string, weight: number][] };

const TOTAL_US: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.72, mid: 0.19, small: 0.09 },
  styles: { value: 0.3, blend: 0.32, growth: 0.38 },
};
const SP500: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.86, mid: 0.14 },
  styles: { value: 0.28, blend: 0.33, growth: 0.39 },
};
const NASDAQ100: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.9, mid: 0.1 },
  styles: { value: 0.05, blend: 0.15, growth: 0.8 },
};
const US_LARGE_GROWTH: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.85, mid: 0.15 },
  styles: { blend: 0.1, growth: 0.9 },
};
const US_LARGE_VALUE: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.8, mid: 0.2 },
  styles: { value: 0.9, blend: 0.1 },
};
const US_MID: Classification = {
  categories: { us_stock: 1 },
  sizes: { large: 0.05, mid: 0.85, small: 0.1 },
  styles: { value: 0.33, blend: 0.34, growth: 0.33 },
};
const US_SMALL: Classification = {
  categories: { us_stock: 1 },
  sizes: { mid: 0.4, small: 0.6 },
  styles: { value: 0.33, blend: 0.34, growth: 0.33 },
};
const US_SMALL_VALUE: Classification = {
  categories: { us_stock: 1 },
  sizes: { mid: 0.2, small: 0.8 },
  styles: { value: 0.85, blend: 0.15 },
};
const TOTAL_INTL: Classification = {
  categories: { intl_stock: 0.75, em_stock: 0.25 },
  sizes: { large: 0.75, mid: 0.17, small: 0.08 },
  styles: { value: 0.38, blend: 0.34, growth: 0.28 },
};
const INTL_DEVELOPED: Classification = {
  categories: { intl_stock: 1 },
  sizes: { large: 0.78, mid: 0.17, small: 0.05 },
  styles: { value: 0.38, blend: 0.33, growth: 0.29 },
};
const EMERGING: Classification = {
  categories: { em_stock: 1 },
  sizes: { large: 0.75, mid: 0.18, small: 0.07 },
  styles: { value: 0.32, blend: 0.34, growth: 0.34 },
};
const US_BOND: Classification = { categories: { us_bond: 1 } };
const INTL_BOND: Classification = { categories: { intl_bond: 1 } };
const CASH: Classification = { categories: { cash: 1 } };
const REIT: Classification = { categories: { real_estate: 1 } };
const AU_SHARES: Classification = {
  categories: { au_stock: 1 },
  sizes: { large: 0.8, mid: 0.15, small: 0.05 },
  styles: { value: 0.35, blend: 0.4, growth: 0.25 },
};
// MSCI World ex-Australia: mostly US.
const WORLD_EX_AU: Classification = {
  categories: { us_stock: 0.72, intl_stock: 0.28 },
  sizes: { large: 0.82, mid: 0.16, small: 0.02 },
  styles: { value: 0.3, blend: 0.33, growth: 0.37 },
};

function all(tickers: string[], profile: FundProfile): Record<string, FundProfile> {
  return Object.fromEntries(tickers.map((ticker) => [ticker, profile]));
}

/**
 * Vanguard Target Retirement mix for a given retirement year: ~90% stocks
 * until ~25 years out, gliding to ~50% at the target date. Stocks split 60/40
 * US/international, bonds 70/30 US/international.
 */
export function targetDateMix(year: number, now = new Date().getUTCFullYear()): [string, number][] {
  const yearsOut = year - now;
  const stocks = Math.max(0.5, Math.min(0.9, 0.5 + (0.4 * yearsOut) / 25));
  const bonds = 1 - stocks;
  return [
    ['VTI', stocks * 0.6],
    ['VXUS', stocks * 0.4],
    ['BND', bonds * 0.7],
    ['BNDX', bonds * 0.3],
  ];
}

const TARGET_DATE_TICKERS: Record<number, string[]> = {
  2025: ['VTTVX'],
  2030: ['VTHRX'],
  2035: ['VTTHX'],
  2040: ['VFORX'],
  2045: ['VTIVX'],
  2050: ['VFIFX'],
  2055: ['VFFVX'],
  2060: ['VTTSX'],
  2065: ['VLXVX'],
  2070: ['VSVNX'],
};

export const FUND_PROFILES: Record<string, FundProfile> = {
  ...all(['VTSAX', 'VTI', 'VTSMX', 'FSKAX', 'FZROX', 'SWTSX', 'ITOT', 'SCHB'], TOTAL_US),
  ...all(['VFIAX', 'VOO', 'VFINX', 'SPY', 'IVV', 'SPLG', 'FXAIX', 'SWPPX', 'SCHX', 'VV'], SP500),
  ...all(['QQQ', 'QQQM'], NASDAQ100),
  ...all(['VUG', 'VIGAX', 'SCHG', 'IWF', 'MGK'], US_LARGE_GROWTH),
  ...all(['VTV', 'VVIAX', 'SCHD', 'IWD', 'VYM'], US_LARGE_VALUE),
  ...all(['VO', 'VIMAX', 'IJH'], US_MID),
  ...all(['VB', 'VSMAX', 'IJR', 'SCHA', 'IWM', 'VTWO'], US_SMALL),
  ...all(['VBR', 'VSIAX', 'AVUV', 'IJS'], US_SMALL_VALUE),
  ...all(['VTIAX', 'VXUS', 'VGTSX', 'IXUS', 'FTIHX', 'FZILX'], TOTAL_INTL),
  ...all(['VEA', 'VTMGX', 'IEFA', 'SCHF', 'SWISX', 'EFA'], INTL_DEVELOPED),
  ...all(['VWO', 'VEMAX', 'IEMG', 'SCHE', 'EEM'], EMERGING),
  ...all(
    [
      'VBTLX', 'BND', 'AGG', 'FXNAX', 'SCHZ', 'VBMFX', 'BIV', 'BSV', 'BLV', 'VGIT', 'VGSH', 'VGLT',
      'SHY', 'IEF', 'TLT', 'VTIP', 'SCHP', 'TIP', 'VBIRX', 'VBILX', 'VWIUX', 'VTEB', 'MUB',
    ],
    US_BOND,
  ),
  ...all(['VTABX', 'BNDX', 'IAGG'], INTL_BOND),
  ...all(['VMFXX', 'VUSXX', 'VMRXX', 'SPAXX', 'FDRXX', 'SWVXX', 'SGOV', 'BIL'], CASH),
  ...all(['VGSLX', 'VNQ', 'SCHH', 'VNQI'], REIT),
  ...all(['VT', 'VTWAX'], { mix: [['VTI', 0.62], ['VXUS', 0.38]] }),
  // Australian-listed (ASX) funds.
  ...all(['VAS', 'A200', 'IOZ', 'STW'], AU_SHARES),
  ...all(['VGS', 'IWLD'], WORLD_EX_AU),
  VGE: EMERGING,
  VAF: { categories: { intl_bond: 1 } },
  VDHG: { mix: [['VAS', 0.36], ['VGS', 0.37], ['VGE', 0.07], ['VB', 0.1], ['VAF', 0.1]] },
  ...Object.fromEntries(
    Object.entries(TARGET_DATE_TICKERS).flatMap(([year, tickers]) =>
      tickers.map((ticker) => [ticker, { mix: targetDateMix(Number(year)) }]),
    ),
  ),
};
