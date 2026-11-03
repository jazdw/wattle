/**
 * OFX / QFX downloads (what institutions offer for Quicken), as one import's
 * accounts (./imports): an investment account's positions and cash, its
 * transactions and the securities they name; a bank or card account's
 * balance on each day its transactions cover. Parsed in the browser with
 * ofx-js (both OFX 1.x SGML and 2.x XML); the server checks the result and
 * works out each day from it.
 */
import { parseStrict } from 'ofx-js';
import { addDays, type IsoDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';
import type { ImportedHoldings, ImportKind } from '../../shared/schemas';
import type { FileAccount, ReadTransaction } from './imports';
import { balanceRows } from './known';

/** Elements and what they do; any other is listed as not understood. */
const KINDS: Record<string, ImportKind> = {
  BUYMF: 'buy',
  BUYSTOCK: 'buy',
  BUYOTHER: 'buy',
  SELLMF: 'sell',
  SELLSTOCK: 'sell',
  SELLOTHER: 'sell',
  REINVEST: 'reinvest',
  TRANSFER: 'transfer',
  INCOME: 'income',
  INVBANKTRAN: 'deposit',
};
const LISTS = new Set(['DTSTART', 'DTEND']);
const CHARGES = ['COMMISSION', 'FEES', 'LOAD', 'TAXES', 'WITHHOLDING'];
/** How long after its income a reinvestment may come. */
const REINVEST_DAYS = 7;

type Element = Record<string, unknown>;
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const number = (value: unknown) => Number(text(value)) || 0;
/** An OFX date-time (20260105150000.000[-6:CST]) as the institution's calendar day. */
const day = (value: unknown) => {
  const digits = text(value).slice(0, 8);
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` as IsoDate;
};
/** ofx-js decodes one level of entities; some institutions escape twice (S&amp;amp;P). */
const decode = (value: string) =>
  value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[name] ?? '');
/** Words some institutions put in the ticker field of a fund that has no ticker. */
const NOT_TICKERS = new Set(['UNKNOWN', 'NULL', 'NONE', 'N/A', 'NA', 'CASH', 'LOAN', 'ALLOC']);
/**
 * A market ticker, or null for a fund with none: plans fill the field with
 * "Unknown", a word (CASH, LOAN) or a numbered placeholder (NONE9, NON0Z).
 */
export const ticker = (value: unknown) => {
  const symbol = text(value).toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol) && !NOT_TICKERS.has(symbol) && !/^NON[E0-9]/.test(symbol) ? symbol : null;
};

/** Whether a file looks like OFX (either version) rather than CSV. */
export function isOfx(content: string): boolean {
  return /^\s*(OFXHEADER:|<\?xml[^>]*>\s*<\?OFX|<OFX>)/i.test(content);
}

/** Each account in a download: investment, bank and card statements. */
export function ofxAccounts(content: string): FileAccount[] {
  const ofx = parseStrict(content).OFX;
  const securities = new Map<string, ImportedHoldings['securities'][number]>();
  for (const [kind, entries] of Object.entries(ofx.SECLISTMSGSRSV1?.SECLIST ?? {})) {
    if (!kind.endsWith('INFO')) continue;
    for (const entry of list(entries as Element | Element[])) {
      const info = entry.SECINFO as Element | undefined;
      const id = text((info?.SECID as Element | undefined)?.UNIQUEID);
      if (id) securities.set(id, { id, ticker: ticker(info?.TICKER), name: decode(text(info?.SECNAME)) || id });
    }
  }
  const signOn = (ofx.SIGNONMSGSRSV1 as unknown as Element | undefined)?.SONRS as Element | undefined;
  const institution = text((signOn?.FI as Element | undefined)?.ORG) || null;
  const responses = (messages: string, wrapper: string, inner: string) =>
    list(((ofx as unknown as Element)[messages] as Element | undefined)?.[wrapper] as Element | Element[] | undefined).flatMap((response) => (response[inner] ? [response[inner] as Element] : []));
  return [
    ...list(ofx.INVSTMTMSGSRSV1?.INVSTMTTRNRS).flatMap((response) => (response.INVSTMTRS ? [statement(response.INVSTMTRS as unknown as Element, securities, institution)] : [])),
    // A bank or card statement with no closing balance has nothing to work back from.
    ...responses('BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS').flatMap((response) => (response.LEDGERBAL ? [bankStatement(response, institution, false)] : [])),
    ...responses('CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS').flatMap((response) => (response.LEDGERBAL ? [bankStatement(response, institution, true)] : [])),
  ];
}

/**
 * A bank or card statement as the account's balance at the end of each day
 * a transaction posted, worked back from its closing (ledger) balance, and
 * on the day the statement starts; the import carries each forward to the
 * next. A card's balance is what's owed.
 */
function bankStatement(response: Element, institution: string | null, card: boolean): FileAccount {
  const from = (response.BANKACCTFROM ?? response.CCACCTFROM) as Element | undefined;
  const ledger = response.LEDGERBAL as Element;
  const asOf = day(ledger.DTASOF);
  const transactions = response.BANKTRANLIST as Element | undefined;
  const posted = list(transactions?.STMTTRN as Element | Element[] | undefined).map((entry) => ({ date: day(entry.DTPOSTED), amount: toMinor(number(entry.TRNAMT)) }));
  const rows = balanceRows(posted, toMinor(number(ledger.BALAMT)), asOf, text(transactions?.DTSTART) ? day(transactions?.DTSTART) : null, card);
  const type = text(from?.ACCTTYPE);
  return {
    number: text(from?.ACCTID) || null,
    institution,
    type: card || type === 'CREDITLINE' ? 'credit' : 'depository',
    unknownTypes: [],
    file: { kind: 'balances', currency: text(response.CURDEF) || 'USD', rows },
  };
}

function statement(response: Element, securities: Map<string, ImportedHoldings['securities'][number]>, institution: string | null): FileAccount {
  const positions: ImportedHoldings['positions'] = [];
  let asOf: IsoDate | null = null;
  for (const entries of Object.values((response.INVPOSLIST ?? {}) as Element)) {
    for (const entry of list(entries as Element | Element[])) {
      const position = entry.INVPOS as Element;
      const security = text((position.SECID as Element).UNIQUEID);
      const date = day(position.DTPRICEASOF);
      if (!asOf || date > asOf) asOf = date;
      if (number(position.UNITS) !== 0) positions.push({ security, shares: number(position.UNITS), price: Math.abs(number(position.UNITPRICE)) });
    }
  }

  const transactions: ReadTransaction[] = [];
  const unknownTypes = new Set<string>();
  for (const [type, entries] of Object.entries((response.INVTRANLIST ?? {}) as Record<string, unknown>)) {
    if (LISTS.has(type)) continue;
    const kind = KINDS[type];
    if (!kind) {
      unknownTypes.add(type);
      continue;
    }
    for (const entry of list(entries as Element | Element[])) transactions.push(transaction(type, kind, entry));
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  // A reinvestment is the income and the purchase it pays for, as other downloads list them (into a
  // money market fund, which is cash, the income is what changes the account's cash). Most come on
  // their own; one reinvested after it's paid, or less a fee, comes after its income, which then isn't added again.
  const paid = transactions.filter((txn) => txn.kind === 'income' && txn.security);
  // The largest first, so a smaller one doesn't take the income a larger one spent.
  for (const txn of transactions.filter((candidate) => candidate.kind === 'reinvest').sort((a, b) => b.value - a.value)) {
    txn.amount = -txn.value;
    // Its income may be more than it reinvests: a fee (an ADR's custody fee, listed on its own) comes out first.
    const earlier = closestIncome(paid, txn);
    if (earlier >= 0) paid.splice(earlier, 1);
    else transactions.push({ ...txn, id: txn.id && `${txn.id}:income`, kind: 'income', shares: 0, price: 0, amount: txn.value, value: 0, charges: 0 });
  }

  // Sweep funds are cash: moving money into or out of them is a sweep, their income is cash income.
  const cash = toMinor(number((response.INVBAL as Element | undefined)?.AVAILCASH));
  const swept = sweepFunds(cash, positions);
  for (const txn of transactions) {
    if (!txn.security || !swept.has(txn.security)) continue;
    if (txn.kind !== 'income') Object.assign(txn, { kind: 'sweep', shares: 0 });
    txn.security = null;
  }
  // Some institutions reinvest the sweep's interest as a withdrawal of the same amount on the day it's
  // paid: the money moves into the sweep (still cash), it doesn't leave the account.
  const cashIncome = transactions.filter((txn) => txn.kind === 'income' && txn.security === null);
  for (const txn of transactions) {
    if (txn.kind !== 'withdrawal') continue;
    const paid = cashIncome.findIndex((income) => income.date === txn.date && income.amount === -txn.amount);
    if (paid < 0) continue;
    cashIncome.splice(paid, 1);
    txn.kind = 'sweep';
  }
  const held = positions.filter((row) => !swept.has(row.security));

  const account = text((response.INVACCTFROM as Element | undefined)?.ACCTID);
  const used = new Set([...held.map((row) => row.security), ...transactions.flatMap((txn) => (txn.security ? [txn.security] : []))]);
  const lastTrade = transactions.map((txn) => txn.date).sort().at(-1);
  return {
    number: account || null,
    institution: institution ?? (text((response.INVACCTFROM as Element | undefined)?.BROKERID) || null),
    unknownTypes: [...unknownTypes],
    file: {
      kind: 'holdings',
      currency: text(response.CURDEF) || 'USD',
      asOf: asOf ?? lastTrade ?? day(response.DTASOF),
      securities: [...securities.values()].filter((security) => used.has(security.id)),
      positions: held,
      cash,
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
    },
  };
}

/**
 * The income a reinvestment spent: from the same security in the days
 * before, at least as much, the closest in amount (two dividends on one day,
 * one less a fee, each go with their own reinvestment); -1 when none.
 */
export function closestIncome(incomes: ReadTransaction[], reinvestment: ReadTransaction): number {
  let best = -1;
  incomes.forEach((income, index) => {
    if (income.security !== reinvestment.security || income.amount < reinvestment.value || income.date > reinvestment.date || income.date < addDays(reinvestment.date, -REINVEST_DAYS)) return;
    if (best < 0 || income.amount < incomes[best].amount) best = index;
  });
  return best;
}

/**
 * The funds the account's cash is swept into. OFX's available cash includes
 * sweep funds: a money market or bank sweep position ($1 a share) worth
 * exactly that much is the cash itself, not a holding beside it.
 */
function sweepFunds(available: number, positions: ImportedHoldings['positions']): Set<string> {
  const dollar = positions.filter((row) => row.price === 1);
  const worth = (rows: typeof dollar) => rows.reduce((sum, row) => sum + toMinor(row.shares), 0);
  if (available === 0 || dollar.length === 0) return new Set();
  const one = dollar.find((row) => Math.abs(worth([row]) - available) <= 1);
  if (one) return new Set([one.security]);
  return Math.abs(worth(dollar) - available) <= 1 ? new Set(dollar.map((row) => row.security)) : new Set();
}

function transaction(type: string, kind: ImportKind, entry: Element): ReadTransaction {
  if (type === 'INVBANKTRAN') {
    // Money in or out of the account's cash.
    const bank = entry.STMTTRN as Element;
    const amount = toMinor(number(bank.TRNAMT));
    return { id: text(bank.FITID), date: day(bank.DTPOSTED), kind: amount < 0 ? 'withdrawal' : 'deposit', label: type, security: null, shares: 0, price: 0, amount, value: 0, charges: 0 };
  }
  // Buys and sells keep their details in INVBUY / INVSELL; the others at the top.
  const detail = (entry.INVBUY ?? entry.INVSELL ?? entry) as Element;
  const core = detail.INVTRAN as Element;
  const total = Math.abs(toMinor(number(detail.TOTAL)));
  // Institutions differ on the sign of a sale's units: the element says which way they went.
  const direction = kind === 'sell' || (kind === 'transfer' && text(entry.TFERACTION) === 'OUT') ? -1 : 1;
  const shares = kind === 'income' ? 0 : direction * Math.abs(number(detail.UNITS));
  // Cash: a buy pays the total, a sale and income bring it in; a transfer only moves shares (a reinvestment's income is added by the caller).
  const amount = kind === 'buy' ? -total : kind === 'sell' ? total : kind === 'income' ? toMinor(number(detail.TOTAL)) : 0;
  return {
    id: text(core.FITID),
    date: day(core.DTTRADE),
    kind,
    label: type,
    security: text((detail.SECID as Element | undefined)?.UNIQUEID) || null,
    shares,
    price: Math.abs(number(detail.UNITPRICE)),
    amount,
    value: kind === 'income' || kind === 'transfer' ? 0 : total,
    charges: CHARGES.reduce((sum, field) => sum + Math.abs(toMinor(number(detail[field]))), 0),
  };
}
