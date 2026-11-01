/**
 * OFX / QFX investment statements (what institutions offer as a "Quicken"
 * download): an account's positions, its transactions and the securities
 * they name. Parsed in the browser with ofx-js (both OFX 1.x SGML and 2.x
 * XML); the server checks the result and works out each day from it.
 */
import { parseStrict } from 'ofx-js';
import type { IsoDate } from '../../shared/dates';
import { toMinor } from '../../shared/money';

export interface OfxFund {
  /** The security's id in the file (a CUSIP, usually): the same fund in every download. */
  id: string;
  name: string;
}

export interface OfxTransaction {
  /** The institution's id for the transaction (FITID): the same in overlapping downloads. */
  id: string;
  date: IsoDate;
  /** The OFX element, e.g. BUYMF. */
  type: string;
  fund: string;
  /** Signed: shares in (bought, reinvested, transferred in) positive. */
  shares: number;
  price: number;
  /** The transaction's total in cents, without sign. */
  amount: number;
  /** Commission, fees, load and taxes in cents: the total is shares × price plus or minus these. */
  charges: number;
}

export interface OfxHoldings {
  /** The account's last four characters (a download can hold several accounts). */
  account: string;
  currency: string;
  /** The day the positions are as of. */
  asOf: IsoDate;
  funds: OfxFund[];
  positions: { fund: string; shares: number; price: number }[];
  transactions: OfxTransaction[];
  /** Transaction types in the file that aren't understood yet (the import is refused). */
  unknownTypes: string[];
}

/** Elements that move shares, and which way. */
const SHARES_IN = new Set(['BUYMF', 'BUYSTOCK', 'BUYOTHER', 'REINVEST']);
const SHARES_OUT = new Set(['SELLMF', 'SELLSTOCK', 'SELLOTHER']);
const LISTS = new Set(['DTSTART', 'DTEND']);

