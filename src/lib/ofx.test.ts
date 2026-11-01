import { describe, expect, it } from 'vitest';
import { isOfx, mergeOfx, ofxHoldings, statementsFor } from './ofx';

/** A made-up QFX download (OFX 1.x SGML, with closing tags as most institutions send). */
function sgml(transactions: string, asOf = '20261008') {
  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>${asOf}190000</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>
<INVSTMTMSGSRSV1><INVSTMTTRNRS><TRNUID>0</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
<INVSTMTRS><DTASOF>${asOf}190000</DTASOF><CURDEF>USD</CURDEF>
<INVACCTFROM><BROKERID>example.com</BROKERID><ACCTID>12345678</ACCTID></INVACCTFROM>
<INVTRANLIST><DTSTART>20260101</DTSTART><DTEND>${asOf}</DTEND>
${transactions}
</INVTRANLIST>
<INVPOSLIST>
<POSMF><INVPOS><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>260.0000</UNITS><UNITPRICE>13.000000</UNITPRICE><MKTVAL>3380.00</MKTVAL><DTPRICEASOF>${asOf}190000.000[-6:CST]</DTPRICEASOF></INVPOS></POSMF>
<POSMF><INVPOS><SECID><UNIQUEID>000000003</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><HELDINACCT>CASH</HELDINACCT><POSTYPE>LONG</POSTYPE><UNITS>0.0000</UNITS><UNITPRICE>21.000000</UNITPRICE><MKTVAL>0.00</MKTVAL><DTPRICEASOF>${asOf}190000.000[-6:CST]</DTPRICEASOF></INVPOS></POSMF>
</INVPOSLIST>
</INVSTMTRS></INVSTMTTRNRS></INVSTMTMSGSRSV1>
<SECLISTMSGSRSV1><SECLIST>
<MFINFO><SECINFO><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>Example S&amp;amp;P Index Fund M</SECNAME><TICKER>Unknown</TICKER></SECINFO></MFINFO>
<MFINFO><SECINFO><SECID><UNIQUEID>000000003</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><SECNAME>Example Target 2050</SECNAME></SECINFO></MFINFO>
</SECLIST></SECLISTMSGSRSV1>
</OFX>`;
}

const buy = (fitid: string, date: string, units: string, price: string, total: string) =>
  `<BUYMF><INVBUY><INVTRAN><FITID>${fitid}</FITID><DTTRADE>${date}150000.000[-6:CST]</DTTRADE><MEMO>Contributions</MEMO></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><UNITS>${units}</UNITS><UNITPRICE>${price}</UNITPRICE><TOTAL>${total}</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVBUY><BUYTYPE>BUY</BUYTYPE></BUYMF>`;
// Some institutions give a sale's units as a positive number.
const fee = `<SELLMF><INVSELL><INVTRAN><FITID>F1</FITID><DTTRADE>20260817</DTTRADE><MEMO>Fees</MEMO></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><UNITS>0.0800</UNITS><UNITPRICE>12.500000</UNITPRICE><TOTAL>1.00</TOTAL><FEES>0.00</FEES><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INVSELL><SELLTYPE>SELL</SELLTYPE></SELLMF>`;

describe('ofxHoldings', () => {
  it("reads an investment statement's funds, positions and transactions", () => {
    const content = sgml(buy('B1', '20260803', '10.0000', '12.500000', '125.00') + fee);
    expect(isOfx(content)).toBe(true);
    expect(isOfx('Date,Balance\n2026-01-01,5')).toBe(false);
    const [holdings] = ofxHoldings(content);
    expect(holdings).toMatchObject({
      account: '5678',
      currency: 'USD',
      asOf: '2026-10-08',
      funds: [
        { id: '000000002', name: 'Example S&P Index Fund M' },
        { id: '000000003', name: 'Example Target 2050' },
      ],
      // Positions with no units are left out.
      positions: [{ fund: '000000002', shares: 260, price: 13 }],
      unknownTypes: [],
    });
    expect(holdings.transactions).toEqual(
      expect.arrayContaining([
        { id: 'B1', date: '2026-08-03', type: 'BUYMF', fund: '000000002', shares: 10, price: 12.5, amount: 12500, charges: 0 },
        { id: 'F1', date: '2026-08-17', type: 'SELLMF', fund: '000000002', shares: -0.08, price: 12.5, amount: 100, charges: 0 },
      ]),
    );
  });

  it('lists transaction types it doesn’t understand, and ignores bank statements', () => {
    const income = `<INCOME><INVTRAN><FITID>I1</FITID><DTTRADE>20260901</DTTRADE></INVTRAN><SECID><UNIQUEID>000000002</UNIQUEID><UNIQUEIDTYPE>CUSIP</UNIQUEIDTYPE></SECID><INCOMETYPE>DIV</INCOMETYPE><TOTAL>5.00</TOTAL><SUBACCTSEC>CASH</SUBACCTSEC><SUBACCTFUND>CASH</SUBACCTFUND></INCOME>`;
    expect(ofxHoldings(sgml(income))[0].unknownTypes).toEqual(['INCOME']);
    const bank = `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX><BANKMSGSRSV1><STMTTRNRS><TRNUID>0</TRNUID><STMTRS><CURDEF>USD</CURDEF><BANKTRANLIST><DTSTART>20260101</DTSTART><DTEND>20261008</DTEND></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    expect(ofxHoldings(bank)).toEqual([]);
  });

  it('reads the XML version too', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n${sgml(buy('B1', '20260803', '10', '12.5', '125.00')).slice(sgml('').indexOf('<OFX>'))}`;
    expect(isOfx(xml)).toBe(true);
    expect(ofxHoldings(xml)[0].transactions).toHaveLength(1);
  });
});

describe('mergeOfx', () => {
  it('counts a transaction in overlapping downloads once, with positions from the latest', () => {
    const [older] = ofxHoldings(sgml(buy('B1', '20250803', '10', '12.5', '125.00'), '20251231'));
    const [newer] = ofxHoldings(sgml(buy('B1', '20250803', '10', '12.5', '125.00') + buy('B2', '20260803', '10', '12.5', '125.00')));
    const merged = mergeOfx([newer, older]);
    expect(merged.transactions.map((txn) => txn.id)).toEqual(['B1', 'B2']);
    expect(merged.asOf).toBe('2026-10-08');
  });
});

describe('statementsFor', () => {
  // A download with two accounts: the same statement again under another account number.
  const one = sgml(buy('B1', '20260803', '10', '12.5', '125.00'));
  const statement = one.slice(one.indexOf('<INVSTMTTRNRS>'), one.indexOf('</INVSTMTMSGSRSV1>'));
  const both = ofxHoldings(one.replace('</INVSTMTMSGSRSV1>', statement.replace('<ACCTID>12345678', '<ACCTID>87654321') + '</INVSTMTMSGSRSV1>'));

  it("picks the chosen account's statements by its last digits", () => {
    expect(both.map((found) => found.account)).toEqual(['5678', '4321']);
    expect(statementsFor(both, '••4321').map((found) => found.account)).toEqual(['4321']);
  });

  it('takes the only account in the files, and names the accounts when it can’t tell', () => {
    expect(statementsFor(ofxHoldings(one), null)).toHaveLength(1);
    expect(() => statementsFor(both, '9999')).toThrow(/accounts ending ··5678, ··4321/);
  });
});
