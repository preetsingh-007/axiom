/**
 * Persistent storage: without it the browser may evict the vault (IndexedDB) under storage
 * pressure, and Safari deletes it after ~7 days without a visit unless the app is on the home
 * screen. Chrome grants or denies silently (based on engagement / installation); Firefox asks.
 */

/** true / false: persisted or not; undefined: the browser has no StorageManager API. */
export async function isStoragePersistent(): Promise<boolean | undefined> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!s?.persisted) return undefined;
  try {
    return await s.persisted();
  } catch {
    return false;
  }
}

/** Asks for persistent storage unless already granted. Resolves to the resulting state. */
export async function requestPersistentStorage(): Promise<boolean | undefined> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  if (!s?.persist) return undefined;
  try {
    if (await s.persisted?.()) return true;
    return await s.persist();
  } catch {
    return false;
  }
}