type Element = Record<string, unknown>;
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const number = (value: unknown) => Number(text(value)) || 0;
/** An OFX date-time (20260105150000.000[-6:CST]) as the institution's calendar day. */
const day = (value: unknown) => {
  const digits = text(value).slice(0, 8);
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}` as IsoDate;
};
/** ofx-js decodes one level of entities; some institutions escape twice (S&amp;amp;P). */
const decode = (value: string) =>
  value.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[name] ?? '');

/** Whether a file looks like OFX (either version) rather than CSV. */
export function isOfx(content: string): boolean {
  return /^\s*(OFXHEADER:|<\?xml[^>]*>\s*<\?OFX|<OFX>)/i.test(content);
}

/** Each investment account's holdings in a download (none for a bank statement). */
export function ofxHoldings(content: string): OfxHoldings[] {
  const ofx = parseStrict(content).OFX;
  const funds = new Map<string, OfxFund>();
  for (const [kind, entries] of Object.entries(ofx.SECLISTMSGSRSV1?.SECLIST ?? {})) {
    if (!kind.endsWith('INFO')) continue;
    for (const entry of list(entries as Element | Element[])) {
      const info = entry.SECINFO as Element | undefined;
      const id = text((info?.SECID as Element | undefined)?.UNIQUEID);
      if (id) funds.set(id, { id, name: decode(text(info?.SECNAME)) || id });
    }
  }
  return list(ofx.INVSTMTMSGSRSV1?.INVSTMTTRNRS).flatMap((response) => (response.INVSTMTRS ? [statement(response.INVSTMTRS as unknown as Element, funds)] : []));
}

function statement(response: Element, funds: Map<string, OfxFund>): OfxHoldings {
  const positions: OfxHoldings['positions'] = [];
  let asOf: IsoDate | null = null;
  for (const entries of Object.values((response.INVPOSLIST ?? {}) as Element)) {
    for (const entry of list(entries as Element | Element[])) {
      const position = entry.INVPOS as Element;
      const fund = text((position.SECID as Element).UNIQUEID);
      const date = day(position.DTPRICEASOF);
      if (!asOf || date > asOf) asOf = date;
      if (number(position.UNITS) !== 0) positions.push({ fund, shares: number(position.UNITS), price: number(position.UNITPRICE) });
    }
  }

  const transactions: OfxTransaction[] = [];
  const unknownTypes = new Set<string>();
  const transactionList = (response.INVTRANLIST ?? {}) as Record<string, unknown>;
  for (const [type, entries] of Object.entries(transactionList)) {
    if (LISTS.has(type)) continue;
    const moves = SHARES_IN.has(type) ? 1 : SHARES_OUT.has(type) ? -1 : type === 'TRANSFER' ? 0 : null;
    if (moves === null) {
      unknownTypes.add(type);
      continue;
    }
    for (const entry of list(entries as Element | Element[])) {
      // Buys and sells keep their details in INVBUY / INVSELL; the others at the top.
      const detail = (entry.INVBUY ?? entry.INVSELL ?? entry) as Element;
      const core = detail.INVTRAN as Element;
      // Institutions differ on the sign of a sale's units: the element says which way they went.
      const direction = moves !== 0 ? moves : text(entry.TFERACTION) === 'OUT' ? -1 : 1;
      transactions.push({
        id: text(core.FITID),
        date: day(core.DTTRADE),
        type,
        fund: text((detail.SECID as Element).UNIQUEID),
        shares: direction * Math.abs(number(detail.UNITS)),
        price: number(detail.UNITPRICE),
        amount: Math.abs(toMinor(number(detail.TOTAL))),
        charges: ['COMMISSION', 'FEES', 'LOAD', 'TAXES'].reduce((sum, field) => sum + Math.abs(toMinor(number(detail[field]))), 0),
      });
    }
  }

  const lastTrade = transactions.map((txn) => txn.date).sort().at(-1);
  return {
    account: text((response.INVACCTFROM as Element | undefined)?.ACCTID).slice(-4),
    currency: text(response.CURDEF) || 'USD',
    asOf: asOf ?? lastTrade ?? day(response.DTASOF),
    funds: [...funds.values()],
    positions,
    transactions,
    unknownTypes: [...unknownTypes],
  };
}

/**
 * The statements for one account: by its last digits when the downloads hold
 * several accounts, else the only account in them. Throws, naming the
 * accounts, when it can't tell.
 */
export function statementsFor(statements: OfxHoldings[], mask: string | null | undefined): OfxHoldings[] {
  const accounts = [...new Set(statements.map((statement) => statement.account))];
  const last4 = mask?.slice(-4);
  if (last4 && accounts.includes(last4)) return statements.filter((statement) => statement.account === last4);
  if (accounts.length === 1) return statements;
  throw new Error(`These files hold accounts ending ${accounts.map((account) => `··${account}`).join(', ')}: choose the account whose number ends the same (set its last digits when editing it).`);
}

/**
 * Several downloads of one account as one: transactions merged by the
 * institution's id (overlapping date ranges count once), positions from the
 * most recent download. Throws when the files disagree on the currency.
 */
export function mergeOfx(statements: OfxHoldings[]): OfxHoldings {
  if (new Set(statements.map((statement) => statement.currency)).size > 1) throw new Error('These files are in different currencies.');
  const latest = statements.reduce((best, statement) => (statement.asOf > best.asOf ? statement : best));
  const transactions = new Map<string, OfxTransaction>();
  const funds = new Map<string, OfxFund>();
  for (const statement of statements) {
    for (const txn of statement.transactions) transactions.set(txn.id || `${txn.date}:${txn.type}:${txn.fund}:${txn.shares}`, txn);
    for (const fund of statement.funds) funds.set(fund.id, fund);
  }
  return {
    account: latest.account,
    currency: latest.currency,
    asOf: latest.asOf,
    funds: [...funds.values()],
    positions: latest.positions,
    transactions: [...transactions.values()].sort((a, b) => a.date.localeCompare(b.date)),
    unknownTypes: [...new Set(statements.flatMap((statement) => statement.unknownTypes))],
  };
}
