/** Request validation (zod), shared by the server and client forms. */
import { z } from 'zod';
import { CURRENCIES } from './money';
import { CATEGORIES, SECURITY_TYPES, SIZES, STYLES } from './taxonomy';
import { TRANSACTION_KINDS, type TransactionKind } from './transactionKinds';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const category = z.enum(CATEGORIES);
const weights = <T extends readonly [string, ...string[]]>(keys: T) =>
  // Any non-negative numbers; the server normalises them to sum to 1.
  z.partialRecord(z.enum(keys), z.number().min(0).max(1e6));

export const classificationSchema = z.object({
  categories: weights(CATEGORIES),
  sizes: weights(SIZES).optional(),
  styles: weights(STYLES).optional(),
});

export const linkTokenSchema = z
  .object({
    kind: z.enum(['account', 'investments']),
    /** Re-authenticate an existing connection (update mode). */
    connectionId: z.string().optional(),
    /** With connectionId: choose which of its accounts Wattle may see (add or remove). */
    chooseAccounts: z.boolean().optional(),
  })
  .refine((body) => !body.chooseAccounts || body.connectionId, { message: 'Choosing accounts needs a connection.' });

/** After Choose accounts: load history for the accounts it added, with or without a bank report. */
export const newAccountsHistorySchema = z.object({
  accountIds: z.array(z.string()).min(1).max(100),
  bankReport: z.boolean(),
});

export const exchangeSchema = z.object({
  publicToken: z.string().min(1),
  kind: z.enum(['account', 'investments']),
});

export const manualAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['depository', 'credit', 'loan', 'investment', 'property', 'other']),
  currency: z.enum(CURRENCIES),
  category: category.nullable().optional(),
  institutionName: z.string().trim().max(100).nullable().optional(),
  /** The kind of account within its type (shared/accounts.ts: checking, 401k, hsa…). */
  subtype: z.string().trim().max(40).nullable().optional(),
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
  /** A manual account's institution and kind (a linked one's come from Plaid). */
  institutionName: z.string().trim().max(100).nullable().optional(),
  subtype: z.string().trim().max(40).nullable().optional(),
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
  /** The version the editor loaded; a save is refused if it changed since. */
  version: z.number().int().min(0),
});

export const securityPatchSchema = z.object({
  classification: classificationSchema,
  /** Only for securities entered by hand: an institution's type comes from it on every sync. */
  type: z.enum(SECURITY_TYPES).nullable().optional(),
});

export const targetSchema = z.object({
  name: z.string().trim().min(1).max(60).default('Target'),
  weights: weights(CATEGORIES),
  bandPct: z.number().min(0).max(50),
  excludedAccountIds: z.array(z.string()).max(200),
  excludedCategories: z.array(category),
  /** The version the editor loaded (absent for a first target); refused if it changed since. */
  version: z.number().int().min(0).optional(),
});

export const householdPatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  displayCurrency: z.enum(CURRENCIES).optional(),
});

/** What a transaction does, as every reader maps its file's own types (src/lib/imports.ts). */
export const IMPORT_KINDS = TRANSACTION_KINDS;
export type ImportKind = TransactionKind;

const securityRef = z.string().trim().min(1).max(40);
/** The file's own id for a transaction (a Quicken FITID), kept so a re-import finds it again. */
const fileTransactionId = z.string().trim().min(1).max(255).optional();
/** How the file describes a transaction (its memo or payee). */
const fileDescription = z.string().trim().max(500).optional();

