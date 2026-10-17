import { sha256Hex } from '../lib/encoding';

/**
 * A UUID-shaped id derived from `key` (SHA-256): the same for every caller,
 * so two requests creating "the same" row at once insert one row (the second
 * insert is ignored) instead of a duplicate.
 */
export async function stableId(key: string): Promise<string> {
  const hex = await sha256Hex(key);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
