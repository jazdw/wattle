/** Request validation (zod), shared by the server and client forms. */
import { z } from 'zod';
import { CURRENCIES } from './money';
import { CATEGORIES, SIZES, STYLES } from './taxonomy';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const category = z.enum(CATEGORIES);
const weights = <T extends readonly [string, ...string[]]>(keys: T) =>
  z.partialRecord(z.enum(keys), z.number().min(0).max(1));

export const classificationSchema = z.object({
  categories: weights(CATEGORIES),
  sizes: weights(SIZES).optional(),
  styles: weights(STYLES).optional(),
});

export const linkTokenSchema = z.object({
  kind: z.enum(['investments', 'banking']),
  /** Re-authenticate an existing connection (update mode). */
  connectionId: z.string().optional(),
});

export const exchangeSchema = z.object({
  publicToken: z.string().min(1),
  kind: z.enum(['investments', 'banking']),
});

export const manualAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'property', 'other']),
  currency: z.enum(CURRENCIES),
  category: category.nullable().optional(),
  institutionName: z.string().trim().max(100).nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  /** Opening balance in major units (liabilities as positive amounts owed). */
  balance: z.number().finite().optional(),
  date: isoDate.optional(),
});

export const accountPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  ownerUserId: z.string().nullable().optional(),
  isHidden: z.boolean().optional(),
  /** When hiding: also delete the account's stored holdings and history. */
  purge: z.boolean().optional(),
  category: category.nullable().optional(),
  currency: z.enum(CURRENCIES).optional(),
});

export const balanceEntrySchema = z.object({
  date: isoDate,
  /** Major units; liabilities as positive amounts owed. */
  balance: z.number().finite(),
});

export const manualHoldingsSchema = z.object({
  holdings: z
    .array(
      z.object({
        ticker: z.string().trim().min(1).max(20),
        name: z.string().trim().max(200).optional(),
        quantity: z.number().finite().min(0),
        /** Unit price for funds without a public ticker. */
        price: z.number().finite().min(0).optional(),
      }),
    )
    .max(200),
});

export const securityPatchSchema = z.object({
  classification: classificationSchema,
});

export const targetSchema = z.object({
  name: z.string().trim().min(1).max(60).default('Target'),
  weights: weights(CATEGORIES),
  bandPct: z.number().min(0).max(50),
  excludedAccountIds: z.array(z.string()).max(200),
  excludedCategories: z.array(category),
});

export const householdPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  displayCurrency: z.enum(CURRENCIES).optional(),
});

export const importBalancesSchema = z.object({
  accountId: z.string(),
  rows: z.array(z.object({ date: isoDate, balance: z.number().finite() })).min(1).max(5000),
  /** Replace synced/backfilled values for the same dates. */
  overwrite: z.boolean().default(false),
});

export const importHoldingsSchema = z.object({
  accountId: z.string(),
  rows: z
    .array(
      z.object({
        date: isoDate,
        ticker: z.string().trim().min(1).max(20),
        quantity: z.number().finite(),
        price: z.number().finite().optional(),
      }),
    )
    .min(1)
    .max(20000),
  overwrite: z.boolean().default(false),
});