/** An investment account's download: its positions and cash now, and its transactions. */
export const importedHoldingsSchema = z.object({
  kind: z.literal('holdings'),
  /** The file's currency, when it says. */
  currency: z.string().length(3).optional(),
  /** The day the positions are as of. */
  asOf: isoDate,
  /** `id` is the file's id for the security (a CUSIP, or its ticker); `ticker` is null for funds with no market ticker. */
  securities: z.array(z.object({ id: securityRef, ticker: z.string().trim().min(1).max(20).nullable(), name: z.string().trim().min(1).max(200) })).max(1000),
  positions: z.array(z.object({ security: securityRef, shares: z.number().finite(), price: z.number().finite().nonnegative().optional() })).max(1000),
  /** Cash held now, in cents. */
  cash: z.number().int(),
  transactions: z
    .array(
      z.object({
        id: fileTransactionId,
        date: isoDate,
        kind: z.enum(IMPORT_KINDS),
        /** The file's own name for the type, for messages. */
        label: z.string().trim().min(1).max(60),
        description: fileDescription,
        /** A Quicken file's MEMO beside its NAME (the description), as the file has it. */
        memo: fileDescription,
        /** Null for cash. */
        security: securityRef.nullable(),
        /** Signed: shares in positive. */
        shares: z.number().finite(),
        price: z.number().finite().nonnegative(),
        /** Cents the account's cash changed by, as the institution reports it (positive in). */
        amount: z.number().int(),
        /** The trade's total in cents, without sign (shares × price, plus or minus the charges). */
        value: z.number().int().nonnegative(),
        /** Commission, fees, load, taxes withheld, in cents. */
        charges: z.number().int().nonnegative(),
      }),
    )
    .min(1)
    .max(20000),
});

/** Dated balances (major units; liabilities as positive amounts owed), and the transactions they came from when the file has them. */
export const importedBalancesSchema = z.object({
  kind: z.literal('balances'),
  currency: z.string().length(3).optional(),
  rows: z.array(z.object({ date: isoDate, balance: z.number().finite() })).min(1).max(5000),
  transactions: z
    .array(
      z.object({
        id: fileTransactionId,
        date: isoDate,
        kind: z.enum(IMPORT_KINDS),
        label: z.string().trim().min(1).max(60),
        description: fileDescription,
        memo: fileDescription,
        /** Cents in (+) or out (−) of the account; a card's purchases out, its payments in. */
        amount: z.number().int(),
      }),
    )
    .max(20000)
    .optional(),
});

/** One import: each account in the files, into an account you have or a new one. */
export const importSchema = z.object({
  accounts: z
    .array(
      z.object({
        /** How the file names the account (··1234), for messages. */
        label: z.string().trim().min(1).max(100),
        target: z.union([
          z.object({ accountId: z.string() }),
          z.object({ new: manualAccountSchema.pick({ name: true, type: true, subtype: true, currency: true, institutionName: true, ownerUserId: true }).extend({ mask: z.string().trim().max(4).nullable().optional() }) }),
        ]),
        file: z.discriminatedUnion('kind', [importedHoldingsSchema, importedBalancesSchema]),
      }),
    )
    .min(1)
    .max(20),
});
export type ImportRequest = z.infer<typeof importSchema>;

/** A transaction's kind, set by you; null goes back to working it out from its type. */
export const transactionPatchSchema = z.object({ kind: z.enum(TRANSACTION_KINDS).nullable() });

/** Two transactions you say are one transfer between your accounts: the money out of one and into the other. */
export const transferCreateSchema = z.object({ outId: z.string().min(1), inId: z.string().min(1) });
/** A suggested or linked transfer: it is one (confirmed), or it isn't (rejected, which is also how a link is undone). */
export const transferPatchSchema = z.object({ status: z.enum(['confirmed', 'rejected']) });

/** Securities a file names without a ticker, to suggest one for. */
export const tickerSuggestionsSchema = z.object({
  securities: z.array(z.object({ id: securityRef, name: z.string().trim().min(1).max(200) })).max(200),
});
export type ImportedHoldings = z.infer<typeof importedHoldingsSchema>;
export type ImportedBalances = z.infer<typeof importedBalancesSchema>;
export type ImportedFile = ImportedHoldings | ImportedBalances;

/** Where a page of the household's activity ends (GET /api/activity?after=…). */
export const activityCursorSchema = z.object({
  startedAt: z.number().int(),
  kind: z.enum(['run', 'snapshot', 'nightly', 'job']),
  id: z.string().max(100),
});
