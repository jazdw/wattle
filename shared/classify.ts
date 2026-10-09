import { FUND_PROFILES, targetDateMix, type FundProfile } from './fundProfiles';
import {
  normalizeWeights,
  type Category,
  type Classification,
  type ClassificationSource,
  type Size,
  type Style,
  type Weights,
} from './taxonomy';

/** Resolve a seeded profile (following fund-of-fund mixes) into weights. */
export function resolveProfile(
  profile: FundProfile,
  profiles: Record<string, FundProfile> = FUND_PROFILES,
  depth = 0,
): Classification {
  if (!('mix' in profile)) return profile;
  if (depth > 4) return { categories: { other: 1 } };

  const categories: Weights<Category> = {};
  const sizes: Weights<Size> = {};
  const styles: Weights<Style> = {};
  for (const [ticker, weight] of profile.mix) {
    const component = profiles[ticker];
    const resolved = component ? resolveProfile(component, profiles, depth + 1) : { categories: { other: 1 } };
    const componentCategories = normalizeWeights(resolved.categories);
    for (const [key, value] of Object.entries(componentCategories) as [Category, number][]) {
      categories[key] = (categories[key] ?? 0) + value * weight;
    }
    // Size/style describe the equity sleeve, so weight them by equity value.
    const equityShare =
      (componentCategories.us_stock ?? 0) +
      (componentCategories.intl_stock ?? 0) +
      (componentCategories.em_stock ?? 0) +
      (componentCategories.au_stock ?? 0);
    for (const [key, value] of Object.entries(resolved.sizes ?? {}) as [Size, number][]) {
      sizes[key] = (sizes[key] ?? 0) + value * weight * equityShare;
    }
    for (const [key, value] of Object.entries(resolved.styles ?? {}) as [Style, number][]) {
      styles[key] = (styles[key] ?? 0) + value * weight * equityShare;
    }
  }
  const result: Classification = { categories: normalizeWeights(categories) };
  if (Object.keys(sizes).length > 0) result.sizes = normalizeWeights(sizes);
  if (Object.keys(styles).length > 0) result.styles = normalizeWeights(styles);
  return result;
}

export interface SecurityFacts {
  ticker: string | null;
  name: string | null;
  /** Plaid security type: equity, etf, mutual fund, fixed income, cash, cryptocurrency, derivative, … */
  type: string | null;
  /** Listing currency, used to spot Australian shares. */
  currency?: string | null;
}

export interface Suggestion {
  classification: Classification;
  source: Exclude<ClassificationSource, 'user'>;
  /** True when the guess is weak and the user should check it. */
  needsReview: boolean;
}

function has(name: string, ...needles: string[]): boolean {
  return needles.some((needle) => name.includes(needle));
}

/**
 * Best classification for a security: a seeded fund profile when the ticker is
 * known, otherwise a heuristic from the name and Plaid type. Works for
 * non-public 401(k) trusts too ("Vanguard Target Retirement 2055 Trust").
 */
export function suggestClassification(facts: SecurityFacts): Suggestion {
  const ticker = facts.ticker?.trim().toUpperCase() ?? '';
  const seeded = FUND_PROFILES[ticker];
  if (seeded) return { classification: resolveProfile(seeded), source: 'seed', needsReview: false };

  const name = (facts.name ?? '').toLowerCase();
  const type = (facts.type ?? '').toLowerCase();
  const heuristic = (classification: Classification, needsReview = false): Suggestion => ({
    classification,
    source: 'heuristic',
    needsReview,
  });

  if (type === 'cash' || ticker.startsWith('CUR:') || has(name, 'money market', 'settlement fund', 'cash')) {
    return heuristic({ categories: { cash: 1 } });
  }
  if (type === 'cryptocurrency') return heuristic({ categories: { crypto: 1 } });
  if (type === 'derivative') return heuristic({ categories: { other: 1 } }, true);

  const targetYear = name.match(/(?:target|retirement|lifecycle|freedom)[^0-9]*(20[2-7]\d)/)?.[1];
  if (targetYear) return heuristic(resolveProfile({ mix: targetDateMix(Number(targetYear)) }), true);

  if (type === 'fixed income' || has(name, 'bond', 'treasury', 'fixed income', 'tips', 'income fund')) {
    return heuristic(
      has(name, 'international', 'intl', 'global', 'ex-us', 'ex us')
        ? { categories: { intl_bond: 1 } }
        : { categories: { us_bond: 1 } },
      true,
    );
  }
  if (has(name, 'real estate', 'reit')) return heuristic({ categories: { real_estate: 1 } }, true);
  if (has(name, 'stable value')) return heuristic({ categories: { cash: 1 } }, true);
  if (has(name, 'emerging')) return heuristic(resolveProfile(FUND_PROFILES.VWO), true);
  if (has(name, 'international', 'intl', 'developed', 'ex-us', 'ex us', 'foreign', 'eafe')) {
    return heuristic(resolveProfile(FUND_PROFILES.VXUS), true);
  }
  if (facts.currency === 'AUD') return heuristic(resolveProfile(FUND_PROFILES.VAS), true);

  const sizes: Weights<Size> | undefined = has(name, 'small')
    ? { small: 0.8, mid: 0.2 }
    : has(name, 'mid')
      ? { mid: 0.85, large: 0.05, small: 0.1 }
      : has(name, 'large', '500', 'total')
        ? { large: 0.8, mid: 0.15, small: 0.05 }
        : undefined;
  const styles: Weights<Style> | undefined = has(name, 'value')
    ? { value: 0.85, blend: 0.15 }
    : has(name, 'growth')
      ? { growth: 0.85, blend: 0.15 }
      : has(name, 'index', 'total', '500')
        ? { value: 0.3, blend: 0.34, growth: 0.36 }
        : undefined;

  const classification: Classification = { categories: { us_stock: 1 } };
  if (sizes) classification.sizes = sizes;
  if (styles) classification.styles = styles;
  // Single stocks are fine as US stocks (size/style unknown); funds without a
  // profile need a look.
  return heuristic(classification, type !== 'equity');
}
