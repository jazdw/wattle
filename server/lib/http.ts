import type { Context } from 'hono';
import type { z } from 'zod';
import { isCurrency, type Currency } from '../../shared/money';
import type { AppEnv } from '../env';

export class HttpError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;

  constructor(status: HttpError['status'], message: string) {
    super(message);
    this.status = status;
  }
}

/** Parse and validate a JSON body, answering 400 with the first issue. */
export async function readBody<S extends z.ZodType>(c: Context<AppEnv>, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, 'Expected a JSON body.');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new HttpError(400, `${issue.path.join('.') || 'body'}: ${issue.message}`);
  }
  return result.data;
}

/** Display currency: ?currency= or the household default. */
export function requestCurrency(c: Context<AppEnv>, fallback: string): Currency {
  const requested = c.req.query('currency');
  if (isCurrency(requested)) return requested;
  return isCurrency(fallback) ? fallback : 'USD';
}

export function notFound(what = 'Not found.'): never {
  throw new HttpError(404, what);
}
