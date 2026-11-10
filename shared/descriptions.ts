/**
 * A transaction's text in one line. A Quicken file's transactions keep its
 * NAME as their description and its MEMO as their memo, as the file has
 * them; this joins the two only where they're shown or searched for a
 * reference (never stored).
 */

/** OFX's NAME holds 32 characters: one that long was cut there, its MEMO going on (often mid-word). */
export const OFX_NAME_LENGTH = 32;

export function fullDescription(description: string | null | undefined, memo: string | null | undefined): string | null {
  if (!memo) return description || null;
  if (!description) return memo;
  // NAME cut at its limit runs straight on into MEMO; otherwise they're two parts.
  return description.length === OFX_NAME_LENGTH ? description + memo : `${description} · ${memo}`;
}
