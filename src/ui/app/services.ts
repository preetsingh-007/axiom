import { createContext, useContext } from 'react';
import type { Vault } from '../../core/vault';
import type { SyncManager } from '../../core/sync/manager';

/**
 * Long-lived per-vault services. Created once in bootstrap.ts and provided through context.
 * Optional services are attached as they initialise (graph index, AI router, git sync).
 */
export interface Services {
  vault: Vault;
  sync: SyncManager;
  device: { id: string; name: string };
  // attached by bootstrap (typed loosely here to avoid import cycles; see bootstrap.ts)
  [key: string]: unknown;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices<T extends Services = Services>(): T {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('ServicesContext missing');
  return s as T;
}
