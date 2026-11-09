/**
 * How an account is named wherever it's shown, and the kinds of account
 * within each type. An account has an institution, a name (yours to change:
 * a nickname), its last four digits, and a kind ("subtype": checking, 401(k),
 * HSA…), which a linked account gets from Plaid and a manual one is given.
 */

export interface Nameable {
  name: string;
  institutionName: string | null;
  mask: string | null;
}

/** "Institution · Name ··1234": the name alone when it already starts with the institution. */
export function accountLabel(account: Nameable): string {
  const institution = account.institutionName?.trim();
  const named = institution && !account.name.toLowerCase().startsWith(institution.toLowerCase()) ? `${institution} · ${account.name}` : account.name;
  return account.mask ? `${named} ··${account.mask}` : named;
}

/** The kinds of account within each type, as Plaid names them (its subtypes); in words, see accountKind (src/lib/format.ts). */
export const ACCOUNT_SUBTYPES: Record<string, string[]> = {
  depository: ['checking', 'savings', 'money market', 'cd', 'cash management', 'hsa'],
  credit: ['credit card'],
  loan: ['mortgage', 'auto', 'student', 'home equity', 'line of credit'],
  investment: ['brokerage', 'ira', 'roth', '401k', 'roth 401k', '403b', '457b', 'hsa', '529', 'sep ira', 'simple ira', 'pension', 'superannuation'],
  property: [],
  other: [],
};
