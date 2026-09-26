import type { Services } from './services';

/**
 * Module-level handle to the services for non-React code paths (event handlers in plain
 * modules). Components should prefer useServices().
 */
let current: Services | null = null;

export function setServicesRef(s: Services | null) {
  current = s;
}

export function getServicesUnsafe(): Services {
  if (!current) throw new Error('services not initialised');
  return current;
}
