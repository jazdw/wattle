import type { AuthUser } from '../shared/types';
import type { Tenant } from './db/tenant';
import type { Deps } from './ports';

/** Hono environment shared by every route. `deps` is supplied by the platform entry. */
export type AppEnv = {
  Bindings: { deps: Deps };
  Variables: {
    user: AuthUser;
    tenant: Tenant;
  };
};
