/**
 * Errors described for logs and the sync log without the data they carry.
 * A failed query's message from Drizzle includes its bound values (emails,
 * balances, account names); only the SQL, which has placeholders, is kept.
 */
import { DrizzleQueryError } from 'drizzle-orm/errors';

const MAX_LENGTH = 1000;

/** One line describing `error` (and its causes), safe to log. */
export function describeError(error: unknown, depth = 0): string {
  if (error instanceof DrizzleQueryError) {
    const cause = depth < 3 && error.cause ? `: ${describeError(error.cause, depth + 1)}` : '';
    return `Failed query: ${error.query}${cause}`.slice(0, MAX_LENGTH);
  }
  if (error instanceof Error) {
    const cause = depth < 3 && error.cause ? ` (cause: ${describeError(error.cause, depth + 1)})` : '';
    return `${error.message}${cause}`.slice(0, MAX_LENGTH);
  }
  return String(error).slice(0, MAX_LENGTH);
}

/** `describeError` plus where it was thrown, for unexpected errors. */
export function describeErrorWithStack(error: unknown): string {
  const description = describeError(error);
  if (!(error instanceof Error) || !error.stack) return description;
  // The stack starts with the message (values and all); keep only the frames.
  const frames = error.stack.indexOf('\n    at ');
  return frames === -1 ? description : description + error.stack.slice(frames);
}
