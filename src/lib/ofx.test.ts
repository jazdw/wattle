import { describe, expect, it } from 'vitest';
import { bankSgml, buy, fee, sgml } from '../test/ofx';
import { fullDescription } from '../../shared/descriptions';
import { bankText, isOfx, ofxAccounts, positionShares } from './ofx';

describe('ofxAccounts', () => {
  it("reads an investment account's securities, positions, cash and transactions", () => {
    const content = sgml(buy('B1', '20260803', '10.0000', '12.500000', '125.00') + fee);
    expect(isOfx(content)).toBe(true);
    expect(isOfx('Date,Balance\n2026-01-01,5')).toBe(false);
    const [account] = ofxAccounts(content);
    expect(account).toMatchObject({ number: '12345678', institution: 'Example Plan', unknownTypes: [] });
    expect(account.file).toMatchObject({
      kind: 'holdings',
      currency: 'USD',
      asOf: '2026-10-08',
      cash: 0,
      // Only the securities the account uses; "Unknown" isn't a ticker.
      securities: [{ id: '000000002', ticker: null, name: 'Example S&P Index Fund M' }],
      // Positions with no units are left out.
      positions: [{ security: '000000002', shares: 260, price: 13 }],
    });
    expect(account.file.kind === 'holdings' && account.file.transactions).toEqual([
      { id: 'B1', date: '2026-08-03', kind: 'buy', label: 'BUYMF', description: 'Contributions', security: '000000002', shares: 10, price: 12.5, amount: -125_00, value: 125_00, charges: 0 },
      { id: 'F1', date: '2026-08-17', kind: 'sell', label: 'SELLMF', description: 'Fees', security: '000000002', shares: -0.08, price: 12.5, amount: 1_00, value: 1_00, charges: 0 },
    ]);
  });

  it('reads cash: income, money in and out, taxes withheld, and the cash balance', () => {
    const income = `<INCOME><INVTRAN><FITID>I1</FITID><DTTRADE>20260901</DTTRADE></INVTRAN><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><INCOMETYPE>DIV</INCOMETYPE><TOTAL>5.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INCOME>`;
    const bank = (fitid: string, amount: string) => `<INVBANKTRAN><STMTTRN><TRNTYPE>OTHER</TRNTYPE><DTPOSTED>20260902</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${fitid}</FITID></STMTTRN><SUBACCTFUND>CASH</SUBACCTFUND></INVBANKTRAN>`;
    const sale = `<SELLSTOCK><INVSELL><INVTRAN><FITID>S1</FITID><DTTRADE>20260903</DTTRADE></INVTRAN><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><UNITS>-2</UNITS><UNITPRICE>300</UNITPRICE><WITHHOLDING>6.00</WITHHOLDING><TOTAL>594.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVSELL><SELLTYPE>SELL</SELLTYPE></SELLSTOCK>`;
    const split = `<TRANSFER><INVTRAN><FITID>T1</FITID><DTTRADE>20260904</DTTRADE><MEMO>STOCK SPLIT RECEIVED</MEMO></INVTRAN><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SUBACCTSEC>CASH</SUBACCTSEC><UNITS>3</UNITS><TFERACTION>IN</TFERACTION><POSTYPE>LONG</POSTYPE></TRANSFER>`;
    const [account] = ofxAccounts(sgml(income + bank('D1', '1000.00') + bank('W1', '-250.00') + sale + split, '20261008', '12.34'));
    if (account.file.kind !== 'holdings') throw new Error('expected holdings');
    expect(account.file.cash).toBe(12_34);
    expect(account.file.securities.map((security) => security.ticker)).toContain('VTI');
    expect(account.file.transactions.map(({ kind, security, shares, amount, value, charges }) => ({ kind, security, shares, amount, value, charges }))).toEqual([
      { kind: 'income', security: '922908769', shares: 0, amount: 5_00, value: 0, charges: 0 },
      { kind: 'deposit', security: null, shares: 0, amount: 1000_00, value: 0, charges: 0 },
      { kind: 'withdrawal', security: null, shares: 0, amount: -250_00, value: 0, charges: 0 },
      { kind: 'sell', security: '922908769', shares: -2, amount: 594_00, value: 594_00, charges: 6_00 },
      { kind: 'transfer', security: '922908769', shares: 3, amount: 0, value: 0, charges: 0 },
    ]);
  });

  it('counts a sweep fund as the cash it is, and a reinvestment as its income and the purchase', () => {
    // A money market sweep fund worth exactly the available cash ($100), and a stock.
    const positions = `<POSMF><INVPOS><SECID><UNIQUEID>000000009</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>100</UNITS><UNITPRICE>1</UNITPRICE><MKTVAL>100</MKTVAL><DTPRICEASOF>20261008</DTPRICEASOF></INVPOS></POSMF>`;
    const reinvest = (fitid: string, date: string, security: string, units: string, total: string) =>
      `<REINVEST><INVTRAN><FITID>${fitid}</FITID><DTTRADE>${date}</DTTRADE></INVTRAN><SECID><UNIQUEID>${security}</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><INCOMETYPE>DIV</INCOMETYPE><TOTAL>${total}</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><UNITS>${units}</UNITS><UNITPRICE>1</UNITPRICE></REINVEST>`;
    const income = (fitid: string, date: string, security: string, total: string) =>
      `<INCOME><INVTRAN><FITID>${fitid}</FITID><DTTRADE>${date}</DTTRADE></INVTRAN>${security ? `<SECID><UNIQUEID>${security}</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID>` : ''}<INCOMETYPE>DIV</INCOMETYPE><TOTAL>${total}</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INCOME>`;
    const bank = (fitid: string, date: string, amount: string) => `<INVBANKTRAN><STMTTRN><TRNTYPE>OTHER</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${fitid}</FITID></STMTTRN><SUBACCTFUND>CASH</SUBACCTFUND></INVBANKTRAN>`;
    const transactions = [
      reinvest('R1', '20260801', '000000009', '1', '1.00'), // on its own: the income is added
      income('I2', '20260831', '922908769', '8.00'), // paid, then $7.75 reinvested after a $0.25 fee
      bank('W2', '20260901', '-0.25'),
      reinvest('R2', '20260901', '922908769', '0.025', '7.75'),
      income('I3', '20260930', '', '2.00'), // the sweep's interest, moved into the sweep the same day
      bank('W3', '20260930', '-2.00'),
      bank('W4', '20261001', '-50.00'), // a real withdrawal
    ].join('');
    const content = sgml(transactions, '20261008', '100.00').replace('<INVPOSLIST>', `<INVPOSLIST>${positions}`).replace('</SECLIST>', '<MFINFO><SECINFO><SECID><UNIQUEID>000000009</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>Example Money Market</SECNAME><TICKER>XYZMM</TICKER></SECINFO></MFINFO></SECLIST>');
    const [account] = ofxAccounts(content);
    if (account.file.kind !== 'holdings') throw new Error('expected holdings');
    // The sweep fund isn't a holding: it's the $100 of cash.
    expect(account.file.cash).toBe(100_00);
    expect(account.file.positions.map((row) => row.security)).toEqual(['000000002']);
    expect(account.file.transactions.map(({ date, kind, security, shares, amount }) => [date, kind, security, shares, amount])).toEqual([
      // Reinvested into the sweep fund: a move within cash, and the income that paid for it.
      ['2026-08-01', 'sweep', null, 0, -1_00],
      ['2026-08-01', 'income', null, 0, 1_00],
      // Its income was listed already (less the fee): not added again.
      ['2026-08-31', 'income', '922908769', 0, 8_00],
      ['2026-09-01', 'reinvest', '922908769', 0.025, -7_75],
      ['2026-09-01', 'withdrawal', null, 0, -25],
      ['2026-09-30', 'income', null, 0, 2_00],
      ['2026-09-30', 'sweep', null, 0, -2_00],
      ['2026-10-01', 'withdrawal', null, 0, -50_00],
    ]);
  });

  it("doesn't take a plan's placeholders for tickers", () => {
    for (const placeholder of ['NON0Z', 'NONE9', 'NONEX', 'CASH', 'loan', 'N/A']) {
      const [account] = ofxAccounts(sgml(buy('B1', '20260803', '10', '12.5', '125.00')).replace('<TICKER>Unknown</TICKER>', `<TICKER>${placeholder}</TICKER>`));
      expect(account.file.kind === 'holdings' && account.file.securities[0].ticker, placeholder).toBeNull();
    }
  });

  it('lists transaction types it doesn’t understand, and skips a bank statement with no closing balance', () => {
    const expense = `<INVEXPENSE><INVTRAN><FITID>E1</FITID><DTTRADE>20260901</DTTRADE></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><TOTAL>5.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVEXPENSE>`;
    expect(ofxAccounts(sgml(expense))[0].unknownTypes).toEqual(['INVEXPENSE']);
    const bank = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>0</TRNUID><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST><DTSTART>20260101</DTSTART><DTEND>20261008</DTEND></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(ofxAccounts(bank)).toEqual([]);
  });

  it('reads the XML version too', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n${sgml(buy('B1', '20260803', '10', '12.5', '125.00')).slice(sgml('').indexOf('<OFX>'))}`;
    expect(isOfx(xml)).toBe(true);
    const [account] = ofxAccounts(xml);
    expect(account.file.kind === 'holdings' && account.file.transactions).toHaveLength(1);
  });

  it("reads a bank statement as the balance on each day a transaction posted, worked back from the closing balance", () => {
    // $1,000 closing on Oct 8: a $500 deposit on Sep 10, $200 and $50 out on Sep 20, $25 in on Oct 8.
    const [account] = ofxAccounts(bankSgml([['20260910', '500.00'], ['20260920', '-200.00'], ['20260920', '-50.00'], ['20261008', '25.00']], '1000.00'));
    expect(account).toMatchObject({ number: '99990001', institution: 'Example Bank', type: 'depository', unknownTypes: [] });
    expect(account.file).toEqual({
      kind: 'balances',
      currency: 'USD',
      rows: [
        { date: '2026-09-01', balance: 725 }, // from the day the statement starts
        { date: '2026-09-10', balance: 1225 },
        { date: '2026-09-20', balance: 975 },
        { date: '2026-10-08', balance: 1000 },
      ],
      // Kept with their ids, for the account's transactions.
      transactions: [
        { id: 'T0', date: '2026-09-10', kind: 'deposit', label: 'CREDIT', description: 'Example', amount: 500_00 },
        { id: 'T1', date: '2026-09-20', kind: 'withdrawal', label: 'DEBIT', description: 'Example', amount: -200_00 },
        { id: 'T2', date: '2026-09-20', kind: 'withdrawal', label: 'DEBIT', description: 'Example', amount: -50_00 },
        { id: 'T3', date: '2026-10-08', kind: 'deposit', label: 'CREDIT', description: 'Example', amount: 25_00 },
      ],
    });
  });

  it("reads a card statement as what's owed, to its closing date", () => {
    // $300 owed at the close (Oct 8), after a $100 purchase on Sep 15 and a $50 payment on Sep 25.
    const [account] = ofxAccounts(bankSgml([['20260915', '-100.00'], ['20260925', '50.00']], '-300.00', { card: true, start: '20260915' }));
    expect(account).toMatchObject({ type: 'credit' });
    expect(account.file).toEqual({
      kind: 'balances',
      currency: 'USD',
      rows: [
        { date: '2026-09-15', balance: 350 },
        { date: '2026-09-25', balance: 300 },
        { date: '2026-10-08', balance: 300 },
      ],
      // The purchase is money out of the card, the payment money in.
      transactions: [
        { id: 'T0', date: '2026-09-15', kind: 'withdrawal', label: 'DEBIT', description: 'Example', amount: -100_00 },
        { id: 'T1', date: '2026-09-25', kind: 'deposit', label: 'CREDIT', description: 'Example', amount: 50_00 },
      ],
    });
  });

  it('pairs each reinvestment with its own income when two are paid on one day, one less a fee', () => {
    // $10.00 paid and $9.80 reinvested after a $0.20 fee, and $9.00 reinvested on its own (its income not listed apart).
    const income = `<INCOME><INVTRAN><FITID>I1</FITID><DTTRADE>20260710</DTTRADE></INVTRAN><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><INCOMETYPE>DIV</INCOMETYPE><TOTAL>10.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INCOME>`;
    const reinvest = (fitid: string, units: string, total: string) =>
      `<REINVEST><INVTRAN><FITID>${fitid}</FITID><DTTRADE>20260710</DTTRADE></INVTRAN><SECID><UNIQUEID>922908769</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><INCOMETYPE>DIV</INCOMETYPE><TOTAL>${total}</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><UNITS>${units}</UNITS><UNITPRICE>100</UNITPRICE></REINVEST>`;
    const fee = `<INVBANKTRAN><STMTTRN><TRNTYPE>OTHER</TRNTYPE><DTPOSTED>20260710</DTPOSTED><TRNAMT>-0.20</TRNAMT><FITID>W1</FITID></STMTTRN><SUBACCTFUND>CASH</SUBACCTFUND></INVBANKTRAN>`;
    const [account] = ofxAccounts(sgml(income + reinvest('R1', '0.09', '9.00') + reinvest('R2', '0.098', '9.80') + fee));
    if (account.file.kind !== 'holdings') throw new Error('expected holdings');
    // Paid, less the fee, all reinvested: the day's cash doesn't move.
    expect(account.file.transactions.reduce((sum, txn) => sum + txn.amount, 0)).toBe(0);
  });

  it("names money in and out by the bank's own type: interest and dividends are income, a fee a fee", () => {
    const bank = (fitid: string, type: string, amount: string) => `<INVBANKTRAN><STMTTRN><TRNTYPE>${type}</TRNTYPE><DTPOSTED>20260930</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${fitid}</FITID><NAME>Example</NAME></STMTTRN><SUBACCTFUND>CASH</SUBACCTFUND></INVBANKTRAN>`;
    const [account] = ofxAccounts(sgml(bank('A', 'INT', '0.05') + bank('B', 'FEE', '-3.00') + bank('C', 'CREDIT', '100.00') + bank('D', 'XFER', '-50.00')));
    if (account.file.kind !== 'holdings') throw new Error('expected holdings');
    expect((account.file.transactions as { id?: string; kind: string; amount: number }[]).map((txn) => [txn.id, txn.kind, txn.amount])).toEqual([
      ['A', 'income', 5],
      ['B', 'fee', -3_00],
      ['C', 'deposit', 100_00],
      ['D', 'withdrawal', -50_00],
    ]);
  });
});

describe('positionShares', () => {
  it("takes the share count from a position's value to the cent, when it agrees with the rounded count shown", () => {
    // 8.117 shown at $694.81 is $5,639.77, but the position is worth $5,639.63: 8.116795 shares.
    expect(positionShares('8.117', 694.81, 5639.63)).toBe(8.116795);
    // Too far from the count shown (a stale price): the count stands.
    expect(positionShares('8.117', 600, 5639.63)).toBe(8.117);
    // A whole number shown isn't moved by more than a rounded count would be.
    expect(positionShares('10', 100, 999)).toBe(10);
    // No count shown: the value over the price; no value or price: the count shown.
    expect(positionShares(null, 694.81, 5639.63)).toBe(8.116795);
    expect(positionShares('8.117', 694.81, null)).toBe(8.117);
    expect(positionShares('8.117', 0, 5639.63)).toBe(8.117);
    expect(positionShares(null, 0, null)).toBeNull();
  });

  it("reads a Quicken position's shares from its market value", () => {
    const content = sgml(buy('B1', '20260803', '10', '12.5', '125.00')).replace('<UNITS>260.0000</UNITS><UNITPRICE>13.000000</UNITPRICE><MKTVAL>3380.00</MKTVAL>', '<UNITS>260.000</UNITS><UNITPRICE>694.810000</UNITPRICE><MKTVAL>180650.53</MKTVAL>');
    const [account] = ofxAccounts(content);
    if (account.file.kind !== 'holdings') throw new Error('expected holdings');
    expect(account.file.positions.find((row) => row.security === '000000002')?.shares).toBe(259.999899);
  });
});

describe('bankText', () => {
  it("keeps a bank's NAME and MEMO as they are, dropping only exact repeats", () => {
    // Made up: NAME filled to its 32 characters, MEMO going on mid-word.
    expect(bankText('Online Transfer 12345678901 to E', 'xample savings ####1234 transfer')).toEqual({ description: 'Online Transfer 12345678901 to E', memo: 'xample savings ####1234 transfer' });
    expect(bankText('', 'Example Savings  1234 transferre')).toEqual({ description: 'Example Savings  1234 transferre' });
    expect(bankText('PAYROLL', '')).toEqual({ description: 'PAYROLL' });
    expect(bankText('', '')).toEqual({});
    expect(bankText('EXAMPLE STORE', 'Card purchase')).toEqual({ description: 'EXAMPLE STORE', memo: 'Card purchase' });
    expect(bankText('Interest', 'Interest')).toEqual({ description: 'Interest' });
    // Written twice running by the institution: once.
    expect(bankText('', 'INTEREST PAYMENTINTEREST PAYMENT')).toEqual({ description: 'INTEREST PAYMENT' });
    expect(bankText('', 'ABAB')).toEqual({ description: 'ABAB' });
    // NAME the start of a MEMO that has it all.
    expect(bankText('Example plan contribution from e', 'Example plan contribution from employer')).toEqual({ description: 'Example plan contribution from employer' });
    // Interest a bank gives no type of its own reads as income.
    const [account] = ofxAccounts(bankSgml([['20260910', '0.13']], '100.00').replace('<NAME>Example</NAME>', '<NAME>INTEREST PAYMENT</NAME>'));
    expect(account.file.kind === 'balances' && account.file.transactions?.[0]).toMatchObject({ kind: 'income', description: 'INTEREST PAYMENT' });
  });

  it('shows the two joined: straight on from a NAME cut at its limit, else with a dot', () => {
    expect(fullDescription('Online Transfer 12345678901 to E', 'xample savings')).toBe('Online Transfer 12345678901 to Example savings');
    expect(fullDescription('EXAMPLE STORE', 'Card purchase')).toBe('EXAMPLE STORE · Card purchase');
    expect(fullDescription('PAYROLL', null)).toBe('PAYROLL');
    expect(fullDescription(null, 'Card purchase')).toBe('Card purchase');
    expect(fullDescription(null, null)).toBeNull();
  });
});
